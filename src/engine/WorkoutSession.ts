import { blockIndexAt, type Timeline } from '../lib/timeline';
import type { Beeper } from './Beeper';
import type { PlaybackController } from './PlaybackController';

export const COUNTDOWN_SECONDS = 3;

export type SessionStatus = 'ready' | 'running' | 'paused' | 'done';

export interface SessionState {
  status: SessionStatus;
  /** Workout time in seconds. */
  t: number;
  blockIndex: number;
  /** Seconds until the next zone, while within the countdown window. */
  countdown: number | null;
}

/**
 * The workout clock. Follows the workout file's timeline; the rider starts it at the same
 * moment as the Zwift workout and can nudge it to stay in sync.
 */
export class WorkoutSession {
  private baseT = 0;
  private resumedAt = 0;
  private timer = 0;
  private state: SessionState = { status: 'ready', t: 0, blockIndex: 0, countdown: null };

  constructor(
    private readonly timeline: Timeline,
    private readonly playback: PlaybackController,
    private readonly beeper: Beeper,
    private readonly onChange: (s: SessionState) => void,
  ) {}

  get snapshot(): SessionState {
    return this.state;
  }

  private now(): number {
    if (this.state.status !== 'running') return this.baseT;
    return this.baseT + (performance.now() - this.resumedAt) / 1000;
  }

  /** Must be called from a click so audio and unmuted video are allowed. */
  start() {
    this.beeper.unlock();
    if (this.state.status === 'done') this.baseT = 0;
    const blockIndex = blockIndexAt(this.timeline.blocks, this.baseT);
    this.playback.enterZone(this.timeline.blocks[blockIndex].zone);
    this.resume(blockIndex);
  }

  private resume(blockIndex = this.state.blockIndex) {
    this.resumedAt = performance.now();
    this.state = { ...this.state, status: 'running', blockIndex };
    this.playback.play();
    window.clearInterval(this.timer);
    this.timer = window.setInterval(() => this.tick(), 100);
    this.tick();
  }

  pause() {
    if (this.state.status !== 'running') return;
    this.baseT = this.now();
    this.state = { ...this.state, status: 'paused', t: this.baseT };
    window.clearInterval(this.timer);
    this.playback.pause();
    this.emit();
  }

  togglePause() {
    if (this.state.status === 'running') this.pause();
    else if (this.state.status === 'paused') {
      this.beeper.unlock();
      this.resume();
    } else this.start();
  }

  /** Jump to a workout time. Zone changes caused by a jump switch immediately, without countdown. */
  seek(t: number) {
    if (this.state.status === 'ready' || this.state.status === 'done') return;
    this.baseT = Math.min(Math.max(0, t), this.timeline.total - 0.01);
    this.resumedAt = performance.now();
    this.state = { ...this.state, t: this.baseT };
    this.update(false);
  }

  nudge(seconds: number) {
    this.seek(this.now() + seconds);
  }

  nextBlock() {
    const next = this.timeline.blocks[this.state.blockIndex + 1];
    if (next) this.seek(next.start);
  }

  previousBlock() {
    const { blocks } = this.timeline;
    const cur = blocks[this.state.blockIndex];
    // Within the first few seconds of a block, go to the previous one; otherwise restart this one.
    const target = this.now() - cur.start < 3 && this.state.blockIndex > 0 ? blocks[this.state.blockIndex - 1] : cur;
    this.seek(target.start);
  }

  private tick() {
    this.update(true);
  }

  private update(natural: boolean) {
    const t = this.now();
    const { blocks, total } = this.timeline;
    if (t >= total) {
      this.baseT = total;
      window.clearInterval(this.timer);
      this.playback.pause();
      this.state = { status: 'done', t: total, blockIndex: blocks.length - 1, countdown: null };
      if (natural) this.beeper.go();
      this.emit();
      return;
    }
    const blockIndex = blockIndexAt(blocks, t);
    if (blockIndex !== this.state.blockIndex) {
      this.playback.enterZone(blocks[blockIndex].zone);
      if (natural) this.beeper.go();
    }
    const remaining = blocks[blockIndex].end - t;
    const countdown = blockIndex < blocks.length - 1 && remaining <= COUNTDOWN_SECONDS ? Math.ceil(remaining) : null;
    if (natural && countdown !== null && countdown !== this.state.countdown) this.beeper.tick();
    this.state = { ...this.state, t, blockIndex, countdown };
    this.emit();
  }

  private emit() {
    this.onChange(this.state);
  }

  destroy() {
    window.clearInterval(this.timer);
  }
}
