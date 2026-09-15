import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import type { RuntimeConfig } from "../config/runtime-config.js";
import type { InputCommand } from "../core/input-command.js";
import type { InputExecutor } from "./input-executor.js";
import { RaspberryHidExecutor } from "./raspberry-hid-executor.js";

/**
 * Sends keyboard/mouse input on this Windows machine through scripts/win-input-helper.py
 * (SendInput). Frame coordinates in mouse commands are mapped to the OTClient window by the
 * helper using the OBS map crop. Meant for the local training world, not the official client.
 * ponytail: one long-lived python child, commands serialized; no batching, no retries.
 */
export class WindowsInputExecutor implements InputExecutor {
  readonly name = "windows-input";
  private child: ChildProcessByStdio<Writable, Readable, null> | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly config: RuntimeConfig) {}

  async execute(command: InputCommand): Promise<void> {
    const run = async () => {
      const child = this.start();
      const line = JSON.stringify({ ...command, frameWidth: this.config.obsCaptureWidth });
      const reply = new Promise<void>((resolveReply, reject) => {
        const rl = createInterface({ input: child.stdout });
        rl.once("line", (text) => {
          rl.close();
          const parsed = JSON.parse(text) as { ok: boolean; error?: string };
          parsed.ok ? resolveReply() : reject(new Error(parsed.error ?? "input helper failed"));
        });
      });
      child.stdin.write(line + "\n");
      await reply;
    };
    this.queue = this.queue.then(run, run);
    return this.queue;
  }

  private start(): ChildProcessByStdio<Writable, Readable, null> {
    if (this.child && this.child.exitCode === null) return this.child;
    const python = process.env.BOTZIN_PYTHON ?? resolve(".venv/Scripts/python.exe");
    const child = spawn(python, [resolve("scripts/win-input-helper.py")], { stdio: ["pipe", "pipe", "inherit"] });
    this.child = child;
    return child;
  }
}

export function createInputExecutor(config: RuntimeConfig): InputExecutor {
  return process.env.BOTZIN_EXECUTOR === "windows" ? new WindowsInputExecutor(config) : new RaspberryHidExecutor(config);
}
