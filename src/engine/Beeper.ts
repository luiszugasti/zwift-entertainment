/** Countdown beeps via Web Audio. Create from a user gesture so audio is allowed. */
export class Beeper {
  private ctx: AudioContext | null = null;

  unlock() {
    if (!this.ctx) this.ctx = new AudioContext();
    void this.ctx.resume();
  }

  private tone(freq: number, seconds: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const t = ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.35, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + seconds + 0.05);
  }

  tick() {
    this.tone(660, 0.15);
  }

  go() {
    this.tone(990, 0.4);
  }
}
