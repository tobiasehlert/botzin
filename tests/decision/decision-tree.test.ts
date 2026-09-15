import { describe, expect, it } from "vitest";
import { bandOf, evaluationOf, PRIORITY, propose, type ActionProposal, type RuleDecision } from "../../src/decision/rule-engine.js";
import type { GameState } from "../../src/decision/game-state.js";

const state = { observedAt: "2026-08-16T12:00:00.000Z" } as GameState;

const proposal = (source: string, priority: number): ActionProposal =>
  propose(source, priority, { kind: "hold" }, `motivo de ${source}`, state);

describe("bandOf", () => {
  it("names the band a priority landed in", () => {
    expect(bandOf(PRIORITY.emergency)).toBe("emergency");
    expect(bandOf(PRIORITY.survival)).toBe("survival");
    expect(bandOf(PRIORITY.combat)).toBe("combat");
    expect(bandOf(PRIORITY.loot)).toBe("loot");
    expect(bandOf(PRIORITY.optional)).toBe("optional");
  });

  it("follows the boost, not the nominal band", () => {
    // Rules shift inside their band (`PRIORITY.survival + 30`), and a boost that
    // crosses into the next band has to be reported where it actually competes.
    expect(bandOf(PRIORITY.emergency + 40)).toBe("emergency");
    expect(bandOf(PRIORITY.survival + 30)).toBe("survival");
    expect(bandOf(PRIORITY.combat - 100)).toBe("positioning");
  });

  it("never falls off the bottom", () => {
    expect(bandOf(0)).toBe("optional");
    expect(bandOf(-50)).toBe("optional");
  });
});

describe("evaluationOf", () => {
  const decision: RuleDecision = {
    accepted: proposal("emergency-heal", PRIORITY.emergency),
    commands: [],
    rejected: [
      { proposal: proposal("hunt-skill-exori", PRIORITY.combat), reason: "Prioridade menor que emergency-heal." },
      { proposal: proposal("loot-corpse", PRIORITY.loot), reason: "Prioridade menor que emergency-heal." }
    ],
    reasons: []
  };

  it("puts the winner first and marks it as not rejected", () => {
    const tree = evaluationOf(decision);
    expect(tree[0]?.source).toBe("emergency-heal");
    expect(tree[0]?.rejectedBecause).toBeNull();
  });

  it("keeps every loser with its reason", () => {
    const tree = evaluationOf(decision);
    expect(tree).toHaveLength(3);
    expect(tree.filter((entry) => entry.rejectedBecause !== null)).toHaveLength(2);
    expect(tree.find((entry) => entry.source === "loot-corpse")?.rejectedBecause)
      .toBe("Prioridade menor que emergency-heal.");
  });

  it("orders by priority so the tree reads top-down", () => {
    const priorities = evaluationOf(decision).map((entry) => entry.priority);
    expect(priorities).toEqual([...priorities].sort((left, right) => right - left));
  });

  it("carries the band and the action kind", () => {
    const tree = evaluationOf(decision);
    expect(tree[0]?.band).toBe("emergency");
    expect(tree[0]?.action).toBe("hold");
  });

  it("handles a cycle where nothing was accepted", () => {
    const tree = evaluationOf({ ...decision, accepted: null });
    expect(tree).toHaveLength(2);
    expect(tree.every((entry) => entry.rejectedBecause !== null)).toBe(true);
  });

  it("returns nothing when no rule proposed at all", () => {
    expect(evaluationOf({ accepted: null, commands: [], rejected: [], reasons: [] })).toEqual([]);
  });
});
