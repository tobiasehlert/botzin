import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import * as ort from "onnxruntime-node";
import sharp from "sharp";
import type { RuntimeConfig } from "../config/runtime-config.js";
import { isGameEntityKind } from "../core/game-entity.js";
import type { BoundingBox, GameEntity, GameEntityKind } from "../core/game-entity.js";
import type { ScreenFrame } from "../core/frame.js";
import type { EntityDetector } from "./entity-detector.js";
import { CreatureSpeciesClassifier } from "./creature-species-classifier.js";

interface ModelLabel {
  readonly id: number;
  readonly kind: GameEntityKind;
  readonly label: string;
}

interface Candidate {
  readonly kind: GameEntityKind;
  readonly label: string;
  readonly confidence: number;
  readonly box: BoundingBox;
}

/**
 * Maps model-input pixel coordinates back to the original frame. `scale` is the
 * uniform resize factor and `padX`/`padY` are the letterbox borders (in model pixels).
 */
interface LetterboxTransform {
  readonly scale: number;
  readonly padX: number;
  readonly padY: number;
}

export class OnnxEntityDetector implements EntityDetector {
  readonly name = "onnx-local-vision";
  private sessionPromise: Promise<ort.InferenceSession> | null = null;
  private labelsPromise: Promise<readonly ModelLabel[]> | null = null;
  private readonly creatureClassifier = new CreatureSpeciesClassifier();

  constructor(private readonly config: RuntimeConfig) {}

  async detect(frame: ScreenFrame): Promise<readonly GameEntity[]> {
    const [session, labels] = await Promise.all([this.getSession(), this.getLabels()]);
    const { tensor: input, transform } = await this.prepareInput(frame);
    const inputName = session.inputNames[0];
    const output = await session.run({ [inputName]: input });
    const outputTensor = output[session.outputNames[0]];

    if (!outputTensor) {
      throw new Error("ONNX model did not return an output tensor.");
    }

    const entities = this.parseDetections(outputTensor, labels, frame, transform).map((candidate) => ({
      id: randomUUID(),
      kind: candidate.kind,
      confidence: candidate.confidence,
      box: candidate.box,
      label: candidate.label,
      sourceComputerId: frame.sourceComputerId,
      observedAt: new Date().toISOString()
    }));
    return this.creatureClassifier.identify(frame, entities);
  }

  private getSession(): Promise<ort.InferenceSession> {
    this.sessionPromise ??= this.createSession();
    return this.sessionPromise;
  }

  private async createSession(): Promise<ort.InferenceSession> {
    const modelPath = resolve(this.config.onnxModelPath);
    await access(modelPath).catch(() => {
      throw new Error(
        `ONNX model not found at "${modelPath}". Train/export a Tibia entity model ` +
        `and point the machine to it in the web panel (Entidades > modelo ONNX).`
      );
    });
    return ort.InferenceSession.create(modelPath);
  }

  private getLabels(): Promise<readonly ModelLabel[]> {
    this.labelsPromise ??= this.loadLabels();
    return this.labelsPromise;
  }

  private async loadLabels(): Promise<readonly ModelLabel[]> {
    const labelsPath = resolve(this.config.onnxLabelsPath);
    const raw = await readFile(labelsPath, "utf8").catch(() => {
      throw new Error(`ONNX labels not found at "${labelsPath}". Create a labels JSON file matching the model classes.`);
    });
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error(`ONNX labels file "${labelsPath}" must contain a JSON array of {id, kind, label} entries.`);
    }
    return parsed.map((entry): ModelLabel => {
      const record = entry as { id?: unknown; kind?: unknown; label?: unknown };
      if (typeof record.id !== "number" || typeof record.label !== "string") {
        throw new Error(`ONNX labels file "${labelsPath}" has an entry without a numeric "id" and string "label".`);
      }
      if (!isGameEntityKind(record.kind)) {
        // A labels file from an older training run can carry per-species class
        // names; degrading to "unknown" keeps detection running instead of
        // corrupting every consumer that switches on the kind.
        console.warn(
          `[onnx-entity-detector] labels file "${labelsPath}" maps class ${record.id} ("${record.label}") ` +
          `to invalid kind "${String(record.kind)}"; treating it as "unknown". Retrain to regenerate the labels file.`
        );
        return { id: record.id, kind: "unknown", label: record.label };
      }
      return { id: record.id, kind: record.kind, label: record.label };
    });
  }

  private async prepareInput(frame: ScreenFrame): Promise<{ tensor: ort.Tensor; transform: LetterboxTransform }> {
    const modelWidth = this.config.onnxInputWidth;
    const modelHeight = this.config.onnxInputHeight;

    // Letterbox: preserve aspect ratio and pad to the model size, matching how YOLO
    // models are typically trained. Stretching ("fill") distorts geometry and accuracy.
    const scale = Math.min(modelWidth / frame.width, modelHeight / frame.height);
    const resizedWidth = Math.round(frame.width * scale);
    const resizedHeight = Math.round(frame.height * scale);
    const padX = Math.floor((modelWidth - resizedWidth) / 2);
    const padY = Math.floor((modelHeight - resizedHeight) / 2);

    const { data, info } = await sharp(frame.data)
      .resize(resizedWidth, resizedHeight, { fit: "fill" })
      .extend({
        top: padY,
        bottom: modelHeight - resizedHeight - padY,
        left: padX,
        right: modelWidth - resizedWidth - padX,
        background: { r: 114, g: 114, b: 114 }
      })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const channels = info.channels;
    const planeSize = info.width * info.height;
    const input = new Float32Array(channels * planeSize);

    for (let index = 0; index < planeSize; index += 1) {
      input[index] = data[index * channels] / 255;
      input[index + planeSize] = data[index * channels + 1] / 255;
      input[index + planeSize * 2] = data[index * channels + 2] / 255;
    }

    return {
      tensor: new ort.Tensor("float32", input, [1, 3, info.height, info.width]),
      transform: { scale, padX, padY }
    };
  }

  private parseDetections(
    tensor: ort.Tensor,
    labels: readonly ModelLabel[],
    frame: ScreenFrame,
    transform: LetterboxTransform
  ): readonly Candidate[] {
    const data = tensor.data as Float32Array;
    const dims = tensor.dims;
    const rows = normalizeRows(data, dims, labels.length);
    const candidates = rows
      .map((row) => this.rowToCandidate(row, labels, frame, transform))
      .filter((candidate): candidate is Candidate => candidate !== null)
      .sort((left, right) => right.confidence - left.confidence);

    return nonMaxSuppression(candidates, this.config.detectionIou);
  }

  private rowToCandidate(
    row: readonly number[],
    labels: readonly ModelLabel[],
    frame: ScreenFrame,
    transform: LetterboxTransform
  ): Candidate | null {
    const hasObjectness = row.length >= labels.length + 5;
    const classOffset = hasObjectness ? 5 : 4;
    const classScores = row.slice(classOffset, classOffset + labels.length);
    let classId = 0;
    let classScore = Number.NEGATIVE_INFINITY;

    for (let index = 0; index < classScores.length; index += 1) {
      if (classScores[index] > classScore) {
        classScore = classScores[index];
        classId = index;
      }
    }

    const objectness = hasObjectness ? row[4] : 1;
    const confidence = classScore * objectness;

    if (confidence < this.config.detectionConfidence) {
      return null;
    }

    const label = labels.find((entry) => entry.id === classId) ?? {
      id: classId,
      kind: "unknown" as const,
      label: `class-${classId}`
    };

    return {
      kind: label.kind,
      label: label.label,
      confidence,
      box: mapBoxFromModel(
        row[0],
        row[1],
        row[2],
        row[3],
        frame,
        transform,
        this.config.onnxInputWidth,
        this.config.onnxInputHeight
      )
    };
  }
}

function normalizeRows(data: Float32Array, dims: readonly number[], labelCount: number): readonly (readonly number[])[] {
  if (dims.length !== 3 || dims[0] !== 1) {
    throw new Error(`Unsupported ONNX output shape: [${dims.join(", ")}]. Expected YOLO-style [1, N, C] or [1, C, N].`);
  }

  const second = dims[1];
  const third = dims[2];
  const channelCount = labelCount + 4;
  const channelCountWithObjectness = labelCount + 5;
  const rows: number[][] = [];

  // Prefer an exact channel dimension before applying the generic fallback.
  // YOLO11 exports [1, 4 + classes, anchors], while some YOLOv5/v8 exports use
  // [1, anchors, 4/5 + classes]. Large class counts can make both dimensions
  // exceed channelCount, so checking only ">=" chooses the wrong orientation.
  if (third === channelCount || third === channelCountWithObjectness) {
    for (let row = 0; row < second; row += 1) {
      const offset = row * third;
      rows.push(Array.from(data.slice(offset, offset + third)));
    }
    return rows;
  }

  if (second === channelCount || second === channelCountWithObjectness) {
    for (let row = 0; row < third; row += 1) {
      const values: number[] = [];
      for (let channel = 0; channel < second; channel += 1) {
        values.push(data[channel * third + row]);
      }
      rows.push(values);
    }
    return rows;
  }

  if (third >= channelCount) {
    for (let row = 0; row < second; row += 1) {
      const offset = row * third;
      rows.push(Array.from(data.slice(offset, offset + third)));
    }
    return rows;
  }

  if (second >= channelCount) {
    for (let row = 0; row < third; row += 1) {
      const values: number[] = [];
      for (let channel = 0; channel < second; channel += 1) values.push(data[channel * third + row]);
      rows.push(values);
    }
    return rows;
  }

  throw new Error(`Unsupported ONNX output shape: [${dims.join(", ")}].`);
}

function mapBoxFromModel(
  centerX: number,
  centerY: number,
  width: number,
  height: number,
  frame: ScreenFrame,
  transform: LetterboxTransform,
  modelWidth: number,
  modelHeight: number
): BoundingBox {
  // Some exports emit normalized coordinates in [0, 1]; convert them to model pixels first.
  const normalized = centerX <= 1 && centerY <= 1 && width <= 1 && height <= 1;
  const modelCenterX = normalized ? centerX * modelWidth : centerX;
  const modelCenterY = normalized ? centerY * modelHeight : centerY;
  const modelW = normalized ? width * modelWidth : width;
  const modelH = normalized ? height * modelHeight : height;

  // Undo the letterbox: remove padding, then divide by the resize scale.
  const x = (modelCenterX - modelW / 2 - transform.padX) / transform.scale;
  const y = (modelCenterY - modelH / 2 - transform.padY) / transform.scale;
  const boxWidth = modelW / transform.scale;
  const boxHeight = modelH / transform.scale;

  const clampedX = clamp(Math.round(x), 0, frame.width);
  const clampedY = clamp(Math.round(y), 0, frame.height);

  return {
    x: clampedX,
    y: clampedY,
    width: clamp(Math.round(boxWidth), 0, frame.width - clampedX),
    height: clamp(Math.round(boxHeight), 0, frame.height - clampedY)
  };
}

function nonMaxSuppression(candidates: readonly Candidate[], threshold: number): readonly Candidate[] {
  const selected: Candidate[] = [];

  for (const candidate of candidates) {
    if (selected.every((entry) => iou(entry.box, candidate.box) <= threshold)) {
      selected.push(candidate);
    }
  }

  return selected;
}

function iou(left: BoundingBox, right: BoundingBox): number {
  const x1 = Math.max(left.x, right.x);
  const y1 = Math.max(left.y, right.y);
  const x2 = Math.min(left.x + left.width, right.x + right.width);
  const y2 = Math.min(left.y + left.height, right.y + right.height);
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = left.width * left.height + right.width * right.height - intersection;
  return union === 0 ? 0 : intersection / union;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
