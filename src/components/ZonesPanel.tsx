import { useState, type CSSProperties } from 'react';
import { uploadsListId } from '../lib/channel';
import {
  childrenOf,
  linksSignature,
  loadChannelState,
  loadPositions,
  savePositions,
  type AppConfig,
  type ZoneConfig,
} from '../lib/config';
import { formatTime } from '../lib/timeline';
import { channelLink, parseYouTubeLink, resolveChannel, thumbnailUrl, type MediaItem } from '../lib/youtube';
import { ZONES, zoneMeta, type ZoneId } from '../lib/zones';

interface Props {
  config: AppConfig;
  onChange: (config: AppConfig) => void;
  locked: boolean;
  /** Seconds spent in each zone by the loaded workout. */
  zoneTime: Partial<Record<ZoneId, number>> | null;
}

export function ZonesPanel({ config, onChange, locked, zoneTime }: Props) {
  const [flash, setFlash] = useState<ZoneId | null>(null);
  const [, setPositionsVersion] = useState(0);
  const positions = loadPositions();

  const updateZone = (id: ZoneId, patch: Partial<ZoneConfig>) => {
    onChange({ ...config, zones: { ...config.zones, [id]: { ...config.zones[id], ...patch } } });
  };

  const goTo = (id: ZoneId) => {
    document.getElementById(`zone-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setFlash(id);
    window.setTimeout(() => setFlash(null), 1200);
  };

  const resetPosition = (id: ZoneId) => {
    const next = loadPositions();
    delete next[id];
    savePositions(next);
    setPositionsVersion((v) => v + 1);
  };

  return (
    <div className="zones">
      {locked && <div className="banner">Stop the ride to change zone content.</div>}
      <p className="muted intro">
        Add YouTube videos, playlists or channels for each zone. They play in order and loop. Each zone remembers where it was, so
        when you come back to it, it picks up where it left off.
      </p>
      {ZONES.map((meta) => (
        <ZoneCard
          key={meta.id}
          id={meta.id}
          config={config}
          locked={locked}
          flash={flash === meta.id}
          seconds={zoneTime?.[meta.id]}
          position={positions[meta.id]}
          onUpdate={(patch) => updateZone(meta.id, patch)}
          onGoTo={goTo}
          onResetPosition={() => resetPosition(meta.id)}
        />
      ))}
    </div>
  );
}

interface CardProps {
  id: ZoneId;
  config: AppConfig;
  locked: boolean;
  flash: boolean;
  seconds: number | undefined;
  position: ReturnType<typeof loadPositions>[ZoneId];
  onUpdate: (patch: Partial<ZoneConfig>) => void;
  onGoTo: (id: ZoneId) => void;
  onResetPosition: () => void;
}

function ZoneCard({ id, config, locked, flash, seconds, position, onUpdate, onGoTo, onResetPosition }: CardProps) {
  const meta = zoneMeta(id);
  const zone = config.zones[id];
  const children = childrenOf(config, id);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [adding, setAdding] = useState(false);

  // Zones that own their content can be copied from.
  const sources = ZONES.filter((z) => z.id !== id && !config.zones[z.id].parent);

  const addLink = async () => {
    let value = draft.trim();
    const item = parseYouTubeLink(value);
    if (!item) {
      setError("That doesn't look like a YouTube video, playlist or channel link.");
      return;
    }
    if (item.kind === 'channel') {
      let channelId = item.channelId;
      if (!channelId) {
        setAdding(true);
        try {
          channelId = (await resolveChannel(item.path)).channelId;
        } catch (e) {
          setError(
            `Couldn't look up that channel (${(e as Error).message || 'no response'}). Paste its channel ID link instead: ` +
              'on the channel page open "more about this channel", choose Share channel, then Copy channel ID, ' +
              'and paste https://www.youtube.com/channel/<that ID>.',
          );
          return;
        } finally {
          setAdding(false);
        }
      }
      value = channelLink(item.path, channelId, item.includeShorts);
    }
    onUpdate({ links: [...zone.links, value] });
    setDraft('');
    setError(null);
  };

  const setLink = (i: number, link: string) => onUpdate({ links: zone.links.map((l, j) => (j === i ? link : l)) });

  const move = (i: number, delta: number) => {
    const links = [...zone.links];
    const [l] = links.splice(i, 1);
    links.splice(i + delta, 0, l);
    onUpdate({ links });
  };

  const validPosition = position && position.sig === linksSignature(zone.links) ? position : null;

  return (
    <section
      id={`zone-${id}`}
      className={`zone-card${flash ? ' flash' : ''}`}
      style={{ '--zone': meta.color } as CSSProperties}
    >
      <header className="zone-card-head">
        <span className="zone-pill">{meta.short}</span>
        <div>
          <h3>{meta.label}</h3>
          <span className="muted">{meta.range}</span>
        </div>
        {seconds !== undefined && <span className="zone-usage">{formatTime(seconds)} in this workout</span>}
      </header>

      {zone.parent ? (
        <div className="linked">
          <p>
            Plays the same content as <strong>{zoneMeta(zone.parent).label}</strong>, and continues from the same spot.
          </p>
          <div className="row">
            <button className="btn" onClick={() => onGoTo(zone.parent!)}>
              Edit in {zoneMeta(zone.parent).label}
            </button>
            <label className="inline-select">
              <span>Copy from</span>
              <select
                disabled={locked}
                value={zone.parent}
                onChange={(e) => onUpdate({ parent: e.target.value as ZoneId })}
              >
                {sources.map((z) => (
                  <option key={z.id} value={z.id}>
                    {z.label}
                  </option>
                ))}
              </select>
            </label>
            <button className="btn ghost" disabled={locked} onClick={() => onUpdate({ parent: null })}>
              Stop copying
            </button>
          </div>
        </div>
      ) : (
        <>
          {zone.links.length === 0 && (
            <p className="muted empty">
              No content. When the workout reaches this zone, the video that's already playing keeps going.
            </p>
          )}
          <ol className="links">
            {zone.links.map((link, i) => {
              const item = parseYouTubeLink(link);
              const thumb = item && thumbnailUrl(item);
              return (
                <li key={`${i}-${link}`} className={validPosition?.item === i ? 'current' : undefined}>
                  <div className="thumb">{thumb ? <img src={thumb} alt="" loading="lazy" /> : <span>▶</span>}</div>
                  <div className="link-body">
                    <span className={`tag ${item ? item.kind : 'invalid'}`}>
                      {item ? { playlist: 'Playlist', video: 'Video', channel: 'Channel' }[item.kind] : 'Invalid link'}
                    </span>
                    <a href={link} target="_blank" rel="noreferrer" className="link-url">
                      {item?.kind === 'channel' ? item.path.slice(1) : link}
                    </a>
                    {item?.kind === 'channel' && item.channelId && (
                      <ChannelInfo
                        zone={id}
                        item={item}
                        locked={locked}
                        onToggleShorts={(on) => setLink(i, channelLink(item.path, item.channelId!, on))}
                      />
                    )}
                  </div>
                  <div className="link-actions">
                    <button className="icon-btn" disabled={locked || i === 0} onClick={() => move(i, -1)} aria-label="Move up">
                      ↑
                    </button>
                    <button
                      className="icon-btn"
                      disabled={locked || i === zone.links.length - 1}
                      onClick={() => move(i, 1)}
                      aria-label="Move down"
                    >
                      ↓
                    </button>
                    <button
                      className="icon-btn danger"
                      disabled={locked}
                      onClick={() => onUpdate({ links: zone.links.filter((_, j) => j !== i) })}
                      aria-label="Remove"
                    >
                      ✕
                    </button>
                  </div>
                </li>
              );
            })}
          </ol>
          <form
            className="add-link"
            onSubmit={(e) => {
              e.preventDefault();
              void addLink();
            }}
          >
            <input
              type="url"
              placeholder="Paste a YouTube video, playlist or channel link"
              value={draft}
              disabled={locked}
              onChange={(e) => {
                setDraft(e.target.value);
                setError(null);
              }}
            />
            <button className="btn primary" disabled={locked || adding || !draft.trim()}>
              {adding ? 'Looking up…' : 'Add'}
            </button>
          </form>
          {error && <p className="error">{error}</p>}

          <div className="row zone-footer">
            {children.length > 0 ? (
              <span className="muted">
                Also playing in {children.map((c) => zoneMeta(c).label).join(', ')}.
              </span>
            ) : picking ? (
              <label className="inline-select">
                <span>Copy content from</span>
                <select
                  autoFocus
                  defaultValue=""
                  onChange={(e) => {
                    if (e.target.value) onUpdate({ parent: e.target.value as ZoneId });
                    setPicking(false);
                  }}
                  onBlur={() => setPicking(false)}
                >
                  <option value="" disabled>
                    Choose a zone…
                  </option>
                  {sources.map((z) => (
                    <option key={z.id} value={z.id}>
                      {z.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <button className="btn ghost" disabled={locked || sources.length === 0} onClick={() => setPicking(true)}>
                Copy content from other zone
              </button>
            )}
            {validPosition && (validPosition.item > 0 || validPosition.playlistIndex > 0 || validPosition.time > 1) && (
              <span className="resume">
                Resumes at link {validPosition.item + 1}
                {validPosition.playlistIndex > 0 && `, video ${validPosition.playlistIndex + 1}`} ·{' '}
                {formatTime(validPosition.time)}
                <button className="link-btn" disabled={locked} onClick={onResetPosition}>
                  Start over
                </button>
              </span>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function ChannelInfo({
  zone,
  item,
  locked,
  onToggleShorts,
}: {
  zone: ZoneId;
  item: Extract<MediaItem, { kind: 'channel' }>;
  locked: boolean;
  onToggleShorts: (on: boolean) => void;
}) {
  // Channel progress is kept per zone that owns the content, and per Shorts setting.
  const state = loadChannelState(`${zone}:${uploadsListId(item.channelId!, item.includeShorts)}`);
  const status = !state
    ? 'Starts with the newest upload, then works back through older ones.'
    : state.catchUp
      ? `Catching up on new uploads, then back to ${state.backlog.videoId ? 'where you were' : 'the older videos'}.`
      : state.backlog.time > 1
        ? `Resumes an older upload at ${formatTime(state.backlog.time)}. New uploads play first.`
        : 'Working back through older uploads. New uploads play first.';
  return (
    <div className="channel-info">
      <span className="muted">{status}</span>
      <label className="check">
        <input type="checkbox" checked={item.includeShorts} disabled={locked} onChange={(e) => onToggleShorts(e.target.checked)} />
        Include Shorts
      </label>
    </div>
  );
}
