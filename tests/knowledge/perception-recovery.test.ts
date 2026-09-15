import { describe, expect, it, vi } from "vitest";
import { PerceptionPipeline } from "../../src/perception/perception-pipeline.js";
import type { ScreenFrame } from "../../src/core/frame.js";

describe("perception capture recovery", () => {
  it("retries capture after OBS becomes available again", async () => {
    const frame: ScreenFrame = { id: "recovered", sourceComputerId: "pc", source: "obs-preview", capturedAt: new Date().toISOString(), width: 640, height: 480, data: Buffer.alloc(0), mimeType: "image/jpeg" };
    const captureFrame = vi.fn().mockRejectedValueOnce(new Error("OBS offline")).mockResolvedValue(frame);
    const detect = vi.fn().mockResolvedValue([]);
    const pipeline = new PerceptionPipeline({ name: "obs", captureFrame }, { name: "test", detect });
    await expect(pipeline.inspectCurrentFrame()).rejects.toThrow("OBS offline");
    expect(detect).not.toHaveBeenCalled();
    await expect(pipeline.inspectCurrentFrame()).resolves.toMatchObject({ frame });
    expect(detect).toHaveBeenCalledWith(frame);
  });
});
