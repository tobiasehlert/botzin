import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { loadRuntimeConfig } from "../../src/config/runtime-config.js";

const obs = vi.hoisted(() => ({ call: vi.fn(), connect: vi.fn(), on: vi.fn(), disconnect: vi.fn() }));
vi.mock("obs-websocket-js", () => ({ default: class { call = obs.call; connect = obs.connect; on = obs.on; disconnect = obs.disconnect; } }));
import { ObsPreviewFrameSource } from "../../src/perception/obs-preview-frame-source.js";

async function screenshot(width: number, height: number, background: string) {
  const data = await sharp({ create: { width, height, channels: 3, background } }).png().toBuffer();
  obs.call.mockResolvedValue({ imageData: `data:image/png;base64,${data.toString("base64")}` });
}

describe("OBS frame validity", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects the 1x1 placeholder instead of sending it to the detector", async () => {
    await screenshot(1, 1, "black");
    await expect(new ObsPreviewFrameSource(loadRuntimeConfig()).captureFrame()).rejects.toThrow("invalid frame");
  });

  it("rejects an all-black screenshot even when OBS scales it to capture size", async () => {
    await screenshot(640, 480, "black");
    await expect(new ObsPreviewFrameSource(loadRuntimeConfig()).captureFrame()).rejects.toThrow("black frame");
  });

  it("accepts visible image content", async () => {
    await screenshot(64, 64, "#825034");
    await expect(new ObsPreviewFrameSource(loadRuntimeConfig()).captureFrame()).resolves.toMatchObject({ width: 64, height: 64 });
  });
});
