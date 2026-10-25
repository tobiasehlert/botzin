export const TIBIA_KNOWLEDGE_DOMAINS = [
  "achievement", "book", "boss", "building", "charm", "city", "event", "hunting-place",
  "market", "mechanic", "mount", "mystery", "npc", "npc-dialogue", "outfit", "quest", "rune", "soul-core"
  , "wheel"
] as const;

export type TibiaKnowledgeDomain = (typeof TIBIA_KNOWLEDGE_DOMAINS)[number];
export type TibiaKnowledgeTrust = "official" | "community" | "user";

export interface TibiaKnowledgeEntry {
  readonly key: string;
  readonly domain: TibiaKnowledgeDomain;
  readonly name: string;
  readonly summary: string | null;
  readonly content: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly sourceUrl: string;
  readonly sourceUpdatedAt: string | null;
  readonly trust: TibiaKnowledgeTrust;
  readonly volatile: boolean;
}

const COMMUNITY_API = "https://tibiadata.bytewizards.de/api/v1";

const DETAIL_DOMAINS = [
  ["achievement", "achievements"],
  ["quest", "quests"],
  ["hunting-place", "hunting-places"],
  ["npc", "npcs"],
  ["charm", "charms"]
] as const;

const LIST_DOMAINS = [
  ["mount", "mounts"],
  ["outfit", "outfits"],
  ["building", "buildings"]
] as const;

export async function fetchTibiaGeneralKnowledge(
  fetcher: (url: string) => Promise<unknown> = fetchJson
): Promise<readonly TibiaKnowledgeEntry[]> {
  const detailed = await Promise.all(DETAIL_DOMAINS.map(async ([domain, endpoint]) => {
    const list = recordArray(await fetcher(`${COMMUNITY_API}/${endpoint}/list`));
    return mapConcurrent(list, 12, async (item) => {
      const id = requiredNumber(item.id, `${endpoint} id`);
      const detail = record(await fetcher(`${COMMUNITY_API}/${endpoint}/${id}`));
      return communityEntry(domain, id, detail);
    });
  }));

  const summaries = await Promise.all(LIST_DOMAINS.map(async ([domain, endpoint]) =>
    recordArray(await fetcher(`${COMMUNITY_API}/${endpoint}/list`))
      .map((item) => communityEntry(domain, requiredNumber(item.id, `${endpoint} id`), item))
  ));

  const bosses = await fetchBosses(fetcher);
  const community = [...detailed.flat(), ...summaries.flat(), ...bosses];
  return [...community, ...cityEntries(community)].sort(compareEntries);
}

export function officialRuneEntries(spells: readonly {
  readonly id: string;
  readonly name: string;
  readonly words: string | null;
  readonly type: "instant" | "rune";
  readonly group: string;
  readonly requiredLevel: number | null;
  readonly manaCost: number | null;
  readonly manaText: string;
  readonly premium: boolean;
  readonly vocations: readonly string[];
  readonly description?: string | null;
  readonly cooldownSeconds?: number | null;
  readonly groupCooldownSeconds?: number | null;
  readonly soulPoints?: number | null;
  readonly amount?: number | null;
  readonly runeVocations?: readonly string[];
  readonly runeGroup?: string | null;
  readonly runeRequiredLevel?: number | null;
  readonly runeMagicLevel?: number | null;
}[]): readonly TibiaKnowledgeEntry[] {
  return spells.filter((spell) => spell.type === "rune").map((spell) => ({
    key: `official:rune:${spell.id}`,
    domain: "rune",
    name: spell.name,
    summary: `${spell.group}; cria ${spell.amount ?? "?"} runa(s) por ${spell.manaText} mana e ${spell.soulPoints ?? "?"} soul point(s)`,
    content: [
      spell.description ? `Efeito: ${spell.description}` : null,
      spell.words ? `Palavras: ${spell.words}.` : null,
      `Criação: ${spell.manaText} mana, ${spell.soulPoints ?? "não informado"} soul point(s), ${spell.amount ?? "não informada"} unidade(s), level ${spell.requiredLevel ?? "variável"}; vocações: ${spell.vocations.join(", ")}.`,
      `Uso: level ${spell.runeRequiredLevel ?? "não informado"}, magic level ${spell.runeMagicLevel ?? "não informado"}, grupo ${spell.runeGroup ?? "não informado"}; vocações: ${spell.runeVocations?.join(", ") || "não informadas"}.`,
      `Cooldown: ${spell.cooldownSeconds ?? "não informado"}s; cooldown do grupo: ${spell.groupCooldownSeconds ?? "não informado"}s. Premium: ${spell.premium ? "sim" : "não"}.`
    ].filter(Boolean).join(" "),
    metadata: { ...spell, detailSourceUrl: "https://tibiadata.bytewizards.de/api/v1/spells", detailTrust: "community" },
    sourceUrl: "https://www.tibia.com/library/?subtopic=spells",
    sourceUpdatedAt: null,
    trust: "official",
    volatile: false
  }));
}

export const OFFICIAL_MECHANIC_KNOWLEDGE: readonly TibiaKnowledgeEntry[] = [
  {
    key: "official:mechanic:shared-experience", domain: "mechanic", name: "Faixa de level do Shared Experience",
    summary: "Para upar com Shared Experience, o menor level precisa ter pelo menos 2/3 do maior.",
    content: "O menor personagem da party não pode ter menos de dois terços do level do maior. O level mínimo é o arredondamento para cima de maior level × 2 ÷ 3. Além disso, os membros precisam permanecer dentro da distância permitida e participar ativamente do combate.",
    metadata: { formula: "lowestLevel * 3 >= highestLevel * 2", minimumLevel: "ceil(highestLevel * 2 / 3)", appliesTo: "leveling" },
    sourceUrl: "https://www.tibia.com/support/?entryid=91&subtopic=gethelp",
    sourceUpdatedAt: null, trust: "official", volatile: false
  },
  {
    key: "official:mechanic:market", domain: "market", name: "Market do Tibia",
    summary: "Ofertas e estatísticas são específicas por mundo e mudam continuamente.",
    content: "O Market é acessado pelo depot. Preços médios, ofertas, volume e histórico variam por mundo. Dados de preço precisam ser capturados com mundo, item, momento e origem; uma fotografia antiga nunca deve autorizar uma compra automaticamente.",
    metadata: { requiresWorld: true, requiresLiveSnapshot: true },
    sourceUrl: "https://www.tibia.com/gameguides/?section=controls_trading&subtopic=manual",
    sourceUpdatedAt: null, trust: "official", volatile: true
  },
  {
    key: "official:mechanic:boosts", domain: "mechanic", name: "Boosts, criatura e boss do dia",
    summary: "Boosts e destaques diários expiram e precisam ser consultados novamente.",
    content: "Criatura e boss destacados são informações diárias. XP boosts da Store e bônus de eventos têm regras e duração próprias. A IA deve verificar o estado atual e o horário do server save antes de planejar com qualquer boost.",
    metadata: { refresh: "daily", officialStatusEndpoint: "https://api.tibiadata.com/v5/boostablebosses" },
    sourceUrl: "https://www.tibia.com/news/?subtopic=newsarchive", sourceUpdatedAt: null,
    trust: "official", volatile: true
  },
  {
    key: "official:event:schedule", domain: "event", name: "Calendário oficial de eventos",
    summary: "Agenda oficial; datas podem ser alteradas e devem ser revalidadas.",
    content: "O calendário oficial informa eventos e o início ou término no server save. A IA deve consultar o mês corrente antes de depender de Rapid Respawn, Double XP/Skill, world changes ou eventos sazonais.",
    metadata: { refresh: "daily", timezone: "CEST/server-save" },
    sourceUrl: "https://www.tibia.com/news/?subtopic=eventcalendar", sourceUpdatedAt: null,
    trust: "official", volatile: true
  },
  {
    key: "official:soul-core:soulpit", domain: "soul-core", name: "Soul Cores e Soulpit",
    summary: "Mecânica de Soul Cores e uso no Soulpit; exige validação da criatura e recursos.",
    content: "Soul Cores são ligados à mecânica do Soulpit. Antes de usar um core, a IA deve confirmar a criatura associada, custos, disponibilidade, objetivo e risco; conteúdo de atualização pode mudar e deve ser revalidado.",
    metadata: { feature: "Soulpit", refresh: "on-game-update" },
    sourceUrl: "https://www.tibia.com/news/?id=7895&subtopic=newsarchive", sourceUpdatedAt: null,
    trust: "official", volatile: true
  }
];

export const CURATED_WHEEL_KNOWLEDGE: readonly TibiaKnowledgeEntry[] = [
  {
    key: "official:wheel:overview", domain: "wheel", name: "Roda do Destino — funcionamento",
    summary: "Personagens promovidos premium recebem pontos para Dedication, Conviction e Revelation.",
    content: "A Roda do Destino fica disponível para personagens promovidos com Premium a partir do level 51. Cada level concede um promotion point. A roda possui quatro domínios e 36 fatias. Dedication concede atributos, Conviction modifica magias e Revelation libera uma habilidade forte conforme os pontos investidos no domínio. Pontos podem ser alocados e removidos livremente; para aplicar ou restaurar uma configuração, faça a alteração em um templo.",
    metadata: { minimumLevel: 51, requiresPromotion: true, requiresPremium: true, pointsPerLevel: 1, domains: 4, slices: 36, perkTypes: ["dedication", "conviction", "revelation"], applyLocation: "temple" },
    sourceUrl: "https://www.tibia.com/news/?id=7013&subtopic=newsarchive", sourceUpdatedAt: "2022-11-18T00:00:00.000Z",
    trust: "official", volatile: true
  },
  {
    key: "community:wheel:points-and-thresholds:2026", domain: "wheel", name: "Roda do Destino — pontos extras e estágios",
    summary: "Revelation Perks avançam nos marcos de 250, 500 e 1000 pontos no domínio.",
    content: "Além dos pontos por level, há fontes limitadas de promotion points extras. Os estágios de Revelation são atingidos ao investir 250, 500 e 1000 pontos no mesmo domínio. A disponibilidade e os custos de fontes extras devem ser conferidos no planner atual antes de recomendar uma build.",
    metadata: { revelationThresholds: [250, 500, 1000], extraPointSources: ["promotion scrolls", "vocation quest", "Hunting Task Shop", "upgraded mods"], validateWithPlanner: true },
    sourceUrl: "https://tibia.fandom.com/wiki/Wheel_of_Destiny", sourceUpdatedAt: "2026-06-02T00:00:00.000Z",
    trust: "community", volatile: true
  },
  {
    key: "official:wheel:current-balance:2026-06", domain: "wheel", name: "Roda do Destino — balanceamento atual",
    summary: "Perks e modificações por vocação foram ajustados em 2 de junho de 2026.",
    content: "As decisões da roda são específicas por vocação e objetivo (solo, party, hunt ou boss). A IA deve usar o Wheel of Destiny Planner oficial e revalidar nomes, valores e custos depois de cada balanceamento; não deve reutilizar uma build antiga automaticamente.",
    metadata: { effectiveDate: "2026-06-02", appliesTo: ["druid", "knight", "monk", "paladin", "sorcerer"], plannerUrl: "https://www.tibia.com/community/?subtopic=wheelofdestinyplanner", refresh: "on-game-update" },
    sourceUrl: "https://www.tibia.com/news/?id=8833&subtopic=newsarchive", sourceUpdatedAt: "2026-06-02T00:00:00.000Z",
    trust: "official", volatile: true
  }
];

export const USER_TAUGHT_KNOWLEDGE: readonly TibiaKnowledgeEntry[] = [
  {
    key: "user:party:composition:v1",
    domain: "mechanic",
    name: "Composição de party ensinada pelo usuário",
    summary: "Party para upar de 2 a 5; boss/quest podem ter mais; núcleo recomendado EK+ED.",
    content: "Uma party para upar normalmente tem 2, 3, 4 ou 5 personagens. Normalmente a composição é formada a partir de EK e ED. Para upar, não pode repetir vocação e o máximo é 5. Para boss ou quest, pode repetir vocação e a party pode ter mais de 5 personagens quando o conteúdo exigir.",
    metadata: {
      normalPartySize: { minimum: 2, maximum: 5, allowed: [2, 3, 4, 5] },
      preferredCore: ["knight", "druid"],
      purposes: {
        leveling: {
          minimumSize: 2, maximumSize: 5, duplicateVocationsAllowed: false,
          sharedExperienceLevelRule: "lowestLevel * 3 >= highestLevel * 2",
          officialKnowledgeKey: "official:mechanic:shared-experience"
        },
        boss: { minimumSize: 2, maximumSize: null, duplicateVocationsAllowed: true, largerPartyAllowed: true },
        quest: { minimumSize: 2, maximumSize: null, duplicateVocationsAllowed: true, largerPartyAllowed: true }
      },
      taughtBy: "user"
    },
    sourceUrl: "user://party-composition-rule",
    sourceUpdatedAt: null,
    trust: "user",
    volatile: false
  }
];

export const CURATED_MYSTERY_KNOWLEDGE: readonly TibiaKnowledgeEntry[] = [
  {
    key: "community:mystery:469",
    domain: "mystery",
    name: "Linguagem 469 dos Bonelords",
    summary: "Mistério sem tradução publicamente comprovada; teorias não devem ser tratadas como solução.",
    content: "469 é apresentada no jogo como uma linguagem numérica associada aos Bonelords e aparece em livros e falas. Existem propostas de tradução e relações sugeridas com outros mistérios, mas nenhuma solução pública possui evidência suficiente para ser classificada como confirmada. A IA deve preservar sequências originais como evidência, comparar fontes e rotular qualquer interpretação como hipótese.",
    metadata: {
      resolutionStatus: "unresolved",
      subject: "Bonelord language",
      facts: [
        "Há textos numéricos atribuídos à linguagem 469 dentro do jogo.",
        "NPCs e materiais do jogo fazem referências à linguagem dos Bonelords."
      ],
      hypotheses: [],
      rejectedClaims: [],
      evidencePolicy: "No theory becomes confirmed without reproducible in-game or official evidence.",
      references: [
        "https://www.tibiawiki.com.br/wiki/469",
        "https://tibia.fandom.com/wiki/469"
      ]
    },
    sourceUrl: "https://www.tibiawiki.com.br/wiki/469",
    sourceUpdatedAt: null,
    trust: "community",
    volatile: true
  }
];

async function fetchBosses(fetcher: (url: string) => Promise<unknown>): Promise<TibiaKnowledgeEntry[]> {
  const first = record(await fetcher(`${COMMUNITY_API}/bosstiary/creatures?page=1&pageSize=100`));
  const total = requiredNumber(first.totalCount, "bosstiary totalCount");
  const pages = Math.ceil(total / 100);
  const responses = await Promise.all(Array.from({ length: pages }, (_, index) => index === 0
    ? first
    : fetcher(`${COMMUNITY_API}/bosstiary/creatures?page=${index + 1}&pageSize=100`).then(record)));
  return responses.flatMap((response) => recordArray(response.items)).map((boss) => {
    const name = requiredString(boss.creatureName, "boss name");
    const category = optionalString(boss.categoryName);
    const totalKills = optionalNumber(boss.totalKillsRequired);
    return {
      key: `community:boss:${requiredNumber(boss.creatureId, "boss id")}`,
      domain: "boss" as const,
      name,
      summary: [category, totalKills === null ? null : `${totalKills} abates para completar`].filter(Boolean).join(" · ") || null,
      content: `Boss ${name}. Categoria: ${category ?? "não informada"}. Progressão do Bosstiary: ${JSON.stringify(boss.levelRequirements ?? [])}.`,
      metadata: cleanMetadata(boss),
      sourceUrl: "https://tibia.fandom.com/wiki/Bosstiary",
      sourceUpdatedAt: optionalString(boss.lastUpdated),
      trust: "community" as const,
      volatile: false
    };
  });
}

function communityEntry(domain: TibiaKnowledgeDomain, id: number, value: Record<string, unknown>): TibiaKnowledgeEntry {
  const name = requiredString(value.name ?? value.title, `${domain} name`);
  const wikiUrl = optionalString(value.wikiUrl) ?? `https://tibia.fandom.com/wiki/${encodeURIComponent(name.replaceAll(" ", "_"))}`;
  return {
    key: `community:${domain}:${id}`,
    domain,
    name,
    summary: optionalString(value.summary) ?? domainSummary(domain, value),
    content: domainContent(domain, value),
    metadata: domain === "hunting-place" ? { ...cleanMetadata(value), huntingProfile: huntingProfile(value) } : cleanMetadata(value),
    sourceUrl: wikiUrl,
    sourceUpdatedAt: optionalString(value.lastUpdated),
    trust: "community",
    volatile: false
  };
}

export function huntingProfile(value: Record<string, unknown>): Record<string, unknown> {
  const structured = recordOrNull(value.structuredData);
  const infobox = structured ? recordOrNull(structured.infobox) : null;
  const sections = structured && Array.isArray(structured.areaCreatureSummaries) ? structured.areaCreatureSummaries : [];
  const creatures = new Set<string>();
  for (const sectionValue of sections) {
    const section = recordOrNull(sectionValue);
    if (!section || !Array.isArray(section.creatures)) continue;
    for (const creatureValue of section.creatures) {
      const creature = recordOrNull(creatureValue);
      const name = creature ? optionalString(creature.name) : null;
      if (name) creatures.add(name);
    }
  }
  const bestLoot = infobox ? [1, 2, 3, 4, 5].map((index) => optionalString(infobox[`bestloot${index}`])).filter((item): item is string => Boolean(item)) : [];
  return {
    city: optionalString(value.city) ?? (infobox ? optionalString(infobox.city) : null),
    location: optionalString(value.location) ?? (infobox ? optionalString(infobox.location) : null),
    vocation: optionalString(value.vocation) ?? (infobox ? optionalString(infobox.vocation) : null),
    recommendedLevels: {
      knight: optionalString(value.levelKnights) ?? (infobox ? optionalString(infobox.lvlknights) : null),
      paladin: optionalString(value.levelPaladins) ?? (infobox ? optionalString(infobox.lvlpaladins) : null),
      mage: optionalString(value.levelMages) ?? (infobox ? optionalString(infobox.lvlmages) : null)
    },
    experience: optionalString(value.experience) ?? (infobox ? optionalString(infobox.exp) : null),
    experienceStars: infobox ? optionalString(infobox.expstar) : null,
    loot: optionalString(value.loot) ?? (infobox ? optionalString(infobox.loot) : null),
    lootStars: infobox ? optionalString(infobox.lootstar) : null,
    bestLoot,
    creatures: [...creatures]
  };
}

function domainSummary(domain: TibiaKnowledgeDomain, value: Record<string, unknown>): string | null {
  if (domain === "achievement") return optionalString(value.description);
  if (domain === "charm") return optionalString(value.effect);
  return null;
}

function domainContent(domain: TibiaKnowledgeDomain, value: Record<string, unknown>): string {
  const structured = recordOrNull(value.structuredData);
  const infobox = structured ? recordOrNull(structured.infobox) : null;
  const parts: unknown[] = [value.summary];
  if (domain === "achievement") parts.push(value.description, value.spoiler, value.grade && `Grade: ${value.grade}`, value.points && `Pontos: ${value.points}`);
  else if (domain === "quest") parts.push(infobox?.legend, infobox?.location, infobox?.reward, infobox?.dangers, infobox?.level, infobox?.levelRecommended);
  else if (domain === "hunting-place") parts.push(value.city, value.location, value.vocation, value.levelKnights, value.levelPaladins, value.levelMages, value.loot, value.experience, wikiBody(value.rawWikiText));
  else if (domain === "npc") parts.push(infobox?.city, infobox?.location, infobox?.job, infobox?.notes, infobox?.buySell);
  else if (domain === "charm") parts.push(value.type, value.cost, value.effect, value.notes);
  else parts.push(value.title, value.city, value.location, value.type);
  const content = parts.flatMap(textValues).map(cleanWikiText).filter(Boolean).join("\n");
  return content || requiredString(value.name ?? value.title, `${domain} content`);
}

function cityEntries(entries: readonly TibiaKnowledgeEntry[]): TibiaKnowledgeEntry[] {
  const cities = new Map<string, { name: string; npcs: string[]; hunts: string[]; buildings: string[] }>();
  for (const entry of entries) {
    const city = metadataString(entry.metadata, "city") ?? metadataInfoboxString(entry.metadata, "city");
    if (!city || city === "Unknown") continue;
    const cityKey = slug(city.replaceAll("’", "'"));
    const grouped = cities.get(cityKey) ?? { name: city.replaceAll("’", "'"), npcs: [], hunts: [], buildings: [] };
    if (entry.domain === "npc") grouped.npcs.push(entry.name);
    if (entry.domain === "hunting-place") grouped.hunts.push(entry.name);
    if (entry.domain === "building") grouped.buildings.push(entry.name);
    cities.set(cityKey, grouped);
  }
  return [...cities.entries()].map(([cityKey, grouped]) => ({
    key: `derived:city:${cityKey}`, domain: "city", name: grouped.name,
    summary: `${grouped.npcs.length} NPCs · ${grouped.hunts.length} hunts · ${grouped.buildings.length} prédios`,
    content: [`Cidade ${grouped.name}.`, listText("NPCs", grouped.npcs), listText("Hunts", grouped.hunts), listText("Prédios", grouped.buildings)].filter(Boolean).join("\n"),
    metadata: { counts: { npcs: grouped.npcs.length, huntingPlaces: grouped.hunts.length, buildings: grouped.buildings.length } },
    sourceUrl: `https://tibia.fandom.com/wiki/${encodeURIComponent(grouped.name.replaceAll(" ", "_"))}`,
    sourceUpdatedAt: null, trust: "community", volatile: false
  }));
}

function cleanMetadata(value: Record<string, unknown>): Record<string, unknown> {
  const { rawWikiText: _raw, plainTextContent: _plain, ...metadata } = value;
  return metadata;
}

function wikiBody(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let depth = 0;
  let end = -1;
  for (let index = 0; index < value.length - 1; index += 1) {
    const pair = value.slice(index, index + 2);
    if (pair === "{{") { depth += 1; index += 1; }
    else if (pair === "}}") { depth -= 1; index += 1; if (depth === 0) { end = index + 1; break; } }
  }
  return end >= 0 ? value.slice(end) : value;
}

export function cleanWikiText(value: string): string {
  return value
    .replace(/<!--([\s\S]*?)-->/g, " ")
    .replace(/\[\[(?:File|Image):[^\]]+\]\]/gi, " ")
    .replace(/\[\[[^\]|]+\|([^\]]+)\]\]/g, "$1")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\{\{Mapper Coords\|([^}]+)\}\}/gi, (_match, coordinates: string) => `coordenadas ${coordinates.split("|").slice(0, 3).join(", ")}`)
    .replace(/\{\{[^{}]*\}\}/g, " ")
    .replace(/<\/?(?:br|div|span|gallery)[^>]*>/gi, " ")
    .replace(/'{2,}/g, "")
    .replace(/^=+|=+$/gm, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function fetchJson(url: string): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { "user-agent": "botzin-game-knowledge/0.1 (+local educational project)" } });
      if (response.ok) return response.json();
      if (response.status < 500 && response.status !== 429) throw new Error(`HTTP ${response.status} for ${url}`);
      lastError = new Error(`HTTP ${response.status} for ${url}`);
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, attempt * 500));
  }
  throw lastError instanceof Error ? lastError : new Error(`Could not fetch ${url}`);
}

async function mapConcurrent<T, R>(values: readonly T[], concurrency: number, mapper: (value: T) => Promise<R>): Promise<R[]> {
  const result = new Array<R>(values.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = next++;
      if (index >= values.length) return;
      result[index] = await mapper(values[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return result;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected API object.");
  return value as Record<string, unknown>;
}
function recordOrNull(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function recordArray(value: unknown): Record<string, unknown>[] { if (!Array.isArray(value)) throw new Error("Expected API array."); return value.map(record); }
function requiredString(value: unknown, field: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`Missing ${field}.`); return value.trim(); }
function optionalString(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function requiredNumber(value: unknown, field: string): number { const result = Number(value); if (!Number.isSafeInteger(result)) throw new Error(`Invalid ${field}.`); return result; }
function optionalNumber(value: unknown): number | null { const result = Number(value); return Number.isFinite(result) ? result : null; }
function textValues(value: unknown): string[] { if (typeof value === "string") return [value]; if (typeof value === "number") return [String(value)]; return []; }
function metadataString(metadata: Readonly<Record<string, unknown>>, key: string): string | null { return optionalString(metadata[key]); }
function metadataInfoboxString(metadata: Readonly<Record<string, unknown>>, key: string): string | null { const structured = recordOrNull(metadata.structuredData); const infobox = structured && recordOrNull(structured.infobox); return infobox ? optionalString(infobox[key]) : null; }
function listText(label: string, values: readonly string[]): string { return values.length ? `${label}: ${values.join(", ")}.` : ""; }
function slug(value: string): string { return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }
function compareEntries(left: TibiaKnowledgeEntry, right: TibiaKnowledgeEntry): number { return left.domain.localeCompare(right.domain) || left.name.localeCompare(right.name); }
