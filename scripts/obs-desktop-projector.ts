/** Open the OBS source as a resizable desktop window (no recording or streaming). */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import OBSWebSocket from "obs-websocket-js";

const settings = JSON.parse(readFileSync(join(process.env.APPDATA ?? "", "obs-studio/plugin_config/obs-websocket/config.json"), "utf8"));
const obs = new OBSWebSocket();
try {
  await obs.connect("ws://127.0.0.1:4455", settings.server_password);
  await obs.call("OpenSourceProjector", { sourceName: "Tibia Preview", monitorIndex: -1 });
  console.log("Janela de projeção do OBS aberta.");
} finally {
  await obs.disconnect();
}
