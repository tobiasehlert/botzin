/**
 * Auto-labelled detector dataset from the local OT world.
 *
 * Every tick: grab the OBS "Tibia Preview" frame (cropped to the game viewport, 15x11 tiles)
 * and read local-ot/training/io/state.txt, whose `creatures` list gives exact tile offsets of
 * every monster/NPC/player on screen. Each one becomes a YOLO box; the own character is a
 * "player" box at the centre tile. Output is an Ultralytics dataset:
 *   storage/datasets/local-ot/{images,labels}/{train,val} + data.yaml
 *
 * Run while something moves the Knight around (trainer in arena or explore mode):
 *   npx tsx scripts/local-ot-collect-dataset.ts --frames 600 --interval 700
 *
 * ponytail: boxes are "one tile plus margin"; refine with sprite offsets if mAP stalls.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import OBSWebSocket from "obs-websocket-js";

const CLASSES = ["creature", "npc", "player"];
const VIEW_TILES_X = 15;
const VIEW_TILES_Y = 11;
const BOX_SCALE = 1.25; // sprites overflow their tile a little (up/left)
const ROOT = join(import.meta.dirname, "..");
const STATE = join(ROOT, "local-ot", "training", "io", "state.txt");
const OUT = join(ROOT, "storage", "datasets", "local-ot");

const args = process.argv.slice(2);
const opt = (name: string, fallback: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const maxFrames = opt("frames", 500);
const intervalMs = opt("interval", 700);

for (const split of ["train", "val"]) {
  mkdirSync(join(OUT, "images", split), { recursive: true });
  mkdirSync(join(OUT, "labels", split), { recursive: true });
}
writeFileSync(join(OUT, "data.yaml"), `path: ${OUT.replace(/\\/g, "/")}\ntrain: images/train\nval: images/val\nnames:\n${CLASSES.map((c, i) => `  ${i}: ${c}`).join("\n")}\n`);

const wsConfig = JSON.parse(readFileSync(join(process.env.APPDATA ?? "", "obs-studio/plugin_config/obs-websocket/config.json"), "utf8"));
const obs = new OBSWebSocket();
await obs.connect("ws://127.0.0.1:4455", wsConfig.server_password);

let saved = readdirSync(join(OUT, "images", "train")).length + readdirSync(join(OUT, "images", "val")).length;
let lastKey = "";
const startedWith = saved;
console.log(JSON.stringify({ out: OUT, existing: saved, target: maxFrames }));

while (saved - startedWith < maxFrames) {
  await new Promise((r) => setTimeout(r, intervalMs));
  let state: any;
  try {
    state = JSON.parse(readFileSync(STATE, "utf8"));
  } catch {
    continue;
  }
  if (!state.online) continue;
  const visible = (state.creatures ?? []).filter((c: any) => c.z === state.z && Math.abs(c.x - state.x) <= 7 && Math.abs(c.y - state.y) <= 5);
  const key = `${state.x},${state.y},${state.z}|` + visible.map((c: any) => `${c.kind}${c.x},${c.y}`).join(";");
  if (key === lastKey) continue; // nothing moved since the last saved frame

  let png: Buffer;
  try {
    const shot = await obs.call("GetSourceScreenshot", { sourceName: "Tibia Preview", imageFormat: "png" });
    png = Buffer.from(String(shot.imageData).split(",")[1], "base64");
  } catch {
    continue;
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  // OBS can emit a 1x1 placeholder while its window source is unavailable.
  // Do not save fabricated boxes for that image, or suppress a later retry.
  if (width < VIEW_TILES_X * 8 || height < VIEW_TILES_Y * 8) continue;
  const tileW = width / VIEW_TILES_X;
  const tileH = height / VIEW_TILES_Y;
  const boxes: string[] = [];
  const add = (cls: number, dx: number, dy: number) => {
    const cx = (VIEW_TILES_X / 2 + dx) * tileW;  // player tile is the centre tile (index 7)
    const cy = (VIEW_TILES_Y / 2 + dy) * tileH;
    const w = tileW * BOX_SCALE;
    const h = tileH * BOX_SCALE;
    // sprites are drawn offset up-left, so shift the box a quarter tile that way
    boxes.push(`${cls} ${((cx - tileW * 0.15) / width).toFixed(5)} ${((cy - tileH * 0.15) / height).toFixed(5)} ${(w / width).toFixed(5)} ${(h / height).toFixed(5)}`);
  };
  add(CLASSES.indexOf("player"), 0, 0);
  for (const c of visible) add(CLASSES.indexOf(c.kind), c.x - state.x, c.y - state.y);

  const split = saved % 5 === 0 ? "val" : "train";
  const name = `frame-${Date.now()}`;
  writeFileSync(join(OUT, "images", split, `${name}.png`), png);
  writeFileSync(join(OUT, "labels", split, `${name}.txt`), boxes.join("\n") + "\n");
  lastKey = key;
  saved += 1;
  if (saved % 25 === 0) console.log(JSON.stringify({ saved, lastBoxes: boxes.length, frame: `${width}x${height}` }));
}
await obs.disconnect();
console.log(JSON.stringify({ done: true, saved }));
