export interface User {
  id: number;
  username: string;
  displayName: string;
  role: string;
}

export interface Account {
  id: number;
  name: string;
  loginIdentifier?: string;
}

export interface Character {
  id: number;
  name: string;
  accountId: number;
  world?: string;
  vocation?: string;
  level?: number;
}

export interface Machine {
  id: number;
  nodeId: string;
  name: string;
  role?: string;
  preferredHost?: string | null;
  connectionNotes?: string | null;
  runtimeConfig: MachineRuntimeConfig;
  obsWebSocketPasswordConfigured: boolean;
  enabled?: boolean;
}

export interface MachineRuntimeConfig {
  coordinatorHost: string;
  coordinatorPort: number;
  networkBindHost: string;
  networkPreferredKinds: string[];
  networkAdvertiseHosts: string[];
  obsWebSocketUrl: string;
  obsSourceName: string;
  frameSource: "mock" | "obs";
  obsProcessName: string;
  tibiaProcessName: string;
  tibiaSourceName: string;
  detector: "mock" | "onnx";
  onnxModelPath: string;
  onnxLabelsPath: string;
  onnxInputWidth: number;
  onnxInputHeight: number;
  detectionConfidence: number;
  detectionIou: number;
  raspberryHost: string;
  raspberryPort: number;
  runFrameIntervalMs: number;
}

export interface Hunt {
  id: number;
  name: string;
  city?: string;
}

export interface Skill {
  id: number;
  name: string;
  spellWords?: string | null;
  allowedVocations: string[];
  category?: string;
  manaCost?: number | null;
  requiredLevel?: number;
  enabled?: boolean;
}

export interface ClientSpellBinding {
  id: number;
  characterId: number;
  skillId: number;
  hotkey: string;
  multiActionSlot: 1 | 2 | 3;
  castMode: "hotkey" | "spell-words";
  targetMode: "self" | "current-target" | "crosshair";
  requireGameFocus: boolean;
  lastVerifiedAt: string | null;
  enabled: boolean;
}

export interface Assignment {
  id: number;
  machineId: number;
  characterId: number;
  huntId: number;
  status: string;
  priority?: number;
  minStaminaMinutes: number;
  refillConfigJson: string | null;
}

export interface HuntSkillRule {
  id: number;
  huntId: number;
  skillId: number;
  priority?: number;
}

export interface HuntTelemetry {
  id: number;
  characterId: number;
  huntId: number;
  assignmentId: number | null;
  runId: number | null;
  capturedAt: string;
  durationSeconds: number | null;
  xpRatePercent: number;
  xpGain: number | null;
  rawXpGain: number | null;
  xpPerHour: number | null;
  rawXpPerHour: number | null;
  lootValue: number | null;
  suppliesValue: number | null;
  profit: number | null;
  creaturesJson: string | null;
  source: string;
}

export interface CharacterRun {
  id: number;
  assignmentId: number;
  machineId: number;
  characterId: number;
  huntId: number;
  status: "running" | "completed" | "aborted";
  clientVersion: string | null;
  loadoutJson: string | null;
  routeSnapshotJson: string | null;
  startedAt: string;
  endedAt: string | null;
  notes: string | null;
}

export interface CatalogPage<T> {
  query: string;
  limit: number;
  offset: number;
  total: number;
  items: T[];
}

export interface CreatureCatalogRecord {
  id: number;
  race: string;
  name: string;
  imageUrl: string | null;
  description: string | null;
  behaviour: string | null;
  hitpoints: number;
  experience: number;
  immune: string[];
  strong: string[];
  weakness: string[];
  healed: string[];
  canBeParalysed: boolean;
  canBeSummoned: boolean;
  summonedMana: number;
  canBeConvinced: boolean;
  convincedMana: number;
  seesInvisible: boolean;
  lootable: boolean;
  loot: string[];
  armor: number;
  mitigation: number;
  maxDamage: number;
  damageByType: Record<string, number>;
  damageModifiers: Record<string, number>;
  attacks: Array<{ name: string; element: string; minimum: number; maximum: number }>;
  location: string | null;
  lootDetails: Array<{ itemName: string; amount: string | null; rarity: string | null }>;
  communitySourceUrl: string | null;
  communitySourceUpdatedAt: string | null;
  sourceUrl: string;
}

export interface ItemCatalogRecord {
  id: number;
  sourceId: number;
  name: string;
  categorySlug: string | null;
  categoryName: string | null;
  primaryType: string | null;
  secondaryType: string | null;
  objectClass: string | null;
  wikiUrl: string | null;
  imagePath: string | null;
  sourceUpdatedAt: string | null;
  sourceUrl: string;
}

export interface GameKnowledgeRecord {
  id: number;
  key: string;
  domain: string;
  name: string;
  summary: string | null;
  content: string;
  metadata: Record<string, unknown>;
  sourceUrl: string;
  sourceUpdatedAt: string | null;
  trust: "official" | "community" | "user";
  volatile: boolean;
}

export interface GameKnowledgeCoverage {
  total: number;
  official: number;
  community: number;
  user: number;
  volatile: number;
  domains: Array<{ domain: string; count: number }>;
}

export interface TibiaLiveStatus {
  fetchedAt: string;
  boostedCreature: { name: string; imageUrl: string | null };
  boostedBoss: { name: string; imageUrl: string | null };
  eventScheduleUrl: string;
  marketRequiresWorldSnapshot: true;
}

export interface LearningMethod {
  id: number;
  name: string;
  methodType: string;
  scope?: string;
  huntId?: number;
  characterId?: number;
}

export interface LearningSource {
  id: number;
  name: string;
  sourceType: string;
  status?: string;
}

export interface LearningMethodSource {
  methodId: number;
  sourceId: number;
  role: string;
  weight?: number;
}

export interface LearningSession {
  id: number;
  name: string;
  methodId: number;
  assignmentId?: number;
  status: string;
}

export interface LearningEvent {
  id: number;
  sessionId: number;
  eventType: string;
  reward: number | null;
}

export interface DecisionFeedback {
  id: number;
  learningEventId: number | null;
  assignmentId: number | null;
  rating: "good" | "bad" | "unsafe" | "unknown";
}

export interface KnowledgeCoverage {
  indexedDocuments: number;
  indexedChunks: number;
  reviewedDocuments: number;
  generatedAt: string | null;
}

export interface KnowledgeSearchResult {
  id: string;
  videoId: string;
  title: string;
  url: string;
  startSeconds: number;
  endSeconds: number;
  text: string;
  reviewed: boolean;
  publishedAt?: string | null;
  gameVersion?: string | null;
  freshness?: "current" | "legacy" | "unknown";
  freshnessWarning?: string | null;
  score: number;
}

export interface LiveDecisionRecord {
  id: string;
  observedAt: string;
  sourceComputerId: string;
  strategy: string;
  mode: "observe" | "suggest";
  status: "observed" | "suggested" | "error";
  decision: string;
  reasons: string[];
  evaluation?: Array<{
    source: string;
    priority: number;
    band: string;
    action: string;
    reason: string;
    rejectedBecause: string | null;
  }>;
  perceptionConfidence: number | null;
  frame?: { id: string; width: number; height: number } | null;
  entities?: Array<{
    id: string;
    kind: "player" | "creature" | "npc" | "player-summon" | "item" | "effect" | "missile" | "unknown";
    confidence: number;
    label?: string;
    box: { x: number; y: number; width: number; height: number };
  }>;
  entityCounts: {
    player: number;
    creature: number;
    npc: number;
    "player-summon": number;
    item: number;
    effect: number;
    missile: number;
    unknown: number;
  };
  commands: Array<{ id: string; type: string }>;
  error: string | null;
}

export interface LiveDecisionSnapshot {
  active: boolean;
  lastSeenAt: string | null;
  records: LiveDecisionRecord[];
}

export interface AppState {
  accounts: Account[];
  characters: Character[];
  machines: Machine[];
  hunts: Hunt[];
  skills: Skill[];
  clientSpellBindings: ClientSpellBinding[];
  assignments: Assignment[];
  huntSkillRules: HuntSkillRule[];
  huntTelemetry: HuntTelemetry[];
  characterRuns: CharacterRun[];
  learningMethods: LearningMethod[];
  learningSources: LearningSource[];
  learningMethodSources: LearningMethodSource[];
  learningSessions: LearningSession[];
  learningEvents: LearningEvent[];
  decisionFeedback: DecisionFeedback[];
}
