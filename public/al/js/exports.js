// Exporte aus FF-Aufnahmeleitung-Tool (server/exports.js), hier im Browser erzeugt.
// Erwartet ein Objekt wie das Relay: { cfg: { timeZone }, rundown, now(), report(), runLog() }.
import { formatTimeOfDay, formatSigned, formatDuration } from './shared/timing.js';

const partsFormatters = new Map();
function wallAsUtc(epochMs, timeZone) {
  let f = partsFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partsFormatters.set(timeZone, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(epochMs)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
}


function zonedToEpoch(dateStr, timeStr, timeZone) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi, s = 0] = timeStr.split(':').map(Number);
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  let guess = asUtc - (wallAsUtc(asUtc, timeZone) - asUtc);
  guess = asUtc - (wallAsUtc(guess, timeZone) - guess);
  return guess;
}

const KIND_DE = { moderated: 'moderiert', fixed: 'Zuspieler', open: 'offen', special: 'Sonderfall', anchor: 'Anker' };

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Nachbericht als CSV (Semikolon, UTF-8 mit BOM für Excel). */
export function reportCsv(relay) {
  const tz = relay.cfg.timeZone;
  const t = (ms) => (ms == null ? '' : formatTimeOfDay(ms, tz, true));
  const d = (ms) => (ms == null ? '' : formatDuration(ms));
  const lines = [];
  lines.push(['Nr', 'Cue', 'Art', 'Block', 'Plan-Start', 'Ist-Start', 'Plan-Dauer', 'Gestreckt', 'Ist-Dauer', 'Abweichung', 'Startzeit-Quelle'].join(';'));
  for (const r of relay.report()) {
    lines.push(
      [
        r.number,
        r.title,
        KIND_DE[r.kind] || r.kind,
        r.block,
        t(r.plannedStartAt),
        t(r.actualStartAt),
        d(r.plannedMs),
        r.stretchMs ? d(r.stretchMs) : '',
        d(r.actualMs),
        r.deltaMs == null ? '' : formatSigned(r.deltaMs),
        r.startHow,
      ]
        .map(csvCell)
        .join(';'),
    );
  }
  lines.push('');
  lines.push(['Zeit', 'Ereignis', 'Cue', 'Detail'].join(';'));
  for (const e of relay.runLog()) {
    if (e.type === 'cue') continue;
    lines.push([t(e.at), eventLabel(e), e.cueNumber != null ? `${e.cueNumber} ${e.cueTitle}` : '', eventDetail(e)].map(csvCell).join(';'));
  }
  return '﻿' + lines.join('\r\n') + '\r\n';
}

function eventLabel(e) {
  switch (e.type) {
    case 'marker':
      return 'Marker';
    case 'signal':
      return { wrap: 'FERTIG WERDEN', cut: 'SCHLUSS', standby: 'GLEICH DU' }[e.signal] + (e.on ? '' : ' aufgehoben');
    case 'stretch':
      return 'STRECKEN';
    case 'scenario':
      return 'Szenario';
    case 'message':
      return e.on ? 'Custom Text' : 'Custom Text ausgeblendet';
    case 'manual':
      return e.on ? 'Manuell-Modus an' : 'Manuell-Modus aus';
    case 'pause':
      return 'Pause';
    case 'resume':
      return 'Weiter';
    case 'idle':
      return 'Kein Cue';
    case 'replay':
      return 'Replay-Sprung';
    case 'source':
      return 'Rundown-Quelle gewechselt';
    case 'rundownEdit':
      return 'Rundown geändert (Website)';
    case 'control':
      return `Rundown: ${{ start: 'Start', next: 'Next', toggle: 'Pause/Weiter', pause: 'Pause/Weiter', prev: 'Zurück', finish: 'Beenden' }[e.action] || e.action}`;
    default:
      return e.type;
  }
}

function eventDetail(e) {
  if (e.type === 'marker' || e.type === 'message') return e.label || '';
  if (e.type === 'stretch') return `${formatSigned(e.ms)} (gesamt ${formatDuration(e.totalMs)})`;
  if (e.type === 'scenario') return e.label;
  if (e.type === 'resume') return `Pause ${formatDuration(e.pausedMs)}`;
  if (e.type === 'replay') return `Cue ${e.jumpTo}`;
  if (e.type === 'rundownEdit') return e.summary || '';
  if (e.type === 'source') return e.title || (e.token === 'env' ? 'Token aus .env' : '');
  if (e.type === 'control') return e.ok ? '' : `Fehler: ${e.error || ''}`;
  return '';
}

function tc(totalFrames, fps) {
  const f = Math.max(0, Math.round(totalFrames));
  const ff = f % fps;
  const s = Math.floor(f / fps);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600) % 24)}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}:${p(ff)}`;
}

/**
 * Timeline-Marker als EDL für DaVinci Resolve
 * (Timeline › Import › Timeline Markers from EDL).
 * tc=rec: 01:00:00:00 = Aufnahmestart (start=HH:MM:SS, sonst erster Cue).
 * tc=tod: Timecode = Uhrzeit (Time-of-Day).
 */
export function markersEdl(relay, { fps = 25, start = '', mode = 'rec' } = {}) {
  fps = [24, 25, 30, 50, 60].includes(Number(fps)) ? Number(fps) : 25;
  const tz = relay.cfg.timeZone;
  const rd = relay.rundown;
  const events = relay.runLog()
    .filter((e) => ['cue', 'marker', 'signal', 'stretch', 'scenario', 'message'].includes(e.type) && (!['signal', 'message'].includes(e.type) || e.on))
    .sort((a, b) => a.at - b.at);
  let ref = null;
  if (mode !== 'tod') {
    if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(start) && rd?.eventDate) {
      ref = zonedToEpoch(rd.eventDate, start.length <= 5 ? `${start}:00` : start, tz);
    } else {
      ref = events.find((e) => e.type === 'cue')?.at ?? events[0]?.at ?? relay.now();
    }
  }
  const toFrames = (at) => {
    if (mode === 'tod') {
      const [h, m, s] = formatTimeOfDay(at, tz, true).split(':').map(Number);
      return (h * 3600 + m * 60 + s) * fps + Math.floor(((at % 1000) + 1000) % 1000 / (1000 / fps));
    }
    return 3600 * fps + ((at - ref) / 1000) * fps;
  };
  const color = (e) =>
    e.type === 'cue' ? 'ResolveColorBlue' : e.type === 'marker' ? 'ResolveColorYellow' : e.type === 'message' ? 'ResolveColorPink' : e.type === 'scenario' ? 'ResolveColorPurple' : e.type === 'stretch' ? 'ResolveColorCyan' : 'ResolveColorRed';
  const name = (e) => {
    const cue = e.cueNumber != null ? `Cue ${e.cueNumber} ${e.cueTitle}` : '';
    if (e.type === 'cue') return cue;
    if (e.type === 'marker') return `Marker${e.label ? ' ' + e.label : ''} · ${cue}`;
    if (e.type === 'message') return `Text: ${e.label || ''} · ${cue}`;
    return `${eventLabel(e)}${e.type === 'scenario' ? ' ' + e.label : ''} · ${cue}`;
  };
  const out = [`TITLE: ${(rd?.title || 'Aufnahmeleitung').replace(/[\r\n]/g, ' ')}`, 'FCM: NON-DROP FRAME', ''];
  let n = 0;
  for (const e of events) {
    const fr = toFrames(e.at);
    if (fr < 0) continue;
    n++;
    const a = tc(fr, fps);
    const b = tc(fr + 1, fps);
    out.push(`${String(n).padStart(3, '0')}  001      V     C        ${a} ${b} ${a} ${b}  `);
    out.push(` |C:${color(e)} |M:${name(e).replace(/\|/g, '/').replace(/[\r\n]/g, ' ')} |D:1`);
    out.push('');
  }
  return out.join('\r\n');
}
