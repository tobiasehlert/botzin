/**
 * Ensure OBS has a "Botzin" scene with a "Tibia Preview" window capture of the OTClient,
 * and make it the current scene. Idempotent. Run with: npx tsx scripts/obs-setup-otclient.ts
 * Uses the obs-websocket password from the OBS plugin config (local machine only).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import OBSWebSocket from "obs-websocket-js";

const SCENE = "Botzin";
const SOURCE = "Tibia Preview";
const WINDOW_EXE = "otclient.exe";

const wsConfig = JSON.parse(readFileSync(join(process.env.APPDATA ?? "", "obs-studio/plugin_config/obs-websocket/config.json"), "utf8"));
const obs = new OBSWebSocket();
await obs.connect("ws://127.0.0.1:4455", wsConfig.server_password);

const { scenes } = await obs.call("GetSceneList");
if (!scenes.some((scene) => scene.sceneName === SCENE)) {
  await obs.call("CreateScene", { sceneName: SCENE });
}

const { inputs } = await obs.call("GetInputList");
if (!inputs.some((input) => input.inputName === SOURCE)) {
  await obs.call("CreateInput", { sceneName: SCENE, inputName: SOURCE, inputKind: "window_capture", inputSettings: {} });
}

const { propertyItems } = await obs.call("GetInputPropertiesListPropertyItems", { inputName: SOURCE, propertyName: "window" });
const item = propertyItems.find((entry) => String(entry.itemValue).toLowerCase().endsWith(WINDOW_EXE));
if (!item) {
  console.error(propertyItems.map((entry) => entry.itemValue).join("\n"));
  throw new Error(`No window from ${WINDOW_EXE} found; is the OTClient open?`);
}
await obs.call("SetInputSettings", { inputName: SOURCE, inputSettings: { window: item.itemValue, capture_cursor: false, method: 2 /* WGC */ } });
await obs.call("SetCurrentProgramScene", { sceneName: SCENE });

const shot = await obs.call("GetSourceScreenshot", { sourceName: SOURCE, imageFormat: "png", imageWidth: 640 });
console.log(JSON.stringify({ scene: SCENE, source: SOURCE, window: item.itemValue, screenshotBytes: String(shot.imageData).length }));
await obs.disconnect();
