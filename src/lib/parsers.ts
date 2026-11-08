/** A workout segment. Power is a fraction of FTP; ramps go linearly from `from` to `to`. */
export type Segment =
  | { kind: 'power'; duration: number; from: number; to: number; label?: string }
  | { kind: 'free'; duration: number; label?: string };

export type WorkoutFormat = 'zwo' | 'mrc' | 'erg';

export interface Workout {
  name: string;
  author?: string;
  description?: string;
  format: WorkoutFormat;
  /** FTP used to convert absolute watts, if any. */
  ftp?: number;
  segments: Segment[];
}

export type ParseResult =
  | { status: 'ok'; workout: Workout }
  /** Absolute-watt file without an FTP in it: caller must ask the user for FTP. */
  | { status: 'needs-ftp'; name: string; build: (ftp: number) => Workout };

export class WorkoutParseError extends Error {}

export function detectFormat(fileName: string): WorkoutFormat {
  const ext = fileName.toLowerCase().split('.').pop();
  if (ext === 'zwo' || ext === 'mrc' || ext === 'erg') return ext;
  throw new WorkoutParseError(`Unsupported file type ".${ext}". Use a .zwo, .erg or .mrc file.`);
}

export function parseWorkoutFile(fileName: string, text: string): ParseResult {
  const format = detectFormat(fileName);
  const baseName = fileName.replace(/\.[^.]+$/, '');
  if (format === 'zwo') return { status: 'ok', workout: parseZwo(text, baseName) };
  return parseCourseFile(text, format, baseName);
}

// ---------------------------------------------------------------- .zwo

function attr(el: Element, ...names: string[]): number | undefined {
  for (const name of names) {
    const lower = name.toLowerCase();
    for (const a of Array.from(el.attributes)) {
      if (a.name.toLowerCase() === lower) {
        const n = parseFloat(a.value);
        if (Number.isFinite(n)) return n;
      }
    }
  }
  return undefined;
}

function childText(root: Element, tag: string): string | undefined {
  const el = Array.from(root.children).find((c) => c.tagName.toLowerCase() === tag);
  const text = el?.textContent?.trim();
  return text || undefined;
}

export function parseZwo(text: string, fallbackName = 'Workout'): Workout {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) {
    throw new WorkoutParseError('This .zwo file is not valid XML.');
  }
  const root = doc.documentElement;
  const workoutEl = Array.from(root.getElementsByTagName('*')).find(
    (e) => e.tagName.toLowerCase() === 'workout',
  );
  if (!workoutEl) throw new WorkoutParseError('No <workout> section found in the .zwo file.');

  const segments: Segment[] = [];
  for (const el of Array.from(workoutEl.children)) {
    const tag = el.tagName.toLowerCase();
    const duration = attr(el, 'Duration') ?? 0;
    switch (tag) {
      case 'steadystate':
      case 'solidstate': {
        const p = attr(el, 'Power', 'PowerLow', 'PowerHigh');
        if (p === undefined) break;
        segments.push({ kind: 'power', duration, from: p, to: p });
        break;
      }
      case 'warmup':
      case 'cooldown':
      case 'ramp': {
        const low = attr(el, 'PowerLow', 'Power');
        const high = attr(el, 'PowerHigh', 'Power');
        if (low === undefined || high === undefined) break;
        const label = tag === 'warmup' ? 'Warm up' : tag === 'cooldown' ? 'Cool down' : undefined;
        segments.push({ kind: 'power', duration, from: low, to: high, label });
        break;
      }
      case 'intervalst': {
        const repeat = Math.max(1, Math.round(attr(el, 'Repeat') ?? 1));
        const onDur = attr(el, 'OnDuration') ?? 0;
        const offDur = attr(el, 'OffDuration') ?? 0;
        const onLow = attr(el, 'OnPower', 'PowerOnLow');
        const onHigh = attr(el, 'OnPower', 'PowerOnHigh') ?? onLow;
        const offLow = attr(el, 'OffPower', 'PowerOffLow');
        const offHigh = attr(el, 'OffPower', 'PowerOffHigh') ?? offLow;
        if (onLow === undefined || offLow === undefined) break;
        for (let i = 0; i < repeat; i++) {
          segments.push({ kind: 'power', duration: onDur, from: onLow, to: onHigh!, label: `Interval ${i + 1}/${repeat} on` });
          segments.push({ kind: 'power', duration: offDur, from: offLow, to: offHigh!, label: `Interval ${i + 1}/${repeat} off` });
        }
        break;
      }
      case 'maxeffort':
        segments.push({ kind: 'power', duration, from: 1.6, to: 1.6, label: 'Max effort' });
        break;
      case 'freeride':
      default:
        // Free ride, or an unknown block with a duration: no target power.
        if (duration > 0) segments.push({ kind: 'free', duration, label: tag === 'freeride' ? 'Free ride' : undefined });
    }
  }

  const valid = segments.filter((s) => s.duration > 0);
  if (!valid.length) throw new WorkoutParseError('The workout has no blocks with a duration.');
  return {
    name: childText(root, 'name') ?? fallbackName,
    author: childText(root, 'author'),
    description: childText(root, 'description'),
    format: 'zwo',
    segments: valid,
  };
}

// ---------------------------------------------------------------- .erg / .mrc

export function parseCourseFile(text: string, format: 'erg' | 'mrc', fallbackName = 'Workout'): ParseResult {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  let section: 'none' | 'header' | 'data' | 'other' = 'none';
  const header: Record<string, string> = {};
  let unit: 'percent' | 'watts' = format === 'mrc' ? 'percent' : 'watts';
  let timeScale = 60; // minutes by default
  const points: [number, number][] = [];

  for (const line of lines) {
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const sectionMatch = line.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      const s = sectionMatch[1].toUpperCase();
      if (s.startsWith('END')) section = 'other';
      else if (s.includes('HEADER')) section = 'header';
      else if (s.includes('DATA')) section = 'data';
      else section = 'other';
      continue;
    }
    if (section === 'header') {
      const kv = line.match(/^([^=]+)=(.*)$/);
      if (kv) {
        header[kv[1].trim().toUpperCase()] = kv[2].trim();
      } else {
        // Column definition line such as "MINUTES WATTS" or "MINUTES PERCENT".
        const u = line.toUpperCase();
        if (u.includes('PERCENT')) unit = 'percent';
        else if (u.includes('WATTS')) unit = 'watts';
        if (u.includes('SECONDS')) timeScale = 1;
        else if (u.includes('MINUTES')) timeScale = 60;
      }
    } else if (section === 'data') {
      const nums = line.split(/[\s,]+/).map(Number);
      if (nums.length >= 2 && Number.isFinite(nums[0]) && Number.isFinite(nums[1])) {
        points.push([nums[0] * timeScale, nums[1]]);
      }
    }
  }

  if (points.length < 2) throw new WorkoutParseError(`No course data found in the .${format} file.`);

  const name = header['DESCRIPTION'] || header['FILE NAME']?.replace(/\.[^.]+$/, '') || fallbackName;
  const fileFtp = parseFloat(header['FTP'] ?? '');

  const build = (ftp?: number): Workout => {
    const toFraction = (v: number) => (unit === 'percent' ? v / 100 : v / ftp!);
    const segments: Segment[] = [];
    for (let i = 0; i < points.length - 1; i++) {
      const [t0, v0] = points[i];
      const [t1, v1] = points[i + 1];
      const duration = t1 - t0;
      if (duration <= 0) continue; // vertical step
      segments.push({ kind: 'power', duration, from: toFraction(v0), to: toFraction(v1) });
    }
    if (!segments.length) throw new WorkoutParseError(`The .${format} file has no timed blocks.`);
    return { name, format, ftp: unit === 'watts' ? ftp : undefined, segments };
  };

  if (unit === 'percent') return { status: 'ok', workout: build() };
  if (Number.isFinite(fileFtp) && fileFtp > 0) return { status: 'ok', workout: build(fileFtp) };
  return { status: 'needs-ftp', name, build: (ftp) => build(ftp) };
}
