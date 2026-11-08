import type { MouseEvent } from 'react';
import type { Timeline } from '../lib/timeline';
import { formatTime } from '../lib/timeline';
import { zoneMeta } from '../lib/zones';

const W = 1000;
const H = 120;
const MAX_POWER = 1.6;
const FREE_POWER = 0.5;

interface Props {
  timeline: Timeline;
  t: number | null;
  onSeek?: (t: number) => void;
}

export function TimelineChart({ timeline, t, onSeek }: Props) {
  const { sub, total } = timeline;
  const x = (s: number) => (s / total) * W;
  const y = (p: number) => H - (Math.min(p, MAX_POWER) / MAX_POWER) * (H - 4);

  const handleClick = (e: MouseEvent<SVGSVGElement>) => {
    if (!onSeek) return;
    const rect = e.currentTarget.getBoundingClientRect();
    onSeek(((e.clientX - rect.left) / rect.width) * total);
  };

  return (
    <div className="timeline">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className={onSeek ? 'seekable' : undefined}
        onClick={handleClick}
        role="img"
        aria-label="Workout power profile"
      >
        {sub.map((s, i) => {
          const free = s.pStart === null;
          const p0 = free ? FREE_POWER : s.pStart!;
          const p1 = free ? FREE_POWER : s.pEnd!;
          const points = `${x(s.start)},${H} ${x(s.start)},${y(p0)} ${x(s.end)},${y(p1)} ${x(s.end)},${H}`;
          return (
            <polygon key={i} points={points} fill={zoneMeta(s.zone).color} opacity={free ? 0.45 : 0.9}>
              <title>
                {zoneMeta(s.zone).label} · {formatTime(s.start)}–{formatTime(s.end)}
                {s.label ? ` · ${s.label}` : ''}
              </title>
            </polygon>
          );
        })}
        {t !== null && <rect x={x(t) - 1.5} y={0} width={3} height={H} className="playhead" />}
      </svg>
      <div className="timeline-axis">
        <span>0:00</span>
        <span>{formatTime(total)}</span>
      </div>
    </div>
  );
}
