// Bühnen-Timer für Moderation, Regie oder einen zweiten Bildschirm
import { fmtDuration, fmtCountdown, fmtTime, fmtClock, parseClock, computeSchedule, liveStatus } from '/shared/timing.js';
import { h, icon, closePop } from '/js/ui.js';

const m = location.pathname.match(/^\/timer\/(?:p\/([^/]+)|(\d+))/);
const publicToken = m?.[1] ? decodeURIComponent(m[1]) : null;
const rundownId = m?.[2] ? Number(m[2]) : null;

let data = null, offset = 0, es = null, structKey = '';
const el = {};

/* ---------- Einstellungen (pro Gerät) */
const DEFAULTS = {
  layout: 'single', background: '#07090b', transparent: false, mirrorH: false, mirrorV: false,
  headerPos: 'top', showTitle: true, showClock: true, showCueTimer: true, showOverUnder: true, showProgress: true, showLastFive: true,
  cueNumbers: true, cueTitles: true, cueSubtitles: true, cueColors: true, cueDurations: true, cueStart: false, cueEnd: false,
  nextCue: true, bigClock: false, columns: [],
};
const O = (() => { try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('ffr.timer') || '{}') }; } catch { return { ...DEFAULTS }; } })();
const saveO = () => { try { localStorage.setItem('ffr.timer', JSON.stringify(O)); } catch { /* */ } };

const set = (e, v) => { if (e && e.textContent !== v) e.textContent = v; };
const timerSize = (text) => `min(${Math.round(118 / Math.max(5, text.length))}vw, 40vh)`;

/* ---------- Zustand berechnen */
function showStartMs() {
  const d = data.rundown.event_date ? new Date(data.rundown.event_date + 'T00:00:00') : new Date();
  if (!data.rundown.event_date) d.setHours(0, 0, 0, 0);
  return d.getTime() + parseClock(data.rundown.start_time) * 1000;
}

function compute() {
  const now = Date.now() + offset;
  const live = data.live || {};
  const st = liveStatus(data.items, live, now);
  const play = data.items.filter((i) => i.type === 'item');
  const r = { now, st, play, big: '--:--', state: 'idle', title: '', label: '', ou: null };
  if (st.running) {
    r.big = fmtCountdown(st.remaining);
    r.state = st.paused ? 'warn' : st.remaining < 0 ? 'over' : st.remaining <= 60 ? 'warn' : 'ok';
    r.title = st.current.title || 'Ohne Titel';
    r.label = st.paused ? (st.probe ? 'PROBE · PAUSE' : 'PAUSE') : st.probe ? 'PROBE' + (st.current.description ? ' · ' + st.current.description : '') : st.current.description || '';
    r.ou = st.delta;
  } else if (live.endedAt) {
    const hist = live.history || {};
    let actual = 0, planned = 0;
    for (const it of play) if (hist[it.id] != null) { actual += hist[it.id]; planned += it.duration || 0; }
    r.ou = actual - planned;
    r.big = fmtTime(live.endedAt, false);
    r.state = 'ended';
    r.title = 'Show beendet';
    r.label = Math.abs(r.ou) >= 1 ? (r.ou > 0 ? `${fmtDuration(r.ou)} später als geplant` : `${fmtDuration(-r.ou)} früher als geplant`) : 'Pünktlich';
  } else {
    const toStart = (showStartMs() - now) / 1000;
    const first = play[0];
    if (toStart > 0 && toStart < 24 * 3600) {
      r.big = fmtCountdown(toStart);
      r.title = `Showbeginn ${fmtClock(parseClock(data.rundown.start_time), false)}`;
    } else {
      r.big = first ? fmtDuration(first.duration) : '--:--';
      r.title = 'Bereit';
    }
    r.label = first ? `Erster Punkt: ${first.title || 'Ohne Titel'}` : '';
  }
  return r;
}

/* ---------- Aufbau */
function build() {
  el.frame = h('div', { class: 'tm-frame' });
  el.root = h('div', { class: 'tm' }, el.frame,
    h('div', { class: 'tm-tools' },
      h('button', { class: 'btn', onclick: toggleConfig }, icon('columns'), h('span', { class: 'lbl' }, 'Anzeige')),
      h('button', { class: 'btn', onclick: toggleFs, title: 'Vollbild (F)' }, icon('maximize'), h('span', { class: 'lbl' }, 'Vollbild'))));
  document.body.replaceChildren(el.root);
  // Werkzeuge und Mauszeiger nur bei Bewegung zeigen
  let idle = 0;
  const wake = () => {
    el.root.classList.add('active');
    el.root.classList.remove('no-cursor');
    clearTimeout(idle);
    idle = setTimeout(() => { if (!el.config) { el.root.classList.remove('active'); el.root.classList.add('no-cursor'); } }, 3000);
  };
  for (const ev of ['mousemove', 'pointerdown', 'keydown', 'touchstart']) window.addEventListener(ev, wake, { passive: true });
  wake();
}

function applyFrame(state) {
  el.root.className = `tm s-${state} pos-${O.headerPos}` + (O.transparent ? ' keying' : '') + (el.root.classList.contains('active') ? ' active' : '') + (el.root.classList.contains('no-cursor') ? ' no-cursor' : '');
  el.root.style.background = O.transparent ? 'transparent' : O.background;
  document.body.style.background = O.transparent ? 'transparent' : O.background;
  const tf = [O.mirrorH ? 'scaleX(-1)' : '', O.mirrorV ? 'scaleY(-1)' : ''].join(' ').trim();
  el.frame.style.transform = tf || '';
}

/** Struktur neu aufbauen (bei Daten-, Einstellungs- oder Punktwechsel) */
function rebuild(c) {
  const { st } = c;
  const header = h('div', { class: 'tm-top' },
    O.showTitle ? (el.show = h('span', { class: 'tm-show' }, data.rundown.title)) : h('span'),
    h('span', { class: 'right' },
      O.layout === 'list' && O.showCueTimer && st.running ? (el.headTimer = h('span', { class: 'tm-head-timer' })) : null,
      O.showOverUnder ? (el.ou = h('span', { class: 'tm-ou' })) : null,
      O.showClock ? (el.clock = h('span', { class: 'tm-clock' })) : null));
  if (!(O.layout === 'list' && O.showCueTimer && st.running)) el.headTimer = null;
  if (!O.showOverUnder) el.ou = null;
  if (!O.showClock) el.clock = null;

  let body;
  el.timer = el.prog = el.five = el.bigClock = el.title = el.label = null;
  if (O.layout === 'single') {
    const cur = st.running ? st.current : null;
    const next = st.running ? st.next : null;
    body = h('div', { class: 'tm-main' },
      O.bigClock ? (el.bigClock = h('div', { class: 'tm-bigclock' })) : null,
      O.cueTitles ? (el.title = h('div', { class: 'tm-title' })) : null,
      O.cueSubtitles ? (el.label = h('div', { class: 'tm-label' })) : null,
      (O.cueStart || O.cueEnd) && cur ? h('div', { class: 'tm-times' },
        O.cueStart ? h('span', null, 'Start ', (el.tStart = h('span'))) : null,
        O.cueEnd ? h('span', null, 'Ende ', (el.tEnd = h('span'))) : null) : null,
      O.showCueTimer ? (el.timer = h('div', { class: 'tm-timer', role: 'timer', 'aria-live': 'off' })) : null,
      O.showProgress && cur ? (el.prog = h('div', { class: 'tm-progress', 'aria-hidden': 'true' }, h('span'))) : null,
      O.showLastFive && cur ? (el.five = h('div', { class: 'last-five', hidden: true }, [5, 4, 3, 2, 1].map((n) => h('span', { dataset: { n } })))) : null,
      O.nextCue && cur ? h('div', { class: 'tm-next' },
        h('span', { class: 'k' }, 'Als Nächstes'),
        h('span', { class: 't' }, next ? next.title || 'Ohne Titel' : 'Ende'),
        next ? h('span', { class: 'd' }, fmtDuration(next.duration)) : null) : null);
  } else {
    body = listView(c);
    if (O.showProgress && st.running) el.prog = h('div', { class: 'tm-progress wide', 'aria-hidden': 'true' }, h('span'));
  }
  el.frame.replaceChildren(...(O.headerPos === 'top' ? [header, body] : [body, header]), ...(O.layout === 'list' && el.prog ? [el.prog] : []));
  document.title = data.rundown.title + ' · Timer';
}

function listView({ st, play }) {
  const sched = computeSchedule(data.items, parseClock(data.rundown.start_time));
  const curIdx = st.running ? st.index : 0;
  const shown = play.slice(curIdx, curIdx + 12);
  const cols = data.columns.filter((c) => O.columns.includes(c.id));
  el.rowDur = null;
  return h('ol', { class: 'tm-list' },
    shown.length ? shown.map((it) => {
      const s = sched.map.get(it.id) || {};
      const isCur = st.running && st.current.id === it.id;
      const dur = h('span', { class: 'dur' }, fmtDuration(it.duration));
      if (isCur) el.rowDur = dur;
      return h('li', { class: 'tm-row' + (isCur ? ' current' : '') + (O.cueColors && it.color ? ' tint' : ''), style: it.color ? `--c:${it.color}` : null },
        O.cueNumbers ? h('span', { class: 'nr' }, String(s.nr)) : h('span'),
        h('span', { class: 'main' },
          O.cueTitles ? h('span', { class: 't' }, it.title || 'Ohne Titel') : null,
          O.cueSubtitles && it.description ? h('span', { class: 's' }, it.description) : null,
          cols.map((c) => (it.cells?.[c.id] ? h('span', { class: 'cell' }, h('b', null, c.name + ': '), it.cells[c.id].replace(/\n/g, ' · ')) : null))),
        h('span', { class: 'times' },
          O.cueStart ? h('span', null, fmtClock(s.start, false)) : null,
          O.cueEnd ? h('span', null, '–' + fmtClock(s.end, false)) : null,
          O.cueDurations ? dur : null));
    }) : h('li', { class: 'tm-row empty' }, 'Keine Programmpunkte'));
}

/* ---------- Werte aktualisieren (alle 250 ms) */
function render() {
  if (!data || !el.root) return;
  const c = compute();
  const { st } = c;
  const key = [JSON.stringify(O), st.running ? st.current.id : c.state, st.running ? st.next?.id : '', structSig].join('|');
  if (key !== structKey) { structKey = key; rebuild(c); }
  applyFrame(c.state);

  if (el.clock) set(el.clock, fmtTime(c.now));
  if (el.bigClock) set(el.bigClock, fmtTime(c.now));
  if (el.ou) {
    if (c.ou == null) { set(el.ou, ''); el.ou.className = 'tm-ou'; }
    else {
      set(el.ou, Math.abs(c.ou) < 1 ? 'Show pünktlich' : `Show ${fmtDuration(c.ou, { sign: true })}`);
      el.ou.className = 'tm-ou ' + (c.ou >= 1 ? 'late' : c.ou <= -1 ? 'early' : '');
    }
  }
  if (el.title) set(el.title, c.title);
  if (el.label) { set(el.label, c.label); el.label.hidden = !c.label; }
  if (el.timer) {
    set(el.timer, c.big);
    el.timer.className = 'tm-timer ' + (c.state === 'idle' || c.state === 'ended' ? 'idle' : c.state);
    el.timer.style.fontSize = timerSize(c.big);
  }
  if (el.headTimer) { set(el.headTimer, c.big); el.headTimer.className = 'tm-head-timer ' + c.state; }
  if (el.rowDur && st.running) set(el.rowDur, fmtCountdown(st.remaining));
  if (st.running) {
    if (el.tStart) set(el.tStart, fmtTime(data.live.itemStartedAt, false));
    if (el.tEnd) set(el.tEnd, fmtTime(data.live.itemStartedAt + st.eff * 1000, false));
    if (el.prog) el.prog.firstChild.style.transform = `scaleX(${st.progress})`;
    if (el.five) {
      const n = st.remaining > 0 && st.remaining <= 5 ? Math.ceil(st.remaining) : 0;
      el.five.hidden = !n;
      for (const d of el.five.children) d.classList.toggle('on', Number(d.dataset.n) <= n);
    }
  }
}

/* ---------- Anzeige einstellen */
function toggleConfig() {
  if (el.config) { el.config.remove(); el.config = null; return; }
  const setO = (patch) => { Object.assign(O, patch); saveO(); render(); paintConfig(); };
  const sw = (key, label, disabled = false) => h('label', { class: 'switch' + (disabled ? ' off' : '') },
    h('input', { type: 'checkbox', checked: !!O[key], disabled, onchange: (e) => setO({ [key]: e.target.checked }) }), label);
  const seg = (key, opts, label) => h('div', { class: 'seg', role: 'radiogroup', 'aria-label': label },
    opts.map(([v, l]) => h('button', { role: 'radio', 'aria-checked': String(O[key] === v), class: O[key] === v ? 'on' : '', onclick: () => setO({ [key]: v }) }, l)));
  const paintConfig = () => {
    const single = O.layout === 'single';
    el.config.replaceChildren(
      h('div', { class: 'head' }, h('h2', null, 'Timer-Anzeige'), h('button', { class: 'icon-btn', 'aria-label': 'Schließen', onclick: toggleConfig }, icon('x'))),
      h('p', { class: 'hint' }, 'Gilt für dieses Gerät.'),
      seg('layout', [['single', 'Einzelner Punkt'], ['list', 'Liste']], 'Layout'),
      h('h3', null, 'Bild'),
      h('label', { class: 'colorrow' }, h('input', { type: 'color', value: O.background, disabled: O.transparent, oninput: (e) => setO({ background: e.target.value }) }), 'Hintergrund'),
      sw('transparent', 'Transparent (Keying, z. B. für OBS)'),
      sw('mirrorH', 'Horizontal spiegeln'),
      sw('mirrorV', 'Vertikal spiegeln'),
      h('h3', null, 'Kopfzeile'),
      seg('headerPos', [['top', 'Oben'], ['bottom', 'Unten']], 'Position der Kopfzeile'),
      sw('showTitle', 'Titel des Rundowns'),
      sw('showClock', 'Uhrzeit'),
      sw('showCueTimer', 'Timer des Punkts'),
      sw('showOverUnder', 'Über / Unter'),
      sw('showProgress', 'Fortschrittsbalken'),
      sw('showLastFive', 'Letzte 5 Sekunden', !single),
      h('h3', null, 'Programmpunkte'),
      sw('cueNumbers', 'Nummern', single),
      sw('cueTitles', 'Titel'),
      sw('cueSubtitles', 'Beschreibung'),
      sw('cueColors', 'Farben', single),
      sw('cueDurations', 'Dauern', single),
      sw('cueStart', 'Startzeiten'),
      sw('cueEnd', 'Endzeiten'),
      sw('nextCue', 'Als Nächstes', !single),
      sw('bigClock', 'Große Uhrzeit', !single),
      !single && data.columns.length ? [h('h3', null, 'Spalten in der Liste'),
        data.columns.map((col) => h('label', { class: 'switch' },
          h('input', { type: 'checkbox', checked: O.columns.includes(col.id), onchange: (e) => setO({ columns: e.target.checked ? [...O.columns, col.id] : O.columns.filter((x) => x !== col.id) }) }), col.name))] : null,
      h('button', { class: 'btn sm reset', onclick: () => { for (const k of Object.keys(O)) delete O[k]; Object.assign(O, structuredClone(DEFAULTS)); setO({}); } }, icon('rotate'), 'Auf Standard zurücksetzen'));
  };
  el.config = h('aside', { class: 'tm-config', 'aria-label': 'Anzeige einstellen' });
  paintConfig();
  document.body.append(el.config);
}

function toggleFs() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}
window.addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, textarea, select')) return;
  if (e.key === 'f' || e.key === 'F') toggleFs();
  else if (e.key === 'Escape' && el.config) toggleConfig();
});

/* ---------- Daten & Echtzeit */
let structSig = '';
function message(html) { closePop(); el.config?.remove(); document.body.replaceChildren(h('div', { class: 'lw-msg', html })); }

function apply(p) {
  data = p;
  offset = p.serverNow - Date.now();
  if (!el.root) build();
  structSig = JSON.stringify([p.items, p.columns, p.rundown]);
  render();
}

async function load() {
  const url = publicToken ? `/api/public/${encodeURIComponent(publicToken)}` : `/api/rundowns/${rundownId}`;
  const res = await fetch(url, { credentials: 'same-origin' });
  if (res.status === 401) return message('Bitte zuerst <a href="/">anmelden</a> und den Timer danach erneut öffnen.');
  if (!res.ok) return message('Rundown nicht gefunden oder Link deaktiviert.');
  apply(await res.json());
}

function connect() {
  es = new EventSource('/api/events?' + new URLSearchParams(publicToken ? { public: publicToken } : { rundown: rundownId, view: 'timer' }));
  let first = true;
  es.addEventListener('hello', () => { if (!first) load(); first = false; });
  es.addEventListener('rundown', (e) => apply(JSON.parse(e.data)));
  es.addEventListener('live', (e) => { const d = JSON.parse(e.data); if (!data) return; data.live = d.live; offset = d.serverNow - Date.now(); structKey = ''; render(); });
  es.addEventListener('gone', () => { es.close(); data = null; message('Dieser Link wurde deaktiviert.'); });
  es.addEventListener('deleted', () => { es.close(); data = null; message('Dieser Rundown wurde gelöscht.'); });
}

async function keepAwake() {
  try { if ('wakeLock' in navigator && document.visibilityState === 'visible') await navigator.wakeLock.request('screen'); } catch { /* */ }
}
document.addEventListener('visibilitychange', keepAwake);

if (!publicToken && !rundownId) message('Ungültige Adresse.');
else {
  await load();
  if (data) { connect(); setInterval(render, 250); keepAwake(); }
}
