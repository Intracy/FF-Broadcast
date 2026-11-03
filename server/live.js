// Live-Steuerung: reine Zustandsübergänge (Start, Weiter, Zurück, Springen, ±Zeit, Beenden)

export function parseLive(str) {
  try { return str ? JSON.parse(str) : {}; } catch { return {}; }
}

export function applyLiveAction(items, live0, action, arg = {}, now = Date.now()) {
  const live = structuredClone(live0 || {});
  live.history ||= {};
  const play = items.filter((i) => i.type === 'item');
  const idx = play.findIndex((i) => i.id === live.currentId);
  const active = live.running && idx >= 0;

  const record = () => {
    if (active) live.history[live.currentId] = Math.round((now - live.itemStartedAt) / 1000);
  };
  const setCurrent = (it) => {
    live.currentId = it.id;
    live.itemStartedAt = now;
    live.adjust = 0;
  };
  const stop = () => {
    live.running = false;
    live.currentId = null;
    live.itemStartedAt = null;
    live.adjust = 0;
    live.endedAt = now;
  };
  const start = (item) => {
    if (!item) return;
    live.running = true;
    live.startedAt = now;
    live.endedAt = null;
    live.history = {};
    setCurrent(item);
  };

  switch (action) {
    case 'start':
      if (active) break;
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
      live.adjust = (live.adjust || 0) + s;
      break;
    }
    case 'setRemaining': {
      // Restzeit des laufenden Punkts auf einen festen Wert setzen
      if (!active) break;
      const rem = Math.max(0, Math.min(24 * 3600, Math.round(Number(arg.seconds) || 0)));
      const elapsed = (now - live.itemStartedAt) / 1000;
      live.adjust = Math.round(elapsed + rem - (play[idx].duration || 0));
      break;
    }
    case 'setDuration': {
      // Gesamtdauer des laufenden Punkts (nur für diesen Live-Durchlauf) setzen
      if (!active) break;
      const dur = Math.max(0, Math.min(24 * 3600, Math.round(Number(arg.seconds) || 0)));
      live.adjust = dur - (play[idx].duration || 0);
      break;
    }
    case 'stop':
      record();
      stop();
      break;
    case 'reset':
      return {};
    default: {
      const e = new Error('Unbekannte Live-Aktion');
      e.status = 400;
      throw e;
    }
  }
  return live;
}
