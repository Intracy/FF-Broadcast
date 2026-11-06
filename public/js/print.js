// Druckansicht: Ablaufplan, Abteilungsliste, Moderationsskript – PDF über „Drucken → Als PDF speichern“
import { fmtDuration, fmtClock, parseClock, computeSchedule } from '/shared/timing.js';
import { h, icon, fill } from '/js/ui.js';

const m = location.pathname.match(/^\/print\/(?:p\/([^/]+)|(\d+))/);
const publicToken = m?.[1] ? decodeURIComponent(m[1]) : null;
const rundownId = m?.[2] ? Number(m[2]) : null;

const VARIANTS = {
  plan: ['Ablaufplan', 'Alle Punkte mit Zeiten, Blöcken und Spalten'],
  dept: ['Abteilungsliste', 'Nur ausgewählte Spalten, z. B. Ton oder Licht'],
  script: ['Moderationsskript', 'Pro Punkt Zeit, Titel und Prompter-Skript'],
};
const WEEKDAYS = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];

let data = null, me = null;
let P = null; // Einstellungen
const el = {};

/* ---------- Einstellungen pro Rundown im Browser merken */
const prefKey = () => 'ffr.print.' + (publicToken ? 'p.' + publicToken.slice(0, 8) : rundownId);
function loadPrefs() {
  const d = { variant: 'plan', orient: 'portrait', size: 'm', colors: true, desc: true, actual: false, onlyFilled: true, pageBreak: false, skipEmptyScript: false, cols: null, deptCols: null, blocks: null };
  try { P = { ...d, ...JSON.parse(localStorage.getItem(prefKey()) || '{}') }; } catch { P = d; }
  const params = new URLSearchParams(location.search);
  if (VARIANTS[params.get('v')]) P.variant = params.get('v');
}
const savePrefs = () => { try { localStorage.setItem(prefKey(), JSON.stringify(P)); } catch { /* */ } };
const update = (patch) => { Object.assign(P, patch); savePrefs(); render(); };

/* ---------- Daten */
async function load() {
  const url = publicToken ? `/api/public/${encodeURIComponent(publicToken)}` : `/api/rundowns/${rundownId}`;
  const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
  if (res.status === 401) return message('Bitte zuerst <a href="/">anmelden</a> und die Druckansicht danach erneut öffnen.');
  if (!res.ok) return message('Rundown nicht gefunden oder kein Zugriff.');
  data = await res.json();
  if (!publicToken) { try { me = (await (await fetch('/api/auth/status', { credentials: 'same-origin' })).json()).user; } catch { /* */ } }
  if (!el.app) build();
  render();
}

function message(html) { document.body.replaceChildren(h('div', { class: 'pr-msg', html: `<div>${html}</div>` })); }

/* ---------- Aufbau Seitenleiste */
function build() {
  el.side = h('aside', { class: 'pr-side' });
  el.sheet = h('div', { class: 'sheet' });
  el.app = h('div', { class: 'pr-app' }, el.side, h('main', { class: 'pr-preview' }, el.sheet));
  document.body.replaceChildren(el.app);
  window.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') { e.preventDefault(); window.print(); } });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') load(); });
}

const seg = (opts, value, onPick, cls = '') => h('div', { class: 'seg ' + cls }, opts.map(([v, label, sub]) =>
  h('button', { type: 'button', class: v === value ? 'sel' : '', onclick: () => onPick(v) }, sub ? h('span', null, label, h('small', null, sub)) : label)));
const chk = (label, checked, onChange, extra) => h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked, onchange: (e) => onChange(e.target.checked) }), h('span', null, label), extra || null);

function drawSide() {
  const cols = data.columns;
  const blocks = data.items.filter((i) => i.type === 'block');
  const hasScript = data.items.some((i) => i.type === 'item' && (i.script || '').trim());
  const sources = actualSources();
  const hasActual = sources.length > 0;
  const colKey = P.variant === 'dept' ? 'deptCols' : 'cols';
  const chosen = P[colKey] ?? (P.variant === 'dept' ? [] : cols.map((c) => c.id));
  const toggleCol = (id, on) => update({ [colKey]: on ? [...new Set([...chosen, id])] : chosen.filter((x) => x !== id) });
  const exBlocks = new Set(P.blocks || []);
  const toggleBlock = (id, on) => { if (on) exBlocks.delete(id); else exBlocks.add(id); update({ blocks: [...exBlocks] }); };

  fill(el.side,
    h('div', { class: 'brand' }, h('span', { class: 'brand-mark' }, icon('logo')), h('div', null, h('b', null, 'Drucken / PDF'), h('span', null, data.rundown.title))),
    h('div', { class: 'pr-group' }, h('div', { class: 'pr-label' }, 'Variante'),
      seg(Object.entries(VARIANTS).map(([k, [l, s]]) => [k, l, s]), P.variant, (v) => update({ variant: v }), 'v')),
    h('div', { class: 'pr-group' }, h('div', { class: 'pr-label' }, 'Format'),
      seg([['portrait', 'Hochformat'], ['landscape', 'Querformat']], P.orient, (v) => update({ orient: v })),
      P.variant !== 'script' && P.orient === 'portrait' && chosen.length > 3 ? h('div', { class: 'pr-hint', style: 'margin-top:6px' }, 'Tipp: Bei vielen Spalten ist Querformat besser lesbar.') : null),
    h('div', { class: 'pr-group' }, h('div', { class: 'pr-label' }, 'Schriftgröße'),
      seg([['s', 'Klein'], ['m', 'Normal'], ['l', 'Groß']], P.size, (v) => update({ size: v }))),
    P.variant !== 'script' ? h('div', { class: 'pr-group' }, h('div', { class: 'pr-label' }, P.variant === 'dept' ? 'Spalten für die Abteilung' : 'Spalten'),
      cols.length ? h('div', { class: 'pr-list' }, cols.map((c) => chk(c.name, chosen.includes(c.id), (on) => toggleCol(c.id, on)))) : h('div', { class: 'pr-hint' }, 'Dieser Rundown hat keine eigenen Spalten.'),
      P.variant === 'dept' && !chosen.length ? h('div', { class: 'pr-hint', style: 'margin-top:6px;color:#fbbf24' }, 'Mindestens eine Spalte auswählen.') : null) : null,
    blocks.length ? h('div', { class: 'pr-group' }, h('div', { class: 'pr-label' }, 'Blöcke'),
      h('div', { class: 'pr-list' }, blocks.map((b) => chk(b.title || 'Block', !exBlocks.has(b.id), (on) => toggleBlock(b.id, on))),
        chk('Punkte außerhalb von Blöcken', !exBlocks.has(0), (on) => toggleBlock(0, on)))) : null,
    h('div', { class: 'pr-group' }, h('div', { class: 'pr-label' }, 'Optionen'),
      chk('Farben', P.colors, (v) => update({ colors: v })),
      P.variant !== 'dept' ? chk('Beschreibung', P.desc, (v) => update({ desc: v })) : null,
      P.variant === 'dept' ? chk('Nur Punkte mit Eintrag', P.onlyFilled, (v) => update({ onlyFilled: v })) : null,
      P.variant === 'script' ? chk('Jeder Punkt auf neuer Seite', P.pageBreak, (v) => update({ pageBreak: v })) : null,
      P.variant === 'script' ? chk('Punkte ohne Skript weglassen', P.skipEmptyScript, (v) => update({ skipEmptyScript: v })) : null,
      P.variant !== 'script' && hasActual ? chk('Ist-Zeiten (Nachbericht)', P.actual, (v) => update({ actual: v }), h('span', { class: 'muted' }, 'aus Live')) : null,
      P.variant !== 'script' && P.actual && sources.length > 1 ? h('select', { class: 'pr-select', title: 'Welcher Durchlauf?', onchange: (e) => update({ actualSrc: e.target.value }) },
        sources.map((x) => h('option', { value: x.key, selected: x.key === actualSource()?.key }, x.label))) : null),
    P.variant === 'script' && !hasScript ? h('div', { class: 'pr-hint', style: 'margin-bottom:12px' }, 'Noch keine Skripte hinterlegt – im Rundown über das Dokument-Symbol im Programmpunkt eintragen. Ohne Skript wird die Beschreibung gedruckt.') : null,
    h('div', { class: 'pr-actions' },
      h('button', { class: 'btn primary', onclick: () => window.print() }, icon('printer'), 'Drucken / Als PDF speichern'),
      h('div', { class: 'pr-hint' }, 'Für ein PDF im Druckdialog „Als PDF speichern“ wählen. Tipp: „Kopf- und Fußzeilen“ des Browsers ausschalten.'),
      h('button', { class: 'btn', onclick: () => load() }, icon('rotate'), 'Neu laden')));
}

/* ---------- Dokument */
function blockFilter(sched) {
  const ex = new Set(P.blocks || []);
  return (it) => {
    const s = sched.map.get(it.id) || {};
    const bid = it.type === 'block' ? it.id : s.block?.id || 0;
    return !ex.has(bid);
  };
}

function header(sched, variantLabel) {
  const r = data.rundown;
  const d = r.event_date ? new Date(r.event_date + 'T12:00:00') : null;
  const now = new Date();
  return h('header', { class: 'doc-head' },
    h('div', null,
      h('div', { class: 'doc-logo' }, icon('logo'), 'FF Rundown'),
      h('h1', null, r.title),
      h('div', { class: 'meta' },
        d ? h('span', null, h('b', null, `${WEEKDAYS[d.getDay()]}, ${d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })}`)) : null,
        h('span', null, 'Start ', h('b', null, fmtClock(parseClock(r.start_time)))), h('span', null, 'Ende ', h('b', null, fmtClock(sched.end))),
        h('span', null, 'Gesamt ', h('b', null, fmtDuration(sched.total, { hours: true }))),
        h('span', null, h('b', null, String(sched.count)), ' Punkte'))),
    h('div', { class: 'right' },
      h('div', { class: 'variant' }, variantLabel),
      h('div', null, `Stand: ${now.toLocaleDateString('de-DE')} ${now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`),
      me ? h('div', null, `Gedruckt von ${me.name || me.email}`) : publicToken ? h('div', null, 'Öffentliche Ansicht') : null));
}

/** Durchläufe mit gemessenen Zeiten: Show, Proben, laufender bzw. letzter Lauf (ältere Daten) */
function actualSources() {
  const lv = data.live || {}, out = [];
  const when = (ms) => (ms ? ' · ' + new Date(ms).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');
  if (lv.show && Object.keys(lv.show.history || {}).length) out.push({ key: 'show', label: 'Show' + when(lv.show.startedAt), history: lv.show.history });
  (lv.probes || []).map((r, i) => ({ key: 'p' + i, label: `Probe ${i + 1}` + when(r.startedAt), history: r.history })).reverse().forEach((x) => out.push(x));
  const cur = Object.keys(lv.history || {}).length;
  if (cur && (lv.running || !out.length)) out.unshift({ key: 'current', label: (lv.running ? (lv.mode === 'probe' ? 'Probe (läuft)' : 'Show (läuft)') : 'Letzter Lauf') + when(lv.startedAt), history: lv.history });
  return out;
}
function actualSource() {
  const all = actualSources();
  return all.find((x) => x.key === P.actualSrc) || all.find((x) => x.key === 'show') || all[0] || null;
}

function renderTable(sched) {
  const dept = P.variant === 'dept';
  const colIds = dept ? (P.deptCols || []) : (P.cols ?? data.columns.map((c) => c.id));
  const cols = data.columns.filter((c) => colIds.includes(c.id));
  if (dept && !cols.length) return h('div', { class: 'doc-empty' }, 'Bitte links mindestens eine Spalte für die Abteilung auswählen.');
  const src = actualSource();
  const showActual = P.actual && !!src;
  const hist = src?.history || {};
  const inFilter = blockFilter(sched);
  const land = P.orient === 'landscape';

  // Spaltenbreiten (in % der Tabellenbreite)
  const fixed = [['nr', 5], ['start', 7.5], ['dur', 7.5], ['end', dept ? 0 : 7.5]].filter(([, w]) => w);
  if (showActual) fixed.push(['act', 8.5]);
  const fixedSum = fixed.reduce((a, [, w]) => a + w, 0);
  const rest = 100 - fixedSum;
  const many = cols.length > 3;
  const titleW = cols.length ? Math.max(dept ? 24 : (land || many ? 22 : 30), rest * (dept ? .3 : (many ? .3 : .38))) : rest;
  const colW = cols.length ? (rest - titleW) / cols.length : 0;

  const colgroup = h('colgroup', null, fixed.map(([, w]) => h('col', { style: `width:${w}%` })), h('col', { style: `width:${titleW}%` }), cols.map(() => h('col', { style: `width:${colW}%` })));
  const head = h('thead', null, h('tr', null,
    h('th', { class: 'c' }, 'Nr.'), h('th', { class: 'c' }, 'Start'), h('th', { class: 'c' }, 'Dauer'), dept ? null : h('th', { class: 'c' }, 'Ende'),
    showActual ? h('th', { class: 'c' }, 'Ist') : null,
    h('th', null, 'Programmpunkt'), cols.map((c) => h('th', null, c.name))));

  const rows = [];
  const span = fixed.length + 1 + cols.length;
  for (const it of data.items) {
    if (!inFilter(it)) continue;
    const s = sched.map.get(it.id) || {};
    if (it.type === 'block_end') continue;
    if (it.type === 'block') {
      rows.push(h('tr', { class: 'block', style: it.color ? `--c:${it.color}` : null }, h('td', { colspan: span },
        h('div', { class: 'bt' }, it.color ? h('span', { class: 'dot' }) : null, h('b', null, it.title || 'Block'),
          h('span', { class: 'bm' }, `${fmtClock(s.start)}–${fmtClock(s.end)} · ${fmtDuration(s.duration || 0, { hours: (s.duration || 0) >= 3600 })} · ${s.count || 0} ${s.count === 1 ? 'Punkt' : 'Punkte'}`)))));
      continue;
    }
    const cellVals = cols.map((c) => (it.cells?.[c.id] || '').trim());
    if (dept && P.onlyFilled && cols.length && !cellVals.some(Boolean)) continue;
    let act = null;
    if (showActual) {
      if (hist[it.id] != null) {
        const diff = hist[it.id] - it.duration;
        act = h('td', { class: 'c num' }, fmtDuration(hist[it.id]), Math.abs(diff) >= 1 ? h('span', { class: 'dev ' + (diff > 0 ? 'plus' : 'minus') }, fmtDuration(diff, { sign: true })) : null);
      } else act = h('td', { class: 'c num empty' }, '–');
    }
    rows.push(h('tr', { class: 'item' + (it.color ? ' has-color' : ''), style: it.color ? `--c:${it.color}` : null },
      h('td', { class: 'c num nr' }, String(s.nr)),
      h('td', { class: 'c num' }, fmtClock(s.start)),
      h('td', { class: 'c num' }, fmtDuration(it.duration)),
      dept ? null : h('td', { class: 'c num' }, fmtClock(s.end)),
      act,
      h('td', { class: 'ttl' }, h('b', null, it.title || '—'), !dept && P.desc && it.description ? h('div', { class: 'desc' }, it.description) : null),
      cellVals.map((v) => h('td', { class: 'cellt' + (v ? '' : ' empty') }, v || ''))));
  }
  if (!rows.length) return h('div', { class: 'doc-empty' }, dept && !cols.length ? 'Bitte links mindestens eine Spalte auswählen.' : 'Keine Punkte für diese Auswahl.');

  let sum = null;
  if (showActual) {
    const done = data.items.filter((i) => i.type === 'item' && hist[i.id] != null);
    const plan = done.reduce((a, i) => a + i.duration, 0), real = done.reduce((a, i) => a + hist[i.id], 0);
    sum = h('div', { class: 'doc-sum' }, h('span', null, `${done.length} von ${sched.count} Punkten gemessen`), h('span', null, 'Plan ', h('b', null, fmtDuration(plan, { hours: true }))),
      h('span', null, `Ist${src && src.key !== 'show' ? ' (' + src.label.split(' · ')[0] + ')' : ''} `, h('b', null, fmtDuration(real, { hours: true }))), h('span', null, 'Abweichung ', h('b', { style: `color:${real - plan > 0 ? 'var(--red)' : 'var(--green)'}` }, fmtDuration(real - plan, { sign: true, hours: Math.abs(real - plan) >= 3600 }))));
  }
  return [h('table', { class: 'plan' }, colgroup, head, h('tbody', null, rows)), sum];
}

function renderScript(sched) {
  const inFilter = blockFilter(sched);
  const out = [];
  for (const it of data.items) {
    if (it.type !== 'item' || !inFilter(it)) continue;
    const s = sched.map.get(it.id) || {};
    const script = (it.script || '').trim();
    if (P.skipEmptyScript && !script) continue;
    out.push(h('section', { class: 'script-item' + (P.pageBreak ? ' break' : ''), style: it.color && P.colors ? `--c:${it.color}` : null },
      h('div', { class: 'sh' }, h('span', { class: 'nr' }, String(s.nr)), h('span', null, `${fmtClock(s.start)}–${fmtClock(s.end)}`), h('span', null, `· ${fmtDuration(it.duration)}`),
        s.block ? h('span', { class: 'blk' }, s.block.title || 'Block') : null),
      h('h2', null, it.title || '—'),
      P.desc && it.description ? h('div', { class: 'sdesc' }, it.description) : null,
      script ? h('div', { class: 'stext' }, script) : h('div', { class: 'stext none' }, P.desc || !it.description ? 'Kein Skript hinterlegt.' : it.description)));
  }
  return out.length ? out : h('div', { class: 'doc-empty' }, 'Keine Punkte für diese Auswahl.');
}

function pageStyle() {
  const r = data.rundown;
  const esc = (t) => String(t).replace(/["\\]/g, '\\$&').replace(/\n/g, ' ');
  const now = new Date();
  const footer = esc(`${r.title} · ${VARIANTS[P.variant][0]} · Stand ${now.toLocaleDateString('de-DE')} ${now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`);
  document.getElementById('page-style').textContent = `@page {
  size: A4 ${P.orient};
  margin: 12mm 11mm 14mm;
  @bottom-left { content: "${footer}"; font-family: 'IBM Plex Sans', sans-serif; font-size: 7.5pt; color: #8a8a96; }
  @bottom-right { content: "Seite " counter(page) " / " counter(pages); font-family: 'IBM Plex Sans', sans-serif; font-size: 7.5pt; color: #8a8a96; }
}`;
  document.title = `${r.title} – ${VARIANTS[P.variant][0]}`;
}

function render() {
  if (!data) return;
  drawSide();
  const sched = computeSchedule(data.items, parseClock(data.rundown.start_time));
  el.sheet.className = `sheet fs-${P.size}` + (P.orient === 'landscape' ? ' landscape' : '') + (P.colors ? ' colors' : '');
  fill(el.sheet, header(sched, VARIANTS[P.variant][0]), P.variant === 'script' ? renderScript(sched) : renderTable(sched));
  pageStyle();
}

if (!publicToken && !rundownId) message('Ungültige Adresse.');
else { loadPrefs(); load(); }
