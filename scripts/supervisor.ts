/**
 * Host-side supervisor: starts and stops the agent and the annotation UI on
 * behalf of the panel, which serves from a container and cannot spawn host
 * processes itself.
 *
 * Run it on the machine that has OBS, the GPU and the Tibia client:
 *   npm run supervisor
 */
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { loadRuntimeConfig } from "../src/config/runtime-config.js";
import {
  controlPaths,
  IDLE_OBSERVATION,
  MANAGED_PROCESSES,
  readControl,
  writeStatus,
  type ManagedProcess,
  type ProcessObservation
} from "../src/coordination/process-control.js";

/**
 * The only commands this process will ever run. The control file selects one of
 * these keys; it never carries a command line of its own.
 */
const COMMANDS: Record<ManagedProcess, readonly string[]> = {
  agent: ["run", "dev"],
  annotator: ["run", "annotations:dev"]
};

const POLL_MS = 2_000;
const HEARTBEAT_MS = 5_000;
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const root = resolve(import.meta.dirname, "..");
const { control: controlPath, status: statusPath } = controlPaths(resolve(loadRuntimeConfig().decisionLogPath));

const running = new Map<ManagedProcess, ChildProcess>();
const observed: Record<ManagedProcess, ProcessObservation> = {
  agent: { ...IDLE_OBSERVATION },
  annotator: { ...IDLE_OBSERVATION }
};

/**
 * The control timestamp that authorised the current attempt. A process that dies
 * on its own is not restarted until the panel writes a newer one — that is, until
 * someone presses the button again.
 *
 * Without this the poll loop sees "desired=running, not running" every 2s and
 * respawns forever: an agent that exits immediately because the machine is not
 * configured got started 219 times in seven minutes.
 */
const attempted = new Map<ManagedProcess, string>();

function start(name: ManagedProcess): void {
  if (running.has(name)) return;
  console.log(`[supervisor] iniciando ${name}: npm ${COMMANDS[name].join(" ")}`);

  let child: ChildProcess;
  try {
    // shell:true is required on Windows — npm is a .cmd and node refuses to spawn
    // batch files directly since the CVE-2024-27980 fix. It is safe here only
    // because COMMANDS is a fixed table: nothing from the control file, and no
    // user input of any kind, ever reaches this command line.
    child = spawn(npm, [...COMMANDS[name]], {
      cwd: root,
      stdio: "inherit",
      shell: process.platform === "win32"
    });
  } catch (error) {
    // A failed spawn must not take the supervisor down with it, or one bad start
    // leaves nothing running to retry or to report the failure.
    observed[name] = { state: "failed", pid: null, since: null, error: error instanceof Error ? error.message : String(error) };
    console.error(`[supervisor] ${name} nao pode ser iniciado: ${observed[name].error}`);
    return;
  }

  running.set(name, child);
  observed[name] = { state: "running", pid: child.pid ?? null, since: new Date().toISOString(), error: null };

  child.on("exit", (code, signal) => {
    running.delete(name);
    // A clean stop we asked for is not a failure; anything else is worth showing.
    const requested = observed[name].state === "stopped";
    observed[name] = requested || code === 0
      ? { ...IDLE_OBSERVATION }
      : { state: "failed", pid: null, since: observed[name].since, error: `saiu com code=${code} signal=${signal ?? "-"}` };
    console.log(`[supervisor] ${name} encerrou code=${code} signal=${signal ?? "-"}`);
  });
  child.on("error", (error) => {
    running.delete(name);
    observed[name] = { state: "failed", pid: null, since: null, error: error.message };
    console.error(`[supervisor] ${name} falhou: ${error.message}`);
  });
}

function stop(name: ManagedProcess): void {
  const child = running.get(name);
  observed[name] = { ...IDLE_OBSERVATION };
  if (!child) return;
  console.log(`[supervisor] parando ${name}`);
  // npm spawns the real process as a child, so killing the tree matters on Windows.
  if (process.platform === "win32" && child.pid) {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
  } else {
    child.kill("SIGTERM");
  }
}

async function tick(): Promise<void> {
  const control = await readControl(controlPath);
  for (const name of MANAGED_PROCESSES) {
    const desired = control.desired[name];
    if (desired === "stopped") {
      attempted.delete(name);
      if (running.has(name)) stop(name);
      continue;
    }
    // One authorisation, one attempt. A newer updatedAt means the operator asked
    // again, which is the only thing that clears a previous failure.
    if (!running.has(name) && attempted.get(name) !== control.updatedAt) {
      attempted.set(name, control.updatedAt);
      start(name);
    }
  }
  await writeStatus(statusPath, { heartbeatAt: new Date().toISOString(), observed });
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    // Leaving orphaned agents behind would keep driving the game with no supervisor.
    for (const name of MANAGED_PROCESSES) stop(name);
    process.exit(0);
  });
}

console.log(`[supervisor] controle=${controlPath}`);
console.log(`[supervisor] status=${statusPath}`);
await tick();
setInterval(() => void tick(), POLL_MS);
setInterval(() => void writeStatus(statusPath, { heartbeatAt: new Date().toISOString(), observed }), HEARTBEAT_MS);
