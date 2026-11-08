import { contentOwner, loadPositions, ownerLinks, savePositions, type AppConfig } from '../lib/config';
import { parseYouTubeLink } from '../lib/youtube';
import type { ZoneId } from '../lib/zones';
import { ZonePlayer } from './ZonePlayer';

/**
 * Decides which zone's content is on screen. Only one player plays at a time; switching
 * pauses the old one (keeping its position) and resumes the new one.
 */
export class PlaybackController {
  private players = new Map<ZoneId, ZonePlayer>();
  private active: ZoneId | null = null;
  private playing = false;
  private saveTimer: number;
  private volume: number;

  constructor(
    private readonly host: HTMLElement,
    private readonly config: AppConfig,
    private readonly onNotice: (msg: string) => void,
  ) {
    this.volume = config.volume;
    this.saveTimer = window.setInterval(() => this.persist(), 3000);
  }

  /** Zone whose content plays in `zone`, or null when it has none (previous content keeps playing). */
  ownerFor(zone: ZoneId): ZoneId | null {
    const links = ownerLinks(this.config, zone);
    return links.some((l) => parseYouTubeLink(l)) ? contentOwner(this.config, zone) : null;
  }

  get activeOwner(): ZoneId | null {
    return this.active;
  }

  /** What entering `zone` will do to playback. */
  transition(zone: ZoneId): 'switch' | 'continue' | 'keep-previous' {
    const owner = this.ownerFor(zone);
    if (!owner) return 'keep-previous';
    return owner === this.active ? 'continue' : 'switch';
  }

  private playerFor(owner: ZoneId): ZonePlayer {
    let p = this.players.get(owner);
    if (!p) {
      const links = ownerLinks(this.config, owner);
      p = new ZonePlayer(owner, links, loadPositions()[owner], this.host, this.volume, this.onNotice);
      this.players.set(owner, p);
    }
    return p;
  }

  enterZone(zone: ZoneId) {
    const owner = this.ownerFor(zone);
    if (!owner || owner === this.active) return;
    const prev = this.active ? this.players.get(this.active) : undefined;
    prev?.pause();
    prev?.hide();
    this.active = owner;
    if (this.playing) void this.playerFor(owner).play();
    this.persist();
  }

  play() {
    this.playing = true;
    if (this.active) void this.playerFor(this.active).play();
  }

  pause() {
    this.playing = false;
    if (this.active) this.players.get(this.active)?.pause();
    this.persist();
  }

  setVolume(volume: number) {
    this.volume = volume;
    for (const p of this.players.values()) p.setVolume(volume);
  }

  persist() {
    if (!this.players.size) return;
    const positions = loadPositions();
    for (const [owner, p] of this.players) positions[owner] = p.position();
    savePositions(positions);
  }

  destroy() {
    this.pause();
    window.clearInterval(this.saveTimer);
    for (const p of this.players.values()) p.destroy();
    this.players.clear();
    this.active = null;
  }
}
