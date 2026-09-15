import type { PerceptionEvent } from "../coordination/perception-event.js";
import type {
  BotCharacter,
  BotClientSpellBinding,
  BotConfigurationSnapshot,
  BotHunt,
  BotHuntSkillRule,
  BotHuntTelemetry,
  BotSkill
} from "../core/bot-configuration.js";
import type { InputCommand } from "../core/input-command.js";
import { ActionValidator, DEFAULT_VALIDATOR_OPTIONS, type ActionValidatorOptions, type RuleMode } from "./action-validator.js";
import { buildGameState, DEFAULT_TARGETING_POLICY, type GameState, type TargetingPolicy } from "./game-state.js";
import { policyFromRunSnapshot, type HuntOperationPolicy } from "./hunt-operation-policy.js";
import { decide, type RuleDecision } from "./rule-engine.js";
import { createCombatRules, type CombatOptions } from "./rules/combat-rules.js";
import { createItemRules, DEFAULT_LOOT_POLICY, type LootPolicy } from "./rules/item-rules.js";
import { createLevelingRules, type LevelingPolicy } from "./rules/leveling-rules.js";
import { createSurvivalRules, survivalThresholdsFrom, type SurvivalThresholds } from "./rules/survival-rules.js";
import { DEFAULT_VOCATION_PROFILE, vocationProfile, type VocationProfile } from "./vocation-profiles.js";
import type { Strategy } from "./strategy.js";

export interface RuleEngineLoadout {
  readonly character: BotCharacter | null;
  readonly hunt: BotHunt | null;
  readonly skills: readonly BotSkill[];
  readonly bindings: readonly BotClientSpellBinding[];
  readonly huntSkillRules: readonly BotHuntSkillRule[];
  readonly telemetry: readonly BotHuntTelemetry[];
  readonly survival: SurvivalThresholds;
  readonly combat: CombatOptions;
  readonly targeting: TargetingPolicy;
  readonly operation: HuntOperationPolicy;
  readonly loot: LootPolicy;
  readonly leveling: LevelingPolicy;
}

/** Everything the rules read from the run snapshot, in one place. */
export function decisionSettingsFrom(
  runSnapshotJson: string | null,
  profile: VocationProfile = DEFAULT_VOCATION_PROFILE
): {
  targeting: TargetingPolicy;
  loot: LootPolicy;
  leveling: LevelingPolicy;
  maxCreatures: number;
} {
  const snapshot = objectValue(parseJson(runSnapshotJson));
  const creatures = objectValue(snapshot.creatures);
  const loot = objectValue(snapshot.loot);
  const leveling = objectValue(snapshot.leveling);
  return {
    targeting: {
      ...DEFAULT_TARGETING_POLICY,
      allowSpecies: stringList(creatures.allowSpecies),
      ignoreSpecies: stringList(creatures.ignoreSpecies),
      dangerousSpecies: stringList(creatures.dangerousSpecies),
      maxThreat: positiveNumber(creatures.maxThreat),
      requireKnownSpecies: creatures.requireKnownSpecies === true
    },
    loot: {
      ...DEFAULT_LOOT_POLICY,
      enabled: loot.enabled !== false,
      allowItems: stringList(loot.allowItems),
      ignoreItems: stringList(loot.ignoreItems),
      maxDistance: positiveNumber(loot.maxDistance) ?? DEFAULT_LOOT_POLICY.maxDistance,
      onlyWhenSafe: loot.onlyWhenSafe !== false
    },
    leveling: {
      minimumXpPerHour: positiveNumber(leveling.minimumXpPerHour),
      minimumProfit: typeof leveling.minimumProfit === "number" ? leveling.minimumProfit : null,
      requireHuntLevel: leveling.requireHuntLevel !== false
    },
    maxCreatures: positiveNumber(creatures.maxCreatures) ?? profile.maxCreatures
  };
}

/** Picks the character, hunt and spells assigned to this machine. */
export function loadoutFromSnapshot(
  snapshot: BotConfigurationSnapshot,
  machineId: number,
  runSnapshotJson: string | null = null
): RuleEngineLoadout {
  const assignment = [...snapshot.assignments]
    .filter((candidate) => candidate.machineId === machineId && (candidate.status === "active" || candidate.status === "planned"))
    .sort((left, right) => (left.status === right.status ? left.priority - right.priority : left.status === "active" ? -1 : 1))[0] ?? null;
  const character = snapshot.characters.find((candidate) => candidate.id === assignment?.characterId && candidate.enabled) ?? null;
  const hunt = snapshot.hunts.find((candidate) => candidate.id === assignment?.huntId && candidate.enabled) ?? null;
  // The vocation baseline is the default the run snapshot overrides, so a
  // character with no tuning yet still heals and flees like its vocation should.
  const profile = vocationProfile(character?.vocation);
  const settings = decisionSettingsFrom(runSnapshotJson, profile);
  return {
    character,
    hunt,
    skills: snapshot.skills.filter((skill) => skill.enabled),
    bindings: snapshot.clientSpellBindings.filter((binding) => binding.enabled && binding.characterId === character?.id),
    huntSkillRules: snapshot.huntSkillRules.filter((rule) => rule.enabled && (hunt === null || rule.huntId === hunt.id)),
    telemetry: snapshot.huntTelemetry.filter((sample) => character === null || sample.characterId === character.id),
    survival: survivalThresholdsFrom(runSnapshotJson, profile.survival),
    combat: { huntId: hunt?.id ?? null, maxCreatures: settings.maxCreatures },
    targeting: settings.targeting,
    // The refill thresholds keep coming from the same policy the run collector
    // already uses, so panel and bot never disagree about supplies.
    operation: policyFromRunSnapshot(runSnapshotJson),
    loot: settings.loot,
    leveling: settings.leveling
  };
}

function parseJson(value: string | null): unknown {
  try {
    return JSON.parse(value ?? "");
  } catch {
    return {};
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "") : [];
}

function positiveNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export interface RuleEngineStrategyOptions {
  readonly targetComputerId: string;
  readonly mode?: RuleMode;
  readonly modes?: Readonly<Record<string, RuleMode>>;
  readonly gameFocused?: boolean;
  readonly validator?: Partial<ActionValidatorOptions>;
}

export class RuleEngineStrategy implements Strategy {
  readonly name = "rule-engine";
  private latest: { state: GameState; decision: RuleDecision } | null = null;
  private readonly rules;
  private readonly validator: ActionValidator;

  constructor(
    private readonly loadout: RuleEngineLoadout,
    options: RuleEngineStrategyOptions
  ) {
    this.rules = [
      ...createSurvivalRules(loadout.skills, loadout.survival),
      ...createCombatRules(loadout.skills, loadout.huntSkillRules, loadout.combat),
      ...createItemRules(loadout.operation, loadout.loot),
      ...createLevelingRules(loadout.telemetry, loadout.leveling)
    ];
    this.validator = new ActionValidator(
      {
        character: loadout.character,
        skills: loadout.skills,
        bindings: loadout.bindings,
        targetComputerId: options.targetComputerId,
        gameFocused: options.gameFocused ?? false
      },
      {
        ...DEFAULT_VALIDATOR_OPTIONS,
        maxReadingAgeMs: loadout.survival.maxReadingAgeMs,
        defaultMode: options.mode ?? DEFAULT_VALIDATOR_OPTIONS.defaultMode,
        modes: options.modes ?? {},
        ...options.validator
      }
    );
  }

  async plan(event: PerceptionEvent): Promise<readonly InputCommand[]> {
    const state = buildGameState({
      event,
      character: this.loadout.character,
      hunt: this.loadout.hunt,
      observation: event.operationObservation ?? null,
      targeting: this.loadout.targeting
    });
    const decision = decide(state, this.rules, (proposal) => this.validator.validate(proposal, state));
    if (decision.accepted) this.validator.commit(decision.accepted, decision.commands);
    this.latest = { state, decision };
    return decision.commands;
  }

  /** Last state and decision, for the live decision log and the panel. */
  lastDecision(): { readonly state: GameState; readonly decision: RuleDecision } | null {
    return this.latest;
  }
}
