export type MediaItem =
  | { kind: 'video'; videoId: string; start?: number }
  | { kind: 'playlist'; listId: string; videoId?: string; index?: number }
  | {
      kind: 'channel';
      /** Channel page path, e.g. "/@Jimmy_Broadbent" or "/channel/UC…". */
      path: string;
      /** Null until looked up (handles and custom URLs need resolving). */
      channelId: string | null;
      includeShorts: boolean;
    };

const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;

const ID_RE = /^[A-Za-z0-9_-]{11}$/;

function parseStart(t: string | null): number | undefined {
  if (!t) return undefined;
  if (/^\d+$/.test(t)) return Number(t);
  const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!m) return undefined;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

/** Parses a YouTube video or playlist link. Returns null if it isn't one. */
export function parseYouTubeLink(raw: string): MediaItem | null {
  const input = raw.trim();
  if (!input) return null;
  if (ID_RE.test(input)) return { kind: 'video', videoId: input };

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www\.|m\.|music\.)/, '');
  if (host === 'youtube.com') {
    const ch = url.pathname.match(/^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)\/?(?:videos|featured|streams)?\/?$/);
    if (ch) {
      const path = `/${decodeURIComponent(ch[1])}`;
      const direct = path.match(/^\/channel\/(.+)$/)?.[1];
      const param = url.searchParams.get('channel_id');
      const channelId = [direct, param].find((id) => id && CHANNEL_ID_RE.test(id)) ?? null;
      if (direct && !channelId) return null;
      return { kind: 'channel', path, channelId, includeShorts: url.searchParams.get('shorts') === '1' };
    }
  }
  let videoId: string | null = null;
  if (host === 'youtu.be') {
    videoId = url.pathname.slice(1).split('/')[0];
  } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    videoId = url.searchParams.get('v');
    const m = url.pathname.match(/^\/(?:embed|shorts|live|v)\/([^/?]+)/);
    if (!videoId && m) videoId = m[1];
  } else {
    return null;
  }
  if (videoId && !ID_RE.test(videoId)) videoId = null;

  const listId = url.searchParams.get('list');
  if (listId && /^[A-Za-z0-9_-]+$/.test(listId)) {
    const idx = Number(url.searchParams.get('index'));
    return {
      kind: 'playlist',
      listId,
      videoId: videoId ?? undefined,
      index: Number.isInteger(idx) && idx > 0 ? idx - 1 : undefined,
    };
  }
  if (videoId) return { kind: 'video', videoId, start: parseStart(url.searchParams.get('t') ?? url.searchParams.get('start')) };
  return null;
}

export function thumbnailUrl(item: MediaItem): string | null {
  return item.kind !== 'channel' && item.videoId ? `https://i.ytimg.com/vi/${item.videoId}/mqdefault.jpg` : null;
}

/** The link stored for a channel: readable, opens the channel, and carries the resolved ID. */
export function channelLink(path: string, channelId: string, includeShorts: boolean): string {
  const url = new URL(`https://www.youtube.com${path}`);
  if (!path.startsWith('/channel/')) url.searchParams.set('channel_id', channelId);
  if (includeShorts) url.searchParams.set('shorts', '1');
  return url.toString();
}

/**
 * Looks up a channel ID from a handle or custom URL. YouTube doesn't allow this from the
 * browser (no CORS), so it goes through the dev/preview server (see vite.config.ts).
 */
export async function resolveChannel(path: string): Promise<{ channelId: string; title?: string }> {
  const res = await fetch(`/api/channel-id?path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error(await res.text().catch(() => res.statusText));
  return res.json();
}

let apiPromise: Promise<void> | null = null;

export function loadYouTubeApi(): Promise<void> {
  if (window.YT?.Player) return Promise.resolve();
  if (apiPromise) return apiPromise;
  apiPromise = new Promise<void>((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve();
    };
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.onerror = () => {
      apiPromise = null;
      reject(new Error('Could not load the YouTube player. Check your internet connection.'));
    };
    document.head.appendChild(script);
  });
  return apiPromise;
}

declare global {
  interface Window {
    onYouTubeIframeAPIReady?: () => void;
  }
}
