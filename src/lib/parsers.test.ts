import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseWorkoutFile, WorkoutParseError } from './parsers';
import { blockIndexAt, buildTimeline } from './timeline';
import { powerToZone } from './zones';

const sample = (name: string) => readFileSync(join(process.cwd(), 'samples', name), 'utf8');

describe('powerToZone', () => {
  it('uses Zwift zone boundaries on rounded percentages', () => {
    expect(powerToZone(0.59)).toBe('z1');
    expect(powerToZone(0.6)).toBe('z2');
    expect(powerToZone(0.75)).toBe('z2');
    expect(powerToZone(0.76)).toBe('z3');
    expect(powerToZone(0.89)).toBe('z3');
    expect(powerToZone(0.9)).toBe('z4');
    expect(powerToZone(1.04)).toBe('z4');
    expect(powerToZone(1.05)).toBe('z5');
    expect(powerToZone(1.18)).toBe('z5');
    expect(powerToZone(1.19)).toBe('z6');
  });
});

describe('zwo', () => {
  it('parses blocks, intervals and free ride', () => {
    const res = parseWorkoutFile('demo.zwo', sample('demo.zwo'));
    if (res.status !== 'ok') throw new Error('expected ok');
    const { workout } = res;
    expect(workout.name).toBe('Demo pyramid');
    // warmup + steady + 3x(on,off) + steady + free + steady + cooldown
    expect(workout.segments).toHaveLength(12);
    expect(workout.segments.find((s) => s.kind === 'free')?.duration).toBe(120);
  });

  it('splits ramps at zone crossings', () => {
    const res = parseWorkoutFile(
      'r.zwo',
      '<workout_file><workout><Warmup Duration="100" PowerLow="0.50" PowerHigh="1.00"/></workout></workout_file>',
    );
    if (res.status !== 'ok') throw new Error('expected ok');
    const { blocks } = buildTimeline(res.workout);
    expect(blocks.map((b) => b.zone)).toEqual(['z1', 'z2', 'z3', 'z4']);
    // 0.595 is reached 19% of the way from 0.50 to 1.00
    expect(blocks[1].start).toBeCloseTo(19);
    expect(blocks[2].start).toBeCloseTo(51);
    expect(blocks[3].start).toBeCloseTo(79);
  });

  it('merges consecutive blocks in the same zone', () => {
    const res = parseWorkoutFile(
      'm.zwo',
      '<workout_file><workout><SteadyState Duration="60" Power="0.65"/><SteadyState Duration="60" Power="0.72"/><SteadyState Duration="30" Power="1.0"/></workout></workout_file>',
    );
    if (res.status !== 'ok') throw new Error('expected ok');
    const { blocks, total } = buildTimeline(res.workout);
    expect(blocks).toEqual([
      { start: 0, end: 120, zone: 'z2' },
      { start: 120, end: 150, zone: 'z4' },
    ]);
    expect(total).toBe(150);
    expect(blockIndexAt(blocks, 119.9)).toBe(0);
    expect(blockIndexAt(blocks, 120)).toBe(1);
  });

  it('rejects broken xml', () => {
    expect(() => parseWorkoutFile('x.zwo', '<workout_file><workout>')).toThrow(WorkoutParseError);
  });
});

describe('erg / mrc', () => {
  it('asks for FTP when an erg file has watts but no FTP', () => {
    const res = parseWorkoutFile('watts-no-ftp.erg', sample('watts-no-ftp.erg'));
    expect(res.status).toBe('needs-ftp');
    if (res.status !== 'needs-ftp') return;
    const workout = res.build(250);
    const zones = buildTimeline(workout).blocks.map((b) => b.zone);
    // 120->180W ramp at 250 FTP is 48%->72%: Z1 then Z2; 225W = 90% = Z4; 130W = 52% = Z1
    expect(zones).toEqual(['z1', 'z2', 'z4', 'z1']);
    expect(workout.ftp).toBe(250);
  });

  it('uses the FTP in the file header when present', () => {
    const text = sample('watts-no-ftp.erg').replace('MINUTES WATTS', 'FTP = 300\nMINUTES WATTS');
    const res = parseWorkoutFile('w.erg', text);
    expect(res.status).toBe('ok');
    if (res.status === 'ok') expect(res.workout.ftp).toBe(300);
  });

  it('parses percent mrc files without FTP', () => {
    const res = parseWorkoutFile('percent.mrc', sample('percent.mrc'));
    if (res.status !== 'ok') throw new Error('expected ok');
    const { blocks, total } = buildTimeline(res.workout);
    expect(total).toBe(28 * 60);
    expect(blocks.map((b) => b.zone)).toEqual(['z1', 'z4', 'z1', 'z4', 'z1']);
  });
});
