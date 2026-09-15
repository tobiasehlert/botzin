/** Run a saved frame through the same detector used by the live agent. */
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { loadRuntimeConfig } from "../src/config/runtime-config.js";
import { OnnxEntityDetector } from "../src/perception/onnx-entity-detector.js";

const [model, labels, inputSize, imagePath] = process.argv.slice(2);
if (!model || !labels || !imagePath || !Number.isInteger(Number(inputSize)) || Number(inputSize) <= 0) {
  throw new Error("Usage: tsx scripts/check-onnx-frame.ts model.onnx labels.json inputSize image.png");
}
const data = await readFile(imagePath);
const meta = await sharp(data).metadata();
const detector = new OnnxEntityDetector({ ...loadRuntimeConfig(), detector: "onnx", onnxModelPath: model, onnxLabelsPath: labels, onnxInputWidth: Number(inputSize), onnxInputHeight: Number(inputSize), detectionConfidence: 0.25 });
const entities = await detector.detect({ id: "offline-validation", sourceComputerId: "offline", source: "file", capturedAt: new Date().toISOString(), width: meta.width!, height: meta.height!, data, mimeType: "image/png" });
console.log(JSON.stringify({ imagePath, model, entities: entities.map(e => ({ kind: e.kind, label: e.label, confidence: e.confidence, box: e.box })) }));
