// Gemeinsame Zeit-Logik für Server und Browser (ES-Modul, keine Abhängigkeiten)

export const pad = (n) => String(n).padStart(2, '0');

/** "30:00" | "1:30:00" | "5" (Minuten) | "90s" -> Sekunden */
export function parseDuration(input) {
  if (typeof input === 'number') return Math.round(input);
  let s = String(input ?? '').trim().replace(',', '.');
  if (!s) return 0;
  const neg = s.startsWith('-');
  if (neg) s = s.slice(1);
  let sec = 0;
  if (/^\d+(\.\d+)?s$/i.test(s)) sec = parseFloat(s);
  else if (/^\d+(\.\d+)?h$/i.test(s)) sec = parseFloat(s) * 3600;
  else if (/^\d+(\.\d+)?m?$/i.test(s)) sec = parseFloat(s) * 60;
  else {
    const p = s.split(/[:.]/).map((x) => parseInt(x, 10) || 0);
    if (p.length === 2) sec = p[0] * 60 + p[1];
    else sec = p[0] * 3600 + p[1] * 60 + (p[2] || 0);
  }
  sec = Math.round(sec);
  return neg ? -sec : sec;
}

/** Sekunden -> "mm:ss" bzw. "h:mm:ss" */
export function fmtDuration(sec, { sign = false, hours = false } = {}) {
  if (sec == null || Number.isNaN(sec)) return '--:--';
  const neg = sec < 0;
  const s = Math.abs(Math.round(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const body = h > 0 || hours ? `${h}:${pad(m)}:${pad(r)}` : `${pad(m)}:${pad(r)}`;
  return (neg ? '−' : sign && s > 0 ? '+' : '') + body;
}

/** Countdown-Anzeige: läuft auf 0, danach Überzeit mit "+" */
export function fmtCountdown(remaining) {
  if (remaining >= 0) return fmtDuration(Math.ceil(remaining));
  return '+' + fmtDuration(Math.floor(-remaining));
}

/** "10:00" | "10:00:30" -> Sekunden seit Mitternacht */
export function parseClock(str) {
  const p = String(str || '0:0').split(':').map((x) => parseInt(x, 10) || 0);
  return p[0] * 3600 + (p[1] || 0) * 60 + (p[2] || 0);
}

/** Sekunden seit Mitternacht -> "HH:MM" (mit Sekunden falls nötig) */
export function fmtClock(sec, withSeconds = 'auto') {
  let s = ((Math.round(sec) % 86400) + 86400) % 86400;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const showSec = withSeconds === true || (withSeconds === 'auto' && r !== 0);
  return `${pad(h)}:${pad(m)}${showSec ? ':' + pad(r) : ''}`;
}

/** Zeitstempel (ms) -> lokale Uhrzeit "HH:MM:SS" */
export function fmtTime(ms, withSeconds = true) {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}${withSeconds ? ':' + pad(d.getSeconds()) : ''}`;
}

/**
 * Plan berechnen. Liefert pro Eintrag Startzeit, Ende, Nummer und Blockzugehörigkeit.
 * items: [{id,type:'item'|'block'|'block_end',duration,color,title}]
 */
export function computeSchedule(items, startTime = 0) {
  const map = new Map();
  let t = 0, nr = 0, block = null;
  for (const it of items) {
    if (it.type === 'block') {
      block = { id: it.id, color: it.color, title: it.title };
      map.set(it.id, { start: startTime + t, end: startTime + t, duration: 0, count: 0, block: null });
      continue;
    }
    if (it.type === 'block_end') {
      map.set(it.id, { start: startTime + t, end: startTime + t, block });
      block = null;
      continue;
    }
    nr++;
    const d = Math.max(0, it.duration || 0);
    map.set(it.id, { nr, start: startTime + t, end: startTime + t + d, offset: t, block });
    t += d;
    if (block) {
      const b = map.get(block.id);
      b.duration += d; b.count++; b.end = startTime + t;
    }
  }
  return { map, total: t, end: startTime + t, count: nr };
}

/**
 * Live-Status aus dem gespeicherten Live-Zustand berechnen.
 * live: {running,startedAt,currentId,itemStartedAt,adjust,history,pausedAt,pausedMs}
 * delta > 0 = hinter dem Plan (zu spät), delta < 0 = vor dem Plan.
 */
export function liveStatus(items, live, now = Date.now()) {
  if (!live || !live.running) return { running: false };
  const play = items.filter((i) => i.type === 'item');
  const idx = play.findIndex((i) => i.id === live.currentId);
  if (idx < 0) return { running: false };
  const cur = play[idx];
  let planned = 0, rest = 0;
  for (let i = 0; i < idx; i++) planned += play[i].duration || 0;
  for (let i = idx + 1; i < play.length; i++) rest += play[i].duration || 0;
  const t = live.pausedAt || now; // während der Pause steht die Zeit des Punkts still
  const elapsed = Math.max(0, (t - live.itemStartedAt) / 1000);
  const eff = Math.max(0, (cur.duration || 0) + (live.adjust || 0));
  const remaining = eff - elapsed;
  const actualOffset = (live.itemStartedAt - live.startedAt - (live.pausedMs || 0)) / 1000;
  const delta = actualOffset - planned + Math.max(elapsed, eff) - (cur.duration || 0);
  return {
    running: true,
    paused: !!live.pausedAt,
    pausedFor: live.pausedAt ? Math.max(0, (now - live.pausedAt) / 1000) : 0,
    current: cur,
    next: play[idx + 1] || null,
    index: idx,
    count: play.length,
    elapsed,
    eff,
    adjust: live.adjust || 0,
    remaining,
    delta,
    liveSince: (now - live.startedAt) / 1000,
    startedAt: live.startedAt,
    projectedEnd: now + Math.max(remaining, 0) * 1000 + rest * 1000,
    progress: eff > 0 ? Math.min(1, elapsed / eff) : 1,
  };
}
