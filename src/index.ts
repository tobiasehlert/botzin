import { loadRuntimeConfig } from "./config/runtime-config.js";
import { applyMachineRuntimeConfig } from "./config/machine-runtime-config.js";
import { InMemoryCoordinator } from "./coordination/in-memory-coordinator.js";
import { RuleEngineStrategy, loadoutFromSnapshot } from "./decision/rule-engine-strategy.js";
import { evaluationOf } from "./decision/rule-engine.js";
import { isEnvironmentReady } from "./environment/check-status.js";
import { ObsShareInspector } from "./environment/obs-share-inspector.js";
import { RuntimeEnvironmentChecker } from "./environment/runtime-environment-checker.js";
import { WindowsProcessInspector } from "./environment/windows-process-inspector.js";
import { LocalNetworkInspector } from "./networking/local-network-inspector.js";
import { NetworkProfileBuilder } from "./networking/network-profile-builder.js";
import { createInputExecutor } from "./execution/windows-input-executor.js";
import { createEntityDetector } from "./perception/detector-factory.js";
import { createFrameSource } from "./perception/frame-source-factory.js";
import { PerceptionPipeline } from "./perception/perception-pipeline.js";
import { resolve } from "node:path";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { LiveDecisionStore, decisionFrom, errorDecision } from "./decision/live-decision-store.js";
import { createMysqlPool } from "./database/mysql-pool.js";
import { ConfigurationRepository } from "./database/configuration-repository.js";
import { RuntimeRunCollector } from "./telemetry/runtime-run-collector.js";

async function main(): Promise<void> {
  const bootstrapConfig = loadRuntimeConfig();
  const pool = createMysqlPool(bootstrapConfig);
  const repository = new ConfigurationRepository(pool, bootstrapConfig.jwtSecret);
  const storedMachine = await repository.getMachineRuntimeConfig(bootstrapConfig.nodeId);
  if (!storedMachine) {
    await pool.end();
    throw new Error(`Machine "${bootstrapConfig.nodeId}" is not configured or is disabled. Configure it in the web application first.`);
  }
  const config = applyMachineRuntimeConfig(bootstrapConfig, storedMachine.machine, storedMachine.runtime);
  const networkInspector = new LocalNetworkInspector();
  const networkProfile = new NetworkProfileBuilder(config).build(networkInspector.listAddresses());
  const environmentChecker = new RuntimeEnvironmentChecker(
    config,
    new WindowsProcessInspector(),
    new ObsShareInspector()
  );
  const frameSource = createFrameSource(config);
  const detector = createEntityDetector(config);
  const pipeline = new PerceptionPipeline(frameSource, detector);
  const executor = createInputExecutor(config);
  const coordinator = new InMemoryCoordinator();
  // ponytail: the loadout is read once at startup; restart the bot after
  // changing the assignment, spells, hotkeys or the run snapshot in the panel.
  const activeRun = await repository.findActiveCharacterRun(config.nodeId);
  const loadout = loadoutFromSnapshot(await repository.getSnapshot(), storedMachine.machine.id, activeRun?.routeSnapshotJson ?? null);
  const strategy = new RuleEngineStrategy(loadout, {
    targetComputerId: config.nodeId,
    mode: config.decisionMode,
    modes: config.decisionRuleModes
  });
  const decisionStore = new LiveDecisionStore(resolve(config.decisionLogPath));
  const monitorPath = process.env.BOTZIN_MONITOR_PATH ? resolve(process.env.BOTZIN_MONITOR_PATH) : null;
  if (monitorPath) await mkdir(dirname(monitorPath), { recursive: true });
  const runCollector = new RuntimeRunCollector(
    repository, config.nodeId, resolve(config.runCaptureDir), config.runFrameIntervalMs
  );
  const abortController = new AbortController();
  process.once("SIGINT", () => abortController.abort());
  process.once("SIGTERM", () => abortController.abort());

  const environment = await environmentChecker.check();
  console.log(
    JSON.stringify(
      {
        nodeId: config.nodeId,
        role: config.role,
        network: networkProfile,
        frameSource: frameSource.name,
        detector: detector.name,
        strategy: strategy.name,
        decisionMode: config.decisionMode,
        character: loadout.character?.name ?? null,
        hunt: loadout.hunt?.name ?? null,
        huntSkillRules: loadout.huntSkillRules.length,
        environmentReady: isEnvironmentReady(environment),
        environment,
        captureMode: "continuous-sequential",
        decisionLogPath: resolve(config.decisionLogPath),
        liveMonitor: "started"
      },
      null,
      2
    )
  );

  while (!abortController.signal.aborted) {
    const cycleStartedAt = performance.now();
    try {
      const perception = await pipeline.inspectCurrentFrame();
      const event = coordinator.ingest(perception);
      const commands = await strategy.plan(event);
      const latest = strategy.lastDecision();
      const decision = decisionFrom(event, strategy.name, commands, {
        decision: latest?.decision.accepted?.source,
        reasons: latest?.decision.reasons,
        evaluation: latest ? evaluationOf(latest.decision) : undefined
      });
      await decisionStore.append(decision);
      if (monitorPath) {
        try {
          const temporary = `${monitorPath}.${process.pid}.tmp`;
          await writeFile(temporary, JSON.stringify({
            decision, capturedAt: perception.capturedAt,
            image: Buffer.from(perception.frame.data).toString("base64"),
            executionMode: config.decisionMode
          }));
          await rename(temporary, monitorPath);
        } catch (error) {
          console.warn("Monitor visual indisponível:", error instanceof Error ? error.message : String(error));
        }
      }
      runCollector.enqueue(perception, decision);
      if (config.decisionMode === "execute") {
        for (const command of commands) await executor.execute(command);
      }
      console.log(JSON.stringify({
        type: "live-decision",
        observedAt: decision.observedAt,
        decision: decision.decision,
        mode: decision.mode,
        entities: decision.entityCounts,
        commands: decision.commands.length,
        latencyMs: Math.round(performance.now() - cycleStartedAt)
      }));
    } catch (error) {
      const decision = errorDecision(config.nodeId, strategy.name, error);
      await decisionStore.append(decision);
      console.error(JSON.stringify({ type: "live-decision-error", observedAt: decision.observedAt, error: decision.error }));
      // Keep connection failures from spinning thousands of times per second
      // while OBS or a remote machine is unavailable.
      await delay(1_000);
    }
    // ponytail: ~6 cycles/s is plenty for a 0.5 s action step and keeps live-decisions.jsonl sane.
    await delay(150);
  }
  await runCollector.flush();
  await pool.end();
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
