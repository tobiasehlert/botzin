import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Lets the panel ask the host to start or stop the agent and the annotation UI.
 *
 * The panel serves from a container and cannot spawn anything on the host, so it
 * only writes a desired state to a file on the shared storage volume. A
 * supervisor running on the host reads that file and does the spawning.
 *
 * The file never carries a command. It carries one of the fixed names below, and
 * the supervisor maps the name to a command it already knows — otherwise anything
 * able to write to the storage directory would get arbitrary code execution.
 */
export const MANAGED_PROCESSES = ["agent", "annotator"] as const;
export type ManagedProcess = (typeof MANAGED_PROCESSES)[number];

export type DesiredState = "running" | "stopped";
export type ObservedState = "running" | "stopped" | "failed";

export interface ProcessControl {
  readonly desired: Readonly<Record<ManagedProcess, DesiredState>>;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export interface ProcessObservation {
  readonly state: ObservedState;
  readonly pid: number | null;
  readonly since: string | null;
  readonly error: string | null;
}

export interface ProcessStatus {
  readonly heartbeatAt: string;
  readonly observed: Readonly<Record<ManagedProcess, ProcessObservation>>;
}

/** The supervisor is considered gone if it has not written a heartbeat recently. */
export const SUPERVISOR_STALE_MS = 15_000;

export const IDLE_OBSERVATION: ProcessObservation = { state: "stopped", pid: null, since: null, error: null };

export function controlPaths(decisionLogPath: string): { control: string; status: string } {
  const root = dirname(decisionLogPath);
  return { control: join(root, "process-control.json"), status: join(root, "process-status.json") };
}

export function defaultControl(): ProcessControl {
  return { desired: { agent: "stopped", annotator: "stopped" }, updatedAt: new Date(0).toISOString(), updatedBy: "default" };
}

export function isManagedProcess(value: unknown): value is ManagedProcess {
  return typeof value === "string" && (MANAGED_PROCESSES as readonly string[]).includes(value);
}

export function isDesiredState(value: unknown): value is DesiredState {
  return value === "running" || value === "stopped";
}

export async function readControl(path: string): Promise<ProcessControl> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<ProcessControl>;
    const desired = { ...defaultControl().desired };
    for (const name of MANAGED_PROCESSES) {
      const value = parsed.desired?.[name];
      if (isDesiredState(value)) desired[name] = value;
    }
    return {
      desired,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
      updatedBy: typeof parsed.updatedBy === "string" ? parsed.updatedBy : "unknown"
    };
  } catch {
    // A missing or corrupt file means "nothing requested", never "start everything".
    return defaultControl();
  }
}

export async function writeControl(path: string, control: ProcessControl): Promise<void> {
  await writeFile(path, JSON.stringify(control, null, 2) + "\n", "utf8");
}

export async function readStatus(path: string): Promise<ProcessStatus | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as ProcessStatus;
    return typeof parsed?.heartbeatAt === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeStatus(path: string, status: ProcessStatus): Promise<void> {
  await writeFile(path, JSON.stringify(status, null, 2) + "\n", "utf8");
}

/** Null when no supervisor is running, so the panel can say so instead of hanging on "starting". */
export function supervisorOnline(status: ProcessStatus | null, now = Date.now()): boolean {
  if (!status) return false;
  const beat = Date.parse(status.heartbeatAt);
  return Number.isFinite(beat) && now - beat < SUPERVISOR_STALE_MS;
}
