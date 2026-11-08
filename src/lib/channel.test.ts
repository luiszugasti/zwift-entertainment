import { describe, expect, it } from 'vitest';
import { advanceChannel, planChannel, recordChannelTime, type ChannelState } from './channel';

// Uploads lists are newest first.
const list = (...ids: string[]) => ids;

/** Plays through to the end of the current video and returns the next plan. */
function finish(state: ChannelState, l: string[], mode: 'catch-up' | 'backlog', index: number) {
  return planChannel(advanceChannel(state, l, mode, index), l);
}

describe('planChannel', () => {
  it('starts at the newest upload and works back through the channel', () => {
    const l = list('v5', 'v4', 'v3', 'v2', 'v1');
    let p = planChannel(null, l);
    expect(p.target).toEqual({ mode: 'backlog', index: 0, time: 0 });
    p = finish(p.state, l, 'backlog', 0);
    expect(p.target).toMatchObject({ mode: 'backlog', index: 1 });
    expect(p.state.backlog.videoId).toBe('v4');
  });

  it('keeps playing as-is when nothing new was uploaded', () => {
    const l = list('v5', 'v4', 'v3', 'v2', 'v1');
    let { state } = planChannel(null, l);
    state = advanceChannel(state, l, 'backlog', 0);
    state = recordChannelTime(state, 'backlog', 123);
    const p = planChannel(state, l);
    expect(p.target).toEqual({ mode: 'backlog', index: 1, time: 123 });
  });

  it('catches up on new uploads, skips B, then returns to A with its timestamp cleared', () => {
    const before = list('v5', 'v4', 'v3', 'v2', 'v1');
    let { state } = planChannel(null, before); // B = v5
    state = advanceChannel(state, before, 'backlog', 0);
    state = advanceChannel(state, before, 'backlog', 1);
    state = recordChannelTime(state, 'backlog', 300); // A = v3 @ 300s

    const after = list('n2', 'n1', 'v5', 'v4', 'v3', 'v2', 'v1');
    let p = planChannel(state, after);
    expect(p.target).toEqual({ mode: 'catch-up', index: 0, time: 0 }); // C = n2
    expect(p.state.backlog).toMatchObject({ videoId: 'v3', time: 0 });
    expect(p.state.known[0]).toBe('v5'); // B not updated yet

    p = finish(p.state, after, 'catch-up', 0);
    expect(p.target).toMatchObject({ mode: 'catch-up', index: 1 }); // n1
    expect(p.state.known[0]).toBe('v5');

    // n1 is the video right before B: finishing it goes to A, not B, and B moves up.
    p = finish(p.state, after, 'catch-up', 1);
    expect(p.target).toEqual({ mode: 'backlog', index: 4, time: 0 }); // v3
    expect(p.state.known[0]).toBe('n2');
    expect(p.state.catchUp).toBeNull();
  });

  it('resumes a catch-up where it was paused', () => {
    const before = list('v2', 'v1');
    const after = list('n2', 'n1', 'v2', 'v1');
    let { state } = planChannel(null, before);
    ({ state } = planChannel(state, after));
    state = recordChannelTime(state, 'catch-up', 42);
    expect(planChannel(state, after).target).toEqual({ mode: 'catch-up', index: 0, time: 42 });
  });

  it('restarts the catch-up from the newest when more uploads arrive mid catch-up, without moving B', () => {
    const before = list('v2', 'v1');
    let { state } = planChannel(null, before);
    const first = list('n2', 'n1', 'v2', 'v1');
    let p = planChannel(state, first);
    p = finish(p.state, first, 'catch-up', 0); // now on n1
    expect(p.state.catchUp?.videoId).toBe('n1');

    const more = list('z2', 'z1', 'n2', 'n1', 'v2', 'v1');
    p = planChannel(p.state, more);
    expect(p.target).toEqual({ mode: 'catch-up', index: 0, time: 0 });
    expect(p.state.known[0]).toBe('v2');
    // Plays all the way down to B before returning to the backlog.
    for (let i = 0; i < 3; i++) {
      p = finish(p.state, more, 'catch-up', i);
      expect(p.target.mode).toBe('catch-up');
    }
    p = finish(p.state, more, 'catch-up', 3);
    expect(p.target.mode).toBe('backlog');
    expect(p.state.known[0]).toBe('z2');
  });

  it('carries on with the next video when A is deleted', () => {
    const l = list('v5', 'v4', 'v3', 'v2', 'v1');
    let { state } = planChannel(null, l);
    state = advanceChannel(state, l, 'backlog', 0);
    state = advanceChannel(state, l, 'backlog', 1); // A = v3
    state = recordChannelTime(state, 'backlog', 99);
    const p = planChannel(state, list('v5', 'v4', 'v2', 'v1'));
    expect(p.target).toEqual({ mode: 'backlog', index: 2, time: 0 });
    expect(p.state.backlog.videoId).toBe('v2');
  });

  it('still finds B when B is deleted', () => {
    const before = list('v3', 'v2', 'v1');
    let { state } = planChannel(null, before); // B = v3
    state = advanceChannel(state, before, 'backlog', 0); // A = v2
    const p = planChannel(state, list('n1', 'v2', 'v1'));
    expect(p.target).toEqual({ mode: 'catch-up', index: 0, time: 0 });
    const done = finish(p.state, list('n1', 'v2', 'v1'), 'catch-up', 0);
    expect(done.target).toMatchObject({ mode: 'backlog', index: 1 }); // v2
  });

  it('wraps to the newest known upload after the oldest one', () => {
    const l = list('v2', 'v1');
    let p = planChannel(null, l);
    p = finish(p.state, l, 'backlog', 0);
    p = finish(p.state, l, 'backlog', 1);
    expect(p.target).toEqual({ mode: 'backlog', index: 0, time: 0 });
  });

  it('goes by position for videos beyond the 200 the player exposes', () => {
    const big = Array.from({ length: 200 }, (_, i) => `v${200 - i}`);
    let { state } = planChannel(null, big);
    state = { ...state, backlog: { videoId: null, time: 10, next: [], offset: 250 } };
    expect(planChannel(state, big).target).toEqual({ mode: 'backlog', index: 250, time: 10 });
    // Two new uploads push it down by two once the catch-up finishes.
    const bigger = ['n2', 'n1', ...big.slice(0, 198)];
    let p = planChannel(state, bigger);
    p = finish(p.state, bigger, 'catch-up', 0);
    p = finish(p.state, bigger, 'catch-up', 1);
    expect(p.target).toEqual({ mode: 'backlog', index: 252, time: 0 });
  });
});
