export type ZoneId = 'z1' | 'z2' | 'z3' | 'z4' | 'z5' | 'z6' | 'free';

export interface ZoneMeta {
  id: ZoneId;
  label: string;
  short: string;
  range: string;
  color: string;
}

export const ZONES: ZoneMeta[] = [
  { id: 'z1', label: 'Zone 1', short: 'Z1', range: '< 60% FTP', color: '#8a8f98' },
  { id: 'z2', label: 'Zone 2', short: 'Z2', range: '60–75% FTP', color: '#3b82f6' },
  { id: 'z3', label: 'Zone 3', short: 'Z3', range: '76–89% FTP', color: '#22c55e' },
  { id: 'z4', label: 'Zone 4', short: 'Z4', range: '90–104% FTP', color: '#eab308' },
  { id: 'z5', label: 'Zone 5', short: 'Z5', range: '105–118% FTP', color: '#f97316' },
  { id: 'z6', label: 'Zone 6', short: 'Z6', range: '≥ 119% FTP', color: '#ef4444' },
  { id: 'free', label: 'Free ride', short: 'FR', range: 'No target power', color: '#a78bfa' },
];

export const ZONE_IDS: ZoneId[] = ZONES.map((z) => z.id);

export function zoneMeta(id: ZoneId): ZoneMeta {
  return ZONES.find((z) => z.id === id)!;
}

/**
 * Zwift zone boundaries as fractions of FTP. Zwift shows whole percentages, so a
 * power belongs to the zone its rounded percentage falls in (e.g. 0.755 -> 76% -> Z3).
 * These are the exact points where the rounded percentage changes zone.
 */
export const ZONE_THRESHOLDS = [0.595, 0.755, 0.895, 1.045, 1.185];

const POWER_ZONES: ZoneId[] = ['z1', 'z2', 'z3', 'z4', 'z5', 'z6'];

export function powerToZone(fraction: number): ZoneId {
  const i = ZONE_THRESHOLDS.findIndex((t) => fraction < t);
  return POWER_ZONES[i === -1 ? POWER_ZONES.length - 1 : i];
}
