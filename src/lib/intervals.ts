/**
 * Loading today's planned workout from intervals.icu, through the local server's
 * /api/intervals/* routes (see vite.config.ts).
 */

const KEY_STORAGE = 'ridereel.intervals.v1';

export interface PlannedWorkout {
  id: string;
  name: string;
  /** Sport, e.g. "Ride" or "VirtualRide". */
  type?: string;
  /** Planned duration in seconds, when intervals.icu knows it. */
  duration?: number;
}

export class IntervalsError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** The API key lives only in this browser; it isn't part of exported settings. */
export function loadIntervalsKey(): string | null {
  try {
    return localStorage.getItem(KEY_STORAGE);
  } catch {
    return null;
  }
}

export function saveIntervalsKey(key: string | null) {
  try {
    if (key) localStorage.setItem(KEY_STORAGE, key);
    else localStorage.removeItem(KEY_STORAGE);
  } catch {
    // Storage unavailable: the key just won't be remembered.
  }
}

/** Today's date in local time, as intervals.icu expects (yyyy-MM-dd, no timezone). */
export function localDate(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function call(path: string, key: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(path, { headers: { 'X-Intervals-Key': key } });
  } catch {
    throw new IntervalsError("Couldn't reach the RideReel server. Is it running (npm start)?", 0);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // A 404 with an HTML page means the app isn't being served by its own server.
    const message = res.status === 404 ? 'This needs the RideReel server (npm start or the Dock app).' : text;
    throw new IntervalsError(message || `Request failed (${res.status}).`, res.status);
  }
  return res;
}

interface RawEvent {
  id?: number | string;
  name?: string;
  category?: string;
  type?: string;
  moving_time?: number;
  workout_doc?: { duration?: number } | null;
}

const RIDE_TYPES = new Set(['Ride', 'VirtualRide', 'GravelRide', 'MountainBikeRide']);

/** Planned workouts for the day. Rides are listed first; other sports only if there are no rides. */
export async function fetchPlannedWorkouts(key: string, date = localDate()): Promise<PlannedWorkout[]> {
  const res = await call(`/api/intervals/events?date=${date}`, key);
  const events = (await res.json()) as RawEvent[];
  const workouts = (Array.isArray(events) ? events : [])
    .filter((e) => e.category === 'WORKOUT' && e.id !== undefined)
    .map((e) => ({
      id: String(e.id),
      name: e.name?.trim() || 'Workout',
      type: e.type,
      duration: e.moving_time || e.workout_doc?.duration || undefined,
    }));
  const rides = workouts.filter((w) => w.type && RIDE_TYPES.has(w.type));
  return rides.length ? rides : workouts;
}

/** The workout as .zwo text. */
export async function downloadWorkout(key: string, id: string): Promise<string> {
  const res = await call(`/api/intervals/workout?id=${encodeURIComponent(id)}`, key);
  return res.text();
}
