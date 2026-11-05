import { evaluate, elapsedFor } from './shared/timing.js';

/** Verdichtet Relay-Zustand + aktuelle Showzeit zu dem, was die Ansichten zeigen. */
export function buildVM(state, now) {
  const cue = state?.cue || null;
  const elapsed = cue ? elapsedFor(cue, now, state.show?.pausedAt) : 0;
  const ev = evaluate({
    hasCue: !!cue,
    kind: cue?.kind,
    title: cue?.title,
    durationMs: cue ? cue.effectiveMs ?? cue.durationMs : 0,
    elapsedMs: elapsed,
    anchorAt: cue?.anchorAt,
    now,
    signals: state?.signals,
    nextKind: state?.next?.kind,
  });
  return { state, cue, next: state?.next || null, ev, elapsed, now };
}
