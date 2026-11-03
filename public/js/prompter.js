// Teleprompter: zeigt die Texte aller Programmpunkte, scrollt gleichmäßig und folgt optional dem laufenden Punkt
import { fmtCountdown, computeSchedule, parseClock, liveStatus } from '/shared/timing.js';
import { h, icon, popover, closePop } from '/js/ui.js';

const m = location.pathname.match(/^\/prompter\/(?:p\/([^/]+)|(\d+))/);
const publicToken = m?.[1] ? decodeURIComponent(m[1]) : null;
const rundownId = m?.[2] ? Number(m[2]) : null;

let data = null, offset = 0, es = null, sig = '', lastCurrent = null, liveKey = '';
const el = {};

/* ---------- Einstellungen (pro Browser) */
const DEFAULTS = { speed: 40, size: 56, margin: 6, indicator: 30, mirror: false, follow: true, uppercase: false, invert: false, details: true, blackout: false };
if (window.innerWidth < 600) DEFAULTS.size = 36;
const P = (() => { try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('ffr.prompter') || '{}') }; } catch { return { ...DEFAULTS }; } })();
const saveP = () => { try { localStorage.setItem('ffr.prompter', JSON.stringify(P)); } catch { /* */ } };
// Textquelle pro Rundown: 'description' oder 'c<Spalten-ID>'
const srcKey = () => 'ffr.prompter.src.' + data.rundown.id;
const getSource = () => { try { return localStorage.getItem(srcKey()) || 'description'; } catch { return 'description'; } };
const setSource = (v) => { try { localStorage.setItem(srcKey(), v); } catch { /* */ } };

let playing = false;
const set = (e, v) => { if (e && e.textContent !== v) e.textContent = v; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* ---------- Aufbau */
function stepper(key, label, min, max, step) {
  const v = h('span', { class: 'v' });
  el['v_' + key] = v;
  return h('span', { class: 'pr-group' },
    h('span', { class: 'k' }, label),
    h('button', { class: 'icon-btn', 'aria-label': `${label} verringern`, onclick: () => update({ [key]: clamp(P[key] - step, min, max) }) }, icon('minus')),
    v,
    h('button', { class: 'icon-btn', 'aria-label': `${label} erhöhen`, onclick: () => update({ [key]: clamp(P[key] + step, min, max) }) }, icon('plus')));
}

function build() {
  el.play = h('button', { class: 'pr-play', title: 'Start/Stopp (Leertaste)', onclick: () => setPlaying(!playing) });
  el.name = h('span', { class: 'pr-name' });
  el.timer = h('span', { class: 'pr-timer idle', role: 'timer' }, '--:--');
  el.curBtn = h('button', { class: 'btn', title: 'Zum laufenden Punkt (Umschalt + ↓)', onclick: () => jumpCurrent() }, icon('follow'), h('span', { class: 'lbl' }, 'Laufender Punkt'));

  el.text = h('div', { class: 'pr-text' });
  el.spacer = h('div');
  el.items = h('div');
  el.text.append(el.spacer, el.items, h('div', { style: { height: '100vh' } }));
  el.scroll = h('div', { class: 'pr-scroll' }, el.text);
  el.blackout = h('div', { class: 'pr-blackout', 'aria-hidden': 'true' });
  el.guide = h('div', { class: 'pr-guide', 'aria-hidden': 'true' }, h('span', { class: 'line' }));

  el.root = h('div', { class: 'pr' },
    h('div', { class: 'pr-tools', role: 'toolbar', 'aria-label': 'Prompter' },
      h('span', { class: 'brand-mark' }, icon('logo')),
      el.name,
      el.play,
      el.timer,
      stepper('speed', 'Tempo', 0, 400, 10),
      stepper('size', 'Schrift', 24, 160, 4),
      h('button', { class: 'btn', title: 'Zum Anfang (Umschalt + ↑)', onclick: () => scrollToId('top') }, icon('chevronUp'), h('span', { class: 'lbl' }, 'Anfang')),
      el.curBtn,
      h('button', { class: 'btn', onclick: (e) => cueMenu(e.currentTarget) }, icon('list'), h('span', { class: 'lbl' }, 'Punkte')),
      h('button', { class: 'btn', onclick: (e) => optionsMenu(e.currentTarget) }, icon('columns'), h('span', { class: 'lbl' }, 'Optionen')),
      h('button', { class: 'icon-btn fs', title: 'Vollbild', 'aria-label': 'Vollbild', onclick: toggleFs }, icon('maximize'))),
    h('div', { class: 'pr-stage' }, el.scroll, el.blackout, el.guide));
  document.body.replaceChildren(el.root);
  applyPrefs();
  paintPlay();
}

function applyPrefs() {
  el.root.classList.toggle('inverted', P.invert);
  el.text.classList.toggle('mirror', P.mirror);
  el.text.classList.toggle('upper', P.uppercase);
  el.text.classList.toggle('plain', !P.details);
  el.scroll.style.fontSize = P.size + 'px';
  el.scroll.style.paddingLeft = el.scroll.style.paddingRight = P.margin + 'vw';
  el.spacer.style.height = `calc(${P.indicator / 100} * var(--stage-h, 70vh))`;
  el.guide.style.top = P.indicator + '%';
  el.blackout.style.height = P.indicator + '%';
  el.blackout.style.display = P.blackout ? '' : 'none';
  for (const k of ['speed', 'size']) set(el['v_' + k], String(P[k]));
  measure();
}

function measure() {
  if (el.scroll) el.text.style.setProperty('--stage-h', el.scroll.clientHeight + 'px');
}
window.addEventListener('resize', measure);

function update(patch) {
  Object.assign(P, patch);
  saveP();
  applyPrefs();
}

function paintPlay() {
  el.play.replaceChildren(icon(playing ? 'square' : 'play'));
  el.play.classList.toggle('on', playing);
  el.play.setAttribute('aria-label', playing ? 'Scrollen anhalten' : 'Scrollen starten');
}

function toggleFs() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}

/* ---------- Menüs */
function cueMenu(anchor) {
  const st = liveStatus(data.items, data.live || {}, Date.now() + offset);
  const sched = computeSchedule(data.items, parseClock(data.rundown.start_time));
  const play = data.items.filter((i) => i.type === 'item');
  const pop = popover(anchor, h('div', { class: 'pr-cues' }, play.length
    ? play.map((it) => h('button', { class: 'mi' + (st.running && st.current.id === it.id ? ' active' : ''), onclick: () => { closePop(); scrollToId(it.id); } },
      h('span', { class: 'nr' }, String(sched.map.get(it.id)?.nr ?? '')), it.title || 'Ohne Titel'))
    : h('div', { class: 'mi' }, 'Keine Programmpunkte')));
  pop.querySelector('.mi.active')?.scrollIntoView({ block: 'center' });
}

function optionsMenu(anchor) {
  const opt = (label, key) => h('label', { class: 'mi switch' },
    h('input', { type: 'checkbox', checked: !!P[key], onchange: (e) => update({ [key]: e.target.checked }) }), label);
  const range = (label, key, min, max, step, unit) => {
    const out = h('b', null, P[key] + unit);
    return h('label', { class: 'field pr-range' }, h('span', null, label, ' ', out),
      h('input', { type: 'range', min, max, step, value: P[key], oninput: (e) => { update({ [key]: Number(e.target.value) }); out.textContent = P[key] + unit; } }));
  };
  const src = getSource();
  popover(anchor, h('div', { class: 'pr-opts' },
    h('label', { class: 'field' }, h('span', null, 'Text aus'),
      h('select', { class: 'input', onchange: (e) => { setSource(e.target.value); renderText(); } },
        h('option', { value: 'description', selected: src === 'description' }, 'Beschreibung der Programmpunkte'),
        data.columns.map((c) => h('option', { value: 'c' + c.id, selected: src === 'c' + c.id }, `Spalte „${c.name}“`)))),
    range('Rand', 'margin', 0, 30, 2, '%'),
    range('Marke (Lesehöhe)', 'indicator', 5, 80, 5, '%'),
    opt('Folgt der Show', 'follow'),
    opt('Spiegeln', 'mirror'),
    opt('Titel und Trennlinien', 'details'),
    opt('Abdunkeln über der Marke', 'blackout'),
    opt('Großbuchstaben', 'uppercase'),
    opt('Farben umkehren', 'invert')));
}

/* ---------- Text */
function textOf(it) {
  const src = getSource();
  if (src === 'description') return it.description || '';
  return it.cells?.[src.slice(1)] || '';
}

function renderText() {
  if (!data) return;
  // Gewählte Spalte existiert nicht mehr → zurück auf Beschreibung
  const src = getSource();
  if (src !== 'description' && !data.columns.some((c) => 'c' + c.id === src)) setSource('description');

  const sched = computeSchedule(data.items, parseClock(data.rundown.start_time));
  const out = [];
  for (const it of data.items) {
    if (it.type === 'block_end') continue;
    if (it.type === 'block') { out.push(h('div', { class: 'pr-block' }, it.title || 'Block')); continue; }
    const text = textOf(it).trim();
    out.push(h('section', { class: 'pr-sec', dataset: { id: it.id } },
      h('div', { class: 'pr-head' }, h('span', { class: 'nr' }, String(sched.map.get(it.id)?.nr ?? '')), h('span', null, it.title || 'Ohne Titel')),
      text ? text.split(/\n{2,}/).map((para) => h('p', null, para)) : h('p', { class: 'pr-empty' }, 'Kein Text')));
  }
  if (!out.length) out.push(h('p', { class: 'pr-empty' }, 'Noch keine Programmpunkte.'));
  el.items.replaceChildren(...out);
  set(el.name, data.rundown.title);
  document.title = data.rundown.title + ' · Prompter';
  liveKey = '';
  applyPrefs();
  render();
}

function scrollToId(id, smooth = true) {
  const box = el.scroll;
  if (!box) return;
  if (id === 'top') return box.scrollTo({ top: 0, behavior: smooth ? 'smooth' : 'auto' });
  const sec = el.items.querySelector(`.pr-sec[data-id="${id}"]`);
  if (!sec) return;
  const top = sec.offsetTop - box.clientHeight * (P.indicator / 100);
  box.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' });
}

function jumpCurrent() {
  const live = data?.live || {};
  if (live.running && live.currentId) scrollToId(live.currentId);
}

/* ---------- Gleichmäßiges Scrollen */
let raf = 0;
function setPlaying(on) {
  playing = on;
  paintPlay();
  cancelAnimationFrame(raf);
  if (!on) return;
  let last = performance.now(), carry = 0;
  const step = (t) => {
    carry += (P.speed * (t - last)) / 1000;
    const whole = Math.trunc(carry);
    if (whole) { el.scroll.scrollTop += whole; carry -= whole; }
    last = t;
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
}

/* ---------- Tastatur */
window.addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, textarea, select, .pop')) return;
  if (e.key === ' ') { e.preventDefault(); setPlaying(!playing); }
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    update({ speed: clamp(P.speed + (e.shiftKey ? 20 : 10) * (e.key === 'ArrowLeft' ? -1 : 1), 0, 400) });
  } else if (e.key === 'ArrowUp' && e.shiftKey) { e.preventDefault(); scrollToId('top'); }
  else if (e.key === 'ArrowDown' && e.shiftKey) { e.preventDefault(); jumpCurrent(); }
  else if (e.key === '+' || e.key === '=') update({ size: clamp(P.size + 4, 24, 160) });
  else if (e.key === '-') update({ size: clamp(P.size - 4, 24, 160) });
});

/* ---------- Live-Werte */
function render() {
  if (!data || !el.root) return;
  const live = data.live || {};
  const st = liveStatus(data.items, live, Date.now() + offset);
  if (st.running) {
    set(el.timer, fmtCountdown(st.remaining));
    el.timer.className = 'pr-timer ' + (st.remaining < 0 ? 'over' : st.remaining <= 60 ? 'warn' : '');
  } else {
    set(el.timer, '--:--');
    el.timer.className = 'pr-timer idle';
  }
  el.curBtn.disabled = !st.running;

  const hist = live.history || {};
  const key = (st.running ? st.current.id : '-') + '|' + Object.keys(hist).join(',');
  if (key === liveKey) return;
  liveKey = key;
  for (const sec of el.items.querySelectorAll('.pr-sec')) {
    const id = Number(sec.dataset.id);
    const isCur = st.running && st.current.id === id;
    sec.classList.toggle('current', isCur);
    sec.classList.toggle('done', hist[id] != null && !isCur);
  }
  const cur = st.running ? st.current.id : null;
  if (cur !== lastCurrent) {
    lastCurrent = cur;
    if (cur && P.follow) scrollToId(cur);
  }
}

/* ---------- Daten & Echtzeit */
function message(html) { closePop(); setPlaying(false); document.body.replaceChildren(h('div', { class: 'lw-msg', html })); }

function apply(p) {
  data = p;
  offset = p.serverNow - Date.now();
  if (!el.root) { build(); lastCurrent = null; }
  const s = JSON.stringify([p.items, p.columns, p.rundown]);
  if (s !== sig) {
    const first = !sig;
    sig = s;
    const keep = el.scroll.scrollTop; // Position halten, wenn sich der Text ändert
    renderText();
    if (!first) el.scroll.scrollTop = keep;
  } else render();
}

async function load() {
  const url = publicToken ? `/api/public/${encodeURIComponent(publicToken)}` : `/api/rundowns/${rundownId}`;
  const res = await fetch(url, { credentials: 'same-origin' });
  if (res.status === 401) return message('Bitte zuerst <a href="/">anmelden</a> und den Prompter danach erneut öffnen.');
  if (!res.ok) return message('Rundown nicht gefunden oder Link deaktiviert.');
  apply(await res.json());
}

function connect() {
  es = new EventSource('/api/events?' + new URLSearchParams(publicToken ? { public: publicToken } : { rundown: rundownId }));
  let first = true;
  es.addEventListener('hello', () => { if (!first) load(); first = false; });
  es.addEventListener('rundown', (e) => apply(JSON.parse(e.data)));
  es.addEventListener('live', (e) => { const d = JSON.parse(e.data); if (!data) return; data.live = d.live; offset = d.serverNow - Date.now(); render(); });
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
  if (data) {
    connect(); setInterval(render, 250); keepAwake();
  }
}
