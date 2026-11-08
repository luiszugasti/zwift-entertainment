import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchPlannedWorkouts, IntervalsError, localDate } from './intervals';

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe('intervals.icu', () => {
  it('formats local dates the way the API expects', () => {
    expect(localDate(new Date(2026, 0, 5, 23, 30))).toBe('2026-01-05');
  });

  it('lists planned rides, ignoring notes and other sports when there are rides', async () => {
    const fn = mockFetch(200, [
      { id: 1, category: 'NOTE', name: 'Rest well' },
      { id: 2, category: 'WORKOUT', type: 'Run', name: 'Easy run', moving_time: 1800 },
      { id: 3, category: 'WORKOUT', type: 'VirtualRide', name: 'Sweet spot', moving_time: 3600 },
      { id: 4, category: 'WORKOUT', type: 'Ride', name: '  ', workout_doc: { duration: 2700 } },
    ]);
    const workouts = await fetchPlannedWorkouts('key', '2026-11-08');
    expect(workouts).toEqual([
      { id: '3', name: 'Sweet spot', type: 'VirtualRide', duration: 3600 },
      { id: '4', name: 'Workout', type: 'Ride', duration: 2700 },
    ]);
    expect(fn).toHaveBeenCalledWith('/api/intervals/events?date=2026-11-08', { headers: { 'X-Intervals-Key': 'key' } });
  });

  it('falls back to other sports when nothing is a ride', async () => {
    mockFetch(200, [{ id: 2, category: 'WORKOUT', type: 'Run', name: 'Easy run' }]);
    expect(await fetchPlannedWorkouts('key', '2026-11-08')).toHaveLength(1);
  });

  it('reports a rejected key with status 401', async () => {
    mockFetch(401, 'intervals.icu rejected the API key.');
    await expect(fetchPlannedWorkouts('bad', '2026-11-08')).rejects.toMatchObject({ status: 401 });
    await expect(fetchPlannedWorkouts('bad', '2026-11-08')).rejects.toBeInstanceOf(IntervalsError);
  });
});
