// Import aus Excel/CSV/Zwischenablage und Export als Excel/CSV
import { parseDuration, fmtDuration, fmtClock, computeSchedule } from '/shared/timing.js';
import { h, icon, modal, toast } from '/js/ui.js';
import { readXlsx, decodeText, parseCsv, toCsv, writeXlsx, download, XLSX_TYPE } from '/js/xlsx.js';

// Stylesheet nur bei Bedarf laden
if (!document.querySelector('link[href="/css/importer.css"]')) document.head.append(h('link', { rel: 'stylesheet', href: '/css/importer.css' }));

const COLOR_NAMES = {
  lila: '#6d28d9', violett: '#6d28d9', purple: '#6d28d9', aubergine: '#45197a',
  blau: '#1e40af', blue: '#1e40af', dunkelblau: '#1e40af', hellblau: '#0369a1',
  türkis: '#0e7490', tuerkis: '#0e7490', cyan: '#0e7490', petrol: '#0f766e',
  grün: '#166534', gruen: '#166534', green: '#166534', hellgrün: '#4d7c0f', oliv: '#4d7c0f',
  gelb: '#a16207', yellow: '#a16207', gold: '#a16207', orange: '#c2410c',
  rot: '#b91c1c', red: '#b91c1c', pink: '#be185d', rosa: '#be185d', magenta: '#86198f',
  grau: '#3f3f46', gray: '#3f3f46', grey: '#3f3f46', schwarz: '#1f2937', black: '#1f2937',
};

/* ================================================================== Zuordnung */
const FIELDS = [
  ['skip', '— nicht importieren —'],
  ['title', 'Titel'],
  ['duration', 'Dauer'],
  ['start', 'Startzeit'],
  ['end', 'Endzeit'],
  ['description', 'Beschreibung'],
  ['script', 'Skript (Prompter)'],
  ['color', 'Farbe'],
  ['type', 'Typ (Punkt / Block)'],
];
const GUESS = [
  ['skip', /^(nr\.?|no\.?|#|nummer|pos\.?|position|id|lfd\.?( nr\.?)?)$/],
  ['title', /^(titel|title|programmpunkt|punkt|beitrag|thema|inhalt|name|ablauf|item|segment|cue|programm)$/],
  ['duration', /^(dauer|länge|laenge|duration|len|length|min\.?|minuten|zeitdauer|soll-?dauer)$/],
  ['start', /^(start|beginn|startzeit|uhrzeit|von|time|zeit|ab|anfang|soll-?start)$/],
  ['end', /^(ende|endzeit|bis|end|schluss)$/],
  ['description', /^(beschreibung|description|info|details|untertitel|subtitle)$/],
  ['script', /^(skript|script|moderation|moderationstext|prompter|text|sprechtext)$/],
  ['color', /^(farbe|color|colour)$/],
  ['type', /^(typ|type|art|zeilentyp)$/],
];
const MAP_KEY = 'ffr.import.map';
const loadMap = () => { try { return JSON.parse(localStorage.getItem(MAP_KEY)) || {}; } catch { return {}; } };
const saveMap = (m) => { try { localStorage.setItem(MAP_KEY, JSON.stringify(m)); } catch { /* */ } };
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/[:*]+$/, '');

/** Dauer aus einer Zelle: "5:00", "1:30:00", "5", "5 min", "90 sek", "1,5 h" */
export function cellDuration(v) {
  let s = String(v ?? '').trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^ca\.?\s*/, '').replace(/\s+/g, ' ');
  let m;
  if ((m = s.match(/^(\d+(?:[.,]\d+)?)\s*(s|sek|sec|sekunden|seconds?)\.?$/))) return Math.round(parseFloat(m[1].replace(',', '.')));
  if ((m = s.match(/^(\d+(?:[.,]\d+)?)\s*(m|min|mins|minute|minuten|minutes)\.?$/))) return Math.round(parseFloat(m[1].replace(',', '.')) * 60);
  if ((m = s.match(/^(\d+(?:[.,]\d+)?)\s*(h|std|stunde|stunden|hours?)\.?$/))) return Math.round(parseFloat(m[1].replace(',', '.')) * 3600);
  if ((m = s.match(/^(\d+)\s*min\.?\s*(\d+)\s*(s|sek|sec)\.?$/))) return Number(m[1]) * 60 + Number(m[2]);
  if (!/^-?\d+([.,:]\d+)*$/.test(s)) return null;
  if (/^\d+[.,]\d+$/.test(s) && !/^\d+[.,]\d{2}$/.test(s)) return Math.round(parseFloat(s.replace(',', '.')) * 60);
  const d = parseDuration(s.replace(/^(\d+)[.,](\d{2})$/, '$1:$2'));
  return d >= 0 ? d : null;
}

/** Uhrzeit aus einer Zelle: "10:30", "10.30", "10:30:15", "31.12.2026 10:30", "10 Uhr" -> Sekunden */
export function cellClock(v) {
  let s = String(v ?? '').trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^\d{1,2}\.\d{1,2}\.\d{2,4}\s+/, '').replace(/^\d{4}-\d{2}-\d{2}[t ]/, '').replace(/\s*uhr$/, '');
  let m = s.match(/^(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?\s*(am|pm)?$/);
  if (!m && (m = s.match(/^(\d{1,2})$/))) m = [s, m[1], '0', '0'];
  if (!m) return null;
  let hh = Number(m[1]);
  if (m[4] === 'pm' && hh < 12) hh += 12;
  if (m[4] === 'am' && hh === 12) hh = 0;
  if (hh > 23 || Number(m[2]) > 59) return null;
  return hh * 3600 + Number(m[2]) * 60 + Number(m[3] || 0);
}

function cellColor(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return '';
  if (/^#?[0-9a-f]{6}$/.test(s)) return '#' + s.replace('#', '');
  if (/^#?[0-9a-f]{3}$/.test(s)) return '#' + s.replace('#', '').split('').map((c) => c + c).join('');
  return COLOR_NAMES[s] || '';
}

function cellType(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return null;
  if (/^(block[- ]?ende|ende|end|blockende|block end|\/block)$/.test(s)) return 'block_end';
  if (/^(block|abschnitt|kapitel|teil|rubrik|überschrift|ueberschrift|header|section)$/.test(s)) return 'block';
  return 'item';
}

/** Zeilen anhand der Zuordnung in Rundown-Einträge umwandeln */
function convert(rows, map, opts) {
  const idx = (field) => map.findIndex((m) => m === field);
  const iTitle = idx('title'), iDur = idx('duration'), iStart = idx('start'), iEnd = idx('end'),
    iDesc = idx('description'), iScript = idx('script'), iColor = idx('color'), iType = idx('type');
  const colTargets = map.map((m, i) => (m.startsWith('col:') ? [i, m.slice(4)] : null)).filter(Boolean);
  const get = (r, i) => (i >= 0 ? String(r[i] ?? '').trim() : '');
  const out = [];
  const warn = { badDur: 0, noTitle: 0, derived: 0 };
  for (const r of rows) {
    if (!r.some((v) => String(v ?? '').trim())) continue;
    const cells = {};
    for (const [i, name] of colTargets) { const v = get(r, i); if (v) cells[name] = v; }
    const title = get(r, iTitle), durRaw = get(r, iDur), startRaw = get(r, iStart);
    let type = iType >= 0 ? cellType(get(r, iType)) || 'item' : 'item';
    if (type === 'item' && opts.detectBlocks && title && !durRaw && !startRaw && !get(r, iEnd) && !get(r, iScript) && !Object.keys(cells).length) type = 'block';
    let dur = type === 'item' ? cellDuration(durRaw) : 0;
    if (type === 'item' && durRaw && dur == null) warn.badDur++;
    if (type !== 'block_end' && !title) warn.noTitle++;
    out.push({
      type, title: type === 'block_end' ? '' : title, duration: dur,
      start: cellClock(startRaw), end: cellClock(get(r, iEnd)),
      description: type === 'block_end' ? '' : get(r, iDesc), script: get(r, iScript), color: cellColor(get(r, iColor)), cells,
    });
  }
  // Fehlende Dauer aus Endzeit oder der nächsten Startzeit berechnen
  out.forEach((it, i) => {
    if (it.type !== 'item' || it.duration != null) return;
    let d = null;
    if (it.start != null && it.end != null) d = it.end - it.start;
    else if (it.start != null) { const nx = out.slice(i + 1).find((x) => x.start != null); if (nx) d = nx.start - it.start; }
    if (d != null) { if (d < 0) d += 86400; it.duration = d; warn.derived++; }
  });
  out.forEach((it) => { if (it.type === 'item' && it.duration == null) it.duration = 0; });
  const firstStart = out.find((x) => x.start != null)?.start;
  return { items: out, warn, firstStart };
}

/* ================================================================== Dateien einlesen */
async function readSource(file) {
  const name = file.name || 'Import';
  const buf = await file.arrayBuffer();
  const b = new Uint8Array(buf.slice(0, 4));
  if (b[0] === 0x50 && b[1] === 0x4b) return { name, sheets: await readXlsx(buf) };
  if (b[0] === 0xd0 && b[1] === 0xcf) throw new Error('Alte Excel-Dateien (.xls) werden nicht unterstützt. Bitte in Excel als .xlsx speichern.');
  if (/\.(numbers|ods)$/i.test(name)) throw new Error('Bitte die Datei als .xlsx oder .csv exportieren.');
  return { name, sheets: [{ name: 'CSV', rows: parseCsv(decodeText(buf)) }] };
}

/* ================================================================== Import-Dialog */
/**
 * opts.api        – API-Funktion der App
 * opts.rundown    – aktueller Rundown (Payload) zum Anhängen, sonst nur „neuer Rundown“
 * opts.canCreate  – darf neue Rundowns anlegen
 * opts.onDone(r)  – nach erfolgreichem Import ({id, added, newColumns, mode, payload?})
 */
export function openImport(opts) {
  const st = { src: null, sheet: 0, header: true, detectBlocks: true, map: [], mode: opts.rundown ? 'append' : 'new' };
  const body = h('div', { class: 'imp' });
  let m;

  const pick = h('input', { type: 'file', accept: '.xlsx,.csv,.txt,.tsv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv', hidden: true, onchange: (e) => e.target.files[0] && load(e.target.files[0]) });

  async function load(file) {
    try {
      st.src = await readSource(file);
      st.sheet = Math.max(0, st.src.sheets.findIndex((s) => s.rows.some((r) => r.some((v) => String(v).trim()))));
      st.header = true;
      setup();
    } catch (e) { toast(e.message, 'err'); }
  }

  const fromPaste = (text) => {
    if (!text.trim()) return;
    const rows = parseCsv(text.replace(/\r?\n$/, ''), text.includes('\t') ? '\t' : undefined);
    st.src = { name: 'Zwischenablage', sheets: [{ name: 'Zwischenablage', rows }] };
    st.sheet = 0;
    setup();
  };

  function stepSource() {
    const paste = h('textarea', { class: 'input imp-paste', rows: 4, placeholder: 'Oder hier Zellen aus Excel / Google Sheets einfügen (Strg+V) …', onpaste: (e) => { const t = e.clipboardData.getData('text/plain'); if (t) { e.preventDefault(); fromPaste(t); } } });
    const drop = h('label', { class: 'imp-drop', ondragover: (e) => { e.preventDefault(); drop.classList.add('over'); }, ondragleave: () => drop.classList.remove('over'),
      ondrop: (e) => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) load(f); } },
      pick, icon('upload'), h('b', null, 'Excel- oder CSV-Datei auswählen'), h('span', null, 'oder hierher ziehen · .xlsx, .csv'));
    body.replaceChildren(
      drop, paste,
      h('div', { class: 'imp-tip' }, icon('info'),
        h('div', null, 'Noch keine passende Tabelle? ', h('button', { class: 'link-btn', onclick: downloadTemplate }, 'Import-Vorlage herunterladen'),
          ' – Spalten wie Start, Dauer, Titel, Beschreibung, Typ und eigene Spalten (Ton, GFX …). Google Sheets: Datei → Herunterladen → .xlsx.')));
    setTimeout(() => paste.focus(), 50);
  }

  function setup() {
    const rows = st.src.sheets[st.sheet].rows;
    const width = rows.reduce((a, r) => Math.max(a, r.length), 0);
    const headers = st.header ? Array.from({ length: width }, (_, i) => String(rows[0]?.[i] ?? '').trim()) : Array.from({ length: width }, () => '');
    const data = st.header ? rows.slice(1) : rows;
    const saved = loadMap();
    const existing = (opts.rundown?.columns || []).map((c) => c.name);
    const used = new Set();
    st.map = headers.map((hd, i) => {
      const empty = !data.some((r) => String(r[i] ?? '').trim());
      const k = norm(hd);
      let t = k && saved[k];
      if (t && t.startsWith('col:') && !hd) t = null;
      if (!t) t = empty ? 'skip' : (GUESS.find(([, re]) => re.test(k))?.[0]);
      if (!t) {
        const ex = existing.find((n) => norm(n) === k);
        t = ex ? 'col:' + ex : hd ? 'col:' + hd : (used.has('title') ? 'skip' : 'title');
      }
      if (!t.startsWith('col:') && t !== 'skip') { if (used.has(t)) t = 'skip'; else used.add(t); }
      return t;
    });
    draw();
  }

  function draw() {
    const sheet = st.src.sheets[st.sheet];
    const rows = sheet.rows;
    const width = rows.reduce((a, r) => Math.max(a, r.length), 0);
    const headers = Array.from({ length: width }, (_, i) => (st.header ? String(rows[0]?.[i] ?? '').trim() : '') || `Spalte ${String.fromCharCode(65 + (i % 26))}${i >= 26 ? Math.floor(i / 26) : ''}`);
    const data = st.header ? rows.slice(1) : rows;
    const existing = (opts.rundown && st.mode === 'append' ? opts.rundown.columns : []).map((c) => c.name);
    const res = convert(data, st.map, st);
    const items = res.items;
    const startSec = st.mode === 'append' ? null : (st.newStart ? cellClock(st.newStart) : res.firstStart ?? 36000);

    const targetOptions = (i) => {
      const cur = st.map[i];
      const colNames = [...new Set([...existing, ...st.map.filter((x) => x.startsWith('col:')).map((x) => x.slice(4)), headers[i]])];
      return [
        ...FIELDS.map(([v, l]) => h('option', { value: v, selected: cur === v }, l)),
        h('optgroup', { label: 'Eigene Spalte' }, colNames.map((n) => h('option', { value: 'col:' + n, selected: cur === 'col:' + n }, (existing.includes(n) ? 'Spalte „' : 'Neue Spalte „') + n + '“'))),
      ];
    };
    const setMap = (i, v) => {
      if (!v.startsWith('col:') && v !== 'skip') st.map = st.map.map((x, j) => (j !== i && x === v ? 'skip' : x));
      st.map[i] = v;
      draw();
    };
    const sample = (i) => data.map((r) => String(r[i] ?? '').trim()).filter(Boolean).slice(0, 3);

    const mapping = h('div', { class: 'imp-map' }, headers.map((hd, i) => h('div', { class: 'imp-map-row' + (st.map[i] === 'skip' ? ' off' : '') },
      h('div', { class: 'imp-src' }, h('b', null, hd), h('span', null, sample(i).map((x) => x.length > 28 ? x.slice(0, 27) + '…' : x).join(' · ') || 'leer')),
      icon('arrowLeft', 'imp-arrow'),
      h('select', { class: 'input', onchange: (e) => setMap(i, e.target.value) }, targetOptions(i)))));

    // Vorschau
    const sched = computeSchedule(items.map((x, i) => ({ ...x, id: i })), startSec ?? 0);
    const newCols = [...new Set(st.map.filter((x) => x.startsWith('col:')).map((x) => x.slice(4)).filter((n) => !existing.some((e) => norm(e) === norm(n))))];
    const nItems = items.filter((x) => x.type === 'item').length, nBlocks = items.filter((x) => x.type === 'block').length;
    const PREV = 14;
    const preview = h('div', { class: 'imp-prev' },
      h('table', null,
        h('thead', null, h('tr', null, h('th', null, 'Start'), h('th', null, 'Dauer'), h('th', null, 'Titel'), h('th', null, 'Weitere Felder'))),
        h('tbody', null, items.slice(0, PREV).map((it, i) => {
          const s = sched.map.get(i);
          if (it.type === 'block_end') return h('tr', { class: 'be' }, h('td', { colspan: 4 }, '— Block-Ende —'));
          const extra = [it.description && 'Beschreibung', it.script && 'Skript', ...Object.keys(it.cells)].filter(Boolean);
          return h('tr', { class: it.type, style: it.color ? `--c:${it.color}` : null },
            h('td', { class: 'num' }, startSec != null ? fmtClock(s.start) : ''),
            h('td', { class: 'num' }, it.type === 'item' ? fmtDuration(it.duration) : ''),
            h('td', null, it.type === 'block' ? h('span', { class: 'imp-blk' }, 'Block') : null, it.title || h('i', { class: 'muted' }, 'ohne Titel')),
            h('td', { class: 'muted' }, extra.join(', ')));
        }))),
      items.length > PREV ? h('div', { class: 'imp-more' }, `… und ${items.length - PREV} weitere Zeilen`) : null);

    const warns = [];
    if (!st.map.includes('title')) warns.push('Keine Spalte als „Titel“ zugeordnet.');
    if (res.warn.badDur) warns.push(`${res.warn.badDur} Dauer-Angabe(n) nicht lesbar – dort wird 00:00 eingetragen.`);
    if (res.warn.derived) warns.push(`${res.warn.derived} Dauer(n) aus Start-/Endzeiten berechnet.`);

    // Ziel
    const today = new Date().toISOString().slice(0, 10);
    st.newTitle ??= (st.src.name || 'Import').replace(/\.(xlsx|csv|txt|tsv)$/i, '');
    const target = h('div', { class: 'imp-target' },
      opts.rundown && opts.canCreate ? h('div', { class: 'seg seg-wide' },
        h('button', { class: st.mode === 'append' ? 'sel' : '', onclick: () => { st.mode = 'append'; draw(); } }, icon('listPlus'), `An „${opts.rundown.rundown.title}“ anhängen`),
        h('button', { class: st.mode === 'new' ? 'sel' : '', onclick: () => { st.mode = 'new'; draw(); } }, icon('plus'), 'Als neuen Rundown anlegen')) : null,
      st.mode === 'new' ? h('div', { class: 'imp-new' },
        h('label', { class: 'field' }, h('span', null, 'Titel'), h('input', { class: 'input', value: st.newTitle, oninput: (e) => { st.newTitle = e.target.value; } })),
        h('label', { class: 'field' }, h('span', null, 'Datum'), h('input', { class: 'input', type: 'date', value: st.newDate ?? today, onchange: (e) => { st.newDate = e.target.value; } })),
        h('label', { class: 'field' }, h('span', null, 'Startzeit'), h('input', { class: 'input', type: 'time', value: st.newStart ?? (res.firstStart != null ? fmtClock(res.firstStart, false) : '10:00'), onchange: (e) => { st.newStart = e.target.value; draw(); } })))
        : h('p', { class: 'hint' }, `Die Zeilen werden am Ende von „${opts.rundown.rundown.title}“ angefügt. Bestehende Programmpunkte bleiben unverändert.`));

    body.replaceChildren(
      h('div', { class: 'imp-file' }, icon('list'), h('b', null, st.src.name),
        st.src.sheets.length > 1 ? h('select', { class: 'input', onchange: (e) => { st.sheet = Number(e.target.value); setup(); } }, st.src.sheets.map((s, i) => h('option', { value: i, selected: i === st.sheet }, s.name))) : null,
        h('button', { class: 'btn ghost sm', onclick: () => { st.src = null; st.newTitle = undefined; stepSource(); } }, 'Andere Datei')),
      h('div', { class: 'imp-opts' },
        h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: st.header, onchange: (e) => { st.header = e.target.checked; setup(); } }), 'Erste Zeile enthält Überschriften'),
        h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: st.detectBlocks, onchange: (e) => { st.detectBlocks = e.target.checked; draw(); } }), 'Zeilen nur mit Titel als Block erkennen')),
      h('div', { class: 'imp-h' }, 'Spalten zuordnen'),
      mapping,
      h('div', { class: 'imp-h' }, 'Vorschau ', h('span', { class: 'muted' }, `${nItems} Programmpunkt${nItems === 1 ? '' : 'e'} · ${nBlocks} ${nBlocks === 1 ? 'Block' : 'Blöcke'} · Gesamt ${fmtDuration(sched.total)}${newCols.length ? ` · ${newCols.length} neue Spalte${newCols.length > 1 ? 'n' : ''}` : ''}`)),
      warns.length ? h('div', { class: 'imp-warn' }, warns.map((w) => h('div', null, icon('alert'), w))) : null,
      preview,
      h('div', { class: 'imp-h' }, 'Ziel'),
      target);
    m.el.querySelector('.imp-go').disabled = !items.length;
    m.el.querySelector('.imp-go').textContent = items.length ? `${items.length} Zeilen importieren` : 'Importieren';
  }

  async function run() {
    if (!st.src) { toast('Bitte zuerst eine Datei auswählen', 'err'); return false; }
    const rows = st.src.sheets[st.sheet].rows;
    const { items } = convert(st.header ? rows.slice(1) : rows, st.map, st);
    if (!items.length) { toast('Keine Zeilen zum Importieren', 'err'); return false; }
    // Zuordnung für das nächste Mal merken (nach Spaltenüberschrift)
    if (st.header) {
      const saved = loadMap();
      rows[0]?.forEach((hd, i) => { const k = norm(hd); if (k && st.map[i]) saved[k] = st.map[i]; });
      saveMap(saved);
    }
    const payload = {
      columns: [...new Set(st.map.filter((x) => x.startsWith('col:')).map((x) => x.slice(4)))],
      items: items.map(({ type, title, duration, description, script, color, cells }) => ({ type, title, duration, description, script, color, cells })),
    };
    const btn = m.el.querySelector('.imp-go');
    btn.disabled = true;
    try {
      let r;
      if (st.mode === 'new') {
        if (!String(st.newTitle || '').trim()) throw new Error('Bitte einen Titel für den neuen Rundown angeben');
        const startIn = m.el.querySelector('.imp-new input[type=time]')?.value;
        const dateIn = m.el.querySelector('.imp-new input[type=date]')?.value;
        r = await opts.api('POST', '/api/rundowns/import', { ...payload, rundown: { title: st.newTitle.trim(), event_date: dateIn || null, start_time: startIn || '10:00' } });
      } else {
        r = await opts.api('POST', `/api/rundowns/${opts.rundown.rundown.id}/import`, payload);
      }
      toast(`${r.added} Zeilen importiert${r.newColumns ? ` · ${r.newColumns} neue Spalte${r.newColumns > 1 ? 'n' : ''}` : ''}`, 'ok');
      opts.onDone?.({ ...r, mode: st.mode });
      return true;
    } catch (e) { toast(e.message, 'err'); btn.disabled = false; return false; }
  }

  m = modal({
    title: opts.rundown ? 'Importieren' : 'Rundown importieren',
    wide: true,
    body,
    actions: [
      { label: 'Abbrechen', class: 'ghost' },
      { label: 'Importieren', class: 'primary imp-go', onClick: run },
    ],
  });
  m.el.classList.add('imp-modal');
  m.el.querySelector('.imp-go').disabled = true;
  stepSource();
  return m;
}

/* ================================================================== Export */
const TYPE_LABEL = { item: 'Punkt', block: 'Block', block_end: 'Block-Ende' };
const fileName = (title, ext) => `${String(title || 'Rundown').replace(/[\\/:*?"<>|]+/g, ' ').trim()}.${ext}`;

function exportTable(data) {
  const start = (() => { const p = String(data.rundown.start_time || '0:0').split(':'); return Number(p[0]) * 3600 + Number(p[1] || 0) * 60 + Number(p[2] || 0); })();
  const sched = computeSchedule(data.items, start);
  const cols = data.columns;
  const head = ['Nr', 'Typ', 'Start', 'Ende', 'Dauer', 'Titel', 'Beschreibung', 'Skript', 'Farbe', ...cols.map((c) => c.name)];
  const blocks = new Set();
  const rows = data.items.map((it, i) => {
    const s = sched.map.get(it.id);
    if (it.type !== 'item') blocks.add(i);
    if (it.type === 'block_end') return ['', TYPE_LABEL.block_end, '', '', '', '', '', '', '', ...cols.map(() => '')];
    return [
      it.type === 'item' ? String(s.nr) : '',
      TYPE_LABEL[it.type],
      fmtClock(s.start),
      fmtClock(s.end),
      it.type === 'item' ? fmtDuration(it.duration) : fmtDuration(s.duration),
      it.title, it.description, it.script || '', it.color || '',
      ...cols.map((c) => it.cells?.[c.id] ?? ''),
    ];
  });
  return { head, rows, blocks };
}

export function exportCsv(data) {
  const { head, rows } = exportTable(data);
  download(fileName(data.rundown.title, 'csv'), toCsv([head, ...rows]), 'text/csv;charset=utf-8');
}

export function exportXlsx(data) {
  const { head, rows, blocks } = exportTable(data);
  const W = { Nr: 6, Typ: 11, Start: 9, Ende: 9, Dauer: 9, Titel: 36, Beschreibung: 36, Skript: 48, Farbe: 10 };
  const wrap = new Set(['Titel', 'Beschreibung', 'Skript']);
  const columns = head.map((t, i) => ({ title: t, width: W[t] && i < 9 ? W[t] : 22, wrap: i < 9 ? wrap.has(t) : true }));
  download(fileName(data.rundown.title, 'xlsx'), writeXlsx([{ name: 'Rundown', columns, rows, blockRows: blocks }]), XLSX_TYPE);
}

export function downloadTemplate() {
  const head = ['Start', 'Dauer', 'Titel', 'Beschreibung', 'Typ', 'Farbe', 'Skript', 'Notizen', 'GFX', 'Ton'];
  const rows = [
    ['10:00', '', 'Einlass', '', 'Block', 'blau', '', '', '', ''],
    ['10:00', '30:00', 'Countdown', 'Loop auf allen Screens', '', '', '', 'Saal öffnen', 'Countdown-Uhr', 'Musik leise'],
    ['', '', '', '', 'Block-Ende', '', '', '', '', ''],
    ['10:30', '', 'Show', '', 'Block', 'lila', '', '', '', ''],
    ['10:30', '2:00', 'Opener', '', '', '', '', '', 'Opener-Video', 'Video-Ton'],
    ['10:32', '5:00', 'Begrüßung', 'Moderation auf der Bühne', '', '', 'Herzlich willkommen!', 'Gäste: Felix, Anna', 'Bauchbinde Moderation', 'Headset Mod'],
    ['10:37', '1:15:00', 'Hauptprogramm', '', '', 'grün', '', '', '', ''],
    ['', '', '', '', 'Block-Ende', '', '', '', '', ''],
  ];
  const guide = [
    ['Start', 'Uhrzeit des Punkts (z. B. 10:30). Optional – fehlt die Dauer, wird sie aus den Startzeiten berechnet.'],
    ['Dauer', 'mm:ss (5:00 = 5 Minuten) oder h:mm:ss (1:15:00). Auch „5“ (Minuten), „5 min“, „90 sek“.'],
    ['Titel', 'Name des Programmpunkts bzw. des Blocks.'],
    ['Beschreibung', 'Zweite Zeile unter dem Titel.'],
    ['Typ', 'Leer = Programmpunkt · „Block“ = Block-Überschrift · „Block-Ende“ = Block schließen.'],
    ['Farbe', 'z. B. rot, blau, grün, gelb, orange, lila, pink, grau oder ein Farbcode wie #b91c1c.'],
    ['Skript', 'Text für den Prompter.'],
    ['Weitere Spalten', 'Alle anderen Spalten (Notizen, GFX, Ton, Kamera, Licht …) werden als eigene Rundown-Spalten übernommen.'],
    ['', ''],
    ['Tipp', 'Spalten dürfen fehlen oder anders heißen – beim Import kann jede Spalte frei zugeordnet werden.'],
  ];
  const columns = [{ title: 'Start', width: 9 }, { title: 'Dauer', width: 9 }, { title: 'Titel', width: 28, wrap: true }, { title: 'Beschreibung', width: 28, wrap: true }, { title: 'Typ', width: 12 }, { title: 'Farbe', width: 10 }, { title: 'Skript', width: 32, wrap: true }, { title: 'Notizen', width: 22, wrap: true }, { title: 'GFX', width: 22, wrap: true }, { title: 'Ton', width: 18, wrap: true }];
  const blockRows = new Set(rows.map((r, i) => (r[4] ? i : -1)).filter((i) => i >= 0));
  download('FF Rundown Import-Vorlage.xlsx', writeXlsx([
    { name: 'Rundown', columns, rows, blockRows },
    { name: 'Anleitung', columns: [{ title: 'Spalte', width: 18 }, { title: 'Bedeutung', width: 90, wrap: true }], rows: guide, freeze: false },
  ]), XLSX_TYPE);
}
