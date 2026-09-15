import type { Pool, RowDataPacket } from "mysql2/promise";
import { normalizePartyVocation, PARTY_BASE_VOCATIONS, type PartyBaseVocation } from "../decision/party-rules.js";
import { VOCATION_PROFILES } from "../decision/vocation-profiles.js";

/**
 * Baseline combat rules per vocation, derived from the spells already in the
 * catalog rather than typed out by hand.
 *
 * Healing is deliberately absent: `createSurvivalRules` picks health and mana
 * skills straight from the skill list, so seeding heal rules here would put two
 * proposals for the same cast in the engine at different priorities.
 */

/** Below this the character is saving mana to get home, not spending it on a spell. */
const AREA_MIN_MANA_PERCENT = 40;
/** A pack this size is what makes an area spell cheaper than casting one by one. */
const AREA_MIN_CREATURES = 3;
/** Rule priority is evaluated ascending, so the area rule must sit above the single-target one. */
const AREA_PRIORITY = 40;
const SINGLE_PRIORITY = 50;
const SINGLE_MAX_CREATURES = 2;

export interface SeedSkill {
  readonly id: number;
  readonly name: string;
  readonly category: string;
  readonly manaCost: number | null;
  readonly allowedVocations: string;
}

export interface VocationSkillRule {
  readonly huntId: number;
  readonly skillId: number;
  readonly priority: number;
  readonly minManaPercent: number | null;
  readonly minCreatures: number | null;
  readonly maxCreatures: number | null;
  readonly notes: string;
}

export function skillAllowsVocation(skill: SeedSkill, vocation: PartyBaseVocation): boolean {
  return skill.allowedVocations
    .split(",")
    .some((allowed) => normalizePartyVocation(allowed) === vocation);
}

/**
 * Two rules per vocation and hunt: the widest attack spell for packs and the
 * cheapest one for single targets. Mana cost is the only strength signal stored
 * for every spell, and it orders area spells above single-target ones the same
 * way the player ranks them.
 */
export function deriveVocationSkillRules(
  skills: readonly SeedSkill[],
  huntIds: readonly number[]
): readonly VocationSkillRule[] {
  const rules: VocationSkillRule[] = [];
  for (const huntId of huntIds) {
    // A skill may be shared by two vocations (druid and sorcerer runes), and the
    // table allows one row per hunt and skill, so the first vocation to claim it
    // keeps it. Iteration order is fixed, so re-seeding is idempotent.
    const claimed = new Set<number>();
    for (const vocation of PARTY_BASE_VOCATIONS) {
      const attacks = skills
        .filter((skill) => skill.category === "attack")
        .filter((skill) => skill.manaCost !== null && skill.manaCost > 0)
        .filter((skill) => skillAllowsVocation(skill, vocation))
        .sort((left, right) => (left.manaCost ?? 0) - (right.manaCost ?? 0));
      if (attacks.length === 0) continue;

      const cheapest = attacks[0]!;
      const widest = attacks[attacks.length - 1]!;
      const profile = VOCATION_PROFILES[vocation];

      if (widest.id !== cheapest.id && !claimed.has(widest.id)) {
        claimed.add(widest.id);
        rules.push({
          huntId,
          skillId: widest.id,
          priority: AREA_PRIORITY,
          minManaPercent: AREA_MIN_MANA_PERCENT,
          minCreatures: AREA_MIN_CREATURES,
          maxCreatures: profile.maxCreatures,
          notes: `Baseline de ${vocation}: ${widest.name} em pacotes de ${AREA_MIN_CREATURES} a ${profile.maxCreatures} criaturas, com mana acima de ${AREA_MIN_MANA_PERCENT}%.`
        });
      }

      if (!claimed.has(cheapest.id)) {
        claimed.add(cheapest.id);
        rules.push({
          huntId,
          skillId: cheapest.id,
          priority: SINGLE_PRIORITY,
          // The refill threshold of the vocation is the floor: below it the mana
          // belongs to the trip home, not to the cheapest attack on screen.
          minManaPercent: profile.survival.manaPotionPercent,
          minCreatures: 1,
          maxCreatures: SINGLE_MAX_CREATURES,
          notes: `Baseline de ${vocation}: ${cheapest.name} em alvo único, com mana acima de ${profile.survival.manaPotionPercent}%.`
        });
      }
    }
  }
  return rules;
}

/**
 * Seeds the baseline for the hunts the operator already enabled. Running it for
 * every derived spot would write tens of thousands of rows nobody asked for.
 */
export async function seedVocationSkillRules(pool: Pool): Promise<number> {
  const [hunts] = await pool.query<RowDataPacket[]>("SELECT id FROM bot_hunts WHERE enabled = TRUE");
  const [skills] = await pool.query<RowDataPacket[]>(
    "SELECT id, name, category, mana_cost, allowed_vocations FROM bot_skills"
  );
  const huntIds = hunts.map((row) => Number(row.id));
  const rules = deriveVocationSkillRules(
    skills.map((row): SeedSkill => ({
      id: Number(row.id),
      name: String(row.name),
      category: String(row.category),
      manaCost: row.mana_cost === null ? null : Number(row.mana_cost),
      allowedVocations: String(row.allowed_vocations ?? "")
    })),
    huntIds
  );
  if (rules.length === 0) return 0;

  const values = rules.map((rule) => [
    rule.huntId, rule.skillId, rule.priority, rule.minManaPercent,
    rule.minCreatures, rule.maxCreatures, rule.notes
  ]);
  const placeholders = values.map(() => "(?, ?, ?, ?, ?, ?, ?, FALSE)").join(", ");
  // enabled stays out of the update for the same reason as the hunt and spell
  // seeds: a rule the operator turned on must not flip back on the next run.
  await pool.execute(
    `INSERT INTO bot_hunt_skill_rules
       (hunt_id, skill_id, priority, min_mana_percent, min_creatures, max_creatures, notes, enabled)
     VALUES ${placeholders}
     ON DUPLICATE KEY UPDATE
       priority = VALUES(priority), min_mana_percent = VALUES(min_mana_percent),
       min_creatures = VALUES(min_creatures), max_creatures = VALUES(max_creatures),
       notes = VALUES(notes)`,
    values.flat()
  );
  return rules.length;
}
