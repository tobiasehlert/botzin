import { createReadStream, existsSync, promises as fs } from "node:fs";
import { createServer } from "node:http";
import { extname, join, relative, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { inside } from "./path-inside.js";

const root = resolve(process.cwd());
const uiRoot = join(root, "annotation-ui");
const sourceRoot = join(root, "storage", "knowledge", "visual-training", "frames");
const outputRoot = join(root, "storage", "knowledge", "human-annotations");
const reviewCsv = join(root, "storage", "reviews", "deteccoes-500", "origens.csv");
const originalAssetRoots = [
  { root: join(root, "storage", "knowledge", "creature-assets"), classId: 0 },
  { root: join(root, "storage", "knowledge", "item-assets"), classId: 2 },
  { root: join(root, "storage", "knowledge", "effect-assets"), classId: 3 },
  { root: join(root, "storage", "knowledge", "missile-assets"), classId: 4 },
];
const port = Number(process.env.ANNOTATION_PORT ?? 4310);
const runFile = promisify(execFile);
const predictionModel = join(root, "models", "candidates", "tibia-human-annotations-experimental.pt");
const predictionScript = join(root, "scripts", "predict-annotation-frame.py");
const python = join(root, ".venv", "Scripts", "python.exe");
const predictionCache = new Map<number, unknown>();
const trainingScript = join(root, "scripts", "train-human-annotations.py");
const nextPredictionModel = join(root, "models", "candidates", "tibia-human-annotations-next.pt");
let training = false;
let trainingPending = false;
let trainingVersion = 0;
let trainingError = "";
const classes = [
  "creature_alive", "npc", "item", "effect", "missile", "character", "player",
  "health", "mana", "minimap", "battlelist", "skills", "level",
  "creature_corpse", "ignored_region", "stamina",
];
const itemCategories = [
  "weapon", "shield", "helmet", "armor", "legs", "boots", "amulet", "ring",
  "ammunition", "container", "consumable", "rune", "tool", "loot", "decoration", "quest", "other",
];

type Box = { classId: number; itemCategory?: string; x: number; y: number; width: number; height: number };
type Annotation = { source: string; width: number; height: number; ignored: boolean; reviewed: boolean; boxes: Box[] };

async function frameList() {
  if (existsSync(reviewCsv)) {
    const lines = (await fs.readFile(reviewCsv, "utf8")).replace(/^\uFEFF/, "").split(/\r?\n/).slice(1);
    return lines.filter(Boolean).map((line) => {
      const fields = line.match(/(?:^|,)("(?:[^"]|"")*"|[^,]*)/g)?.map((v) => v.replace(/^,/, "").replace(/^"|"$/g, "").replace(/""/g, '"')) ?? [];
      return fields[1];
    }).filter((value): value is string => Boolean(value && inside(sourceRoot, value)));
  }
  const found: string[] = [];
  async function walk(directory: string) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if ([".jpg", ".jpeg", ".png"].includes(extname(entry.name).toLowerCase())) found.push(path);
    }
  }
  await walk(sourceRoot);
  return found.sort().slice(0, 500);
}

function recordPath(index: number) { return join(outputRoot, "records", `${String(index).padStart(6, "0")}.json`); }
function labelPath(index: number) { return join(outputRoot, "labels", `${String(index).padStart(6, "0")}.txt`); }
function feedbackPath(index: number) { return join(outputRoot, "feedback", `${String(index).padStart(6, "0")}.jsonl`); }

async function readBody(request: Parameters<typeof createServer>[0] extends never ? never : any) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(response: any, status: number, value: unknown) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

// ponytail: single global lock serializes every prediction against the model swap;
// per-model locks only matter if we ever serve more than one model at a time.
let modelLock: Promise<unknown> = Promise.resolve();
function withModel<T>(action: () => Promise<T>): Promise<T> {
  const next = modelLock.then(action, action);
  modelLock = next.catch(() => {});
  return next;
}

function queueTraining() {
  if (training) { trainingPending = true; return; }
  training = true; trainingError = "";
  void (async () => {
    try {
      const baseModel = existsSync(predictionModel) ? predictionModel : "yolo11n.pt";
      await runFile(python, [trainingScript, "--epochs", "12", "--image-size", "640", "--batch", "2", "--device", "0", "--base-model", baseModel, "--output-model", nextPredictionModel], { timeout: 30 * 60 * 1000, maxBuffer: 20_000_000 });
      await withModel(() => fs.copyFile(nextPredictionModel, predictionModel));
      await fs.rm(nextPredictionModel, { force: true });
      predictionCache.clear(); trainingVersion++;
    } catch (error) { trainingError = error instanceof Error ? error.message : String(error); }
    finally {
      training = false;
      if (trainingPending) { trainingPending = false; queueTraining(); }
    }
  })();
}

const visualFrames = await frameList();
const originalAssets: { path: string; classId: number; entityName?: string }[] = [];
const creatureNameCache = new Map<string, string | undefined>();
async function officialCreatureName(folder: string) {
  if (creatureNameCache.has(folder)) return creatureNameCache.get(folder);
  try {
    const manifest = JSON.parse(await fs.readFile(join(originalAssetRoots[0].root, folder, "manifest.json"), "utf8"));
    const name = typeof manifest.name === "string" && manifest.name.trim() ? manifest.name.trim() : undefined;
    creatureNameCache.set(folder, name);
    return name;
  } catch {
    creatureNameCache.set(folder, undefined);
    return undefined;
  }
}
for (const asset of originalAssetRoots) {
  async function walkOriginal(directory: string) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walkOriginal(path);
      else if ([".png", ".jpg", ".jpeg", ".webp"].includes(extname(entry.name).toLowerCase())) {
        const firstFolder = relative(asset.root, path).split(sep)[0];
        const entityName = asset.classId === 0 ? await officialCreatureName(firstFolder) : undefined;
        originalAssets.push({ path, classId: asset.classId, entityName });
      }
    }
  }
  await walkOriginal(asset.root);
}
originalAssets.sort((a, b) => a.path.localeCompare(b.path));
const frames = [...visualFrames, ...originalAssets.map((asset) => asset.path)];
await fs.mkdir(join(outputRoot, "records"), { recursive: true });
await fs.mkdir(join(outputRoot, "labels"), { recursive: true });
await fs.mkdir(join(outputRoot, "feedback"), { recursive: true });
await fs.writeFile(join(outputRoot, "classes.json"), JSON.stringify(classes, null, 2) + "\n");

createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
    if (url.pathname === "/api/meta") {
      const recordNames = (await fs.readdir(join(outputRoot, "records"))).filter((name) => name.endsWith(".json"));
      const reviewedIndices = recordNames.map((name) => Number(name.replace(/\.json$/, ""))).filter(Number.isFinite);
      return json(response, 200, { total: frames.length, visualTotal: visualFrames.length, originalTotal: originalAssets.length, reviewed: reviewedIndices.length, reviewedIndices, classes, itemCategories, training: { active: training, pending: trainingPending, version: trainingVersion, error: trainingError } });
    }
    const frameMatch = url.pathname.match(/^\/api\/frames\/(\d+)$/);
    if (frameMatch && request.method === "GET") {
      const index = Number(frameMatch[1]);
      if (!frames[index]) return json(response, 404, { error: "Frame não encontrado" });
      let annotation: Annotation | null = null;
      try { annotation = JSON.parse(await fs.readFile(recordPath(index), "utf8")); } catch {}
      const original = index >= visualFrames.length ? originalAssets[index - visualFrames.length] : undefined;
      return json(response, 200, { index, source: frames[index], imageUrl: `/api/images/${index}`, annotation, entityName: original?.entityName });
    }
    if (frameMatch && request.method === "PUT") {
      const index = Number(frameMatch[1]);
      if (!frames[index]) return json(response, 404, { error: "Frame não encontrado" });
      const body = await readBody(request) as Annotation;
      const boxes = (body.boxes ?? []).filter((box) => classes[box.classId] && [box.x, box.y, box.width, box.height].every(Number.isFinite)).map((box) => ({
        ...box,
        itemCategory: box.classId === 2 && itemCategories.includes(box.itemCategory ?? "") ? box.itemCategory : undefined,
      }));
      const record: Annotation = { source: frames[index], width: body.width, height: body.height, ignored: Boolean(body.ignored), reviewed: true, boxes };
      await fs.writeFile(recordPath(index), JSON.stringify(record, null, 2) + "\n");
      const trainable = boxes.filter((box) => classes[box.classId] !== "ignored_region");
      const yolo = record.ignored ? "" : trainable.map((box) => `${box.classId} ${box.x.toFixed(6)} ${box.y.toFixed(6)} ${box.width.toFixed(6)} ${box.height.toFixed(6)}`).join("\n") + (trainable.length ? "\n" : "");
      await fs.writeFile(labelPath(index), yolo);
      queueTraining();
      return json(response, 200, { saved: true, trainingQueued: true });
    }
    if (url.pathname === "/api/training/status") return json(response, 200, { active: training, pending: trainingPending, version: trainingVersion, error: trainingError });
    const predictionMatch = url.pathname.match(/^\/api\/predictions\/(\d+)$/);
    if (predictionMatch && request.method === "GET") {
      const index = Number(predictionMatch[1]);
      if (!frames[index]) return json(response, 404, { error: "Frame não encontrado" });
      if (index >= visualFrames.length) {
        const asset = originalAssets[index - visualFrames.length];
        return json(response, 200, { suggestions: [{ classId: asset.classId, confidence: 1, entityName: asset.entityName, x: .5, y: .5, width: .94, height: .94 }] });
      }
      if (!existsSync(predictionModel)) return json(response, 503, { error: "Modelo de sugestões não encontrado" });
      if (predictionCache.has(index)) return json(response, 200, predictionCache.get(index));
      const { stdout } = await withModel(() => runFile(python, [predictionScript, frames[index], "--model", predictionModel], { timeout: 120000, maxBuffer: 10_000_000 }));
      const marker = stdout.split(/\r?\n/).find((line) => line.startsWith("PREDICTIONS_JSON="));
      if (!marker) throw new Error("A IA não retornou sugestões válidas");
      const predictions = JSON.parse(marker.slice("PREDICTIONS_JSON=".length));
      predictionCache.set(index, predictions);
      return json(response, 200, predictions);
    }
    const feedbackMatch = url.pathname.match(/^\/api\/feedback\/(\d+)$/);
    if (feedbackMatch && request.method === "POST") {
      const index = Number(feedbackMatch[1]);
      if (!frames[index]) return json(response, 404, { error: "Frame não encontrado" });
      const body = await readBody(request);
      const event = { timestamp: new Date().toISOString(), source: frames[index], ...body };
      await fs.appendFile(feedbackPath(index), JSON.stringify(event) + "\n", "utf8");
      return json(response, 200, { saved: true });
    }
    const imageMatch = url.pathname.match(/^\/api\/images\/(\d+)$/);
    if (imageMatch) {
      const path = frames[Number(imageMatch[1])];
      if (!path) return json(response, 404, { error: "Imagem não encontrada" });
      const allowedOriginal = originalAssetRoots.some((asset) => inside(asset.root, path));
      if (!inside(sourceRoot, path) && !allowedOriginal) return json(response, 404, { error: "Imagem não encontrada" });
      response.writeHead(200, { "content-type": extname(path).toLowerCase() === ".png" ? "image/png" : "image/jpeg" });
      return createReadStream(path).pipe(response);
    }
    const asset = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const file = join(uiRoot, asset);
    if (!inside(uiRoot, file) || !existsSync(file)) return json(response, 404, { error: "Não encontrado" });
    const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
    response.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(response);
  } catch (error) {
    json(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
}).listen(port, "127.0.0.1", () => console.log(`Anotador: http://127.0.0.1:${port}`));
