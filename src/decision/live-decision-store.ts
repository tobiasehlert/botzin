import { appendFile, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { PerceptionEvent } from "../coordination/perception-event.js";
import type { GameEntity, GameEntityKind } from "../core/game-entity.js";
import type { InputCommand } from "../core/input-command.js";

/** One rule's verdict in a cycle, kept structured so the panel can draw the tree. */
export interface EvaluatedProposal {
  readonly source: string;
  readonly priority: number;
  readonly band: string;
  readonly action: string;
  readonly reason: string;
  /** Null on the proposal that won; the losing reason otherwise. */
  readonly rejectedBecause: string | null;
}

export interface LiveDecisionRecord {
  readonly id: string;
  readonly observedAt: string;
  readonly sourceComputerId: string;
  readonly strategy: string;
  readonly mode: "observe" | "suggest";
  readonly status: "observed" | "suggested" | "error";
  readonly decision: string;
  readonly reasons: readonly string[];
  /**
   * Absent on records written before the tree existed and on non-rule strategies,
   * so the panel falls back to the flat `reasons` list rather than showing an
   * empty tree.
   */
  readonly evaluation?: readonly EvaluatedProposal[];
  readonly perceptionConfidence: number | null;
  readonly frame: { readonly id: string; readonly width: number; readonly height: number } | null;
  readonly entities: readonly GameEntity[];
  readonly entityCounts: Readonly<Record<GameEntityKind, number>>;
  readonly commands: readonly InputCommand[];
  readonly error: string | null;
}

export interface LiveDecisionSnapshot {
  readonly active: boolean;
  readonly lastSeenAt: string | null;
  readonly records: readonly LiveDecisionRecord[];
}

const EMPTY_COUNTS: Readonly<Record<GameEntityKind, number>> = {
  player: 0,
  creature: 0,
  npc: 0,
  "player-summon": 0,
  item: 0,
  effect: 0,
  missile: 0,
  unknown: 0
};

export function decisionFrom(
  event: PerceptionEvent,
  strategy: string,
  commands: readonly InputCommand[],
  /** Filled by rule based strategies so every record explains its own decision. */
  detail?: {
    readonly decision?: string;
    readonly reasons?: readonly string[];
    readonly evaluation?: readonly EvaluatedProposal[];
  }
): LiveDecisionRecord {
  const entityCounts = { ...EMPTY_COUNTS };
  // Entities can carry a kind from an out-of-date labels file; counting it under
  // a dynamic key would produce NaN (undefined + 1) in every persisted record.
  for (const entity of event.entities) entityCounts[entity.kind in entityCounts ? entity.kind : "unknown"] += 1;
  const confidence = event.entities.length > 0
    ? event.entities.reduce((sum, entity) => sum + entity.confidence, 0) / event.entities.length
    : null;
  const hasCommands = commands.length > 0;
  return {
    id: randomUUID(),
    observedAt: new Date().toISOString(),
    sourceComputerId: event.sourceComputerId,
    strategy,
    mode: hasCommands ? "suggest" : "observe",
    status: hasCommands ? "suggested" : "observed",
    decision: detail?.decision ?? (hasCommands ? commands.map((command) => command.type).join(", ") : "Nenhuma ação"),
    reasons: detail?.reasons ?? (hasCommands
      ? ["A estratégia produziu comandos candidatos.", "Execução automática não está conectada a este monitor."]
      : ["Estratégia passiva em modo de observação.", "Nenhum comando foi produzido neste ciclo."]),
    ...(detail?.evaluation ? { evaluation: detail.evaluation } : {}),
    perceptionConfidence: confidence,
    frame: event.frame,
    entities: event.entities,
    entityCounts,
    commands,
    error: null
  };
}

export function errorDecision(sourceComputerId: string, strategy: string, error: unknown): LiveDecisionRecord {
  return {
    id: randomUUID(),
    observedAt: new Date().toISOString(),
    sourceComputerId,
    strategy,
    mode: "observe",
    status: "error",
    decision: "Falha ao avaliar o frame",
    reasons: ["O ciclo foi interrompido antes de produzir uma decisão."],
    perceptionConfidence: null,
    frame: null,
    entities: [],
    entityCounts: { ...EMPTY_COUNTS },
    commands: [],
    error: error instanceof Error ? error.message : String(error)
  };
}

export class LiveDecisionStore {
  private writes = 0;

  constructor(
    private readonly path: string,
    private readonly retainedRecords = 1_000
  ) {}

  async append(record: LiveDecisionRecord): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(record)}\n`, "utf8");
    this.writes += 1;
    if (this.writes % 100 === 0 || await this.isOversized()) await this.compact();
  }

  async listLatest(limit = 50): Promise<LiveDecisionRecord[]> {
    try {
      const lines = (await readFile(this.path, "utf8")).split(/\r?\n/).filter(Boolean);
      return lines.slice(-clampLimit(limit)).flatMap((line) => {
        try {
          return [JSON.parse(line) as LiveDecisionRecord];
        } catch {
          return [];
        }
      }).reverse();
    } catch {
      return [];
    }
  }

  async snapshot(limit: number, activeWindowMs: number): Promise<LiveDecisionSnapshot> {
    const records = await this.listLatest(limit);
    const lastSeenAt = records[0]?.observedAt ?? null;
    return {
      active: lastSeenAt !== null && Date.now() - Date.parse(lastSeenAt) <= activeWindowMs,
      lastSeenAt,
      records
    };
  }

  private async isOversized(): Promise<boolean> {
    try {
      return (await stat(this.path)).size > 5 * 1024 * 1024;
    } catch {
      return false;
    }
  }

  private async compact(): Promise<void> {
    const records = (await this.listLatest(this.retainedRecords)).reverse();
    const temporaryPath = `${this.path}.tmp`;
    const contents = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
    await writeFile(temporaryPath, contents, "utf8");
    try {
      // Windows can reject replacing the file while the web panel is reading it.
      // Readers are short polls, so a brief retry usually recovers the atomic
      // rename; only after that fall back to an in-place rewrite, which risks a
      // torn concurrent read but keeps the monitor alive.
      for (let attempt = 0; ; attempt += 1) {
        try {
          await rename(temporaryPath, this.path);
          return;
        } catch (error) {
          if (!isWindowsReplaceError(error)) throw error;
          if (attempt >= 3) break;
          await wait(50 * (attempt + 1));
        }
      }
      await writeFile(this.path, contents, "utf8");
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}

function isWindowsReplaceError(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES");
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function clampLimit(limit: number): number {
  return Number.isFinite(limit) ? Math.max(1, Math.min(Math.floor(limit), 200)) : 50;
}
