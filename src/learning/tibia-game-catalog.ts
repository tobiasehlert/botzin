export interface TibiaCreatureCatalogEntry {
  readonly race: string;
  readonly name: string;
  /** Wiki taxonomy (Demons, Mammals, The Undead...); present for most creatures. */
  readonly creatureClass: string | null;
  /** In-game Bestiary class. Only creatures actually listed in the Bestiary have one. */
  readonly bestiaryClass: string | null;
  readonly bestiaryDifficulty: string | null;
  readonly bestiaryOccurrence: string | null;
  readonly imageUrl: string;
  readonly description: string;
  readonly behaviour: string;
  readonly hitpoints: number;
  readonly experience: number;
  readonly immune: readonly string[];
  readonly strong: readonly string[];
  readonly weakness: readonly string[];
  readonly healed: readonly string[];
  readonly canBeParalysed: boolean;
  readonly canBeSummoned: boolean;
  readonly summonedMana: number;
  readonly canBeConvinced: boolean;
  readonly convincedMana: number;
  readonly seesInvisible: boolean;
  readonly lootable: boolean;
  readonly loot: readonly string[];
  readonly armor: number;
  readonly mitigation: number;
  readonly maxDamage: number;
  readonly damageByType: Readonly<Record<string, number>>;
  readonly damageModifiers: Readonly<Record<string, number>>;
  readonly attacks: readonly TibiaCreatureAttack[];
  readonly location: string;
  readonly lootDetails: readonly TibiaCreatureLootDrop[];
  readonly communitySourceUrl: string | null;
  readonly communitySourceUpdatedAt: string | null;
}

export interface TibiaCreatureAttack {
  readonly name: string;
  readonly element: string;
  readonly minimum: number;
  readonly maximum: number;
}

export interface TibiaCreatureLootDrop {
  readonly itemName: string;
  readonly amount: string | null;
  readonly rarity: string | null;
}

export interface TibiaItemCatalogEntry {
  readonly sourceId: number;
  readonly name: string;
  readonly categorySlug: string | null;
  readonly categoryName: string | null;
  readonly primaryType: string | null;
  readonly secondaryType: string | null;
  readonly objectClass: string | null;
  readonly wikiUrl: string;
  readonly imagePath: string | null;
  readonly sourceUpdatedAt: string;
}

export interface TibiaItemImageSource {
  readonly sourceId: number;
  readonly name: string;
  readonly assetId: number;
  readonly categorySlug: string | null;
}

interface OfficialCreatureOverviewResponse {
  creatures?: { creature_list?: Array<{ race?: unknown }> };
}

interface OfficialCreatureDetailResponse {
  creature?: Record<string, unknown>;
}

interface ItemPageResponse {
  page?: unknown;
  pageSize?: unknown;
  totalCount?: unknown;
  items?: unknown;
}

const OFFICIAL_CREATURES_URL = "https://api.tibiadata.com/v5/creatures";
const ITEM_API_URL = "https://tibiadata.bytewizards.de/api/v1/items";
const COMMUNITY_CREATURE_API_URL = "https://tibiadata.bytewizards.de/api/v1/creatures";

export async function fetchOfficialCreatureCatalog(
  fetchJson: (url: string) => Promise<unknown> = fetchJsonWithRetry,
  concurrency = 12,
  fetchCommunityJson: (url: string) => Promise<unknown> = fetchJsonWithRetry
): Promise<readonly TibiaCreatureCatalogEntry[]> {
  const overview = await fetchJson(OFFICIAL_CREATURES_URL) as OfficialCreatureOverviewResponse;
  const races = (overview.creatures?.creature_list ?? [])
    .map((entry) => stringValue(entry.race))
    .filter((race): race is string => Boolean(race));
  if (races.length < 600) throw new Error(`Official creature catalog returned only ${races.length} entries.`);
  const communityIndex = await fetchCommunityCreatureIndex(fetchCommunityJson).catch(() => new Map<string, number>());

  const details = await concurrentMap(races, concurrency, async (race) => {
    const [response, community] = await Promise.all([
      fetchJson(`${OFFICIAL_CREATURES_URL.replace(/s$/, "")}/${encodeURIComponent(race)}`) as Promise<OfficialCreatureDetailResponse>,
      fetchCommunityCreature(fetchCommunityJson, race, communityIndex)
    ]);
    return enrichCreature(parseOfficialCreature(response.creature, race), community, race);
  });
  return details.sort((left, right) => left.name.localeCompare(right.name));
}

export async function fetchTibiaItemCatalog(
  fetchJson: (url: string) => Promise<unknown> = fetchJsonWithRetry,
  concurrency = 6
): Promise<readonly TibiaItemCatalogEntry[]> {
  const firstPage = await fetchItemPage(fetchJson, 1);
  const totalPages = Math.ceil(firstPage.totalCount / firstPage.pageSize);
  const pageNumbers = Array.from({ length: Math.max(0, totalPages - 1) }, (_, index) => index + 2);
  const remaining = await concurrentMap(pageNumbers, concurrency, (page) => fetchItemPage(fetchJson, page));
  const items = [firstPage, ...remaining].flatMap((page) => page.items);
  if (items.length < 5_000) throw new Error(`Tibia item catalog returned only ${items.length} entries.`);
  if (new Set(items.map((item) => item.sourceId)).size !== items.length) {
    throw new Error("Tibia item catalog contains duplicate source IDs.");
  }
  return items.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Sprite sources for the local visual training pipeline. The generated item catalog only
 * keeps the storage key, while downloading requires the numeric asset id.
 */
export async function fetchTibiaItemImageSources(
  fetchJson: (url: string) => Promise<unknown> = fetchJsonWithRetry,
  concurrency = 6,
  limit: number | null = null
): Promise<readonly TibiaItemImageSource[]> {
  const first = objectValue(await fetchJson(`${ITEM_API_URL}?page=1&pageSize=100`));
  const pageSize = positiveNumber(first.pageSize, 100);
  let totalPages = Math.ceil(nonNegativeNumber(first.totalCount) / pageSize);
  // A caller that only wants the first N items must not pay for the ~50-request
  // crawl of the full catalog. Entries without a usable image are filtered out
  // after paging, so the caller can receive slightly fewer than `limit` items.
  if (limit !== null) totalPages = Math.min(totalPages, Math.ceil(limit / pageSize));
  const pageNumbers = Array.from({ length: Math.max(0, totalPages - 1) }, (_, index) => index + 2);
  const remaining = await concurrentMap(pageNumbers, concurrency, (page) =>
    fetchJson(`${ITEM_API_URL}?page=${page}&pageSize=${pageSize}`).then(objectValue));
  return [first, ...remaining].flatMap((page) => parseItemImageSources(page));
}

export function parseItemImageSources(value: unknown): TibiaItemImageSource[] {
  return arrayValue(objectValue(value).items).map((raw) => {
    const item = objectValue(raw);
    const image = objectValue(item.primaryImage);
    const assetId = positiveNumber(image.assetId);
    const sourceId = positiveNumber(item.id);
    const name = stringValue(item.name);
    return assetId && sourceId && name ? {
      sourceId,
      name: decodeHtml(name),
      assetId,
      categorySlug: stringValue(item.categorySlug)
    } : null;
  }).filter((entry): entry is TibiaItemImageSource => entry !== null);
}

export function parseOfficialCreature(value: unknown, fallbackRace: string): TibiaCreatureCatalogEntry {
  const creature = objectValue(value);
  return {
    race: stringValue(creature.race) ?? fallbackRace,
    name: requiredCatalogString(creature.name, `creature ${fallbackRace} name`),
    // The official endpoint carries no taxonomy; these are filled by enrichCreature.
    creatureClass: null,
    bestiaryClass: null,
    bestiaryDifficulty: null,
    bestiaryOccurrence: null,
    imageUrl: stringValue(creature.image_url) ?? "",
    description: stringValue(creature.description) ?? "",
    behaviour: stringValue(creature.behaviour) ?? "",
    hitpoints: nonNegativeNumber(creature.hitpoints),
    experience: nonNegativeNumber(creature.experience_points),
    immune: stringArray(creature.immune),
    strong: stringArray(creature.strong),
    weakness: stringArray(creature.weakness),
    healed: stringArray(creature.healed),
    canBeParalysed: booleanValue(creature.be_paralysed),
    canBeSummoned: booleanValue(creature.be_summoned),
    summonedMana: nonNegativeNumber(creature.summoned_mana),
    canBeConvinced: booleanValue(creature.be_convinced),
    convincedMana: nonNegativeNumber(creature.convinced_mana),
    seesInvisible: booleanValue(creature.see_invisible),
    lootable: booleanValue(creature.is_lootable),
    loot: stringArray(creature.loot_list).map(decodeHtml),
    armor: 0,
    mitigation: 0,
    maxDamage: 0,
    damageByType: {},
    damageModifiers: {},
    attacks: [],
    location: "",
    lootDetails: [],
    communitySourceUrl: null,
    communitySourceUpdatedAt: null
  };
}

export function enrichCreature(
  creature: TibiaCreatureCatalogEntry,
  value: unknown,
  sourceName = creature.race
): TibiaCreatureCatalogEntry {
  const detail = objectValue(value);
  const structured = objectValue(detail.structuredData);
  const infobox = objectValue(structured.infobox);
  const combat = objectValue(structured.combatProperties);
  const damageByType = parseMaxDamage(stringValue(infobox.maxDamage) ?? "");
  const damageModifiers = percentRecord(objectValue(structured.resistanceSummary));
  const lootDetails = arrayValue(detail.lootStatistics).map((raw) => {
    const drop = objectValue(raw);
    const itemName = stringValue(drop.itemName);
    return itemName ? {
      itemName: decodeHtml(itemName),
      amount: stringValue(drop.chance),
      rarity: stringValue(drop.rarity)
    } : null;
  }).filter((drop): drop is TibiaCreatureLootDrop => drop !== null);
  return {
    ...creature,
    creatureClass: normalizeCreatureClass(stringValue(infobox.creatureClass)),
    bestiaryClass: normalizeCreatureClass(stringValue(infobox.bestiaryClass)),
    bestiaryDifficulty: stringValue(infobox.bestiaryDifficulty),
    bestiaryOccurrence: stringValue(infobox.bestiaryOccurrence),
    armor: nonNegativeNumber(combat.armor),
    mitigation: nonNegativeNumber(combat.mitigation),
    maxDamage: Object.values(damageByType).reduce((sum, damage) => sum + damage, 0),
    damageByType,
    damageModifiers,
    attacks: parseCreatureAttacks(stringValue(infobox.abilities) ?? ""),
    location: cleanCommunityText(stringValue(infobox.location) ?? ""),
    lootDetails,
    communitySourceUrl: `${COMMUNITY_CREATURE_API_URL}/${encodeURIComponent(nonNegativeNumber(detail.id) || sourceName)}`,
    communitySourceUpdatedAt: stringValue(detail.lastUpdated)
  };
}

const CREATURE_CLASS_ALIASES: Readonly<Record<string, string>> = {
  "the undead": "Undead",
  "special creatures": "Special"
};

/**
 * The wiki spells the same class several ways - "Human" and "Humans", "Special"
 * and "Special Creatures" - and the Bestiary field arrives lowercased. Without
 * folding those together the catalog ends up with duplicate categories.
 */
export function normalizeCreatureClass(value: string | null): string | null {
  const cleaned = value?.trim().toLowerCase();
  if (!cleaned) return null;
  const alias = CREATURE_CLASS_ALIASES[cleaned];
  if (alias) return alias;
  const singular = cleaned.endsWith("s") && !cleaned.endsWith("ss") ? cleaned.slice(0, -1) : cleaned;
  return singular.replace(/(^|\s)\S/g, (character) => character.toUpperCase());
}

export function parseCreatureAttacks(abilities: string): readonly TibiaCreatureAttack[] {
  const attacks: TibiaCreatureAttack[] = [];
  for (const match of abilities.matchAll(/\{\{Melee\|(\d+)-(\d+)/gi)) {
    attacks.push({ name: "Melee", element: "physical", minimum: Number(match[1]), maximum: Number(match[2]) });
  }
  for (const match of abilities.matchAll(/\{\{Ability\|([^|}\n]+)\|(\d+)-(\d+)((?:\|[^}]*)?)\}\}/gi)) {
    const element = match[4]?.match(/\|element=([^|}\n]+)/i)?.[1]?.trim().toLowerCase() ?? "unknown";
    attacks.push({ name: match[1]!.trim(), element, minimum: Number(match[2]), maximum: Number(match[3]) });
  }
  return attacks;
}

function parseMaxDamage(value: string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const match of value.matchAll(/\|([a-z][a-z0-9]*)=(\d+)/gi)) result[match[1]!.toLowerCase()] = Number(match[2]);
  return result;
}

function percentRecord(value: Record<string, unknown>): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!key.endsWith("Percent") || !Number.isFinite(Number(raw))) continue;
    result[key.slice(0, -"Percent".length)] = Number(raw);
  }
  return result;
}

function cleanCommunityText(value: string): string {
  return decodeHtml(value).replace(/\[\[(?:[^\]|]+\|)?([^\]]+)\]\]/g, "$1").replace(/\{\{[^}]+\}\}/g, "").trim();
}

async function fetchCommunityCreature(fetchJson: (url: string) => Promise<unknown>, race: string, index: ReadonlyMap<string, number>): Promise<unknown> {
  try {
    const target = index.get(normalizeCreatureName(race)) ?? race;
    return await fetchJson(`${COMMUNITY_CREATURE_API_URL}/${encodeURIComponent(target)}`);
  } catch {
    return null;
  }
}

async function fetchCommunityCreatureIndex(fetchJson: (url: string) => Promise<unknown>): Promise<Map<string, number>> {
  const first = objectValue(await fetchJson(`${COMMUNITY_CREATURE_API_URL}?page=1&pageSize=100`));
  const total = nonNegativeNumber(first.totalCount);
  const pages = Math.max(1, Math.ceil(total / 100));
  const responses = [first, ...await Promise.all(Array.from({ length: pages - 1 }, (_, index) =>
    fetchJson(`${COMMUNITY_CREATURE_API_URL}?page=${index + 2}&pageSize=100`).then(objectValue)))];
  const result = new Map<string, number>();
  for (const response of responses) for (const raw of arrayValue(response.items)) {
    const item = objectValue(raw); const name = stringValue(item.name); const id = nonNegativeNumber(item.id);
    if (name && id) result.set(normalizeCreatureName(name), id);
  }
  return result;
}

export function normalizeCreatureName(value: string): string {
  return value.toLowerCase().split(/\s+/).map((word) => word.endsWith("ies") ? `${word.slice(0, -3)}y`
    : word.endsWith("ves") ? `${word.slice(0, -3)}f`
    : /(ches|shes|xes|sses|zes)$/.test(word) ? word.slice(0, -2)
    : word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word).join("").replace(/[^a-z0-9]/g, "");
}

export function parseItemPage(value: unknown): { page: number; pageSize: number; totalCount: number; items: TibiaItemCatalogEntry[] } {
  const response = objectValue(value) as ItemPageResponse;
  const rawItems = Array.isArray(response.items) ? response.items : [];
  return {
    page: positiveNumber(response.page, 1),
    pageSize: positiveNumber(response.pageSize, 100),
    totalCount: nonNegativeNumber(response.totalCount),
    items: rawItems.map((raw) => {
      const item = objectValue(raw);
      const image = objectValue(item.primaryImage);
      return {
        sourceId: positiveNumber(item.id),
        name: requiredCatalogString(item.name, "item name"),
        categorySlug: stringValue(item.categorySlug),
        categoryName: stringValue(item.categoryName),
        primaryType: stringValue(item.primaryType),
        secondaryType: stringValue(item.secondaryType),
        objectClass: stringValue(item.objectClass),
        wikiUrl: stringValue(item.wikiUrl) ?? "",
        imagePath: stringValue(image.storageKey),
        sourceUpdatedAt: stringValue(item.lastUpdated) ?? ""
      };
    })
  };
}

async function fetchItemPage(fetchJson: (url: string) => Promise<unknown>, page: number) {
  return parseItemPage(await fetchJson(`${ITEM_API_URL}?page=${page}&pageSize=100`));
}

async function fetchJsonWithRetry(url: string): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { "user-agent": "botzin-game-catalog/0.1" } });
      if (response.ok) return response.json();
      if (response.status !== 429 && response.status < 500) {
        throw new Error(`Could not fetch ${url}: HTTP ${response.status}.`);
      }
      lastError = new Error(`Could not fetch ${url}: HTTP ${response.status}.`);
    } catch (error) {
      lastError = error;
    }
    await wait(attempt * 750);
  }
  throw lastError instanceof Error ? lastError : new Error(`Could not fetch ${url}.`);
}

async function concurrentMap<T, R>(values: readonly T[], concurrency: number, mapper: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await mapper(values[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return results;
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayValue(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requiredCatalogString(value: unknown, field: string): string {
  const parsed = stringValue(value);
  if (!parsed) throw new Error(`Missing ${field} in catalog response.`);
  return decodeHtml(parsed);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(stringValue).filter((item): item is string => Boolean(item)) : [];
}

function nonNegativeNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function positiveNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function decodeHtml(value: string): string {
  return value.replaceAll("&#39;", "'").replaceAll("&amp;", "&").replaceAll("&quot;", '"');
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
