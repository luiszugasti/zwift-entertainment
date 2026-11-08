import type { ChannelState } from './channel';
import { ZONE_IDS, type ZoneId } from './zones';

export interface ZoneConfig {
  /** The zone's own links. Kept while linked to a parent so clearing the link restores them. */
  links: string[];
  /** When set, this zone plays the parent zone's content (and shares its position). */
  parent: ZoneId | null;
}

export interface AppConfig {
  zones: Record<ZoneId, ZoneConfig>;
  volume: number;
  ftp: number | null;
}

/** Where a zone's player had got to. Keyed by the zone that owns the content. */
export interface SavedPosition {
  /** Signature of the links this position belongs to; a mismatch means the links changed. */
  sig: string;
  item: number;
  playlistIndex: number;
  /** Video playing within a playlist; preferred over the index if the playlist changes. */
  videoId?: string;
  time: number;
}

const CONFIG_KEY = 'ridereel.config.v1';
const POSITIONS_KEY = 'ridereel.positions.v1';
const WORKOUT_KEY = 'ridereel.workout.v1';
const CHANNELS_KEY = 'ridereel.channels.v1';

export function defaultConfig(): AppConfig {
  const zones = {} as Record<ZoneId, ZoneConfig>;
  for (const id of ZONE_IDS) zones[id] = { links: [], parent: null };
  return { zones, volume: 80, ftp: null };
}

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable (private mode, quota): settings just won't persist.
  }
}

/** Validates untrusted config (from storage or an imported file). Throws on bad shape. */
export function normalizeConfig(input: unknown): AppConfig {
  if (!input || typeof input !== 'object') throw new Error('Not a RideReel settings file.');
  const obj = input as Record<string, unknown>;
  const rawZones = obj.zones as Record<string, unknown> | undefined;
  if (!rawZones || typeof rawZones !== 'object') throw new Error('Settings file has no zones.');
  const config = defaultConfig();
  for (const id of ZONE_IDS) {
    const z = rawZones[id] as Partial<ZoneConfig> | undefined;
    if (!z) continue;
    config.zones[id] = {
      links: Array.isArray(z.links) ? z.links.filter((l): l is string => typeof l === 'string') : [],
      parent: typeof z.parent === 'string' && (ZONE_IDS as string[]).includes(z.parent) && z.parent !== id ? z.parent : null,
    };
  }
  // A parent must own its content; drop chains and cycles.
  for (const id of ZONE_IDS) {
    const p = config.zones[id].parent;
    if (p && config.zones[p].parent) config.zones[id].parent = null;
  }
  if (typeof obj.volume === 'number') config.volume = Math.min(100, Math.max(0, Math.round(obj.volume)));
  if (typeof obj.ftp === 'number' && obj.ftp > 0) config.ftp = Math.round(obj.ftp);
  return config;
}

export function loadConfig(): AppConfig {
  const raw = read<unknown>(CONFIG_KEY);
  if (!raw) return defaultConfig();
  try {
    return normalizeConfig(raw);
  } catch {
    return defaultConfig();
  }
}

export function saveConfig(config: AppConfig) {
  write(CONFIG_KEY, config);
}

export function exportConfig(config: AppConfig): string {
  return JSON.stringify({ app: 'RideReel', version: 1, zones: config.zones, volume: config.volume, ftp: config.ftp }, null, 2);
}

/** The zone whose content `zone` plays. */
export function contentOwner(config: AppConfig, zone: ZoneId): ZoneId {
  return config.zones[zone].parent ?? zone;
}

export function ownerLinks(config: AppConfig, zone: ZoneId): string[] {
  return config.zones[contentOwner(config, zone)].links.filter((l) => l.trim());
}

export function childrenOf(config: AppConfig, zone: ZoneId): ZoneId[] {
  return ZONE_IDS.filter((id) => config.zones[id].parent === zone);
}

export function linksSignature(links: string[]): string {
  return JSON.stringify(links);
}

export function loadPositions(): Partial<Record<ZoneId, SavedPosition>> {
  return read(POSITIONS_KEY) ?? {};
}

export function savePositions(positions: Partial<Record<ZoneId, SavedPosition>>) {
  write(POSITIONS_KEY, positions);
}

export interface StoredWorkout {
  fileName: string;
  text: string;
  ftp?: number;
}

export function loadStoredWorkout(): StoredWorkout | null {
  return read(WORKOUT_KEY);
}

export function saveStoredWorkout(w: StoredWorkout | null) {
  write(WORKOUT_KEY, w);
}

/** Channel progress, keyed by `${owner zone}:${uploads list id}`. Survives edits to the zone's other links. */
export function loadChannelState(key: string): ChannelState | null {
  return read<Record<string, ChannelState>>(CHANNELS_KEY)?.[key] ?? null;
}

export function saveChannelState(key: string, state: ChannelState | null) {
  const all = read<Record<string, ChannelState>>(CHANNELS_KEY) ?? {};
  if (state) all[key] = state;
  else delete all[key];
  write(CHANNELS_KEY, all);
}
