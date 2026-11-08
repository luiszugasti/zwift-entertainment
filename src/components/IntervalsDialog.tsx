import { useCallback, useEffect, useRef, useState } from 'react';
import {
  downloadWorkout,
  fetchPlannedWorkouts,
  IntervalsError,
  loadIntervalsKey,
  saveIntervalsKey,
  type PlannedWorkout,
} from '../lib/intervals';
import { formatTime } from '../lib/timeline';

interface Props {
  /** Loads the downloaded .zwo; throws if it can't be used. */
  onLoad: (fileName: string, text: string) => void;
  onClose: () => void;
}

type State =
  | { step: 'key'; error?: string }
  | { step: 'loading'; message: string }
  | { step: 'list'; workouts: PlannedWorkout[] }
  | { step: 'empty' }
  | { step: 'error'; message: string };

/** Loads today's planned workout from intervals.icu, asking for the API key the first time. */
export function IntervalsDialog({ onLoad, onClose }: Props) {
  const [key, setKey] = useState(loadIntervalsKey);
  const [draft, setDraft] = useState('');
  const [state, setState] = useState<State>(key ? { step: 'loading', message: "Checking today's plan…" } : { step: 'key' });
  // Latest callbacks, so the fetch below doesn't re-run when the parent re-renders.
  const callbacks = useRef({ onLoad, onClose });
  callbacks.current = { onLoad, onClose };

  const fail = useCallback((e: unknown) => {
    if (e instanceof IntervalsError && e.status === 401) {
      setState({ step: 'key', error: 'intervals.icu rejected that API key. Check it and paste it again.' });
    } else {
      setState({ step: 'error', message: (e as Error).message });
    }
  }, []);

  const load = useCallback(
    async (k: string, w: PlannedWorkout) => {
      setState({ step: 'loading', message: `Loading “${w.name}”…` });
      try {
        const text = await downloadWorkout(k, w.id);
        callbacks.current.onLoad(`${w.name}.zwo`, text);
        callbacks.current.onClose();
      } catch (e) {
        fail(e);
      }
    },
    [fail],
  );

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    setState({ step: 'loading', message: "Checking today's plan…" });
    fetchPlannedWorkouts(key)
      .then((workouts) => {
        if (cancelled) return;
        if (workouts.length === 1) void load(key, workouts[0]);
        else setState(workouts.length ? { step: 'list', workouts } : { step: 'empty' });
      })
      .catch((e) => !cancelled && fail(e));
    return () => {
      cancelled = true;
    };
  }, [key, load, fail]);

  const saveKey = () => {
    const k = draft.trim();
    if (!k) return;
    saveIntervalsKey(k);
    setDraft('');
    setKey(k);
  };

  const forgetKey = () => {
    saveIntervalsKey(null);
    setKey(null);
    setState({ step: 'key' });
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="intervals-title">
      <div className="modal">
        <h2 id="intervals-title">Today from intervals.icu</h2>

        {state.step === 'key' && (
          <form
            className="intervals-key"
            onSubmit={(e) => {
              e.preventDefault();
              saveKey();
            }}
          >
            <p>
              Paste your API key from intervals.icu → Settings → Developer Settings. It's saved in this browser only.
            </p>
            {state.error && <p className="error">{state.error}</p>}
            <label className="field">
              <span>API key</span>
              <input autoFocus type="password" autoComplete="off" value={draft} onChange={(e) => setDraft(e.target.value)} />
            </label>
            <div className="modal-actions">
              <button type="button" className="btn ghost" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="btn primary" disabled={!draft.trim()}>
                Save and load
              </button>
            </div>
          </form>
        )}

        {state.step === 'loading' && <p>{state.message}</p>}

        {state.step === 'list' && (
          <>
            <p>You have {state.workouts.length} workouts planned today. Which one?</p>
            <ul className="planned">
              {state.workouts.map((w) => (
                <li key={w.id}>
                  <button className="planned-btn" onClick={() => void load(key!, w)}>
                    <strong>{w.name}</strong>
                    <span className="muted">
                      {[w.type, w.duration ? formatTime(w.duration) : null].filter(Boolean).join(' · ')}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}

        {state.step === 'empty' && <p>No workouts are planned on intervals.icu for today.</p>}
        {state.step === 'error' && <p className="error">{state.message}</p>}

        {state.step !== 'key' && (
          <div className="modal-actions spread">
            <button className="link-btn" onClick={forgetKey}>
              Use a different API key
            </button>
            <button className="btn ghost" onClick={onClose}>
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
