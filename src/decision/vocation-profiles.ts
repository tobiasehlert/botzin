import { normalizePartyVocation, type PartyBaseVocation } from "./party-rules.js";
import { DEFAULT_COMBAT_OPTIONS } from "./rules/combat-rules.js";
import { DEFAULT_SURVIVAL_THRESHOLDS, type SurvivalThresholds } from "./rules/survival-rules.js";

/**
 * Per-vocation defaults for the thresholds the rules already read. The run
 * snapshot still wins over these, so the panel can retune a single character
 * without touching the vocation baseline.
 */
export interface VocationProfile {
  readonly survival: SurvivalThresholds;
  readonly maxCreatures: number;
}

/**
 * A knight soaks damage and heals late; a sorcerer that waits as long dies. The
 * creature limit follows the same axis: melee vocations hold a block, mana
 * vocations run before the screen fills.
 *
 * These are starting points measured against nothing yet — tune them per
 * character in the run snapshot as telemetry comes in.
 */
export const VOCATION_PROFILES: Readonly<Record<PartyBaseVocation, VocationProfile>> = {
  knight: {
    survival: { ...DEFAULT_SURVIVAL_THRESHOLDS, emergencyHealthPercent: 25, healHealthPercent: 55, manaPotionPercent: 35 },
    maxCreatures: 8
  },
  monk: {
    survival: { ...DEFAULT_SURVIVAL_THRESHOLDS, emergencyHealthPercent: 30, healHealthPercent: 60, manaPotionPercent: 40 },
    maxCreatures: 6
  },
  paladin: {
    survival: { ...DEFAULT_SURVIVAL_THRESHOLDS, emergencyHealthPercent: 35, healHealthPercent: 65, manaPotionPercent: 50 },
    maxCreatures: 4
  },
  druid: {
    survival: { ...DEFAULT_SURVIVAL_THRESHOLDS, emergencyHealthPercent: 40, healHealthPercent: 70, manaPotionPercent: 60 },
    maxCreatures: 2
  },
  sorcerer: {
    survival: { ...DEFAULT_SURVIVAL_THRESHOLDS, emergencyHealthPercent: 45, healHealthPercent: 70, manaPotionPercent: 60 },
    maxCreatures: 2
  }
};

export const DEFAULT_VOCATION_PROFILE: VocationProfile = {
  survival: DEFAULT_SURVIVAL_THRESHOLDS,
  maxCreatures: DEFAULT_COMBAT_OPTIONS.maxCreatures
};

/**
 * An unknown or missing vocation falls back to the neutral profile instead of
 * guessing: the skill filter already refuses to cast for it, and inheriting a
 * knight's 25% emergency threshold would be lethal for a sorcerer.
 */
export function vocationProfile(vocation: string | null | undefined): VocationProfile {
  const base = normalizePartyVocation(vocation ?? "");
  return base === null ? DEFAULT_VOCATION_PROFILE : VOCATION_PROFILES[base];
}
