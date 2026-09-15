import { describe, expect, it } from "vitest";
import { VOCATION_PROFILES } from "../../src/decision/vocation-profiles.js";
import {
  deriveVocationSkillRules,
  skillAllowsVocation,
  type SeedSkill
} from "../../src/learning/seed-vocation-skill-rules.js";

const skill = (id: number, name: string, manaCost: number | null, vocations: string, category = "attack"): SeedSkill =>
  ({ id, name, category, manaCost, allowedVocations: vocations });

const SKILLS: readonly SeedSkill[] = [
  skill(1, "Energy Strike", 20, "sorcerer,master sorcerer"),
  skill(2, "Rage of the Skies", 600, "sorcerer,master sorcerer"),
  skill(3, "Ice Strike", 20, "druid,elder druid"),
  skill(4, "Eternal Winter", 1050, "druid,elder druid"),
  skill(5, "Divine Missile", 20, "paladin,royal paladin"),
  skill(6, "Divine Caldera", 160, "paladin,royal paladin"),
  skill(7, "Brutal Strike", 30, "knight,elite knight"),
  skill(8, "Fierce Berserk", 340, "knight,elite knight"),
  skill(9, "Exura Vita", 160, "knight,elite knight", "healing"),
  skill(10, "Variable Cost", null, "sorcerer")
];

describe("skillAllowsVocation", () => {
  it("matches promoted names and ignores unrelated vocations", () => {
    expect(skillAllowsVocation(SKILLS[0]!, "sorcerer")).toBe(true);
    expect(skillAllowsVocation(skill(99, "x", 10, "elite knight"), "knight")).toBe(true);
    expect(skillAllowsVocation(SKILLS[0]!, "druid")).toBe(false);
  });
});

describe("deriveVocationSkillRules", () => {
  const rules = deriveVocationSkillRules(SKILLS, [7]);

  it("never seeds a healing skill, because survival rules own healing", () => {
    expect(rules.some((rule) => rule.skillId === 9)).toBe(false);
  });

  it("skips spells with no fixed mana cost", () => {
    expect(rules.some((rule) => rule.skillId === 10)).toBe(false);
  });

  it("pairs a cheap single-target rule with a wide area rule per vocation", () => {
    const single = rules.find((rule) => rule.skillId === 1)!;
    const area = rules.find((rule) => rule.skillId === 2)!;
    expect(single.minCreatures).toBe(1);
    expect(single.maxCreatures).toBe(2);
    expect(area.minCreatures).toBe(3);
    expect(area.maxCreatures).toBe(VOCATION_PROFILES.sorcerer.maxCreatures);
    // Ascending priority is evaluated first, so the area rule must outrank it.
    expect(area.priority).toBeLessThan(single.priority);
  });

  it("floors single-target mana at the vocation refill threshold", () => {
    expect(rules.find((rule) => rule.skillId === 7)!.minManaPercent)
      .toBe(VOCATION_PROFILES.knight.survival.manaPotionPercent);
    expect(rules.find((rule) => rule.skillId === 3)!.minManaPercent)
      .toBe(VOCATION_PROFILES.druid.survival.manaPotionPercent);
  });

  it("respects the one-row-per-hunt-and-skill constraint", () => {
    const shared = deriveVocationSkillRules(
      [skill(1, "Shared Rune", 20, "druid,sorcerer"), skill(2, "Wide Rune", 500, "druid,sorcerer")],
      [7, 8]
    );
    for (const huntId of [7, 8]) {
      const keys = shared.filter((rule) => rule.huntId === huntId).map((rule) => rule.skillId);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it("covers every hunt it is given and nothing when there is none", () => {
    expect(new Set(deriveVocationSkillRules(SKILLS, [7, 8]).map((rule) => rule.huntId))).toEqual(new Set([7, 8]));
    expect(deriveVocationSkillRules(SKILLS, [])).toEqual([]);
  });
});
