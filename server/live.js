// Live-Steuerung: reine Zustandsübergänge (Start, Pause, Weiter, Zurück, Springen, ±Zeit, Beenden)
// Pause: pausedAt = Zeitpunkt der Pause; beim Fortsetzen wird die Pausenzeit beim laufenden Punkt
// herausgerechnet (itemStartedAt verschoben) und in pausedMs für die Gesamtabweichung gesammelt.
//
// Probe-Modus: live.mode = 'probe' | 'show'. Beim Beenden wird jeder Lauf gesichert –
// die letzte Show in live.show, Proben in live.probes (die letzten PROBES_MAX). So bleiben die
// echten Ist-Zeiten der Show für den Nachbericht sauber, auch wenn danach noch geprobt wird.
//
// Aufnahmeleitung (live.al): Signale fürs Schild (GLEICH DU, SCHLUSS, STRECKEN), eigener Text
// und Marker. Was für Nachbericht und Marker-Export protokolliert werden soll, landet in
// live._events; der Server hängt es an das AL-Protokoll an und entfernt das Feld wieder.

const AL_SIGNALS = ['wrap', 'cut', 'standby'];
const emptySignals = () => ({ wrap: false, cut: false, standby: false, stretchAt: null });
const clip = (v, n) => String(v ?? '').slice(0, n);
export const PROBES_MAX = 10;

/** Abgeschlossenen Lauf sichern (nur, wenn wirklich etwas gemessen wurde) */
function archiveRun(live, now) {
  if (!live.running || !live.startedAt || !Object.keys(live.history || {}).length) return;
  const run = { mode: live.mode === 'probe' ? 'probe' : 'show', startedAt: live.startedAt, endedAt: now, history: { ...live.history }, pausedMs: live.pausedMs || 0 };
  if (run.mode === 'show') live.show = run;
  else live.probes = [...(live.probes || []), run].slice(-PROBES_MAX);
}

export function parseLive(str) {
  try { return str ? JSON.parse(str) : {}; } catch { return {}; }
}

export function applyLiveAction(items, live0, action, arg = {}, now = Date.now()) {
  const live = structuredClone(live0 || {});
  live.history ||= {};
  live.starts ||= {}; // Startzeit je Punkt (letzter Start)
  live.adjusts ||= {}; // ±Zeit je gelaufenem Punkt
  live.al ||= { signals: emptySignals(), message: null, markers: 0 };
  const events = [];
  const log = (e) => events.push({ at: now, id: live.currentId ?? null, ...e });
  const play = items.filter((i) => i.type === 'item');
  const idx = play.findIndex((i) => i.id === live.currentId);
  const active = live.running && idx >= 0;

  const unpause = () => {
    if (!live.pausedAt) return;
    const d = Math.max(0, now - live.pausedAt);
    log({ type: 'resume', pausedMs: d });
    if (live.itemStartedAt) live.itemStartedAt += d;
    live.pausedMs = (live.pausedMs || 0) + d;
    live.pausedAt = null;
  };
  const record = () => {
    if (!active) return;
    live.history[live.currentId] = Math.round((now - live.itemStartedAt) / 1000);
    live.adjusts[live.currentId] = live.adjust || 0;
  };
  const setCurrent = (it) => {
    live.currentId = it.id;
    live.itemStartedAt = now;
    live.adjust = 0;
    live.starts[it.id] = now;
    delete live.adjusts[it.id];
    live.al.signals = emptySignals(); // Signale gelten nur für den laufenden Punkt
    log({ type: 'cue' });
  };
  const stretched = (before) => {
    live.al.signals.stretchAt = now;
    log({ type: 'stretch', ms: ((live.adjust || 0) - before) * 1000, totalMs: (live.adjust || 0) * 1000 });
  };
  const stop = () => {
    archiveRun(live, now);
    live.running = false;
    live.currentId = null;
    live.itemStartedAt = null;
    live.adjust = 0;
    live.endedAt = now;
    live.pausedAt = null;
    live.al.signals = emptySignals();
    log({ type: 'idle' });
  };
  const start = (item) => {
    if (!item) return;
    live.running = true;
    live.mode = arg.mode === 'probe' ? 'probe' : 'show';
    live.startedAt = now;
    live.endedAt = null;
    live.history = {};
    live.pausedAt = null;
    live.pausedMs = 0;
    live.starts = {};
    live.adjusts = {};
    live.al = { signals: emptySignals(), message: null, markers: 0 };
    events.push({ at: now, type: 'reset', ...(live.mode === 'probe' ? { probe: true } : {}) }); // neuer Lauf: Nachbericht und Marker beginnen neu
    setCurrent(item);
  };
  const pause = () => { live.pausedAt = now; log({ type: 'pause' }); };

  // Wer während der Pause weiterschaltet, springt oder beendet, setzt die Pause automatisch fort
  if (active && live.pausedAt && ['next', 'prev', 'goto', 'stop'].includes(action)) unpause();

  switch (action) {
    case 'pause':
      if (active && !live.pausedAt) pause();
      break;
    case 'resume':
      if (active) unpause();
      break;
    case 'toggle':
      if (!active) start(play[0]);
      else if (live.pausedAt) unpause();
      else pause();
      break;
    case 'start':
      if (active) { unpause(); break; }
      start(arg.itemId ? play.find((i) => i.id === Number(arg.itemId)) : play[0]);
      break;
    case 'next':
      if (!active) { start(play[0]); break; }
      record();
      if (play[idx + 1]) setCurrent(play[idx + 1]);
      else stop();
      break;
    case 'prev':
      if (!active) break;
      if (idx === 0) { live.itemStartedAt = now; live.adjust = 0; break; }
      delete live.history[live.currentId];
      delete live.history[play[idx - 1].id];
      setCurrent(play[idx - 1]);
      break;
    case 'goto': {
      const target = play.find((i) => i.id === Number(arg.itemId));
      if (!target) break;
      if (!active) { start(target); break; }
      if (target.id === live.currentId) { live.itemStartedAt = now; live.adjust = 0; break; }
      record();
      delete live.history[target.id];
      setCurrent(target);
      break;
    }
    case 'adjust': {
      if (!active) break;
      const s = Math.max(-3600, Math.min(3600, parseInt(arg.seconds, 10) || 0));
      const before = live.adjust || 0;
      live.adjust = before + s;
      stretched(before);
      break;
    }
    case 'setRemaining': {
      // Restzeit des laufenden Punkts auf einen festen Wert setzen
      if (!active) break;
      const rem = Math.max(0, Math.min(24 * 3600, Math.round(Number(arg.seconds) || 0)));
      const elapsed = ((live.pausedAt || now) - live.itemStartedAt) / 1000;
      const before = live.adjust || 0;
      live.adjust = Math.round(elapsed + rem - (play[idx].duration || 0));
      stretched(before);
      break;
    }
    case 'setDuration': {
      // Gesamtdauer des laufenden Punkts (nur für diesen Live-Durchlauf) setzen
      if (!active) break;
      const dur = Math.max(0, Math.min(24 * 3600, Math.round(Number(arg.seconds) || 0)));
      const before = live.adjust || 0;
      live.adjust = dur - (play[idx].duration || 0);
      stretched(before);
      break;
    }
    case 'stop':
      record();
      stop();
      break;
    case 'reset':
      // Live-Zustand zurücksetzen – gesicherte Show- und Probezeiten bleiben erhalten
      return { show: live.show, probes: live.probes, _events: [{ at: now, type: 'reset' }] };
    case 'clearRuns':
      // Gesicherte Läufe löschen (nur Probe oder alle)
      if (arg.which === 'probes' || arg.which === 'all') delete live.probes;
      if (arg.which === 'show' || arg.which === 'all') delete live.show;
      break;
    // ---- Aufnahmeleitung
    case 'alSignal': {
      // GLEICH DU / SCHLUSS / FERTIG WERDEN fürs Schild – nur mit laufendem Punkt
      const kind = String(arg.kind);
      if (!AL_SIGNALS.includes(kind)) { const e = new Error('Unbekanntes Signal'); e.status = 400; throw e; }
      if (!active) break;
      const on = !!arg.on;
      if (live.al.signals[kind] === on) break;
      live.al.signals[kind] = on;
      log({ type: 'signal', signal: kind, on });
      break;
    }
    case 'alMessage': {
      // Eigener Text (und GIF) auf dem Schild; wird auf jedem Gerät noch einmal bereinigt
      if (arg.clear) {
        if (live.al.message) log({ type: 'message', on: false, label: live.al.message.text || '' });
        live.al.message = null;
        break;
      }
      const gif = arg.gif && typeof arg.gif === 'object' && /^https:\/\//.test(String(arg.gif.url || ''))
        ? { url: clip(arg.gif.url, 500), width: Number(arg.gif.width) || 0, height: Number(arg.gif.height) || 0, id: clip(arg.gif.id, 60), title: clip(arg.gif.title, 120) }
        : null;
      const text = clip(arg.text, 1000);
      if (!text.trim() && !gif) break;
      live.al.message = { html: clip(arg.html, 4000), text, gif, upper: !!arg.upper, only: !!arg.only, at: now };
      log({ type: 'message', on: true, label: text });
      break;
    }
    case 'alMarker':
      live.al.markers = (live.al.markers || 0) + 1;
      live.al.lastMarkerAt = now;
      log({ type: 'marker', label: clip(arg.label, 200) });
      break;
    default: {
      const e = new Error('Unbekannte Live-Aktion');
      e.status = 400;
      throw e;
    }
  }
  if (events.length) live._events = events;
  return live;
}
