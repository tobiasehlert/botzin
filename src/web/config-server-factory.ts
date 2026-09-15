import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, stat, unlink } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, extname, join, normalize } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import Busboy from "busboy";
import bcrypt from "bcryptjs";
import type { Pool } from "mysql2/promise";
import type { AuthenticatedConfigUser, ConfigUserRole } from "../core/config-user.js";
import { ValidationError } from "../core/errors.js";
import { JwtService } from "../auth/jwt-service.js";
import { hasRole } from "../auth/role-policy.js";
import type { RuntimeConfig } from "../config/runtime-config.js";
import { applyMachineRuntimeConfig } from "../config/machine-runtime-config.js";
import { ConfigUserRepository } from "../database/config-user-repository.js";
import { ConfigurationRepository } from "../database/configuration-repository.js";
import { GameCatalogRepository } from "../database/game-catalog-repository.js";
import { TIBIA_KNOWLEDGE_DOMAINS } from "../learning/tibia-general-knowledge.js";
import { TibiaLiveStatusService } from "../knowledge/tibia-live-status.js";
import { ObsPreviewFrameSource } from "../perception/obs-preview-frame-source.js";
import { KnowledgeStore } from "../knowledge/knowledge-store.js";
import { LiveDecisionStore } from "../decision/live-decision-store.js";
import {
  controlPaths,
  isDesiredState,
  isManagedProcess,
  MANAGED_PROCESSES,
  readControl,
  readStatus,
  supervisorOnline,
  writeControl
} from "../coordination/process-control.js";
import { parseSessionAnalyser } from "../telemetry/session-analyser-parser.js";
import { importCreatureAnimation } from "../knowledge/creature-animation-importer.js";
import { CreatureAnimationBatchJob } from "../knowledge/creature-animation-batch.js";
import { importItemAsset } from "../knowledge/item-asset-importer.js";
import { ItemAssetBatchJob } from "../knowledge/item-asset-batch.js";
import { fetchTibiaItemImageSources } from "../learning/tibia-game-catalog.js";

const MAX_JSON_BYTES = 1024 * 1024;
const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_FAILURES = 8;

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message);
  }
}

function httpError(statusCode: number, message: string): HttpError {
  return new HttpError(statusCode, message);
}

function statusCodeFor(error: unknown): number {
  if (error instanceof HttpError) return error.statusCode;
  if (error instanceof ValidationError) return 400;
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = String(error.code);
    if (code === "ER_DUP_ENTRY") return 409;
    if (["ER_NO_REFERENCED_ROW_2", "ER_TRUNCATED_WRONG_VALUE_FOR_FIELD", "ER_DATA_TOO_LONG"].includes(code)) {
      return 400;
    }
  }
  return 500;
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer"
  });
  response.end(JSON.stringify(payload));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let receivedBytes = 0;

  const declaredBytes = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredBytes) && declaredBytes > MAX_JSON_BYTES) {
    throw httpError(413, "JSON body exceeds the 1 MB limit.");
  }

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    receivedBytes += buffer.length;
    if (receivedBytes > MAX_JSON_BYTES) {
      request.resume();
      throw httpError(413, "JSON body exceeds the 1 MB limit.");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw httpError(400, "JSON body must be an object.");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw httpError(400, "JSON body is invalid.");
  }
}

function contentType(filePath: string): string {
  switch (extname(filePath)) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function isAllowedVideo(filename: string, mimeType: string): boolean {
  const extension = extname(filename).toLowerCase();
  return ["video/mp4", "video/x-matroska", "video/quicktime", "video/x-msvideo", "video/webm"].includes(mimeType) &&
    [".mp4", ".mkv", ".mov", ".avi", ".webm"].includes(extension);
}

function hasAllowedVideoSignature(filename: string, header: Buffer): boolean {
  const extension = extname(filename).toLowerCase();
  if (extension === ".mp4" || extension === ".mov") {
    return header.length >= 8 && header.subarray(4, 8).toString("ascii") === "ftyp";
  }
  if (extension === ".avi") {
    return header.length >= 12 && header.subarray(0, 4).toString("ascii") === "RIFF" &&
      header.subarray(8, 11).toString("ascii") === "AVI";
  }
  if (extension === ".mkv" || extension === ".webm") {
    return header.length >= 4 && header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  }
  return false;
}

function sanitizeFilename(filename: string): string {
  const safeBase = basename(filename).replace(/[^a-zA-Z0-9._-]/g, "_");
  return safeBase || "hunt-video.mp4";
}

export function createConfigServer(
  config: RuntimeConfig,
  pool: Pool,
  publicDir: string,
  storageDir: string,
  knowledgeDir = join(storageDir, "knowledge"),
  decisionLogPath = join(storageDir, "live-decisions.jsonl")
): Server {
  const repository = new ConfigurationRepository(pool, config.jwtSecret);
  const gameCatalogRepository = new GameCatalogRepository(pool);
  const tibiaLiveStatus = new TibiaLiveStatusService();
  const userRepository = new ConfigUserRepository(pool);
  const jwtService = new JwtService(config);
  const knowledgeStore = new KnowledgeStore(knowledgeDir);
  const liveDecisionStore = new LiveDecisionStore(decisionLogPath);
  const processControlPaths = controlPaths(decisionLogPath);
  let obsPreview: ObsPreviewFrameSource | null = null;
  let obsPreviewFingerprint = "";
  const creatureAnimationRoot = join(knowledgeDir, "creature-assets");
  const creatureAnimationBatch = new CreatureAnimationBatchJob(creatureAnimationRoot);
  const itemAssetRoot = join(knowledgeDir, "item-assets");
  const itemAssetBatch = new ItemAssetBatchJob(itemAssetRoot);
  const loginFailures = new Map<string, { count: number; resetAt: number }>();
  const dummyPasswordHash = bcrypt.hash(randomUUID(), 12);

  async function handleApi(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? "GET";
    const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const pathname = requestUrl.pathname;

    if (method === "POST" && pathname === "/api/auth/login") {
      sendJson(response, 200, await login(request, await readJson(request)));
      return;
    }

    const user = await authenticate(request);

    if (method === "GET" && pathname === "/api/auth/me") {
      sendJson(response, 200, { user });
      return;
    }

    if (method === "GET" && pathname === "/api/config") {
      requireRole(user, "viewer");
      sendJson(response, 200, await repository.getSnapshot());
      return;
    }

    if (method === "GET" && pathname === "/api/catalog/creatures") {
      requireRole(user, "viewer");
      const options = catalogSearchOptions(requestUrl);
      sendJson(response, 200, await gameCatalogRepository.searchCreatures(options.query, options.limit, options.offset));
      return;
    }

    if (method === "GET" && pathname === "/api/spell-icons") {
      requireRole(user, "viewer");
      sendJson(response, 200, await readSpellIconLinks());
      return;
    }

    if (method === "GET" && pathname === "/api/catalog/sprite") {
      requireRole(user, "viewer");
      const sprite = catalogSpritePath(
        requestUrl.searchParams.get("kind"),
        requestUrl.searchParams.get("id")
      );
      if (!sprite) throw httpError(400, "kind must be 'creature' or 'item' and id must be a slug.");
      const spriteStat = await stat(sprite.path).catch(() => null);
      if (!spriteStat?.isFile()) throw httpError(404, "Sprite was not found.");
      response.writeHead(200, {
        "Content-Type": sprite.type,
        // Imported assets are content-addressed by sha256 and never rewritten in place.
        "Cache-Control": "public, max-age=86400",
        "X-Content-Type-Options": "nosniff"
      });
      createReadStream(sprite.path).pipe(response);
      return;
    }

    if (method === "GET" && pathname === "/api/spell-icons/image") {
      requireRole(user, "viewer");
      const iconPath = await resolveSpellIconPath(requestUrl.searchParams.get("spell"));
      if (!iconPath) throw httpError(404, "Spell icon was not found.");
      const iconStat = await stat(iconPath).catch(() => null);
      if (!iconStat?.isFile()) throw httpError(404, "Spell icon was not found.");
      response.writeHead(200, {
        "Content-Type": "image/png",
        // The icons come out of an immutable client build, so they can be cached hard.
        "Cache-Control": "public, max-age=86400",
        "X-Content-Type-Options": "nosniff"
      });
      const iconStream = createReadStream(iconPath);
      iconStream.on("error", () => response.destroy());
      iconStream.pipe(response);
      return;
    }

    if (method === "GET" && pathname === "/api/catalog/items") {
      requireRole(user, "viewer");
      const options = catalogSearchOptions(requestUrl);
      sendJson(response, 200, await gameCatalogRepository.searchItems(options.query, options.limit, options.offset));
      return;
    }

    if (method === "POST" && pathname === "/api/creature-assets/import") {
      requireRole(user, "operator");
      const payload = await readJson(request);
      const race = typeof payload.race === "string" ? payload.race.trim().toLowerCase() : "";
      const fileTitle = typeof payload.fileTitle === "string" ? payload.fileTitle.trim() : undefined;
      if (!race) throw new ValidationError("race is required.");
      const creature = await gameCatalogRepository.findCreatureByRace(race);
      if (!creature) throw httpError(404, `Creature race "${race}" was not found in the catalog.`);
      const result = await importCreatureAnimation({
        root: creatureAnimationRoot,
        identity: {
          catalogId: creature.id,
          race: creature.race,
          name: creature.name,
          officialImageUrl: creature.imageUrl
        },
        fileTitle
      });
      sendJson(response, result.cached ? 200 : 201, result);
      return;
    }

    if (method === "POST" && pathname === "/api/creature-assets/import-all") {
      requireRole(user, "operator");
      const payload = await readJson(request);
      const delayMs = payload.delayMs === undefined ? 750 : Number(payload.delayMs);
      const limit = payload.limit === undefined ? null : Number(payload.limit);
      if (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 1_000)) {
        throw new ValidationError("limit must be an integer between 1 and 1000.");
      }
      const catalog = await gameCatalogRepository.listCreatureAnimationSources();
      const selected = limit === null ? catalog : catalog.slice(0, limit);
      const status = await creatureAnimationBatch.start(selected.map((creature) => ({
        catalogId: creature.id,
        race: creature.race,
        name: creature.name,
        officialImageUrl: creature.imageUrl
      })), delayMs);
      sendJson(response, 202, status);
      return;
    }

    if (method === "GET" && pathname === "/api/creature-assets/import-all/status") {
      requireRole(user, "viewer");
      const status = await creatureAnimationBatch.getStatus();
      sendJson(response, status ? 200 : 404, status ?? { error: "No creature animation import job was found." });
      return;
    }

    if (method === "POST" && pathname === "/api/item-assets/import") {
      requireRole(user, "operator");
      const payload = await readJson(request);
      const sourceId = Number(payload.sourceId);
      if (!Number.isSafeInteger(sourceId) || sourceId < 1) throw new ValidationError("sourceId is required.");
      const name = typeof payload.name === "string" && payload.name.trim() ? payload.name.trim() : `item ${sourceId}`;
      const result = await importItemAsset({ root: itemAssetRoot, identity: { sourceId, name } });
      sendJson(response, result.cached ? 200 : 201, result);
      return;
    }

    if (method === "POST" && pathname === "/api/item-assets/import-all") {
      requireRole(user, "operator");
      const payload = await readJson(request);
      const delayMs = payload.delayMs === undefined ? 120 : Number(payload.delayMs);
      const concurrency = payload.concurrency === undefined ? 4 : Number(payload.concurrency);
      const limit = payload.limit === undefined ? null : Number(payload.limit);
      if (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 10_000)) {
        throw new ValidationError("limit must be an integer between 1 and 10000.");
      }
      const catalog = await fetchTibiaItemImageSources(undefined, undefined, limit);
      const selected = limit === null ? catalog : catalog.slice(0, limit);
      const status = await itemAssetBatch.start(selected, delayMs, concurrency);
      sendJson(response, 202, status);
      return;
    }

    if (method === "GET" && pathname === "/api/item-assets/import-all/status") {
      requireRole(user, "viewer");
      const status = await itemAssetBatch.getStatus();
      sendJson(response, status ? 200 : 404, status ?? { error: "No item asset import job was found." });
      return;
    }

    if (method === "GET" && pathname === "/api/catalog/knowledge") {
      requireRole(user, "viewer");
      const options = catalogSearchOptions(requestUrl);
      const domain = (requestUrl.searchParams.get("domain") ?? "").trim() || null;
      if (domain && !TIBIA_KNOWLEDGE_DOMAINS.includes(domain as (typeof TIBIA_KNOWLEDGE_DOMAINS)[number])) {
        throw httpError(400, "Unknown Tibia knowledge domain.");
      }
      sendJson(response, 200, await gameCatalogRepository.searchKnowledge(options.query, domain, options.limit, options.offset));
      return;
    }

    if (method === "GET" && pathname === "/api/catalog/knowledge/coverage") {
      requireRole(user, "viewer");
      sendJson(response, 200, await gameCatalogRepository.knowledgeCoverage());
      return;
    }

    if (method === "GET" && pathname === "/api/catalog/live-status") {
      requireRole(user, "viewer");
      sendJson(response, 200, await tibiaLiveStatus.get());
      return;
    }

    if (method === "GET" && pathname === "/api/knowledge/coverage") {
      requireRole(user, "viewer");
      sendJson(response, 200, await knowledgeStore.coverage());
      return;
    }

    if (method === "GET" && pathname === "/api/knowledge/search") {
      requireRole(user, "viewer");
      const query = (requestUrl.searchParams.get("q") ?? "").trim();
      if (!query) throw httpError(400, "Knowledge search query is required.");
      if (query.length > 200) throw httpError(400, "Knowledge search query is limited to 200 characters.");
      const limit = Number(requestUrl.searchParams.get("limit") ?? 5);
      sendJson(response, 200, { query, results: await knowledgeStore.search(query, limit) });
      return;
    }

    if (method === "GET" && pathname === "/api/process-control") {
      requireRole(user, "viewer");
      const [control, status] = await Promise.all([
        readControl(processControlPaths.control),
        readStatus(processControlPaths.status)
      ]);
      sendJson(response, 200, {
        desired: control.desired,
        updatedAt: control.updatedAt,
        updatedBy: control.updatedBy,
        supervisorOnline: supervisorOnline(status),
        observed: status?.observed ?? null
      });
      return;
    }

    if (method === "POST" && pathname === "/api/process-control") {
      requireRole(user, "operator");
      const body = await readJson(request) as { process?: unknown; desired?: unknown };
      if (!isManagedProcess(body.process)) {
        throw httpError(400, `process must be one of: ${MANAGED_PROCESSES.join(", ")}.`);
      }
      if (!isDesiredState(body.desired)) throw httpError(400, "desired must be 'running' or 'stopped'.");
      const current = await readControl(processControlPaths.control);
      const next = {
        desired: { ...current.desired, [body.process]: body.desired },
        updatedAt: new Date().toISOString(),
        updatedBy: user.username
      };
      await writeControl(processControlPaths.control, next);
      // The supervisor picks this up on its next poll; the panel shows "aguardando"
      // until the status file confirms, so nothing here pretends the process is up.
      sendJson(response, 202, { desired: next.desired, updatedAt: next.updatedAt });
      return;
    }

    if (method === "GET" && pathname === "/api/decisions/stream") {
      requireRole(user, "viewer");
      const limit = Number(requestUrl.searchParams.get("limit") ?? 30);
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no"
      });

      let closed = false;
      let lastFingerprint = "";
      let lastSentAt = 0;

      /**
       * fs.watch is useless here: the log is written on the Windows host and read
       * through a Docker bind mount, which does not propagate change events into
       * the container. So the file is polled — but a stat is all it costs, and the
       * whole log is only parsed once the size or mtime actually moves.
       */
      const push = async (): Promise<void> => {
        if (closed) return;
        try {
          const info = await stat(decisionLogPath).catch(() => null);
          const fingerprint = info ? `${info.size}:${info.mtimeMs}` : "none";
          const stale = Date.now() - lastSentAt > 10_000;
          if (fingerprint === lastFingerprint && !stale) return;
          lastFingerprint = fingerprint;
          const snapshot = await liveDecisionStore.snapshot(limit, 5_000);
          lastSentAt = Date.now();
          response.write(`data: ${JSON.stringify(snapshot)}\n\n`);
        } catch {
          // A transient read error must not kill the stream; the next tick retries.
        }
      };

      const pushTimer = setInterval(() => void push(), 300);
      // Separate and slow: proxies drop an idle stream, but a comment is enough.
      const keepAliveTimer = setInterval(() => {
        if (!closed) response.write(": keep-alive\n\n");
      }, 20_000);
      const stop = (): void => {
        closed = true;
        clearInterval(pushTimer);
        clearInterval(keepAliveTimer);
      };
      request.on("close", stop);
      response.on("close", stop);
      await push();
      return;
    }

    if (method === "GET" && pathname === "/api/decisions/live") {
      requireRole(user, "viewer");
      const limit = Number(requestUrl.searchParams.get("limit") ?? 50);
      const activeWindowMs = 5_000;
      sendJson(response, 200, await liveDecisionStore.snapshot(limit, activeWindowMs));
      return;
    }

    if (method === "GET" && pathname === "/api/hunt-telemetry") {
      requireRole(user, "viewer");
      const characterValue = requestUrl.searchParams.get("characterId");
      const characterId = characterValue === null ? undefined : Number(characterValue);
      if (characterId !== undefined && (!Number.isSafeInteger(characterId) || characterId <= 0)) {
        throw httpError(400, "characterId must be a positive integer.");
      }
      sendJson(response, 200, { samples: await repository.listHuntTelemetry(characterId) });
      return;
    }

    if (method === "POST" && pathname === "/api/hunt-telemetry") {
      requireRole(user, "operator");
      sendJson(response, 201, await repository.createHuntTelemetry(await readJson(request)));
      return;
    }

    if (method === "POST" && pathname === "/api/hunt-telemetry/import-analyser") {
      requireRole(user, "operator");
      const payload = await readJson(request);
      if (typeof payload.rawText !== "string") throw httpError(400, "rawText is required.");
      const parsed = parseSessionAnalyser(payload.rawText);
      const telemetry = await repository.createHuntTelemetry({
        ...payload,
        ...parsed,
        creaturesJson: parsed.creatures,
        source: "session-analyser"
      });
      if (telemetry.runId !== null) {
        await repository.createCharacterRunSample({
          runId: telemetry.runId,
          sampleType: "telemetry",
          observedAt: telemetry.capturedAt,
          outcomeJson: telemetry,
          notes: "Hunting Session Analyser importado durante ou ao final da execução."
        });
      }
      sendJson(response, 201, telemetry);
      return;
    }

    if (method === "GET" && pathname === "/api/obs/preview") {
      requireRole(user, "viewer");
      try {
        const storedMachine = await repository.getMachineRuntimeConfig(config.nodeId);
        const previewConfig = storedMachine
          ? applyMachineRuntimeConfig(config, storedMachine.machine, storedMachine.runtime)
          : config;
        const fingerprint = `${previewConfig.obsWebSocketUrl}\n${previewConfig.obsSourceName}\n${previewConfig.obsWebSocketPassword}`;
        if (!obsPreview || fingerprint !== obsPreviewFingerprint) {
          await obsPreview?.disconnect();
          obsPreview = new ObsPreviewFrameSource(previewConfig);
          obsPreviewFingerprint = fingerprint;
        }
        const frame = await obsPreview.capturePreviewFrame();
        response.writeHead(200, {
          "Content-Type": frame.mimeType,
          "Cache-Control": "no-store, no-cache",
          "X-Frame-Width": String(frame.width),
          "X-Frame-Height": String(frame.height),
        });
        response.end(frame.data);
      } catch {
        sendJson(response, 503, { error: "OBS not available." });
      }
      return;
    }

    if (method === "POST" && pathname === "/api/accounts") {
      requireRole(user, "operator");
      sendJson(response, 201, await repository.createAccount(await readJson(request)));
      return;
    }

    if (method === "POST" && pathname === "/api/characters") {
      requireRole(user, "operator");
      sendJson(response, 201, await repository.createCharacter(await readJson(request)));
      return;
    }

    if (method === "POST" && pathname === "/api/machines") {
      requireRole(user, "operator");
      sendJson(response, 201, await repository.createMachine(await readJson(request)));
      return;
    }

    if (method === "POST" && pathname === "/api/hunts") {
      requireRole(user, "operator");
      sendJson(response, 201, await repository.createHunt(await readJson(request)));
      return;
    }

    if (method === "POST" && pathname === "/api/skills") {
      requireRole(user, "operator");
      sendJson(response, 201, await repository.createSkill(await readJson(request)));
      return;
    }

    if (method === "POST" && pathname === "/api/client-spell-bindings") {
      requireRole(user, "operator");
      sendJson(response, 201, await repository.createClientSpellBinding(await readJson(request)));
      return;
    }

    const machineUpdateMatch = pathname.match(/^\/api\/machines\/(\d+)$/);
    if (method === "POST" && machineUpdateMatch) {
      requireRole(user, "operator");
      sendJson(response, 200, await repository.updateMachine(Number(machineUpdateMatch[1]), await readJson(request)));
      return;
    }

    if (method === "GET" && pathname === "/api/character-runs") {
      requireRole(user, "viewer");
      sendJson(response, 200, { runs: await repository.listCharacterRuns(Number(requestUrl.searchParams.get("limit") ?? 100)) });
      return;
    }

    if (method === "POST" && pathname === "/api/character-runs/start") {
      requireRole(user, "operator");
      sendJson(response, 201, await repository.startCharacterRun(await readJson(request)));
      return;
    }

    const finishRunMatch = pathname.match(/^\/api\/character-runs\/(\d+)\/stop$/);
    if (method === "POST" && finishRunMatch) {
      requireRole(user, "operator");
      sendJson(response, 200, await repository.finishCharacterRun(Number(finishRunMatch[1]), await readJson(request)));
      return;
    }

    if (method === "GET" && pathname === "/api/character-run-samples") {
      requireRole(user, "viewer");
      const runId = Number(requestUrl.searchParams.get("runId"));
      if (!Number.isSafeInteger(runId) || runId <= 0) throw httpError(400, "runId must be a positive integer.");
      sendJson(response, 200, { samples: await repository.listCharacterRunSamples(runId, Number(requestUrl.searchParams.get("limit") ?? 200)) });
      return;
    }

    if (method === "POST" && pathname === "/api/character-run-samples") {
      requireRole(user, "operator");
      sendJson(response, 201, await repository.createCharacterRunSample(await readJson(request)));
      return;
    }

    if (method === "POST" && pathname === "/api/assignments") {
      requireRole(user, "operator");
      sendJson(response, 201, await repository.createAssignment(await readJson(request)));
      return;
    }

    const assignmentStatusMatch = pathname.match(/^\/api\/assignments\/(\d+)\/status$/);
    if (method === "POST" && assignmentStatusMatch) {
      requireRole(user, "operator");
      sendJson(response, 200, await repository.updateAssignmentStatus(Number(assignmentStatusMatch[1]), await readJson(request)));
      return;
    }

    if (method === "POST" && pathname === "/api/hunt-skill-rules") {
      requireRole(user, "operator");
      sendJson(response, 201, await repository.createHuntSkillRule(await readJson(request)));
      return;
    }

    if (method === "POST" && pathname === "/api/learning-methods") {
      requireRole(user, "operator");
      const payload = await readJson(request);
      if (payload.mode === "execute") requireRole(user, "admin");
      sendJson(response, 201, await repository.createLearningMethod(payload));
      return;
    }

    if (method === "POST" && pathname === "/api/learning-sources") {
      requireRole(user, "operator");
      const payload = await readJson(request);
      if (payload.trustLevel === "high" || payload.trustLevel === "verified") requireRole(user, "admin");
      sendJson(response, 201, await repository.createLearningSource(payload));
      return;
    }

    if (method === "POST" && pathname === "/api/learning-sources/upload-video") {
      requireRole(user, "operator");
      sendJson(response, 201, await uploadLearningVideo(request));
      return;
    }

    if (method === "POST" && pathname === "/api/learning-method-sources") {
      requireRole(user, "operator");
      sendJson(response, 201, await repository.createLearningMethodSource(await readJson(request)));
      return;
    }

    if (method === "POST" && pathname === "/api/learning-sessions") {
      requireRole(user, "operator");
      sendJson(response, 201, await repository.createLearningSession(await readJson(request)));
      return;
    }

    if (method === "POST" && pathname === "/api/learning-events") {
      requireRole(user, "operator");
      sendJson(response, 201, await repository.createLearningEvent(await readJson(request)));
      return;
    }

    if (method === "POST" && pathname === "/api/decision-feedback") {
      requireRole(user, "operator");
      sendJson(response, 201, await repository.createDecisionFeedback(await readJson(request)));
      return;
    }

    sendJson(response, 404, { error: "API route not found." });
  }

  async function login(request: IncomingMessage, payload: Record<string, unknown>): Promise<unknown> {
    const clientKey = request.socket.remoteAddress ?? "unknown";
    enforceLoginRateLimit(clientKey);
    const username = typeof payload.username === "string" ? payload.username.trim() : "";
    const password = typeof payload.password === "string" ? payload.password : "";

    if (!username || !password) {
      throw httpError(400, "Username and password are required.");
    }

    const user = await userRepository.findByUsername(username);
    if (!user || !user.enabled) {
      await bcrypt.compare(password, await dummyPasswordHash);
      recordLoginFailure(clientKey);
      throw httpError(401, "Invalid username or password.");
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      recordLoginFailure(clientKey);
      throw httpError(401, "Invalid username or password.");
    }

    loginFailures.delete(clientKey);
    await userRepository.markLogin(user.id);

    const safeUser: AuthenticatedConfigUser = {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role
    };

    return { token: jwtService.sign(safeUser), user: safeUser };
  }

  async function authenticate(request: IncomingMessage): Promise<AuthenticatedConfigUser> {
    const authorization = request.headers.authorization ?? "";
    const [scheme, token] = authorization.split(" ");

    if (scheme !== "Bearer" || !token) {
      throw httpError(401, "Missing Bearer token.");
    }

    try {
      const tokenUser = jwtService.verify(token);
      const currentUser = await userRepository.findById(tokenUser.id);
      if (!currentUser || !currentUser.enabled || currentUser.username !== tokenUser.username || currentUser.role !== tokenUser.role) {
        throw new Error("Token user is no longer authorized.");
      }
      return tokenUser;
    } catch {
      throw httpError(401, "Invalid or expired token.");
    }
  }

  function enforceLoginRateLimit(clientKey: string): void {
    const now = Date.now();
    const entry = loginFailures.get(clientKey);
    if (!entry || entry.resetAt <= now) {
      loginFailures.delete(clientKey);
      return;
    }
    if (entry.count >= MAX_LOGIN_FAILURES) {
      throw httpError(429, "Too many login attempts. Try again later.");
    }
  }

  function recordLoginFailure(clientKey: string): void {
    const now = Date.now();
    const current = loginFailures.get(clientKey);
    if (!current || current.resetAt <= now) {
      loginFailures.set(clientKey, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
      return;
    }
    current.count += 1;
  }

  interface SpellIconLink {
    readonly id: string;
    readonly name: string;
    readonly type: string;
    readonly group: string;
    readonly words: string | null;
    readonly source?: string | null;
    readonly iconIndex?: number;
    readonly spriteId?: number;
  }

  let spellIconCache: { mtimeMs: number; links: readonly SpellIconLink[]; byId: ReadonlyMap<string, SpellIconLink> } | null = null;

  // The grid fetches every icon individually right after loading the list, so an
  // uncached implementation would re-read and re-parse the links file hundreds of
  // times per page view. The mtime check keeps a re-run of the linking script visible.
  async function loadSpellIconLinks(): Promise<{ links: readonly SpellIconLink[]; byId: ReadonlyMap<string, SpellIconLink> }> {
    const path = join(knowledgeDir, "spell-icon-links.json");
    try {
      const mtimeMs = (await stat(path)).mtimeMs;
      if (spellIconCache?.mtimeMs !== mtimeMs) {
        const payload = JSON.parse(await readFile(path, "utf8")) as { links?: readonly SpellIconLink[] };
        const links = payload.links ?? [];
        spellIconCache = { mtimeMs, links, byId: new Map(links.map((link) => [link.id, link])) };
      }
      return spellIconCache;
    } catch {
      // The linking step is optional tooling; an unprepared install just has no icons.
      return { links: [], byId: new Map() };
    }
  }

  async function readSpellIconLinks(): Promise<{ links: readonly SpellIconLink[] }> {
    return { links: (await loadSpellIconLinks()).links };
  }

  /**
   * Maps a catalog entry to its imported sprite on disk.
   *
   * The identifier comes straight from the query string, so it is matched against
   * a strict whitelist rather than sanitised: creature folders are lowercase
   * alphanumeric race slugs and item folders are numeric source ids. Anything
   * with a separator, a dot or an accent is rejected outright, which is what keeps
   * `..` from ever reaching join().
   */
  function catalogSpritePath(kind: string | null, id: string | null): { path: string; type: string } | null {
    if (!id) return null;
    if (kind === "creature" && /^[a-z0-9]{1,64}$/.test(id)) {
      // The original GIF, not frames/001.png: it carries every frame and the
      // browser animates it natively, so one request replaces one per frame.
      return { path: join(knowledgeDir, "creature-assets", id, "source.gif"), type: "image/gif" };
    }
    if (kind === "item" && /^[0-9]{1,12}$/.test(id)) {
      return { path: join(knowledgeDir, "item-assets", id, "sprite.png"), type: "image/png" };
    }
    return null;
  }

  async function resolveSpellIconPath(spellId: string | null): Promise<string | null> {
    if (!spellId) return null;
    const link = (await loadSpellIconLinks()).byId.get(spellId);
    if (!link?.source) return null;
    // Both branches build the path from numbers, so a crafted id cannot escape the root.
    if (link.source === "client-atlas" && Number.isSafeInteger(link.iconIndex)) {
      const name = String(link.iconIndex).padStart(3, "0");
      return join(knowledgeDir, "client-spell-icons", "spell-icons-32x32", `${name}.png`);
    }
    if (link.source === "client-object" && Number.isSafeInteger(link.spriteId)) {
      const sprite = link.spriteId as number;
      const shard = String(Math.floor(sprite / 1000)).padStart(4, "0");
      return join(knowledgeDir, "client-sprites", shard, `${sprite}.png`);
    }
    return null;
  }

  function requireRole(user: AuthenticatedConfigUser, role: ConfigUserRole): void {
    if (!hasRole(user.role, role)) {
      throw httpError(403, `Role "${role}" is required.`);
    }
  }

  async function uploadLearningVideo(request: IncomingMessage): Promise<unknown> {
    await mkdir(storageDir, { recursive: true });

    return new Promise((resolvePromise, reject) => {
      const busboy = Busboy({ headers: request.headers, limits: { files: 1, fileSize: MAX_VIDEO_BYTES } });
      const fields: Record<string, string> = {};
      let storedPath: string | null = null;
      let originalFilename: string | null = null;
      let mimeType: string | null = null;
      let fileWrite: Promise<void> | null = null;
      let fileWriter: ReturnType<typeof createWriteStream> | null = null;
      let fileHash: ReturnType<typeof createHash> | null = null;
      let fileHeader = Buffer.alloc(0);
      let settled = false;

      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        request.unpipe(busboy);
        const partialPath = storedPath;
        if (fileWriter && !fileWriter.closed) {
          fileWriter.once("close", () => { void cleanupPartialFile(partialPath); });
          fileWriter.destroy();
          void fileWrite?.catch(() => undefined);
        } else {
          void cleanupPartialFile(partialPath);
        }
        reject(error);
      };

      busboy.on("field", (name, value) => { fields[name] = value; });

      busboy.on("file", (_name, file, info) => {
        originalFilename = info.filename;
        mimeType = info.mimeType;

        if (!isAllowedVideo(info.filename, info.mimeType)) {
          file.resume();
          fail(new ValidationError("Video format is not allowed. Use mp4, mkv, mov, avi or webm."));
          return;
        }

        const safeName = sanitizeFilename(info.filename);
        storedPath = join(storageDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}-${safeName}`);
        const writer = createWriteStream(storedPath);
        fileWriter = writer;
        fileHash = createHash("sha256");
        file.on("data", (chunk: Buffer) => {
          fileHash?.update(chunk);
          if (fileHeader.length < 12) fileHeader = Buffer.concat([fileHeader, chunk.subarray(0, 12 - fileHeader.length)]);
        });
        file.pipe(writer);
        fileWrite = new Promise((resolveWrite, rejectWrite) => {
          writer.on("finish", resolveWrite);
          writer.on("error", rejectWrite);
          file.on("error", rejectWrite);
          file.on("limit", () => { rejectWrite(new ValidationError("Video exceeds the 10 GB upload limit.")); });
        });
      });

      busboy.on("error", fail);

      busboy.on("finish", async () => {
        try {
          if (!storedPath || !fileWrite) throw new ValidationError("No video file was uploaded.");
          await fileWrite;

          if (!originalFilename || !hasAllowedVideoSignature(originalFilename, fileHeader)) {
            throw new ValidationError("Uploaded file content does not match the declared video format.");
          }
          if (!fileHash) throw new ValidationError("Unable to hash the uploaded video.");
          const source = await repository.createLearningSource({
            name: fields.name || originalFilename || basename(storedPath),
            sourceType: fields.sourceType || "video",
            uri: storedPath,
            contentHash: fileHash.digest("hex"),
            language: fields.language || null,
            status: "pending",
            trustLevel: "low",
            capturedAt: fields.capturedAt || null,
            metadataJson: JSON.stringify({ originalFilename, mimeType, hunt: fields.hunt || null, quest: fields.quest || null }),
            notes: fields.notes || null,
            enabled: true
          });

          if (settled) return;
          settled = true;
          resolvePromise(source);
        } catch (error) {
          fail(error);
        }
      });

      request.pipe(busboy);
      request.on("aborted", () => fail(new ValidationError("Upload was interrupted.")));
    });
  }

  async function serveStatic(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const pathname = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`).pathname;
    const requestedPath = pathname === "/" ? "/index.html" : pathname;
    const filePath = normalize(join(publicDir, requestedPath));

    if (!filePath.startsWith(publicDir)) {
      sendJson(response, 403, { error: "Forbidden." });
      return;
    }

    try {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) {
        sendJson(response, 404, { error: "File not found." });
        return;
      }
    } catch {
      sendJson(response, 404, { error: "File not found." });
      return;
    }

    response.writeHead(200, {
      "Content-Type": contentType(filePath),
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'self'; img-src 'self' data: blob:; connect-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'"
    });
    createReadStream(filePath).pipe(response);
  }

  return createServer(async (request, response) => {
    try {
      if (request.url?.startsWith("/api/")) {
        await handleApi(request, response);
        return;
      }
      await serveStatic(request, response);
    } catch (error) {
      const statusCode = statusCodeFor(error);
      const errorId = randomUUID();
      if (statusCode >= 500) console.error(`[${errorId}]`, error);
      sendJson(response, statusCode, {
        error: statusCode >= 500
          ? `Unexpected server error. Reference: ${errorId}`
          : error instanceof Error ? error.message : "Request failed."
      });
    }
  });
}

async function cleanupPartialFile(path: string | null): Promise<void> {
  if (!path) return;
  await unlink(path).catch(() => undefined);
}

function catalogSearchOptions(url: URL): { query: string; limit: number; offset: number } {
  const query = (url.searchParams.get("q") ?? "").trim();
  if (query.length > 100) throw httpError(400, "Catalog search query is limited to 100 characters.");
  const limit = Number(url.searchParams.get("limit") ?? 25);
  const offset = Number(url.searchParams.get("offset") ?? 0);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw httpError(400, "Catalog limit must be an integer between 1 and 100.");
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) {
    throw httpError(400, "Catalog offset must be a non-negative integer.");
  }
  return { query, limit, offset };
}
