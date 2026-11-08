/**
 * Playback order for a YouTube channel.
 *
 * The channel's uploads list is newest first. Normally we work back through it (the "backlog",
 * cursor A). When new uploads appear above the newest video we knew about (B), we pause the
 * backlog, play the new uploads from the newest down (the "catch-up", cursor C), and when the
 * next video would be B we go back to A instead of replaying B. Only then does B move up to
 * the new top of the list.
 *
 * The embed player only exposes the first LIST_WINDOW video IDs of a list, so everything here
 * works on that window and falls back to index arithmetic for videos further down.
 */

export const LIST_WINDOW = 200;
/** How many IDs at the top of the list we remember as "known", so B can be found even if B itself is deleted. */
const KNOWN = 20;
/** How many following IDs each cursor remembers, to carry on if its own video is deleted. */
const NEXT = 5;

export interface Cursor {
  /** Null when the video is beyond the visible window and hasn't been identified yet. */
  videoId: string | null;
  time: number;
  /** The videos that came after this one, in case it gets deleted. */
  next: string[];
}

export interface BacklogCursor extends Cursor {
  /** Position below B; used when the video is beyond the visible window. */
  offset: number;
}

export interface CatchUpCursor extends Cursor {
  /** Top of the list when this catch-up started; a different top means more uploads arrived. */
  tip: string;
}

export interface ChannelState {
  /** B followed by the next older uploads, as of the last completed catch-up. */
  known: string[];
  backlog: BacklogCursor;
  catchUp: CatchUpCursor | null;
}

export type ChannelMode = 'catch-up' | 'backlog';

export interface ChannelTarget {
  mode: ChannelMode;
  /** Index in the uploads list to load. */
  index: number;
  time: number;
}

function cursorAt(list: string[], i: number): Cursor {
  return { videoId: list[i] ?? null, time: 0, next: list.slice(i + 1, i + 1 + NEXT) };
}

/** Index of the cursor's video, or of the first following video still in the list. */
function locate(cursor: Cursor, list: string[]): number {
  for (const id of [cursor.videoId, ...cursor.next]) {
    const i = id ? list.indexOf(id) : -1;
    if (i >= 0) return i;
  }
  return -1;
}

/**
 * `fresh`: how many new uploads sit above the known ones. `b`: where B is, or would be if B
 * was deleted (can be negative then). Null if none of the known videos are visible.
 */
function findB(known: string[], list: string[]): { fresh: number; b: number } | null {
  for (let i = 0; i < list.length; i++) {
    const j = known.indexOf(list[i]);
    if (j >= 0) return { fresh: i, b: i - j };
  }
  return null;
}

function clone(state: ChannelState): ChannelState {
  return {
    known: [...state.known],
    backlog: { ...state.backlog, next: [...state.backlog.next] },
    catchUp: state.catchUp && { ...state.catchUp, next: [...state.catchUp.next] },
  };
}

/** Decides what to play given the current uploads list (newest first). */
export function planChannel(prev: ChannelState | null, list: string[]): { state: ChannelState; target: ChannelTarget } {
  if (!list.length) throw new Error('The channel has no videos.');
  if (!prev) {
    const state: ChannelState = { known: list.slice(0, KNOWN), backlog: { ...cursorAt(list, 0), offset: 0 }, catchUp: null };
    return { state, target: { mode: 'backlog', index: 0, time: 0 } };
  }

  const state = clone(prev);
  let { fresh, b } = findB(state.known, list) ?? { fresh: -1, b: 0 };
  if (fresh < 0) {
    // None of the known videos are visible (they were removed, or 200+ new uploads):
    // start a fresh baseline instead of guessing.
    state.known = list.slice(0, KNOWN);
    state.catchUp = null;
    fresh = 0;
  }

  if (fresh > 0) {
    if (!state.catchUp) {
      state.catchUp = { ...cursorAt(list, 0), tip: list[0] };
      state.backlog.time = 0;
    } else if (state.catchUp.tip !== list[0]) {
      // More uploads arrived mid catch-up: restart from the newest. B stays put.
      state.catchUp = { ...cursorAt(list, 0), tip: list[0] };
    }
    const i = locate(state.catchUp, list);
    if (i >= 0 && i < fresh) {
      if (list[i] !== state.catchUp.videoId) state.catchUp = { ...cursorAt(list, i), tip: state.catchUp.tip };
      return { state, target: { mode: 'catch-up', index: i, time: state.catchUp.time } };
    }
    // Reached B: the catch-up is done. B moves up to the top and A stays where it was.
    state.backlog.offset += b;
    state.known = list.slice(0, KNOWN);
    state.catchUp = null;
    b = 0;
  } else {
    state.catchUp = null;
  }

  const a = state.backlog;
  const found = a.videoId ? list.indexOf(a.videoId) : -1;
  if (found >= 0) {
    a.offset = found - b;
    return { state, target: { mode: 'backlog', index: found, time: a.time } };
  }
  const expected = b + a.offset;
  if (expected >= list.length && list.length >= LIST_WINDOW) {
    // Further down than the player lets us see: go by position.
    return { state, target: { mode: 'backlog', index: expected, time: a.time } };
  }
  // A should be visible but isn't (deleted), or we ran off the end of a small channel.
  let i = locate(a, list);
  if (i < 0) i = expected < list.length ? Math.max(0, expected) : Math.max(0, b); // past the oldest upload: wrap to B
  state.backlog = { ...cursorAt(list, i), offset: i - b };
  return { state, target: { mode: 'backlog', index: i, time: 0 } };
}

/** Moves past the video that just finished (or failed) at `index`. Call planChannel next. */
export function advanceChannel(state: ChannelState, list: string[], mode: ChannelMode, index: number): ChannelState {
  const next = clone(state);
  if (mode === 'catch-up' && next.catchUp) {
    next.catchUp = { ...cursorAt(list, index + 1), tip: next.catchUp.tip };
  } else {
    next.backlog = { ...cursorAt(list, index + 1), offset: next.backlog.offset + 1 };
    if (index + 1 >= list.length && list.length < LIST_WINDOW) {
      // Finished the oldest upload: wrap around to B.
      next.backlog = { videoId: next.known[0] ?? null, time: 0, next: next.known.slice(1, 1 + NEXT), offset: 0 };
    }
  }
  return next;
}

/** Records progress in the current video. */
export function recordChannelTime(state: ChannelState, mode: ChannelMode, time: number, videoId?: string): ChannelState {
  const next = clone(state);
  const cursor = mode === 'catch-up' && next.catchUp ? next.catchUp : next.backlog;
  cursor.time = time;
  if (!cursor.videoId && videoId) cursor.videoId = videoId;
  return next;
}

/** Uploads list for a channel. "UULF" is long-form videos only (no Shorts). */
export function uploadsListId(channelId: string, includeShorts: boolean): string {
  return (includeShorts ? 'UU' : 'UULF') + channelId.slice(2);
}
