import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { loadRuntimeConfig } from "../src/config/runtime-config.js";
import { applyMachineRuntimeConfig } from "../src/config/machine-runtime-config.js";
import { createMysqlPool } from "../src/database/mysql-pool.js";
import { ConfigurationRepository } from "../src/database/configuration-repository.js";
import { OnnxEntityDetector } from "../src/perception/onnx-entity-detector.js";

const bootstrap = loadRuntimeConfig();
const pool = createMysqlPool(bootstrap);
try {
  const stored = await new ConfigurationRepository(pool, bootstrap.jwtSecret).getMachineRuntimeConfig(bootstrap.nodeId);
  if (!stored) throw new Error("Máquina não configurada");
  const config = applyMachineRuntimeConfig(bootstrap, stored.machine, stored.runtime);
  console.log(JSON.stringify({ model: config.onnxModelPath, labels: config.onnxLabelsPath, threshold: config.detectionConfidence, input: [config.onnxInputWidth, config.onnxInputHeight] }));
  const snapshot = JSON.parse(await readFile("storage/desktop-monitor.json", "utf8"));
  const original = Buffer.from(snapshot.image, "base64");
  const roi = process.argv.slice(2).map(Number);
  const cases = [{ name: "full", data: original }];
  if (roi.length === 4) cases.push({ name: "map", data: await sharp(original).extract({ left: roi[0], top: roi[1], width: roi[2], height: roi[3] }).toBuffer() });
  const detector = new OnnxEntityDetector({ ...config, detectionConfidence: 0.05 });
  for (const sample of cases) {
    const meta = await sharp(sample.data).metadata();
    const entities = await detector.detect({ id: snapshot.decision.frame.id, sourceComputerId: config.nodeId, source: "obs-preview", capturedAt: snapshot.capturedAt, width: meta.width!, height: meta.height!, data: sample.data, mimeType: "image/jpeg" });
    console.log(JSON.stringify({ case: sample.name, capturedAt: snapshot.capturedAt, detections: entities.map(e => ({ kind: e.kind, label: e.label, confidence: e.confidence, box: e.box })) }));
  }
} finally {
  await pool.end();
}
