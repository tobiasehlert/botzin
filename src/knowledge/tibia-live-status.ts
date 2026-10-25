export interface TibiaFeaturedEntry {
  readonly name: string;
  readonly imageUrl: string | null;
}

export interface TibiaLiveStatus {
  readonly fetchedAt: string;
  readonly boostedCreature: TibiaFeaturedEntry;
  readonly boostedBoss: TibiaFeaturedEntry;
  readonly eventScheduleUrl: string;
  readonly marketRequiresWorldSnapshot: true;
}

const CREATURES_URL = "https://api.tibiadata.com/v5/creatures";
const BOSSES_URL = "https://api.tibiadata.com/v5/boostablebosses";
const CACHE_MS = 5 * 60_000;

export class TibiaLiveStatusService {
  private cached: { expiresAt: number; value: TibiaLiveStatus } | null = null;

  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async get(): Promise<TibiaLiveStatus> {
    if (this.cached && this.cached.expiresAt > Date.now()) return this.cached.value;
    const [creaturesResponse, bossesResponse] = await Promise.all([
      this.fetcher(CREATURES_URL, { headers: { "user-agent": "botzin-live-status/0.1" } }),
      this.fetcher(BOSSES_URL, { headers: { "user-agent": "botzin-live-status/0.1" } })
    ]);
    const failedEndpoints = [
      !creaturesResponse.ok ? `creatures HTTP ${creaturesResponse.status}` : null,
      !bossesResponse.ok ? `boostablebosses HTTP ${bossesResponse.status}` : null
    ].filter((failure): failure is string => failure !== null);
    if (failedEndpoints.length) {
      throw new Error(`Could not refresh official Tibia boosts: ${failedEndpoints.join(", ")}.`);
    }
    const creatures = object(await creaturesResponse.json());
    const bosses = object(await bossesResponse.json());
    const creatureGroup = object(creatures.creatures);
    const bossGroup = object(bosses.boostable_bosses);
    const value: TibiaLiveStatus = {
      fetchedAt: new Date().toISOString(),
      boostedCreature: featured(creatureGroup.boosted, "boosted creature"),
      boostedBoss: featured(bossGroup.boosted, "boosted boss"),
      eventScheduleUrl: "https://www.tibia.com/news/?subtopic=eventcalendar",
      marketRequiresWorldSnapshot: true
    };
    this.cached = { expiresAt: Date.now() + CACHE_MS, value };
    return value;
  }
}

function featured(value: unknown, label: string): TibiaFeaturedEntry {
  const entry = object(value);
  if (typeof entry.name !== "string" || !entry.name.trim()) throw new Error(`Official API did not return ${label}.`);
  return { name: entry.name.trim(), imageUrl: typeof entry.image_url === "string" ? entry.image_url : null };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid official Tibia API response.");
  return value as Record<string, unknown>;
}
