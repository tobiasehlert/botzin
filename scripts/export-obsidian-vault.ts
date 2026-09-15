/**
 * Generates an Obsidian vault from everything the bot knows about Tibia.
 *
 * Obsidian is not a dependency and nothing gets installed into the project: a
 * vault is just a folder of markdown files linked with [[wikilinks]]. This writes
 * that folder; you open it with File > Open folder as vault.
 *
 *   npm run vault:export
 *   npm run vault:export -- --output D:/vaults/botzin --no-assets
 */
import { copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Pool, RowDataPacket } from "mysql2/promise";
import { loadRuntimeConfig } from "../src/config/runtime-config.js";
import { createMysqlPool } from "../src/database/mysql-pool.js";
import { GameCatalogRepository, type CreatureCatalogRecord, type GameKnowledgeRecord, type ItemCatalogRecord } from "../src/database/game-catalog-repository.js";

const PAGE = 500;

interface Options {
  readonly output: string;
  readonly assets: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const outputIndex = argv.indexOf("--output");
  return {
    output: resolve(outputIndex === -1 ? "obsidian-vault" : argv[outputIndex + 1] ?? "obsidian-vault"),
    assets: !argv.includes("--no-assets")
  };
}

/**
 * Obsidian and Windows both refuse some characters, and `[]#^|` additionally
 * break wikilink parsing even when the filesystem accepts them.
 */
function safeName(value: string): string {
  const cleaned = value.replace(/[\\/:*?"<>|[\]#^]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, 90) || "sem-nome";
}

function quote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

/** Path-qualified so a creature and an item sharing a name never collide. */
function link(folder: string, name: string, label = name): string {
  return `[[${folder}/${safeName(name)}|${label}]]`;
}

function frontmatter(fields: Record<string, string | number | boolean | readonly string[] | null>): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === "" || (Array.isArray(value) && value.length === 0)) continue;
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const entry of value) lines.push(`  - ${quote(String(entry))}`);
    } else if (typeof value === "string") {
      lines.push(`${key}: ${quote(value)}`);
    } else {
      lines.push(`${key}: ${String(value)}`);
    }
  }
  lines.push("---", "");
  return lines.join("\n");
}

async function pageThrough<T>(fetch: (offset: number) => Promise<{ items: readonly T[]; total: number }>): Promise<T[]> {
  const all: T[] = [];
  let offset = 0;
  for (;;) {
    const page = await fetch(offset);
    all.push(...page.items);
    offset += PAGE;
    if (all.length >= page.total || page.items.length === 0) return all;
  }
}

/**
 * Joins note lines, dropping only the conditional ones. Filtering on "" instead
 * would collapse the spacing between every section, because a section that does
 * not apply and a deliberate paragraph break look identical once both are empty.
 */
function lines(entries: readonly (string | null)[]): string {
  return entries.filter((entry): entry is string => entry !== null).join("\n");
}

function creatureNote(
  creature: CreatureCatalogRecord,
  itemNames: ReadonlyMap<string, string>,
  huntNames: ReadonlyMap<string, string>,
  hasSprite: boolean
): string {
  // The loot list spells items in lowercase ("demonic essence") while the note is
  // titled "Demonic Essence", so the link has to target the catalog's spelling —
  // matching case-insensitively but linking with the raw name breaks the link.
  const loot = creature.lootDetails.length > 0
    ? creature.lootDetails.map((drop) => {
        const label = `${drop.itemName}${drop.amount ? ` (${drop.amount})` : ""}${drop.rarity ? ` — ${drop.rarity}` : ""}`;
        // Only link loot that actually has an item note, otherwise the vault fills
        // with dead links to things the catalog never imported.
        const canonical = itemNames.get(drop.itemName.toLowerCase());
        return canonical ? `- ${link("Itens", canonical, label)}` : `- ${label}`;
      })
    : creature.loot.map((name) => {
        const canonical = itemNames.get(name.toLowerCase());
        return canonical ? `- ${link("Itens", canonical, name)}` : `- ${name}`;
      });

  const locations = (creature.location ?? "")
    .split(",")
    .map((part) => part.trim().replace(/[.;]+$/, ""))
    .filter(Boolean);

  return lines([
    frontmatter({
      tipo: "criatura",
      race: creature.race,
      hp: creature.hitpoints,
      xp: creature.experience,
      fraco_contra: creature.weakness,
      forte_contra: creature.strong,
      imune: creature.immune,
      curado_por: creature.healed,
      paralisavel: creature.canBeParalysed,
      convencivel: creature.canBeConvinced,
      ve_invisivel: creature.seesInvisible
    }),
    `# ${creature.name}`,
    "",
    hasSprite ? `![[assets/criaturas/${creature.race}.gif]]` : "*Sprite não importado.*",
    "",
    `**${creature.hitpoints.toLocaleString("pt-BR")} HP** · **${creature.experience.toLocaleString("pt-BR")} XP** · armadura ${creature.armor}`,
    "",
    creature.description ? `> ${creature.description}\n` : null,
    "## Combate",
    creature.weakness.length ? `- **Fraco contra:** ${creature.weakness.join(", ")}` : null,
    creature.strong.length ? `- **Forte contra:** ${creature.strong.join(", ")}` : null,
    creature.immune.length ? `- **Imune:** ${creature.immune.join(", ")}` : null,
    creature.healed.length ? `- **Curado por:** ${creature.healed.join(", ")}` : null,
    creature.maxDamage > 0 ? `- **Dano máximo estimado:** ${creature.maxDamage.toLocaleString("pt-BR")}` : null,
    creature.attacks.length
      ? `- **Ataques:** ${creature.attacks.map((a) => `${a.name} ${a.minimum}-${a.maximum} (${a.element})`).join(" · ")}`
      : null,
    "",
    locations.length ? "## Onde encontrar" : null,
    ...locations.map((place) => {
      const canonical = huntNames.get(place.toLowerCase());
      return canonical ? `- ${link("Hunts", canonical, place)}` : `- ${place}`;
    }),
    "",
    loot.length ? "## Loot" : null,
    ...loot,
    "",
    "---",
    `[Fonte oficial](${creature.sourceUrl})${creature.communitySourceUrl ? ` · [Dano e loot da comunidade](${creature.communitySourceUrl})` : ""}`,
    ""
  ]);
}

function itemNote(item: ItemCatalogRecord, droppedBy: readonly string[], hasSprite: boolean): string {
  return lines([
    frontmatter({
      tipo: "item",
      categoria: item.categoryName,
      classe: item.objectClass,
      tipo_primario: item.primaryType,
      tipo_secundario: item.secondaryType
    }),
    `# ${item.name}`,
    "",
    hasSprite ? `![[assets/itens/${item.sourceId}.png]]` : null,
    "",
    item.categoryName ? `**Categoria:** ${item.categoryName}` : null,
    [item.primaryType, item.secondaryType].filter(Boolean).length
      ? `**Tipo:** ${[item.primaryType, item.secondaryType].filter(Boolean).join(" · ")}`
      : null,
    "",
    droppedBy.length ? "## Dropado por" : null,
    ...droppedBy.map((name) => `- ${link("Criaturas", name)}`),
    "",
    item.wikiUrl ? `---\n[Abrir no TibiaWiki](${item.wikiUrl})` : null,
    ""
  ]);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const config = loadRuntimeConfig();
  const pool = createMysqlPool(config);
  const catalog = new GameCatalogRepository(pool);
  const knowledgeRoot = resolve(config.knowledgeDir);

  console.log(`[vault] destino: ${options.output}`);
  await rm(options.output, { recursive: true, force: true });
  for (const folder of ["Criaturas", "Itens", "Magias", "Hunts", "Conhecimento", "assets/criaturas", "assets/itens"]) {
    await mkdir(join(options.output, folder), { recursive: true });
  }

  try {
    const creatures = await pageThrough<CreatureCatalogRecord>((offset) => catalog.searchCreatures("", PAGE, offset));
    const items = await pageThrough<ItemCatalogRecord>((offset) => catalog.searchItems("", PAGE, offset));
    const knowledge = await pageThrough<GameKnowledgeRecord>((offset) => catalog.searchKnowledge("", null, PAGE, offset));
    const [skills] = await pool.query<RowDataPacket[]>("SELECT name, spell_words, category, mana_cost, required_level, allowed_vocations, notes FROM bot_skills");
    const [hunts] = await pool.query<RowDataPacket[]>("SELECT name, city, min_level, notes FROM bot_hunts");
    console.log(`[vault] criaturas=${creatures.length} itens=${items.length} magias=${skills.length} hunts=${hunts.length} conhecimento=${knowledge.length}`);

    const itemNames = new Map(items.map((item) => [item.name.toLowerCase(), item.name] as const));
    const huntNames = new Map(hunts.map((hunt) => [String(hunt.name).toLowerCase(), String(hunt.name)] as const));
    const spriteRaces = new Set(
      existsSync(join(knowledgeRoot, "creature-assets"))
        ? (await readdir(join(knowledgeRoot, "creature-assets"), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)
        : []
    );

    // Reverse index built once: without it every item would rescan every creature.
    const droppedBy = new Map<string, string[]>();
    for (const creature of creatures) {
      const names = creature.lootDetails.length > 0 ? creature.lootDetails.map((d) => d.itemName) : creature.loot;
      for (const name of names) {
        const key = name.toLowerCase();
        if (!itemNames.has(key)) continue;
        const list = droppedBy.get(key) ?? [];
        if (!list.includes(creature.name)) list.push(creature.name);
        droppedBy.set(key, list);
      }
    }

    let copied = 0;
    for (const creature of creatures) {
      const hasSprite = spriteRaces.has(creature.race);
      await writeFile(join(options.output, "Criaturas", `${safeName(creature.name)}.md`),
        creatureNote(creature, itemNames, huntNames, hasSprite && options.assets), "utf8");
      if (hasSprite && options.assets) {
        await copyFile(join(knowledgeRoot, "creature-assets", creature.race, "source.gif"),
          join(options.output, "assets", "criaturas", `${creature.race}.gif`)).then(() => { copied += 1; }).catch(() => undefined);
      }
    }

    for (const item of items) {
      const spritePath = join(knowledgeRoot, "item-assets", String(item.sourceId), "sprite.png");
      const hasSprite = options.assets && existsSync(spritePath);
      await writeFile(join(options.output, "Itens", `${safeName(item.name)}.md`),
        itemNote(item, droppedBy.get(item.name.toLowerCase()) ?? [], hasSprite), "utf8");
      if (hasSprite) {
        await copyFile(spritePath, join(options.output, "assets", "itens", `${item.sourceId}.png`)).then(() => { copied += 1; }).catch(() => undefined);
      }
    }

    for (const skill of skills) {
      const vocations = String(skill.allowed_vocations ?? "").split(",").map((v) => v.trim()).filter(Boolean);
      await writeFile(join(options.output, "Magias", `${safeName(String(skill.name))}.md`), lines([
        frontmatter({ tipo: "magia", categoria: String(skill.category), mana: Number(skill.mana_cost ?? 0), level: Number(skill.required_level ?? 0), vocacoes: vocations }),
        `# ${skill.name}`,
        "",
        skill.spell_words ? `\`${skill.spell_words}\`` : null,
        "",
        `**Mana:** ${skill.mana_cost ?? "variável"} · **Level:** ${skill.required_level || "—"} · **Categoria:** ${skill.category}`,
        vocations.length ? `**Vocações:** ${vocations.join(", ")}` : null,
        "",
        skill.notes ? `> ${skill.notes}` : null,
        ""
      ]), "utf8");
    }

    for (const hunt of hunts) {
      const here = creatures.filter((c) => (c.location ?? "").toLowerCase().includes(String(hunt.name).toLowerCase()));
      await writeFile(join(options.output, "Hunts", `${safeName(String(hunt.name))}.md`), lines([
        frontmatter({ tipo: "hunt", cidade: hunt.city ? String(hunt.city) : null, level_minimo: Number(hunt.min_level ?? 0), criaturas: here.length }),
        `# ${hunt.name}`,
        "",
        `**Level sugerido:** ${hunt.min_level || "—"}`,
        "",
        here.length ? "## Criaturas" : null,
        ...here.map((c) => `- ${link("Criaturas", c.name)} — ${c.hitpoints.toLocaleString("pt-BR")} HP, ${c.experience.toLocaleString("pt-BR")} XP`),
        "",
        hunt.notes ? `---\n${hunt.notes}` : null,
        ""
      ]), "utf8");
    }

    for (const record of knowledge) {
      await writeFile(join(options.output, "Conhecimento", `${safeName(record.name)}.md`), lines([
        frontmatter({ tipo: "conhecimento", dominio: record.domain, confianca: record.trust, dinamico: record.volatile }),
        `# ${record.name}`,
        "",
        record.summary ?? null,
        "",
        record.content && record.content !== record.summary ? record.content : null,
        "",
        `---\n[Fonte](${record.sourceUrl})`,
        ""
      ]), "utf8");
    }

    await writeFile(join(options.output, "Índice.md"), lines([
      frontmatter({ tipo: "indice", gerado_em: new Date().toISOString() }),
      "# O que a IA sabe sobre Tibia",
      "",
      "Vault gerado por `npm run vault:export`. Regenerar sobrescreve tudo — não edite as notas à mão.",
      "",
      `- **Criaturas:** ${creatures.length}`,
      `- **Itens:** ${items.length}`,
      `- **Magias:** ${skills.length}`,
      `- **Hunts:** ${hunts.length}`,
      `- **Conhecimento:** ${knowledge.length}`,
      "",
      "## Por onde começar",
      "- Abra o grafo (Ctrl+G) para ver criaturas, loot e hunts ligados entre si.",
      "- As propriedades no topo de cada nota (`hp`, `xp`, `fraco_contra`) são pesquisáveis.",
      ""
    ]), "utf8");

    console.log(`[vault] pronto: ${creatures.length + items.length + skills.length + hunts.length + knowledge.length} notas, ${copied} sprites`);
  } finally {
    await pool.end();
  }
}

await main();
