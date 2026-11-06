// Gemeinsames Zeitmodul für Relay (Node) und iPad (Browser).
// Reine Funktionen, keine Abhängigkeiten. Alle Zeiten in Millisekunden.

/** Warnstufen analog zu den AL-Handzeichen. */
export const STAGES_MS = [300_000, 120_000, 60_000, 30_000];
export const STAGE_WORDS = { 300000: 'NOCH 5', 120000: 'NOCH 2', 60000: 'NOCH 1', 30000: '30 SEK' };
/** Ab hier FERTIG WERDEN (wenn der Cue lang genug ist). */
export const WRAP_AT_MS = 10_000;
/** So lange vor Ende eines Zuspielers geht das Schild auf GLEICH DU. */
export const STANDBY_LEAD_MS = 15_000;
/** So lange zeigt das Schild STRECKEN nach dem Tippen. */
export const STRETCH_FLASH_MS = 3_000;
/** Schritt des STRECKEN-Buttons. */
export const STRETCH_STEP_MS = 30_000;

export const KINDS = {
  moderated: 'MODERIERT',
  fixed: 'ZUSPIELER',
  open: 'OFFEN',
  special: 'SONDERFALL',
  anchor: 'ANKER',
};

/**
 * Welche Stufen ein Cue bekommt: eine Stufe erscheint nur,
 * wenn sie höchstens die halbe Planlänge beträgt.
 */
export function stagesFor(durationMs) {
  const half = durationMs / 2;
  return {
    stages: STAGES_MS.filter((s) => s <= half),
    wrap: WRAP_AT_MS <= half,
  };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Zustandsautomat des Segment-Timers.
 * Liefert, was Schild und Bedienansicht zeigen.
 *
 * @param {object} p
 * @param {boolean} p.hasCue
 * @param {string}  p.kind          moderated | fixed | open | special | anchor
 * @param {string}  [p.title]       Cue-Titel (für PAUSE-Erkennung)
 * @param {number}  p.durationMs    Planlänge inkl. STRECKEN
 * @param {number}  p.elapsedMs     verstrichene Zeit im Cue
 * @param {number}  [p.anchorAt]    Zielzeit (nur anchor)
 * @param {number}  p.now           Showzeit
 * @param {object}  [p.signals]     { wrap, cut, standby, stretchAt }
 * @param {string}  [p.nextKind]    Art des nächsten Cues
 */
export function evaluate(p) {
  const signals = p.signals || {};
  if (!p.hasCue) {
    return { state: 'idle', word: 'BEREIT', icon: null, digitsMs: null, countUp: false, progress: null, remainingMs: null };
  }
  const isAnchor = p.kind === 'anchor' && Number.isFinite(p.anchorAt);
  const remainingMs = isAnchor ? p.anchorAt - p.now : p.durationMs - p.elapsedMs;
  const progress = isAnchor ? null : p.durationMs > 0 ? clamp(p.elapsedMs / p.durationMs, 0, 1) : 1;
  const base = { remainingMs, elapsedMs: p.elapsedMs, progress, icon: null, countUp: false, stage: null, over: false };
  const known = p.kind !== 'open';

  if (signals.cut) return { ...base, state: 'cut', word: 'SCHLUSS', icon: 'cut', digitsMs: null };

  if (signals.stretchAt != null && p.now - signals.stretchAt >= 0 && p.now - signals.stretchAt < STRETCH_FLASH_MS) {
    return { ...base, state: 'stretch', word: 'STRECKEN', icon: 'stretch', digitsMs: known ? Math.max(0, remainingMs) : null };
  }

  if (signals.standby) {
    return { ...base, state: 'standby', word: 'GLEICH DU', digitsMs: known && remainingMs > 0 ? remainingMs : null };
  }

  if (p.kind === 'moderated') {
    if (remainingMs < 0) return { ...base, state: 'over', word: 'ÜBER', digitsMs: -remainingMs, countUp: true, over: true };
    const { stages, wrap } = stagesFor(p.durationMs);
    if (signals.wrap || (wrap && remainingMs <= WRAP_AT_MS)) {
      return { ...base, state: 'wrap', word: 'FERTIG WERDEN', icon: 'wrap', digitsMs: remainingMs };
    }
    const reached = stages.filter((s) => remainingMs <= s);
    if (reached.length) {
      const stage = reached[reached.length - 1];
      return { ...base, state: 'step', word: STAGE_WORDS[stage], stage, digitsMs: remainingMs };
    }
    return { ...base, state: 'run', word: '', digitsMs: remainingMs };
  }

  if (signals.wrap) {
    return { ...base, state: 'wrap', word: 'FERTIG WERDEN', icon: 'wrap', digitsMs: known ? Math.max(0, remainingMs) : null };
  }

  if (p.kind === 'open') {
    return { ...base, state: 'dark', word: '', digitsMs: p.elapsedMs, countUp: true };
  }

  // fixed, anchor, special
  if (p.nextKind === 'moderated' && remainingMs <= STANDBY_LEAD_MS && remainingMs > -STANDBY_LEAD_MS) {
    return { ...base, state: 'standby', word: 'GLEICH DU', digitsMs: Math.max(0, remainingMs) };
  }
  const word = p.kind === 'special' ? '' : isAnchor || /pause/i.test(p.title || '') ? 'PAUSE' : 'ZUSPIELER';
  if (remainingMs < 0) {
    return { ...base, state: 'neutral', word: 'ÜBER', digitsMs: -remainingMs, countUp: true, over: true };
  }
  return { ...base, state: 'neutral', word, digitsMs: remainingMs };
}

/**
 * Ziffern für das Schild. Countdown rundet auf (0:01 bis zur Null),
 * Hochzählen rundet ab.
 * fmt: hmmss | mmss | mss | ss
 */
export function formatSignDigits(ms, countUp = false) {
  const total = Math.max(0, countUp ? Math.floor(ms / 1000) : Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  if (h > 0) return { text: `${h}:${String(m).padStart(2, '0')}:${ss}`, fmt: 'hmmss' };
  if (total >= 600) return { text: `${String(m).padStart(2, '0')}:${ss}`, fmt: 'mmss' };
  if (total >= 60) return { text: `${m}:${ss}`, fmt: 'mss' };
  return { text: ss, fmt: 'ss' };
}

/** Ziffern für die Bedienansicht: immer M:SS bzw. H:MM:SS. */
export function formatClock(ms, countUp = false) {
  const total = Math.max(0, countUp ? Math.floor(ms / 1000) : Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** Saldo mit Vorzeichen: +1:20, −0:45, ±0:00. */
export function formatSigned(ms) {
  if (ms == null || !Number.isFinite(ms)) return '–';
  const sec = Math.round(ms / 1000);
  if (sec === 0) return '±0:00';
  const sign = sec > 0 ? '+' : '−';
  return sign + formatClock(Math.abs(sec) * 1000, true);
}

/** Dauer ohne Vorzeichen, z. B. 1:00 oder 40:00. */
export function formatDuration(ms) {
  return formatClock(ms, true);
}

const tzFormatters = new Map();
/** Uhrzeit in der Zeitzone der Show, z. B. 21:47 oder 21:47:30. */
export function formatTimeOfDay(epochMs, timeZone = 'Europe/Berlin', withSeconds = false) {
  if (epochMs == null || !Number.isFinite(epochMs)) return '–';
  const key = `${timeZone}|${withSeconds}`;
  let f = tzFormatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('de-DE', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      ...(withSeconds ? { second: '2-digit' } : {}),
      hourCycle: 'h23',
    });
    tzFormatters.set(key, f);
  }
  return f.format(new Date(epochMs));
}

/** Verstrichene Zeit im Cue (Showzeit), eingefroren während einer Pause. */
export function elapsedFor(cue, now, pausedAt) {
  if (!cue || !Number.isFinite(cue.startedAt)) return 0;
  const ref = Number.isFinite(pausedAt) ? pausedAt : now;
  return Math.max(0, ref - cue.startedAt);
}
