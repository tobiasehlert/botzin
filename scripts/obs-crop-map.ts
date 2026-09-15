/** Add/update a crop filter on "Tibia Preview" so Botzin only sees the game map viewport.
 * Usage: npx tsx scripts/obs-crop-map.ts left top right bottom   (pixels cut from each edge) */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import OBSWebSocket from "obs-websocket-js";
const [left, top, right, bottom] = process.argv.slice(2, 6).map(Number);
const cfg = JSON.parse(readFileSync(join(process.env.APPDATA ?? "", "obs-studio/plugin_config/obs-websocket/config.json"), "utf8"));
const obs = new OBSWebSocket();
await obs.connect("ws://127.0.0.1:4455", cfg.server_password);
const { filters } = await obs.call("GetSourceFilterList", { sourceName: "Tibia Preview" });
const settings = { left, top, right, bottom, relative: true };
if (filters.some((f) => f.filterName === "Map crop")) {
  await obs.call("SetSourceFilterSettings", { sourceName: "Tibia Preview", filterName: "Map crop", filterSettings: settings });
} else {
  await obs.call("CreateSourceFilter", { sourceName: "Tibia Preview", filterName: "Map crop", filterKind: "crop_filter", filterSettings: settings });
}
const shot = await obs.call("GetSourceScreenshot", { sourceName: "Tibia Preview", imageFormat: "png" });
const png = Buffer.from(String(shot.imageData).split(",")[1], "base64");
console.log(JSON.stringify({ crop: settings, width: png.readUInt32BE(16), height: png.readUInt32BE(20) }));
await obs.disconnect();
