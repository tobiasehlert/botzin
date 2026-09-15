import type { RuntimeConfig } from "../config/runtime-config.js";
import type { ScreenFrame } from "../core/frame.js";
import type { FrameSource } from "./frame-source.js";
import OBSWebSocket from "obs-websocket-js";
import sharp from "sharp";
import { randomUUID } from "node:crypto";

export class ObsPreviewFrameSource implements FrameSource {
  readonly name = "obs-preview";
  private readonly obs = new OBSWebSocket();
  private connected = false;
  private connecting: Promise<void> | null = null;

  constructor(private readonly config: RuntimeConfig) {
    // When OBS drops or errors, mark ourselves disconnected so the next capture reconnects.
    this.obs.on("ConnectionClosed", () => {
      this.connected = false;
    });
    this.obs.on("ConnectionError", () => {
      this.connected = false;
    });
  }

  async captureFrame(): Promise<ScreenFrame> {
    // The detector letterboxes whatever arrives down to its input size, so the
    // capture width only needs enough detail for the second-stage species
    // classifier's creature crops. Asking OBS for a full-resolution PNG would
    // waste network, decode and resize time on every cycle.
    return this.captureScreenshot("jpg", 72, this.config.obsCaptureWidth);
  }

  async capturePreviewFrame(): Promise<ScreenFrame> {
    return this.captureScreenshot("jpg", 70, 1280);
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    await this.obs.disconnect();
    this.connected = false;
  }

  private async captureScreenshot(imageFormat: "png" | "jpg", imageCompressionQuality: number, imageWidth?: number): Promise<ScreenFrame> {
    await this.connect();

    const screenshot = await this.obs.call("GetSourceScreenshot", {
      sourceName: this.config.obsSourceName,
      imageFormat,
      imageCompressionQuality,
      ...(imageWidth ? { imageWidth } : {})
    });
    const data = parseImageData(String(screenshot.imageData));
    const metadata = await sharp(data).metadata();
    if (!metadata.width || !metadata.height || metadata.width < 32 || metadata.height < 32) {
      throw new Error("OBS returned an invalid frame: check whether the game window and capture source are available.");
    }
    const statistics = await sharp(data).stats();
    if (statistics.channels.slice(0, 3).every(channel => channel.max <= 2)) {
      throw new Error("OBS returned a black frame: the game may be closed, minimized or unavailable to capture.");
    }

    return {
      id: randomUUID(),
      sourceComputerId: this.config.nodeId,
      source: "obs-preview",
      capturedAt: new Date().toISOString(),
      width: metadata.width ?? 0,
      height: metadata.height ?? 0,
      data,
      mimeType: imageFormat === "jpg" ? "image/jpeg" : "image/png"
    };
  }

  private async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    // Coalesce concurrent captures so only a single handshake is in flight at a time.
    this.connecting ??= this.openConnection();

    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private async openConnection(): Promise<void> {
    await this.obs.connect(this.config.obsWebSocketUrl, this.config.obsWebSocketPassword || undefined);
    this.connected = true;
  }
}

function parseImageData(imageData: string): Buffer {
  const base64 = imageData.includes(",") ? imageData.slice(imageData.indexOf(",") + 1) : imageData;
  return Buffer.from(base64, "base64");
}
