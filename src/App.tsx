import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type RefObject } from 'react';
import { FtpModal } from './components/FtpModal';
import { TimelineChart } from './components/TimelineChart';
import { ZonesPanel } from './components/ZonesPanel';
import { Beeper } from './engine/Beeper';
import { PlaybackController } from './engine/PlaybackController';
import { WorkoutSession, type SessionState } from './engine/WorkoutSession';
import {
  childrenOf,
  exportConfig,
  loadConfig,
  loadStoredWorkout,
  normalizeConfig,
  ownerLinks,
  saveConfig,
  saveStoredWorkout,
  type AppConfig,
} from './lib/config';
import { parseWorkoutFile, WorkoutParseError, type Workout } from './lib/parsers';
import { buildTimeline, formatTime, type Timeline } from './lib/timeline';
import { loadYouTubeApi } from './lib/youtube';
import { zoneMeta, type ZoneId } from './lib/zones';

interface LoadedWorkout {
  workout: Workout;
  timeline: Timeline;
}

interface PendingFtp {
  fileName: string;
  text: string;
  name: string;
  build: (ftp: number) => Workout;
}

type Tab = 'ride' | 'zones';

/** A ride is in progress (including the end-of-workout prompt and watching on afterwards). */
function isActive(session: SessionState | null): boolean {
  return !!session && session.status !== 'ready' && session.status !== 'done';
}

function load(workout: Workout): LoadedWorkout {
  return { workout, timeline: buildTimeline(workout) };
}

function restoreWorkout(): LoadedWorkout | null {
  const stored = loadStoredWorkout();
  if (!stored) return null;
  try {
    const res = parseWorkoutFile(stored.fileName, stored.text);
    if (res.status === 'ok') return load(res.workout);
    return stored.ftp ? load(res.build(stored.ftp)) : null;
  } catch {
    return null;
  }
}

export function App() {
  const [config, setConfig] = useState<AppConfig>(loadConfig);
  const [tab, setTab] = useState<Tab>('ride');
  const [loaded, setLoaded] = useState<LoadedWorkout | null>(restoreWorkout);
  const [pendingFtp, setPendingFtp] = useState<PendingFtp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notices, setNotices] = useState<{ id: number; text: string }[]>([]);
  const [session, setSession] = useState<SessionState | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);

  const stageRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<PlaybackController | null>(null);
  const sessionRef = useRef<WorkoutSession | null>(null);
  const beeperRef = useRef(new Beeper());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  const active = isActive(session);

  useEffect(() => saveConfig(config), [config]);

  useEffect(() => {
    loadYouTubeApi().catch((e: Error) => setApiError(e.message));
  }, []);

  const notify = useCallback((text: string) => {
    const id = Date.now() + Math.random();
    setNotices((n) => [...n.slice(-2), { id, text }]);
    window.setTimeout(() => setNotices((n) => n.filter((x) => x.id !== id)), 6000);
  }, []);

  const teardown = useCallback(() => {
    sessionRef.current?.destroy();
    controllerRef.current?.destroy();
    sessionRef.current = null;
    controllerRef.current = null;
  }, []);

  const stopRide = useCallback(() => {
    teardown();
    setSession(null);
  }, [teardown]);

  // The complete screen keeps its players so the rider can watch on. If zone content is
  // edited they'd be out of date, so drop them (the bar disappears until the next ride).
  const zonesRef = useRef(config.zones);
  useEffect(() => {
    if (zonesRef.current === config.zones) return;
    zonesRef.current = config.zones;
    if (sessionRef.current?.snapshot.status === 'done') {
      teardown();
      setSession((s) => (s ? { ...s } : s));
    }
  }, [config.zones, teardown]);

  /** The rider picked a zone's content from the bar under the video. */
  const pickContent = (owner: ZoneId) => {
    const s = sessionRef.current;
    const c = controllerRef.current;
    if (!s || !c) return;
    c.select(owner);
    if (s.snapshot.status === 'ending') s.continueWatching();
    else if (s.snapshot.status === 'done') s.watchAfter();
    // The clock doesn't tick after the workout, so re-render for the new selection.
    setSession({ ...s.snapshot });
  };

  useEffect(() => {
    const save = () => controllerRef.current?.persist();
    window.addEventListener('beforeunload', save);
    return () => {
      window.removeEventListener('beforeunload', save);
      teardown();
    };
  }, [teardown]);

  const startRide = async () => {
    if (!loaded || !stageRef.current) return;
    beeperRef.current.unlock();
    try {
      await loadYouTubeApi();
    } catch (e) {
      setApiError((e as Error).message);
      return;
    }
    teardown();
    const controller = new PlaybackController(stageRef.current, config, notify);
    const s = new WorkoutSession(loaded.timeline, controller, beeperRef.current, setSession);
    controllerRef.current = controller;
    sessionRef.current = s;
    if (import.meta.env.DEV) Object.assign(window, { __rideReel: { controller, session: s } });
    s.start();
  };

  const acceptWorkout = (fileName: string, text: string, workout: Workout, ftp?: number) => {
    setLoaded(load(workout));
    saveStoredWorkout({ fileName, text, ftp });
    setSession(null);
    setError(null);
  };

  const handleFile = async (file: File) => {
    if (active) return;
    try {
      const text = await file.text();
      const res = parseWorkoutFile(file.name, text);
      if (res.status === 'ok') acceptWorkout(file.name, text, res.workout);
      else setPendingFtp({ fileName: file.name, text, name: res.name, build: res.build });
    } catch (e) {
      setError(e instanceof WorkoutParseError ? e.message : `Couldn't read that file: ${(e as Error).message}`);
    }
  };

  const setVolume = (volume: number) => {
    setConfig((c) => ({ ...c, volume }));
    controllerRef.current?.setVolume(volume);
  };

  const exportSettings = () => {
    const blob = new Blob([exportConfig(config)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'ridereel-settings.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const importSettings = async (file: File) => {
    try {
      const next = normalizeConfig(JSON.parse(await file.text()));
      if (window.confirm('Replace your current zone content with the imported settings?')) {
        setConfig(next);
        notify('Settings imported.');
      }
    } catch (e) {
      setError(`Couldn't import settings: ${(e as Error).message}`);
    }
  };

  // Keyboard: space = play/pause, ←/→ = nudge 5s.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = sessionRef.current;
      if (!s || tab !== 'ride' || (e.target as HTMLElement).closest('input, select, textarea, button')) return;
      if (e.code === 'Space') {
        e.preventDefault();
        s.togglePause();
      } else if (e.code === 'ArrowLeft') s.nudge(-5);
      else if (e.code === 'ArrowRight') s.nudge(5);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tab]);

  const zoneTime = useMemo(() => {
    if (!loaded) return null;
    const totals: Partial<Record<ZoneId, number>> = {};
    for (const b of loaded.timeline.blocks) totals[b.zone] = (totals[b.zone] ?? 0) + (b.end - b.start);
    return totals;
  }, [loaded]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            ▶
          </span>
          RideReel
        </div>
        <nav className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'ride'} className={tab === 'ride' ? 'on' : ''} onClick={() => setTab('ride')}>
            Ride
          </button>
          <button role="tab" aria-selected={tab === 'zones'} className={tab === 'zones' ? 'on' : ''} onClick={() => setTab('zones')}>
            Zone content
          </button>
        </nav>
        <div className="topbar-tools">
          <label className="volume" title="Video volume">
            <span aria-hidden>🔊</span>
            <input type="range" min={0} max={100} value={config.volume} onChange={(e) => setVolume(Number(e.target.value))} />
            <span className="volume-value">{config.volume}</span>
          </label>
          <button className="btn ghost small" onClick={exportSettings}>
            Export
          </button>
          <button className="btn ghost small" disabled={active} onClick={() => importInputRef.current?.click()}>
            Import
          </button>
          <input
            ref={importInputRef}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void importSettings(f);
              e.target.value = '';
            }}
          />
        </div>
      </header>

      {(error || apiError) && (
        <div className="banner error-banner" role="alert">
          {error ?? apiError}
          {error && (
            <button className="link-btn" onClick={() => setError(null)}>
              Dismiss
            </button>
          )}
        </div>
      )}

      <main>
        <section hidden={tab !== 'ride'} className="ride">
          <RidePanel
            loaded={loaded}
            config={config}
            session={session}
            controller={controllerRef.current}
            stageRef={stageRef}
            onPickFile={() => fileInputRef.current?.click()}
            onDropFile={handleFile}
            onStart={startRide}
            onStop={stopRide}
            sessionApi={sessionRef.current}
            onEditZones={() => setTab('zones')}
            onPickContent={pickContent}
          />
          <input
            ref={fileInputRef}
            type="file"
            accept=".zwo,.erg,.mrc"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleFile(f);
              e.target.value = '';
            }}
          />
        </section>
        {tab === 'zones' && <ZonesPanel config={config} onChange={setConfig} locked={active} zoneTime={zoneTime} />}
      </main>

      <footer className="footer">
        <a href="https://github.com/luiszugasti" target="_blank" rel="noreferrer">
          my github (@luiszugasti)
        </a>
        <span aria-hidden>|</span>
        <a href="https://buymeacoffee.com/luiszugasti" target="_blank" rel="noreferrer">
          buy me more tokens
        </a>
        <span aria-hidden>|</span>
        <a href="https://luiszugasti.me" target="_blank" rel="noreferrer">
          my website
        </a>
      </footer>

      <div className="toasts" aria-live="polite">
        {notices.map((n) => (
          <div key={n.id} className="toast">
            {n.text}
          </div>
        ))}
      </div>

      {pendingFtp && (
        <FtpModal
          workoutName={pendingFtp.name}
          initialFtp={config.ftp}
          onCancel={() => setPendingFtp(null)}
          onSubmit={(ftp) => {
            setConfig((c) => ({ ...c, ftp }));
            acceptWorkout(pendingFtp.fileName, pendingFtp.text, pendingFtp.build(ftp), ftp);
            setPendingFtp(null);
          }}
        />
      )}
    </div>
  );
}

interface RideProps {
  loaded: LoadedWorkout | null;
  config: AppConfig;
  session: SessionState | null;
  controller: PlaybackController | null;
  sessionApi: WorkoutSession | null;
  stageRef: RefObject<HTMLDivElement | null>;
  onPickFile: () => void;
  onDropFile: (f: File) => void;
  onStart: () => void;
  onStop: () => void;
  onEditZones: () => void;
  onPickContent: (owner: ZoneId) => void;
}

function RidePanel({
  loaded,
  config,
  session,
  controller,
  sessionApi,
  stageRef,
  onPickFile,
  onDropFile,
  onStart,
  onStop,
  onEditZones,
  onPickContent,
}: RideProps) {
  const [dragging, setDragging] = useState(false);
  const active = isActive(session);
  const theaterRef = useRef<HTMLDivElement>(null);
  const [fullscreen, toggleFullscreen] = useFullscreen(theaterRef);
  const dockRef = useRef<HTMLDivElement>(null);
  const [idle, wake] = useIdle(theaterRef, fullscreen, dockRef);

  // F toggles full screen during a ride.
  useEffect(() => {
    if (!session) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'KeyF' || e.metaKey || e.ctrlKey || e.altKey) return;
      if ((e.target as HTMLElement).closest('input, select, textarea')) return;
      toggleFullscreen();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [session, toggleFullscreen]);

  const dropProps = {
    onDragOver: (e: DragEvent) => {
      e.preventDefault();
      if (!active) setDragging(true);
    },
    onDragLeave: () => setDragging(false),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const f = e.dataTransfer.files[0];
      if (f && !active) onDropFile(f);
    },
  };

  if (!loaded) {
    return (
      <div className={`dropzone${dragging ? ' dragging' : ''}`} {...dropProps}>
        <h1>Load a workout</h1>
        <p className="muted">Drop a Zwift workout file here (.zwo, .erg or .mrc), or</p>
        <button className="btn primary" onClick={onPickFile}>
          Choose file
        </button>
      </div>
    );
  }

  const { workout, timeline } = loaded;
  const { blocks } = timeline;
  const t = session?.t ?? 0;
  const idx = session?.blockIndex ?? 0;
  const block = blocks[idx];
  const next = blocks[idx + 1];
  const zone = zoneMeta(block.zone);
  const done = session?.status === 'done';
  const inWorkout = session?.status === 'running' || session?.status === 'paused';
  const afterWorkout = session?.status === 'ending' || session?.status === 'extra';

  const owner = controller?.activeOwner ?? null;
  const transition = next && controller ? controller.transition(next.zone) : null;
  const usedZones = [...new Set(blocks.map((b) => b.zone))];

  return (
    <div className="ride-layout" {...dropProps}>
      <div className="workout-head">
        <div>
          <h1>{workout.name}</h1>
          <p className="muted">
            {formatTime(timeline.total)} · {blocks.length} zone {blocks.length === 1 ? 'block' : 'blocks'} · .{workout.format}
            {workout.ftp ? ` · FTP ${workout.ftp} W` : ''}
          </p>
        </div>
        <button className="btn ghost" disabled={active} onClick={onPickFile}>
          Change workout
        </button>
      </div>

      <TimelineChart timeline={timeline} t={session ? t : null} onSeek={inWorkout || session?.status === 'ending' ? (s) => sessionApi?.seek(s) : undefined} />

      <div className="hud" style={{ '--zone': zone.color } as CSSProperties}>
        <div className="hud-zone">
          <span className="zone-pill big">{zone.short}</span>
          <div>
            <strong>{zone.label}</strong>
            <span className="muted">{zone.range}</span>
          </div>
        </div>
        <div className="hud-stat">
          <span className="muted">Block left</span>
          <strong>{formatTime(block.end - t)}</strong>
        </div>
        <div className="hud-stat">
          <span className="muted">Elapsed</span>
          <strong>
            {formatTime(t)} <span className="muted">/ {formatTime(timeline.total)}</span>
          </strong>
        </div>
        <div className="hud-stat">
          <span className="muted">Next</span>
          <strong>{next ? `${zoneMeta(next.zone).label} in ${formatTime(next.start - t)}` : 'Finish'}</strong>
        </div>
      </div>

      <div ref={theaterRef} className={`theater${fullscreen ? ' fs' : ''}${idle ? ' idle' : ''}`}>
      <div className="stage-wrap">
        <div className="stage" ref={stageRef} />
        {!session && (
          <div className="stage-overlay">
            <p className="hint">Press Play at the same moment you start the workout in Zwift.</p>
            <button className="play-btn" onClick={onStart} aria-label="Play">
              ▶
            </button>
            <ZoneCheck zones={usedZones} config={config} onEdit={onEditZones} />
          </div>
        )}
        {done && (
          <div className="stage-overlay">
            <h2>Workout complete</h2>
            <p className="muted">
              Each zone's position is saved for next time.
              {controller && ' Pick a zone below to keep watching.'}
            </p>
            <button className="btn primary" onClick={onStart}>
              Ride again
            </button>
          </div>
        )}
        {active && !owner && (
          <div className="stage-overlay soft">
            <p>
              No content set for {zone.label}.{' '}
              <button className="link-btn" onClick={onEditZones}>
                Add some
              </button>{' '}
              after this ride.
            </p>
          </div>
        )}
        {(session?.status === 'paused' || (session?.status === 'extra' && session.extraPaused)) && (
          <div className="stage-overlay soft">
            <h2>Paused</h2>
          </div>
        )}
        {inWorkout && session?.countdown != null && next && (
          <div className="countdown" style={{ '--zone': zoneMeta(next.zone).color } as CSSProperties}>
            <span className="countdown-num">{session?.countdown}</span>
            <span className="countdown-label">{zoneMeta(next.zone).label} next</span>
            <span className="countdown-sub">
              {transition === 'continue'
                ? 'Same content, keeps playing'
                : transition === 'keep-previous'
                  ? 'No content set, current video keeps playing'
                  : 'Switching video'}
            </span>
          </div>
        )}
        {session?.status === 'ending' && (
          <div className="continue-prompt" role="alertdialog" aria-labelledby="continue-title">
            <span className="countdown-num">{session.endingIn}</span>
            <h2 id="continue-title">Workout complete</h2>
            <p>Keep watching?</p>
            <div className="row">
              <button className="btn primary" autoFocus onClick={() => sessionApi?.continueWatching()}>
                Continue
              </button>
              <button className="btn ghost" onClick={() => sessionApi?.finish()}>
                Finish
              </button>
            </div>
          </div>
        )}
        {active && owner && (owner !== block.zone || afterWorkout) && (
          <div className="now-from">
            {session?.status === 'extra' ? 'Workout complete · ' : ''}Playing {zoneMeta(owner).label} content
          </div>
        )}
        {fullscreen && session && !done && (
          <div className="fs-hud" style={{ '--zone': zone.color } as CSSProperties}>
            <span className="zone-pill big">{zone.short}</span>
            {inWorkout ? (
              <>
                <div>
                  <span className="muted">Block left</span>
                  <strong>{formatTime(block.end - t)}</strong>
                </div>
                <div>
                  <span className="muted">Next</span>
                  <strong>{next ? `${zoneMeta(next.zone).short} in ${formatTime(next.start - t)}` : 'Finish'}</strong>
                </div>
              </>
            ) : (
              <strong>Workout complete</strong>
            )}
          </div>
        )}
      </div>

      {fullscreen && idle && (
        <button
          className="dock-bubble"
          aria-label="Show controls"
          title="Show controls"
          onMouseEnter={wake}
          onFocus={wake}
          onClick={wake}
        >
          ⌃
        </button>
      )}
      <div ref={dockRef} className="theater-dock">
      {session && controller && <ContentBar controller={controller} config={config} onPick={onPickContent} />}

      {session?.status === 'extra' && (
        <div className="controls">
          <button className="btn primary wide" onClick={() => sessionApi?.togglePause()} title="Space">
            {session.extraPaused ? 'Resume' : 'Pause'}
          </button>
          <button className="btn ghost" onClick={() => sessionApi?.finish()}>
            Finish
          </button>
          <FullscreenButton on={fullscreen} onToggle={toggleFullscreen} />
        </div>
      )}
      {inWorkout && (
        <div className="controls">
          <button className="btn" onClick={() => sessionApi?.previousBlock()} title="Previous block">
            ⏮ Block
          </button>
          <button className="btn" onClick={() => sessionApi?.nudge(-5)} title="Back 5 seconds (←)">
            −5s
          </button>
          <button className="btn primary wide" onClick={() => sessionApi?.togglePause()} title="Space">
            {session.status === 'running' ? 'Pause' : 'Resume'}
          </button>
          <button className="btn" onClick={() => sessionApi?.nudge(5)} title="Forward 5 seconds (→)">
            +5s
          </button>
          <button className="btn" onClick={() => sessionApi?.nextBlock()} title="Next block">
            Block ⏭
          </button>
          <FullscreenButton on={fullscreen} onToggle={toggleFullscreen} />
          <button className="btn ghost danger" onClick={onStop}>
            Stop
          </button>
        </div>
      )}
      {inWorkout && !fullscreen && (
        <p className="muted small center">
          Out of sync with Zwift? Use ±5s, skip blocks, or click the chart to jump. Space pauses, F is full screen.
        </p>
      )}
      </div>
      </div>
    </div>
  );
}

function ZoneCheck({ zones, config, onEdit }: { zones: ZoneId[]; config: AppConfig; onEdit: () => void }) {
  return (
    <ul className="zone-check">
      {zones.map((z) => {
        const meta = zoneMeta(z);
        const links = ownerLinks(config, z);
        const parent = config.zones[z].parent;
        return (
          <li key={z} style={{ '--zone': meta.color } as CSSProperties}>
            <span className="zone-pill">{meta.short}</span>
            {links.length === 0 ? (
              <span className="warn">No content, previous video continues</span>
            ) : parent ? (
              <span>Same as {zoneMeta(parent).label}</span>
            ) : (
              <span>
                {links.length} {links.length === 1 ? 'link' : 'links'}
              </span>
            )}
          </li>
        );
      })}
      <li>
        <button className="link-btn" onClick={onEdit}>
          Edit zone content
        </button>
      </li>
    </ul>
  );
}

/** One button per zone with its own content: shows what it's on and switches the video to it. */
function ContentBar({
  controller,
  config,
  onPick,
}: {
  controller: PlaybackController;
  config: AppConfig;
  onPick: (owner: ZoneId) => void;
}) {
  // Refresh titles and times even when the workout clock isn't ticking (after the workout).
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  const owners = controller.owners();
  if (!owners.length) return null;
  const active = controller.activeOwner;

  return (
    <div className="content-bar" role="group" aria-label="Choose what to watch">
      {owners.map((owner) => {
        const info = controller.nowPlaying(owner);
        const zones = [owner, ...childrenOf(config, owner)];
        const meta = zoneMeta(owner);
        return (
          <button
            key={owner}
            className={`content-btn${owner === active ? ' on' : ''}`}
            style={{ '--zone': meta.color } as CSSProperties}
            aria-pressed={owner === active}
            onClick={() => onPick(owner)}
            title={info?.title ? `${zones.map((z) => zoneMeta(z).label).join(', ')}: ${info.title}` : undefined}
          >
            <span className="content-zones">
              {zones.map((z) => (
                <span key={z} className="zone-pill" style={{ '--zone': zoneMeta(z).color } as CSSProperties}>
                  {zoneMeta(z).short}
                </span>
              ))}
            </span>
            <span className="content-title">{info?.title ?? 'Not played yet'}</span>
            <span className="content-time">
              {info ? `${formatTime(info.time)}${info.duration ? ` / ${formatTime(info.duration)}` : ''}` : ''}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function FullscreenButton({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button className="btn ghost" onClick={onToggle} title="Full screen (F)">
      {on ? 'Exit full screen' : '⛶ Full screen'}
    </button>
  );
}

/**
 * Full screen for the video area as a whole (players, countdown, bar and controls). YouTube's
 * own full-screen button is turned off: it only covers one player, so the countdown would be
 * hidden and a zone switch would leave you looking at a paused video.
 */
function useFullscreen(ref: RefObject<HTMLElement | null>): [boolean, () => void] {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const update = () => setOn(!!ref.current && document.fullscreenElement === ref.current);
    document.addEventListener('fullscreenchange', update);
    return () => document.removeEventListener('fullscreenchange', update);
  }, [ref]);
  const toggle = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void ref.current?.requestFullscreen().catch(() => {});
  }, [ref]);
  return [on, toggle];
}

/**
 * True after 3s without mouse, touch or key input inside `ref`, while `enabled`. Input over a
 * YouTube player never reaches the page (it's a cross-origin frame), so `wake` is also returned
 * for elements layered above the video. Stays awake while the pointer rests on `holdRef`, for
 * at most 20s without input, so a missed "pointer left" can't pin the controls open.
 */
function useIdle(
  ref: RefObject<HTMLElement | null>,
  enabled: boolean,
  holdRef: RefObject<HTMLElement | null>,
): [boolean, () => void] {
  const [idle, setIdle] = useState(false);
  const timer = useRef(0);
  const wake = useCallback(() => {
    setIdle(false);
    window.clearTimeout(timer.current);
    const wokeAt = performance.now();
    timer.current = window.setTimeout(function check() {
      // :hover is false once the pointer moves onto the video frame.
      const held = holdRef.current?.matches(':hover') && performance.now() - wokeAt < 20_000;
      if (held) timer.current = window.setTimeout(check, 1000);
      else setIdle(true);
    }, 3000);
  }, [holdRef]);
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el) {
      window.clearTimeout(timer.current);
      setIdle(false);
      return;
    }
    wake();
    const events = ['mousemove', 'mousedown', 'touchstart', 'keydown'] as const;
    for (const e of events) el.addEventListener(e, wake);
    return () => {
      window.clearTimeout(timer.current);
      for (const e of events) el.removeEventListener(e, wake);
    };
  }, [ref, enabled, wake]);
  return [idle, wake];
}
