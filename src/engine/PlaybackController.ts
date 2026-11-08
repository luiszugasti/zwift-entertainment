import { contentOwner, linksSignature, loadPositions, ownerLinks, savePositions, type AppConfig } from '../lib/config';
import { parseYouTubeLink } from '../lib/youtube';
import { ZONE_IDS, type ZoneId } from '../lib/zones';
import { ZonePlayer, type NowPlaying } from './ZonePlayer';

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

  /**
   * The workout entered `zone`. Switches to its content; a zone without content keeps whatever
   * is on screen, including content the rider picked by hand.
   */
  enterZone(zone: ZoneId) {
    const owner = this.ownerFor(zone);
    if (owner) this.switchTo(owner);
  }

  /** The rider picked a zone's content by hand. It stays on until the workout changes zone. */
  select(owner: ZoneId) {
    if (this.ownerFor(owner) === owner) this.switchTo(owner);
  }

  private switchTo(owner: ZoneId) {
    if (owner === this.active) return;
    const prev = this.active ? this.players.get(this.active) : undefined;
    prev?.pause();
    prev?.hide();
    this.active = owner;
    const next = this.playerFor(owner);
    if (this.playing) next.play();
    else next.show();
    this.persist();
  }

  /** Zones that own playable content, in zone order. */
  owners(): ZoneId[] {
    return ZONE_IDS.filter((z) => this.ownerFor(z) === z);
  }

  /** What a zone's content is on (or will resume), live if its player exists. */
  nowPlaying(owner: ZoneId): NowPlaying | null {
    const live = this.players.get(owner)?.nowPlaying();
    if (live) return live;
    const saved = loadPositions()[owner];
    if (!saved || saved.sig !== linksSignature(ownerLinks(this.config, owner)) || !saved.title) return null;
    return { title: saved.title, time: saved.shownTime ?? saved.time, duration: saved.duration };
  }

  play() {
    this.playing = true;
    if (this.active) this.playerFor(this.active).play();
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
