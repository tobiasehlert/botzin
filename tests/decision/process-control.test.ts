import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  controlPaths,
  defaultControl,
  isDesiredState,
  isManagedProcess,
  readControl,
  supervisorOnline,
  writeControl
} from "../../src/coordination/process-control.js";

const tempDir = () => mkdtemp(join(tmpdir(), "botzin-control-"));

describe("controlPaths", () => {
  it("puts both files beside the decision log, the one path both sides already share", () => {
    const paths = controlPaths(join("storage", "live-decisions.jsonl"));
    expect(paths.control).toBe(join("storage", "process-control.json"));
    expect(paths.status).toBe(join("storage", "process-status.json"));
  });
});

describe("readControl", () => {
  it("defaults to stopped when the file is missing", async () => {
    const control = await readControl(join(await tempDir(), "nope.json"));
    expect(control.desired).toEqual({ agent: "stopped", annotator: "stopped" });
  });

  it("defaults to stopped when the file is corrupt, never to running", async () => {
    const path = join(await tempDir(), "control.json");
    await writeFile(path, "{ not json");
    expect((await readControl(path)).desired.agent).toBe("stopped");
  });

  it("ignores unknown processes and bogus states", async () => {
    const path = join(await tempDir(), "control.json");
    await writeFile(path, JSON.stringify({ desired: { agent: "launch-nukes", evil: "running" } }));
    const control = await readControl(path);
    expect(control.desired).toEqual({ agent: "stopped", annotator: "stopped" });
    expect(control.desired).not.toHaveProperty("evil");
  });

  it("round-trips what the panel writes", async () => {
    const path = join(await tempDir(), "control.json");
    await writeControl(path, { ...defaultControl(), desired: { agent: "running", annotator: "stopped" }, updatedBy: "admin" });
    const control = await readControl(path);
    expect(control.desired.agent).toBe("running");
    expect(control.updatedBy).toBe("admin");
  });
});

describe("guards", () => {
  it("only accepts the two managed names", () => {
    expect(isManagedProcess("agent")).toBe(true);
    expect(isManagedProcess("annotator")).toBe(true);
    expect(isManagedProcess("rm -rf /")).toBe(false);
    expect(isManagedProcess(null)).toBe(false);
  });

  it("only accepts the two states", () => {
    expect(isDesiredState("running")).toBe(true);
    expect(isDesiredState("paused")).toBe(false);
  });
});

describe("supervisorOnline", () => {
  const now = Date.parse("2026-08-16T12:00:00.000Z");
  const at = (iso: string) => ({ heartbeatAt: iso, observed: {} as never });

  it("is offline with no status file at all", () => {
    expect(supervisorOnline(null, now)).toBe(false);
  });

  it("is online for a fresh heartbeat and offline for a stale one", () => {
    expect(supervisorOnline(at("2026-08-16T11:59:57.000Z"), now)).toBe(true);
    expect(supervisorOnline(at("2026-08-16T11:59:30.000Z"), now)).toBe(false);
  });

  it("treats an unparseable heartbeat as offline", () => {
    expect(supervisorOnline(at("ontem"), now)).toBe(false);
  });
});
