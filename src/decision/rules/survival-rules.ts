import type { BotCharacter, BotSkill } from "../../core/bot-configuration.js";
import type { GameState } from "../game-state.js";
import { normalizePartyVocation } from "../party-rules.js";
import { PRIORITY, propose, type ActionProposal, type DecisionRule } from "../rule-engine.js";

export interface SurvivalThresholds {
  readonly emergencyHealthPercent: number;
  readonly healHealthPercent: number;
  readonly manaPotionPercent: number;
  readonly maxReadingAgeMs: number;
  /** Optional overrides when the automatic pick is not the wanted spell or potion. */
  readonly emergencyHealSkillName: string | null;
  readonly healSkillName: string | null;
  readonly manaSkillName: string | null;
}

export const DEFAULT_SURVIVAL_THRESHOLDS: SurvivalThresholds = {
  emergencyHealthPercent: 30,
  healHealthPercent: 65,
  manaPotionPercent: 45,
  maxReadingAgeMs: 2_000,
  emergencyHealSkillName: null,
  healSkillName: null,
  manaSkillName: null
};

/**
 * Reads the `survival` block of the same run snapshot used by the refill policy.
 * `defaults` is the vocation baseline, so an absent field falls back to what the
 * vocation asks for rather than to a vocation-neutral number.
 */
export function survivalThresholdsFrom(
  value: string | null,
  defaults: SurvivalThresholds = DEFAULT_SURVIVAL_THRESHOLDS
): SurvivalThresholds {
  try {
    const snapshot = JSON.parse(value ?? "") as Record<string, unknown>;
    const survival = snapshot.survival as Record<string, unknown> | undefined;
    if (!survival) return defaults;
    return {
      emergencyHealthPercent: percent(survival.emergencyHealthPercent) ?? defaults.emergencyHealthPercent,
      healHealthPercent: percent(survival.healHealthPercent) ?? defaults.healHealthPercent,
      manaPotionPercent: percent(survival.manaPotionPercent) ?? defaults.manaPotionPercent,
      maxReadingAgeMs: positive(survival.maxReadingAgeMs) ?? defaults.maxReadingAgeMs,
      emergencyHealSkillName: name(survival.emergencyHealSkillName) ?? defaults.emergencyHealSkillName,
      healSkillName: name(survival.healSkillName) ?? defaults.healSkillName,
      manaSkillName: name(survival.manaSkillName) ?? defaults.manaSkillName
    };
  } catch {
    return defaults;
  }
}

export function createSurvivalRules(
  skills: readonly BotSkill[],
  thresholds: SurvivalThresholds = DEFAULT_SURVIVAL_THRESHOLDS
): readonly DecisionRule[] {
  return [
    {
      id: "stale-reading",
      priority: PRIORITY.emergency + 40,
      evaluate: (state) => state.ageMs > thresholds.maxReadingAgeMs
        ? propose("stale-reading", PRIORITY.emergency + 40, { kind: "hold" }, `Leitura com ${Math.round(state.ageMs)} ms, acima do limite de ${thresholds.maxReadingAgeMs} ms.`, state)
        : null
    },
    {
      id: "emergency-heal",
      priority: PRIORITY.emergency,
      evaluate: (state) => {
        if (!belowPercent(state.health, thresholds.emergencyHealthPercent)) return null;
        const skill = pickHealthSkill(skills, state, thresholds, "strongest");
        return skill
          ? propose("emergency-heal", PRIORITY.emergency, { kind: "cast", skillId: skill.id }, `HP em ${percentText(state)}%, abaixo do limite de emergência ${thresholds.emergencyHealthPercent}%; usando ${skill.name}.`, state)
          : null;
      }
    },
    {
      id: "escape",
      priority: PRIORITY.emergency - 10,
      evaluate: (state) => {
        if (!belowPercent(state.health, thresholds.emergencyHealthPercent)) return null;
        return pickHealthSkill(skills, state, thresholds, "strongest")
          ? null
          : propose("escape", PRIORITY.emergency - 10, { kind: "flee" }, `HP em ${percentText(state)}% e nenhuma cura disponível ou com suprimento suficiente.`, state);
      }
    },
    {
      id: "heal",
      priority: PRIORITY.survival,
      evaluate: (state) => {
        if (!belowPercent(state.health, thresholds.healHealthPercent)) return null;
        const skill = pickHealthSkill(skills, state, thresholds, "cheapest");
        return skill
          ? propose("heal", PRIORITY.survival, { kind: "cast", skillId: skill.id }, `HP em ${percentText(state)}%, abaixo de ${thresholds.healHealthPercent}%; usando ${skill.name}.`, state)
          : null;
      }
    },
    {
      id: "mana",
      priority: PRIORITY.survival - 40,
      evaluate: (state) => {
        if (!belowPercent(state.mana, thresholds.manaPotionPercent)) return null;
        const skill = pickSkill(manaCandidates(skills, thresholds), state, "cheapest");
        return skill
          ? propose("mana", PRIORITY.survival - 40, { kind: "cast", skillId: skill.id }, `Mana em ${Math.round(state.mana?.percent ?? 0)}%, abaixo de ${thresholds.manaPotionPercent}%; usando ${skill.name}.`, state)
          : null;
      }
    }
  ];
}

function pickHealthSkill(
  skills: readonly BotSkill[],
  state: GameState,
  thresholds: SurvivalThresholds,
  strength: "strongest" | "cheapest"
): BotSkill | null {
  const explicit = strength === "strongest" ? thresholds.emergencyHealSkillName : thresholds.healSkillName;
  const candidates = explicit
    ? skills.filter((skill) => sameName(skill.name, explicit))
    : skills.filter((skill) => skill.category === "healing" && !/mana/i.test(skill.name));
  return pickSkill(candidates, state, strength);
}

function manaCandidates(skills: readonly BotSkill[], thresholds: SurvivalThresholds): readonly BotSkill[] {
  if (thresholds.manaSkillName) return skills.filter((skill) => sameName(skill.name, thresholds.manaSkillName!));
  return skills.filter((skill) => /mana|spirit/i.test(skill.name));
}

function pickSkill(
  candidates: readonly BotSkill[],
  state: GameState,
  strength: "strongest" | "cheapest"
): BotSkill | null {
  const usable = candidates
    .filter((skill) => skill.enabled)
    .filter((skill) => canUse(skill, state.character))
    .filter((skill) => (state.mana === null ? (skill.manaCost ?? 0) === 0 : state.mana.current >= (skill.manaCost ?? 0)))
    .filter((skill) => hasSupply(skill, state))
    // requiredLevel is the only strength signal stored for both spells and
    // potions: exura vita and ultimate health potion both sit above the cheap
    // options, so it orders them the same way the player would.
    .sort((left, right) => strength === "strongest" ? right.requiredLevel - left.requiredLevel : left.requiredLevel - right.requiredLevel);
  return usable[0] ?? null;
}

function hasSupply(skill: BotSkill, state: GameState): boolean {
  // A spell has no supply entry; only a tracked consumable can run out. The
  // minimum stock for going back to town belongs to the resupply rules, not
  // here: refusing to heal at 19 potions would be lethal.
  const remaining = state.supplies[skill.name.toLowerCase()];
  return remaining === undefined || remaining > 0;
}

function canUse(skill: BotSkill, character: BotCharacter | null): boolean {
  if (!character) return false;
  if ((character.level ?? 0) < skill.requiredLevel) return false;
  const vocation = normalizePartyVocation(character.vocation ?? "");
  return vocation !== null && skill.allowedVocations.some((allowed) => normalizePartyVocation(allowed) === vocation);
}

function belowPercent(vital: GameState["health"], threshold: number): boolean {
  return vital !== null && vital.percent <= threshold;
}

function percentText(state: GameState): number {
  return Math.round(state.health?.percent ?? 0);
}

function sameName(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function percent(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 100 ? number : null;
}

function positive(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function name(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}
