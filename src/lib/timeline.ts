import type { Workout } from './parsers';
import { powerToZone, ZONE_THRESHOLDS, type ZoneId } from './zones';

/** A piece of the workout with a single zone; used for drawing the power profile. */
export interface SubBlock {
  start: number;
  end: number;
  zone: ZoneId;
  /** Power (fraction of FTP) at start and end; null for free ride. */
  pStart: number | null;
  pEnd: number | null;
  label?: string;
}

/** Consecutive time in the same zone; this is what drives playback. */
export interface ZoneBlock {
  start: number;
  end: number;
  zone: ZoneId;
}

export interface Timeline {
  sub: SubBlock[];
  blocks: ZoneBlock[];
  total: number;
}

export function buildTimeline(workout: Workout): Timeline {
  const sub: SubBlock[] = [];
  let t = 0;
  for (const seg of workout.segments) {
    const start = t;
    const end = t + seg.duration;
    t = end;
    if (seg.kind === 'free') {
      sub.push({ start, end, zone: 'free', pStart: null, pEnd: null, label: seg.label });
      continue;
    }
    const { from, to } = seg;
    // Split ramps at every zone boundary they cross.
    const cuts = [start];
    if (from !== to) {
      const lo = Math.min(from, to);
      const hi = Math.max(from, to);
      const crossings = ZONE_THRESHOLDS.filter((th) => th > lo && th <= hi)
        .map((th) => start + ((th - from) / (to - from)) * seg.duration)
        .sort((a, b) => a - b);
      cuts.push(...crossings);
    }
    cuts.push(end);
    const powerAt = (x: number) => from + ((x - start) / seg.duration) * (to - from);
    for (let i = 0; i < cuts.length - 1; i++) {
      const a = cuts[i];
      const b = cuts[i + 1];
      if (b - a <= 1e-9) continue;
      sub.push({ start: a, end: b, zone: powerToZone(powerAt((a + b) / 2)), pStart: powerAt(a), pEnd: powerAt(b), label: seg.label });
    }
  }

  const blocks: ZoneBlock[] = [];
  for (const s of sub) {
    const last = blocks[blocks.length - 1];
    if (last && last.zone === s.zone) last.end = s.end;
    else blocks.push({ start: s.start, end: s.end, zone: s.zone });
  }
  return { sub, blocks, total: t };
}

/** Index of the block containing time `t` (clamped to the last block). */
export function blockIndexAt(blocks: ZoneBlock[], t: number): number {
  for (let i = 0; i < blocks.length; i++) {
    if (t < blocks[i].end) return i;
  }
  return blocks.length - 1;
}

export function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}
