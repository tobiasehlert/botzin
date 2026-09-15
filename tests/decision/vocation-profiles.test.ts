import { describe, expect, it } from "vitest";
import { PARTY_BASE_VOCATIONS } from "../../src/decision/party-rules.js";
import {
  DEFAULT_VOCATION_PROFILE,
  VOCATION_PROFILES,
  vocationProfile
} from "../../src/decision/vocation-profiles.js";
import { survivalThresholdsFrom } from "../../src/decision/rules/survival-rules.js";

describe("vocationProfile", () => {
  it("resolves every base vocation and its aliases", () => {
    for (const vocation of PARTY_BASE_VOCATIONS) {
      expect(vocationProfile(vocation)).toBe(VOCATION_PROFILES[vocation]);
    }
    expect(vocationProfile("Elite Knight")).toBe(VOCATION_PROFILES.knight);
    expect(vocationProfile("ms")).toBe(VOCATION_PROFILES.sorcerer);
  });

  it("falls back to the neutral profile instead of guessing", () => {
    expect(vocationProfile(null)).toBe(DEFAULT_VOCATION_PROFILE);
    expect(vocationProfile("")).toBe(DEFAULT_VOCATION_PROFILE);
    expect(vocationProfile("bard")).toBe(DEFAULT_VOCATION_PROFILE);
  });

  it("keeps mana vocations more cautious than melee ones", () => {
    // The ordering is the contract; the exact numbers are tuning knobs.
    const { knight, monk, paladin, druid, sorcerer } = VOCATION_PROFILES;
    expect(knight.survival.emergencyHealthPercent).toBeLessThan(monk.survival.emergencyHealthPercent);
    expect(monk.survival.emergencyHealthPercent).toBeLessThan(paladin.survival.emergencyHealthPercent);
    expect(paladin.survival.emergencyHealthPercent).toBeLessThan(druid.survival.emergencyHealthPercent);
    expect(druid.survival.emergencyHealthPercent).toBeLessThan(sorcerer.survival.emergencyHealthPercent);
    expect(knight.maxCreatures).toBeGreaterThan(paladin.maxCreatures);
    expect(paladin.maxCreatures).toBeGreaterThan(sorcerer.maxCreatures);
  });

  it("always heals before the emergency threshold", () => {
    for (const profile of Object.values(VOCATION_PROFILES)) {
      expect(profile.survival.healHealthPercent).toBeGreaterThan(profile.survival.emergencyHealthPercent);
    }
  });
});

describe("survivalThresholdsFrom with a vocation baseline", () => {
  const knight = VOCATION_PROFILES.knight.survival;

  it("uses the vocation baseline when the run snapshot says nothing", () => {
    expect(survivalThresholdsFrom(null, knight)).toBe(knight);
    expect(survivalThresholdsFrom("{}", knight)).toBe(knight);
    expect(survivalThresholdsFrom("not json", knight)).toBe(knight);
  });

  it("lets the run snapshot override a single field and keeps the rest", () => {
    const tuned = survivalThresholdsFrom(JSON.stringify({ survival: { healHealthPercent: 80 } }), knight);
    expect(tuned.healHealthPercent).toBe(80);
    expect(tuned.emergencyHealthPercent).toBe(knight.emergencyHealthPercent);
    expect(tuned.manaPotionPercent).toBe(knight.manaPotionPercent);
  });

  it("keeps the baseline skill overrides when the snapshot omits them", () => {
    const baseline = { ...knight, healSkillName: "exura ico" };
    expect(survivalThresholdsFrom(JSON.stringify({ survival: { healHealthPercent: 70 } }), baseline).healSkillName)
      .toBe("exura ico");
  });
});
