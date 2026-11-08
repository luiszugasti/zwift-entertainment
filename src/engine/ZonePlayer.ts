import {
  advanceChannel,
  planChannel,
  recordChannelTime,
  uploadsListId,
  type ChannelMode,
  type ChannelState,
} from '../lib/channel';
import { linksSignature, loadChannelState, saveChannelState, type SavedPosition } from '../lib/config';
import { parseYouTubeLink, type MediaItem } from '../lib/youtube';
import type { ZoneId } from '../lib/zones';

// YT.PlayerState values; the typings declare them as a const enum.
const ENDED = 0;
const PLAYING = 1;
const PAUSED = 2;
const BUFFERING = 3;

/** A channel video that never starts is usually an upcoming premiere or scheduled stream. */
const STALL_MS = 60_000;

interface Position {
  item: number;
  playlistIndex: number;
  videoId?: string;
  time: number;
}

interface ChannelRun {
  key: string;
  listId: string;
  /** Uploads list (newest first) the current plan was made from. */
  list: string[];
  state: ChannelState;
  mode: ChannelMode;
  index: number;
}

type ChannelItem = Extract<MediaItem, { kind: 'channel' }>;

export interface NowPlaying {
  title: string;
  time: number;
  duration?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Plays one zone's content: a list of videos, playlists and channels played in order, looping.
 * Remembers where it is so the zone resumes where it left off.
 */
export class ZonePlayer {
  readonly owner: ZoneId;
  readonly el: HTMLDivElement;
  private readonly items: MediaItem[];
  private readonly sig: string;
  private pos: Position;
  private player: YT.Player | null = null;
  private ready = false;
  /** Bumped on every new player so callbacks from a replaced one are ignored. */
  private generation = 0;
  /** Item the current player was created for, -1 if none. */
  private mountedItem = -1;
  /** True once the loaded video has actually started, so its time is meaningful. */
  private started = false;
  /** Video to jump to within a playlist once it loads (resume by ID, or a link to a specific video). */
  private pendingJump: { videoId: string; time: number } | null = null;
  private pendingSeek: number | null = null;
  private channel: ChannelRun | null = null;
  private stallTimer = 0;
  private wantPlaying = false;
  private errorStreak = 0;
  private volume: number;
  /** Last seen video details; persisted so the zone can show what it will resume. */
  private info: NowPlaying | null = null;

  constructor(
    owner: ZoneId,
    links: string[],
    saved: SavedPosition | undefined,
    host: HTMLElement,
    volume: number,
    private readonly onNotice: (msg: string) => void,
  ) {
    this.owner = owner;
    this.volume = volume;
    this.sig = linksSignature(links);
    this.items = links
      .map(parseYouTubeLink)
      .filter((i): i is MediaItem => i !== null && (i.kind !== 'channel' || i.channelId !== null));
    if (saved && saved.sig === this.sig && saved.item < this.items.length) {
      this.pos = { item: saved.item, playlistIndex: saved.playlistIndex, videoId: saved.videoId, time: saved.time };
      if (saved.title) this.info = { title: saved.title, time: saved.shownTime ?? saved.time, duration: saved.duration };
      if (this.items[saved.item].kind === 'playlist' && saved.videoId) {
        this.pendingJump = { videoId: saved.videoId, time: saved.time };
      }
    } else {
      this.pos = this.freshPosition(0);
    }

    this.el = document.createElement('div');
    this.el.className = 'zone-player';
    host.appendChild(this.el);
  }

  get playable(): boolean {
    return this.items.length > 0;
  }

  private freshPosition(item: number): Position {
    const it = this.items[item];
    this.pendingJump =
      it?.kind === 'playlist' && it.videoId && it.index === undefined ? { videoId: it.videoId, time: 0 } : null;
    return {
      item,
      playlistIndex: it?.kind === 'playlist' ? (it.index ?? 0) : 0,
      time: it?.kind === 'video' ? (it.start ?? 0) : 0,
    };
  }

  private channelListId(it: ChannelItem): string {
    return uploadsListId(it.channelId!, it.includeShorts);
  }

  /**
   * Creates a fresh YouTube player for the current item. Reusing a player for a different list
   * is unreliable: it can keep reporting, and even playing from, the previous list.
   */
  private mount() {
    const gen = ++this.generation;
    this.teardownPlayer();
    this.mountedItem = this.pos.item;
    const it = this.items[this.pos.item];
    const target = document.createElement('div');
    this.el.appendChild(target);
    const playerVars: YT.PlayerVars = { autoplay: 0, playsinline: 1, rel: 0 };
    if (it.kind === 'channel') Object.assign(playerVars, { listType: 'playlist', list: this.channelListId(it) });
    this.player = new YT.Player(target, {
      width: '100%',
      height: '100%',
      playerVars,
      events: {
        onReady: () => gen === this.generation && void this.handleReady(gen),
        onStateChange: (e) => gen === this.generation && this.handleState(e.data),
        onError: (e) => gen === this.generation && this.handleError(e.data),
      },
    });
  }

  private teardownPlayer() {
    window.clearTimeout(this.stallTimer);
    try {
      this.player?.destroy();
    } catch {
      // Player may not have finished initialising.
    }
    this.player = null;
    this.ready = false;
    this.started = false;
    this.pendingSeek = null;
    this.channel = null;
    this.el.replaceChildren();
  }

  private async handleReady(gen: number) {
    const p = this.player!;
    p.setVolume(this.volume);
    p.unMute();
    this.ready = true;
    const it = this.items[this.pos.item];
    if (it.kind === 'video') {
      const args = { videoId: it.videoId, startSeconds: this.pos.time };
      if (this.wantPlaying) p.loadVideoById(args);
      else p.cueVideoById(args);
    } else if (it.kind === 'playlist') {
      // The positional (listId, index, start) form only cues the list; the object form plays it.
      const args = { list: it.listId, listType: 'playlist' as const, index: this.pos.playlistIndex, startSeconds: this.pos.time };
      if (this.wantPlaying) p.loadPlaylist(args);
      else p.cuePlaylist(args);
    } else {
      await this.startChannel(it, gen);
    }
  }

  private async startChannel(it: ChannelItem, gen: number) {
    const p = this.player!;
    const listId = this.channelListId(it);
    let list: string[] = [];
    for (let i = 0; i < 50 && gen === this.generation; i++) {
      list = p.getPlaylist() ?? [];
      if (list.length) break;
      await sleep(100);
    }
    if (gen !== this.generation) return;
    if (!list.length) {
      this.handleError(-1, "couldn't load the channel's videos");
      return;
    }
    const key = `${this.owner}:${listId}`;
    const { state, target } = planChannel(loadChannelState(key), list);
    saveChannelState(key, state);
    this.channel = { key, listId, list, state, mode: target.mode, index: target.index };
    const args = { list: listId, listType: 'playlist' as const, index: target.index, startSeconds: target.time };
    if (this.wantPlaying) {
      p.loadPlaylist(args);
      this.armStallTimer();
    } else {
      p.cuePlaylist(args);
    }
  }

  private armStallTimer() {
    window.clearTimeout(this.stallTimer);
    if (!this.channel) return;
    this.stallTimer = window.setTimeout(() => {
      if (this.wantPlaying && !this.started && this.channel) {
        this.onNotice("Skipped a channel video that didn't start (an upcoming premiere or stream?).");
        this.nextChannelVideo();
      }
    }, STALL_MS);
  }

  play() {
    if (!this.playable) return;
    this.wantPlaying = true;
    this.el.classList.add('active');
    if (!this.player || this.mountedItem !== this.pos.item) {
      this.mount(); // plays once ready
      return;
    }
    if (!this.ready) return;
    this.player.unMute();
    this.player.playVideo();
    if (!this.started) this.armStallTimer();
  }

  pause() {
    this.wantPlaying = false;
    window.clearTimeout(this.stallTimer);
    if (!this.player || !this.ready) return;
    this.capture();
    this.player.pauseVideo();
  }

  hide() {
    this.el.classList.remove('active');
  }

  show() {
    this.el.classList.add('active');
  }

  /** Current video title and time; falls back to the last seen details. */
  nowPlaying(): NowPlaying | null {
    const p = this.player;
    if (p && this.ready && this.started && this.pendingSeek === null && !this.pendingJump) {
      const title = p.getVideoData()?.title;
      if (title) this.info = { title, time: p.getCurrentTime() || 0, duration: p.getDuration() || undefined };
    }
    return this.info;
  }

  setVolume(volume: number) {
    this.volume = volume;
    if (this.ready) this.player?.setVolume(volume);
  }

  /** Reads the live position from the player. */
  private capture() {
    const p = this.player;
    if (!p || !this.ready || !this.started || this.pendingSeek !== null || this.pendingJump) return;
    const state = p.getPlayerState();
    if (state !== PLAYING && state !== PAUSED && state !== BUFFERING) return;
    const time = p.getCurrentTime() || 0;
    this.nowPlaying();
    const it = this.items[this.pos.item];
    if (it.kind === 'channel') {
      const ch = this.channel;
      if (!ch || p.getPlaylistIndex() !== ch.index) return;
      ch.state = recordChannelTime(ch.state, ch.mode, time, p.getVideoData()?.video_id);
      saveChannelState(ch.key, ch.state);
      return;
    }
    this.pos.time = time;
    if (it.kind === 'playlist') {
      const idx = p.getPlaylistIndex();
      if (idx >= 0) this.pos.playlistIndex = idx;
      this.pos.videoId = p.getVideoData()?.video_id || this.pos.videoId;
    }
  }

  position(): SavedPosition {
    this.capture();
    const info = this.info ? { title: this.info.title, duration: this.info.duration, shownTime: this.info.time } : {};
    return { sig: this.sig, ...this.pos, ...info };
  }

  /** Next link in the zone's list (looping). */
  private advance() {
    this.pos = this.freshPosition((this.pos.item + 1) % this.items.length);
    if (this.wantPlaying) this.mount();
    else this.mountedItem = -1;
  }

  /** Next video of the current channel, per the catch-up/backlog rules. */
  private nextChannelVideo() {
    const ch = this.channel!;
    ch.state = advanceChannel(ch.state, ch.list, ch.mode, ch.index);
    saveChannelState(ch.key, ch.state);
    // A fresh player re-reads the uploads list, which picks up anything new.
    if (this.wantPlaying) this.mount();
    else this.mountedItem = -1;
  }

  private handleState(state: number) {
    const p = this.player!;
    // Within a list YouTube moves on to the next video without an ENDED event. For a channel
    // we choose the next video ourselves, so treat leaving the chosen video as it ending.
    if (this.channel && this.started && state !== ENDED) {
      const idx = p.getPlaylistIndex();
      if (idx >= 0 && idx !== this.channel.index) {
        this.nextChannelVideo();
        return;
      }
    }
    if (state === PLAYING) {
      this.started = true;
      this.errorStreak = 0;
      window.clearTimeout(this.stallTimer);
      if (!this.wantPlaying) {
        p.pauseVideo();
        return;
      }
      if (this.pendingSeek !== null) {
        const t = this.pendingSeek;
        this.pendingSeek = null;
        p.seekTo(t, true);
        return;
      }
      if (this.pendingJump) {
        const jump = this.pendingJump;
        this.pendingJump = null;
        const idx = p.getPlaylist()?.indexOf(jump.videoId) ?? -1;
        if (idx >= 0 && idx !== p.getPlaylistIndex()) {
          this.pendingSeek = jump.time > 1 ? jump.time : null;
          p.playVideoAt(idx);
        }
      }
    } else if (state === ENDED) {
      const it = this.items[this.pos.item];
      if (it.kind === 'channel') {
        if (this.channel) this.nextChannelVideo();
        return;
      }
      if (it.kind === 'playlist') {
        const list = p.getPlaylist();
        // YouTube moves through the playlist itself; only step in after its last video.
        if (list && p.getPlaylistIndex() < list.length - 1) return;
      }
      this.advance();
    }
  }

  private handleError(code: number, reason?: string) {
    this.errorStreak++;
    if (this.errorStreak > 20) {
      this.onNotice('Nothing in this zone could be played. Check its links.');
      this.wantPlaying = false;
      return;
    }
    reason ??= code === 101 || code === 150 ? "the owner doesn't allow it to play outside YouTube" : `YouTube error ${code}`;
    this.onNotice(`Skipped a video: ${reason}.`);
    const it = this.items[this.pos.item];
    if (it.kind === 'channel' && this.channel) {
      this.nextChannelVideo();
      return;
    }
    const p = this.player;
    const list = it.kind === 'playlist' ? p?.getPlaylist() : null;
    if (p && list && p.getPlaylistIndex() < list.length - 1) p.nextVideo();
    else this.advance();
  }

  destroy() {
    this.wantPlaying = false;
    this.generation++;
    this.teardownPlayer();
    this.el.remove();
  }
}
