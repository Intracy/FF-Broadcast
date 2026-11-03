import { fmtDuration, fmtCountdown, fmtTime, fmtClock, parseClock, computeSchedule, liveStatus } from '/shared/timing.js';
import { h, icon, popover, closePop, themeToggle } from '/js/ui.js';

const m = location.pathname.match(/^\/live\/(?:p\/([^/]+)|(\d+))/);
const publicToken = m?.[1] ? decodeURIComponent(m[1]) : null;
const rundownId = m?.[2] ? Number(m[2]) : null;

let data = null, offset = 0, es = null, sig = '', liveKey = '', lastCurrent = null;
const el = {};

/* ---------- Einstellungen (pro Browser) */
const P = (() => { try { return JSON.parse(localStorage.getItem('ffr.live') || '{}'); } catch { return {}; } })();
P.mode ||= 'table';
P.follow ??= true;
const saveP = () => localStorage.setItem('ffr.live', JSON.stringify(P));
let hidden = new Set();
const hiddenKey = () => 'ffr.hidden.' + data.rundown.id;
const loadHidden = () => { try { hidden = new Set(JSON.parse(localStorage.getItem(hiddenKey()) || '[]')); } catch { hidden = new Set(); } };
const saveHidden = () => localStorage.setItem(hiddenKey(), JSON.stringify([...hidden]));
const show = (k) => !hidden.has(k);
const visCols = () => data.columns.filter((c) => show('c' + c.id));
const fmtDate = (d) => (d ? d.split('-').reverse().map((x, i) => (i < 2 ? String(Number(x)) : x)).join('.') : '');
const set = (e, v) => { if (e && e.textContent !== v) e.textContent = v; };

/* ---------- Aufbau */
function build() {
  el.title = h('div', { class: 't' });
  el.sub = h('div', { class: 's' });
  el.clock = h('span');
  el.themeBtn = themeToggle();

  // Status
  el.prog = h('div', { class: 'progress' }, h('span'));
  el.state = h('b');
  el.since = h('b');
  el.delta = h('b');
  el.deltaWrap = h('span', null, 'Gesamt ', el.delta);
  el.next = h('b');
  el.rest = h('div', { class: 'v' }, '--:--');

  // Tabelle
  el.head = h('div', { class: 'lw-row lw-head' });
  el.rows = h('div', { class: 'lw-rows' });
  el.grid = h('div', { class: 'lw-grid' }, el.head, el.rows);
  el.table = h('section', { class: 'card lw-table' }, el.grid);

  // Countdown
  el.bLbl = h('div', { class: 'lbl' });
  el.bName = h('div', { class: 'name' });
  el.bDesc = h('div', { class: 'desc' });
  el.bCount = h('div', { class: 'count' });
  el.bProg = h('div', { class: 'progress' }, h('span'));
  el.bNext = h('b');
  el.big = h('section', { class: 'lw-big' }, el.bLbl, el.bName, el.bDesc, el.bCount, el.bProg, h('div', { class: 'nx' }, 'Als Nächstes: ', el.bNext));

  el.root = h('div', { class: 'lw' },
    h('header', { class: 'lw-top' },
      h('span', { class: 'brand-mark' }, icon('logo')),
      h('div', { class: 'lw-title' }, el.title, el.sub),
      h('span', { class: 'lw-clock' }, icon('clock'), el.clock),
      h('button', { class: 'btn', onclick: (e) => viewMenu(e.currentTarget) }, icon('eye'), h('span', { class: 'lbl' }, 'Ansicht')),
      h('button', { class: 'icon-btn', title: 'Vollbild', onclick: toggleFs }, icon('maximize')),
      el.themeBtn),
    h('main', { class: 'lw-body' },
      h('section', { class: 'card lw-status' },
        h('div', { class: 'left' }, el.prog,
          h('div', { class: 'lw-line' },
            el.state,
            h('span', null, 'Live seit ', el.since),
            el.deltaWrap,
            h('span', null, 'Als Nächstes: ', el.next))),
        h('div', { class: 'lw-rest' }, h('div', { class: 'lbl' }, 'Restzeit'), el.rest)),
      el.table,
      el.big));
  document.body.replaceChildren(el.root);
  applyClasses();
}

function applyClasses() {
  el.root.classList.toggle('mode-countdown', P.mode === 'countdown');
  el.root.classList.toggle('compact', !!P.compact);
  el.root.classList.toggle('hide-done', !!P.hideDone);
}

function toggleFs() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}

function viewMenu(anchor) {
  const opt = (label, on, fn) => h('button', { class: 'mi' + (on ? ' active' : ''), onclick: () => { fn(); viewMenu(anchor); } }, on ? icon('check') : h('span', { class: 'ico' }), label);
  const sep = (t) => h('div', { class: 'label', style: { padding: '10px 12px 4px', fontSize: '11px' } }, t);
  popover(anchor, [
    sep('Darstellung'),
    opt('Tabelle', P.mode === 'table', () => { P.mode = 'table'; saveP(); applyClasses(); scrollToCurrent(true); }),
    opt('Großer Countdown', P.mode === 'countdown', () => { P.mode = 'countdown'; saveP(); applyClasses(); }),
    sep('Optionen'),
    opt('Mitlaufen (aktueller Punkt oben)', P.follow, () => { P.follow = !P.follow; saveP(); scrollToCurrent(true); }),
    opt('Erledigte ausblenden', P.hideDone, () => { P.hideDone = !P.hideDone; saveP(); applyClasses(); }),
    opt('Kompakt', P.compact, () => { P.compact = !P.compact; saveP(); applyClasses(); }),
    sep('Spalten'),
    [['start', 'Start'], ['end', 'Ende']].map(([k, n]) => opt(n, show(k), () => toggleCol(k))),
    data.columns.map((c) => opt(c.name, show('c' + c.id), () => toggleCol('c' + c.id))),
  ]);
}
function toggleCol(k) {
  if (hidden.has(k)) hidden.delete(k); else hidden.add(k);
  saveHidden();
  renderTable();
}

/* ---------- Tabelle */
function renderTable() {
  if (!data) return;
  const cols = visCols();
  const tpl = ['50px'];
  if (show('start')) tpl.push('92px');
  tpl.push('150px');
  if (show('end')) tpl.push('92px');
  tpl.push('minmax(220px, 1.25fr)');
  cols.forEach(() => tpl.push('minmax(160px, 1fr)'));
  el.grid.style.setProperty('--cols', tpl.join(' '));
  el.grid.style.minWidth = 50 + 150 + 220 + (show('start') ? 92 : 0) + (show('end') ? 92 : 0) + cols.length * 160 + tpl.length * 7 + 'px';

  el.head.replaceChildren(...[
    h('div', { class: 'center' }, 'Nr.'),
    show('start') ? h('div', { class: 'center' }, 'Start') : null,
    h('div', { class: 'center' }, 'Dauer'),
    show('end') ? h('div', { class: 'center' }, 'Ende') : null,
    h('div', null, 'Programmpunkt'),
    ...cols.map((c) => h('div', null, c.name)),
  ].filter(Boolean));

  const sched = computeSchedule(data.items, parseClock(data.rundown.start_time));
  const out = [];
  for (const it of data.items) {
    const s = sched.map.get(it.id) || {};
    if (it.type === 'block_end') continue;
    if (it.type === 'block') {
      out.push(h('div', { class: 'lw-block', style: it.color ? `--c:${it.color}` : null },
        it.color ? h('span', { class: 'dot' }) : null,
        it.title || 'Block',
        h('span', { class: 'meta' }, `${fmtClock(s.start)}–${fmtClock(s.end)} · ${fmtDuration(s.duration || 0, { hours: (s.duration || 0) >= 3600 })}`)));
      continue;
    }
    out.push(h('div', { class: 'lw-row lw-item' + (it.color ? ' has-color' : ''), style: it.color ? `--c:${it.color}` : null, dataset: { id: it.id } },
      h('div', { class: 'lw-c center nrc', 'data-label': 'Nr.' }, h('span', { class: 'num' }, String(s.nr))),
      show('start') ? h('div', { class: 'lw-c center c-start', 'data-label': 'Start' }, h('span', { class: 'num' }, fmtClock(s.start))) : null,
      h('div', { class: 'lw-c center c-dur', 'data-label': 'Dauer' }, h('span', { class: 'dur' }, fmtDuration(it.duration)), h('span', { class: 'delta', 'data-r': 'delta' })),
      show('end') ? h('div', { class: 'lw-c center c-end', 'data-label': 'Ende' }, h('span', { class: 'num' }, fmtClock(s.end))) : null,
      h('div', { class: 'lw-c ttl' }, h('div', { class: 't1' }, it.title || ''), h('div', { class: 't2' }, it.description || ''), h('div', { class: 'bar' }, h('span'))),
      ...cols.map((c) => h('div', { class: 'lw-c txc' + (it.cells?.[c.id] ? '' : ' empty-c'), 'data-label': c.name }, h('div', { class: 'tx' }, it.cells?.[c.id] || '')))));
  }
  if (!out.length) out.push(h('div', { class: 'empty' }, 'Noch keine Programmpunkte.'));
  el.rows.replaceChildren(...out);
  set(el.title, data.rundown.title);
  set(el.sub, [fmtDate(data.rundown.event_date), `${fmtClock(parseClock(data.rundown.start_time))} Uhr`, `Gesamt ${fmtDuration(sched.total, { hours: true })}`].filter(Boolean).join(' · '));
  document.title = data.rundown.title + ' · Live';
  liveKey = '';
  render();
}

function scrollToCurrent(force = false) {
  if (!data || !el.rows) return;
  const id = data.live?.running ? data.live.currentId : null;
  el.rows.classList.toggle('following', !!id && P.follow && P.mode === 'table');
  if (!P.follow || P.mode !== 'table') { lastCurrent = id; return; }
  if (!id || (!force && id === lastCurrent)) { lastCurrent = id; return; }
  lastCurrent = id;
  const row = el.rows.querySelector(`.lw-item[data-id="${id}"]`);
  if (!row) return;
  const box = el.table;
  requestAnimationFrame(() => {
    const headH = el.head.offsetParent ? el.head.getBoundingClientRect().height : 0;
    const top = box.scrollTop + (row.getBoundingClientRect().top - box.getBoundingClientRect().top) - headH - 8;
    box.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  });
}

/* ---------- Live-Werte */
function render() {
  if (!data || !el.root) return;
  const now = Date.now() + offset;
  const live = data.live || {};
  const st = liveStatus(data.items, live, now);
  const play = data.items.filter((i) => i.type === 'item');
  set(el.clock, fmtTime(now));

  const cls = st.running ? (st.remaining < 0 ? 'over' : st.remaining <= 60 ? 'warn' : '') : '';
  if (st.running) {
    set(el.state, `Live · Vergangen ${fmtDuration(st.elapsed)}`);
    set(el.since, fmtTime(st.startedAt, false));
    set(el.delta, fmtDuration(st.delta, { sign: true }));
    el.deltaWrap.className = st.delta > 0.5 ? 'red' : 'green';
    set(el.next, st.next ? st.next.title || 'Ohne Titel' : 'Ende');
    set(el.rest, fmtCountdown(st.remaining));
    el.prog.firstChild.style.width = st.progress * 100 + '%';
  } else {
    set(el.state, live.endedAt ? `Beendet ${fmtTime(live.endedAt, false)}` : 'Nicht live');
    set(el.since, '--:--');
    set(el.delta, '--:--'); el.deltaWrap.className = '';
    set(el.next, play[0]?.title || '–');
    set(el.rest, '--:--');
    el.prog.firstChild.style.width = '0';
  }
  el.rest.className = 'v ' + cls;
  el.prog.className = 'progress ' + cls;

  // Zeilen markieren
  const hist = live.history || {};
  const key = (st.running ? st.current.id : '-') + '|' + JSON.stringify(hist);
  if (key !== liveKey) {
    liveKey = key;
    for (const row of el.rows.querySelectorAll('.lw-item')) {
      const id = Number(row.dataset.id);
      const isLive = st.running && st.current.id === id;
      row.classList.toggle('is-live', isLive);
      row.classList.toggle('is-next', !!(st.running && st.next?.id === id));
      row.classList.toggle('is-done', hist[id] != null && !isLive);
      if (!isLive) { row.classList.remove('over'); row.querySelector('.bar span').style.width = '0'; }
      const d = row.querySelector('[data-r="delta"]');
      if (hist[id] != null && !isLive) {
        const it = data.items.find((i) => i.id === id);
        const diff = hist[id] - (it?.duration || 0);
        d.textContent = fmtDuration(diff, { sign: true });
        d.className = 'delta ' + (diff > 0 ? 'red' : 'green');
      } else { d.textContent = ''; d.className = 'delta'; }
    }
    scrollToCurrent();
  }
  if (st.running) {
    const row = el.rows.querySelector(`.lw-item[data-id="${st.current.id}"]`);
    if (row) {
      row.classList.toggle('over', st.remaining < 0);
      const d = row.querySelector('[data-r="delta"]');
      d.textContent = fmtCountdown(st.remaining);
      d.className = 'delta ' + (st.remaining < 0 ? 'red' : st.remaining <= 60 ? 'yellow' : 'green');
      row.querySelector('.bar span').style.width = st.progress * 100 + '%';
    }
  }

  // Countdown-Modus
  if (P.mode === 'countdown') {
    if (st.running) {
      set(el.bLbl, `Jetzt · ${st.index + 1} / ${st.count}`);
      set(el.bName, st.current.title || 'Ohne Titel');
      set(el.bDesc, st.current.description || '');
      set(el.bCount, fmtCountdown(st.remaining));
      set(el.bNext, st.next ? st.next.title || 'Ohne Titel' : 'Ende');
      el.bProg.firstChild.style.width = st.progress * 100 + '%';
    } else {
      set(el.bLbl, live.endedAt ? 'Beendet' : `Geplanter Start ${fmtClock(parseClock(data.rundown.start_time))}`);
      set(el.bName, play[0]?.title || '–');
      set(el.bDesc, '');
      set(el.bCount, play[0] ? fmtDuration(play[0].duration) : '--:--');
      set(el.bNext, play[1]?.title || '–');
      el.bProg.firstChild.style.width = '0';
    }
    el.bCount.className = 'count ' + (st.running ? cls : 'idle');
    el.bProg.className = 'progress ' + cls;
    el.big.classList.toggle('over', st.running && st.remaining < 0);
  }
}

/* ---------- Daten & Echtzeit */
function message(html) { closePop(); document.body.replaceChildren(h('div', { class: 'lw-msg', html })); }

function apply(p) {
  data = p;
  offset = p.serverNow - Date.now();
  if (!el.root) { loadHidden(); build(); }
  const s = JSON.stringify([p.items, p.columns, p.rundown]);
  if (s !== sig) { sig = s; renderTable(); } else render();
}

async function load() {
  const url = publicToken ? `/api/public/${encodeURIComponent(publicToken)}` : `/api/rundowns/${rundownId}`;
  const res = await fetch(url, { credentials: 'same-origin' });
  if (res.status === 401) return message('Bitte zuerst <a href="/">anmelden</a> und die Live-Ansicht danach erneut öffnen.');
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

let wake = null;
async function keepAwake() {
  try { if ('wakeLock' in navigator && document.visibilityState === 'visible') wake = await navigator.wakeLock.request('screen'); } catch { /* */ }
}
document.addEventListener('visibilitychange', keepAwake);

if (!publicToken && !rundownId) message('Ungültige Adresse.');
else {
  await load();
  if (data) { connect(); setInterval(render, 250); keepAwake(); }
}
