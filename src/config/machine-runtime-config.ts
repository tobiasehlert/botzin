import type { BotMachine, MachineRuntimeConfig, MachineRuntimeConfigWithSecret } from "../core/bot-configuration.js";
import type { RuntimeConfig } from "./runtime-config.js";

export const DEFAULT_MACHINE_RUNTIME_CONFIG: MachineRuntimeConfig = {
  coordinatorHost: "127.0.0.1",
  coordinatorPort: 4573,
  networkBindHost: "0.0.0.0",
  networkPreferredKinds: ["ethernet", "wifi"],
  networkAdvertiseHosts: [],
  obsWebSocketUrl: "ws://127.0.0.1:4455",
  obsSourceName: "Tibia Preview",
  frameSource: "mock",
  obsProcessName: "obs64.exe",
  tibiaProcessName: "client.exe",
  tibiaSourceName: "Tibia",
  // 2x the 320px detector input: the detector letterboxes down to 320 anyway,
  // while the species classifier crops creature patches from the same frame and
  // benefits from the extra detail.
  obsCaptureWidth: 640,
  detector: "mock",
  onnxModelPath: "models/candidates/tibia-entities-five.onnx",
  onnxLabelsPath: "models/candidates/tibia-entities-five.labels.json",
  onnxInputWidth: 320,
  onnxInputHeight: 320,
  detectionConfidence: 0.35,
  detectionIou: 0.45,
  raspberryHost: "127.0.0.1",
  raspberryPort: 4574,
  runFrameIntervalMs: 10_000
};

export function applyMachineRuntimeConfig(
  bootstrap: RuntimeConfig,
  machine: BotMachine,
  runtime: MachineRuntimeConfigWithSecret
): RuntimeConfig {
  return {
    ...bootstrap,
    nodeId: machine.nodeId,
    role: machine.role === "coordinator" || machine.role === "raspberry-executor" ? machine.role : "perception",
    ...runtime
  };
}
