import type { GameEntity } from "../core/game-entity.js";
import type { EntityDetector } from "./entity-detector.js";
import type { FrameSource } from "./frame-source.js";
import type { ScreenFrame } from "../core/frame.js";
import type { CharacterOperationObservation } from "../decision/hunt-operation-policy.js";

export interface PerceptionResult {
  readonly sourceComputerId: string;
  readonly capturedAt: string;
  readonly entities: readonly GameEntity[];
  readonly frame: ScreenFrame;
  readonly operationObservation?: CharacterOperationObservation;
}

export class PerceptionPipeline {
  private nextFrame: Promise<ScreenFrame> | null = null;

  constructor(
    private readonly frameSource: FrameSource,
    private readonly detector: EntityDetector
  ) {}

  async inspectCurrentFrame(): Promise<PerceptionResult> {
    this.nextFrame ??= this.captureNextFrame();
    let frame: ScreenFrame;
    try {
      frame = await this.nextFrame;
    } catch (error) {
      // A failed prefetched promise must not poison every subsequent cycle.
      this.nextFrame = null;
      throw error;
    }
    // Capture the next frame while the detector processes this one. Only one
    // frame is prefetched, so stale frames never accumulate in a queue.
    this.nextFrame = this.captureNextFrame();
    // The ONNX detector already names each creature through the species
    // classifier, so the pipeline must not run it a second time.
    const entities = await this.detector.detect(frame);

    return {
      sourceComputerId: frame.sourceComputerId,
      capturedAt: frame.capturedAt,
      entities,
      frame
    };
  }

  private captureNextFrame(): Promise<ScreenFrame> {
    const pending = this.frameSource.captureFrame();
    // A slow detector may finish after a prefetched capture fails. Attach a
    // handler immediately; the original rejection is still observed next cycle.
    void pending.catch(() => undefined);
    return pending;
  }
}
