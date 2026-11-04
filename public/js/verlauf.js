// Änderungsverlauf: Seitenleiste mit allen Änderungen eines Rundowns, Rückgängig pro Eintrag,
// „Stand wiederherstellen“ und Strg+Z / Strg+Umschalt+Z für die eigenen Änderungen.
import { fmtDuration } from '/shared/timing.js';
import { h, icon, toast, confirmDialog, menu, debounce } from '/js/ui.js';

if (!document.querySelector('link[href="/css/verlauf.css"]')) document.head.append(h('link', { rel: 'stylesheet', href: '/css/verlauf.css' }));

const KIND = {
  'item.add': 'Programmpunkt hinzugefügt', 'block.add': 'Block hinzugefügt', 'blockend.add': 'Block-Ende hinzugefügt',
  'item.del': 'Programmpunkt gelöscht', 'block.del': 'Block gelöscht', 'blockend.del': 'Block-Ende gelöscht',
  'item.edit': 'Geändert', order: 'Reihenfolge geändert', 'rd.edit': 'Rundown geändert',
  'col.add': 'Spalte hinzugefügt', 'col.edit': 'Spalte geändert', 'col.del': 'Spalte gelöscht', 'col.order': 'Spalten sortiert',
  import: 'Import', restore: 'Stand wiederhergestellt',
};
const FIELD = { title: 'Titel', description: 'Beschreibung', script: 'Skript', duration: 'Dauer', color: 'Farbe', type: 'Typ', event_date: 'Datum', start_time: 'Startzeit', name: 'Name', is_public: 'Öffentlich' };
const TYPE = { item: 'Programmpunkt', block: 'Block', block_end: 'Block-Ende' };
const COLORS = ['#a78bfa', '#60a5fa', '#34d399', '#fbbf24', '#f472b6', '#22d3ee', '#fb923c', '#a3e635'];
const userColor = (id) => COLORS[Math.abs(Number(id) || 0) % COLORS.length];
const pad = (n) => String(n).padStart(2, '0');
const hhmm = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const short = (v, n = 70) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

export function entryLabel(e) {
  const base = KIND[e.kind] || 'Änderung';
  return (e.flag === 'undo' ? 'Rückgängig: ' : e.flag === 'redo' ? 'Wiederholt: ' : '') + base;
}

function dayLabel(ms) {
  const d = new Date(ms), t = new Date();
  const key = (x) => x.toDateString();
  if (key(d) === key(t)) return 'Heute';
  const y = new Date(t); y.setDate(t.getDate() - 1);
  if (key(d) === key(y)) return 'Gestern';
  return d.toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
}

/** Wert für die Anzeige */
function show(field, v) {
  if (field === 'duration') return fmtDuration(Number(v) || 0);
  if (field === 'color') return v ? h('span', { class: 'hx-sw', style: `--sw:${v}` }) : 'keine';
  if (field === 'type') return TYPE[v] || v;
  if (field === 'is_public') return v ? 'ja' : 'nein';
  if (field === 'event_date' && v) return new Date(v + 'T12:00').toLocaleDateString('de-DE');
  if (field === 'start_time' && v) return v;
  const s = short(v);
  return s ? `„${s}“` : h('i', null, 'leer');
}

/** Detailzeilen eines Eintrags (vorher → nachher) */
function details(e, colName) {
  const lines = [];
  if (e.kind === 'restore' || e.kind === 'import') return lines;
  for (const op of e.ops) {
    if (op.t === 'item' && op.b && op.a && !op.a.full && !op.b.full) {
      for (const k of Object.keys(op.a)) {
        if (k === 'cells') for (const c of Object.keys(op.a.cells || {})) lines.push([colName(c), show('', op.b.cells?.[c]), show('', op.a.cells[c])]);
        else lines.push([FIELD[k] || k, show(k, op.b[k]), show(k, op.a[k])]);
      }
    } else if ((op.t === 'rd' || op.t === 'col') && op.b && op.a && !op.a.full) {
      for (const k of Object.keys(op.a)) lines.push([FIELD[k] || k, show(k, op.b[k]), show(k, op.a[k])]);
    }
  }
  return lines.slice(0, 6);
}

/**
 * ctx: { api, rd(), applyPayload(p), me, flush(), onClose() }
 */
export function openPanel(ctx) {
  const st = { entries: [], more: false, filter: '', retention: 30, loading: false };
  const list = h('div', { class: 'hx-list' });
  const filterSel = h('select', { class: 'input hx-filter', onchange: (e) => { st.filter = e.target.value; draw(); } });
  const sub = h('div', { class: 'hx-sub' });
  const panel = h('aside', { class: 'hx-panel', 'aria-label': 'Änderungsverlauf' },
    h('div', { class: 'hx-head' },
      h('div', { class: 'hx-title' }, icon('history'), h('div', null, h('b', null, 'Verlauf'), sub)),
      h('button', { class: 'icon-btn', title: 'Schließen (Esc)', onclick: () => close() }, icon('x'))),
    h('div', { class: 'hx-tools' }, filterSel,
      h('span', { class: 'hx-keys', title: 'Tastenkürzel außerhalb von Eingabefeldern' }, h('kbd', null, navigator.platform.includes('Mac') ? '⌘Z' : 'Strg+Z'), ' eigene Änderung rückgängig')),
    list);
  document.body.append(panel);
  requestAnimationFrame(() => panel.classList.add('open'));
  const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('.modal-back')) close(); };
  document.addEventListener('keydown', onKey);

  const colName = (id) => ctx.rd()?.columns.find((c) => String(c.id) === String(id))?.name || 'Spalte';

  async function load(more = false) {
    const rd = ctx.rd();
    if (!rd || st.loading) return;
    st.loading = true;
    try {
      const before = more && st.entries.length ? st.entries[st.entries.length - 1].id : '';
      const r = await ctx.api('GET', `/api/rundowns/${rd.rundown.id}/history?limit=80${before ? '&before=' + before : ''}`);
      st.entries = more ? [...st.entries, ...r.entries] : r.entries;
      st.more = r.more; st.retention = r.retention_days;
      draw();
    } catch (e) { toast(e.message, 'err'); }
    finally { st.loading = false; }
  }

  function draw() {
    sub.textContent = st.retention ? `Änderungen der letzten ${st.retention} Tage` : 'Alle Änderungen';
    const people = [...new Map(st.entries.map((e) => [String(e.user_id), e.user_name])).entries()];
    filterSel.replaceChildren(h('option', { value: '' }, 'Alle Personen'), ...people.map(([id, n]) => h('option', { value: id, selected: st.filter === id }, n)));
    const byId = new Map(st.entries.map((e) => [e.id, e]));
    const shown = st.entries.filter((e) => !st.filter || String(e.user_id) === st.filter);
    if (!shown.length) {
      list.replaceChildren(h('div', { class: 'hx-empty' }, icon('history'), h('b', null, 'Noch keine Änderungen'), h('span', null, 'Sobald jemand den Rundown bearbeitet, erscheint es hier.')));
      return;
    }
    const out = [];
    let day = '';
    for (const e of shown) {
      const d = dayLabel(e.at);
      if (d !== day) { day = d; out.push(h('div', { class: 'hx-day' }, d)); }
      const undoneBy = e.undone_by ? byId.get(e.undone_by) : null;
      const redone = undoneBy?.undone_by;
      const lines = details(e, colName);
      const isUndone = !!e.undone_by && !redone;
      out.push(h('div', { class: 'hx-entry' + (isUndone ? ' undone' : '') + (e.flag !== 'do' ? ' meta' : '') },
        h('div', { class: 'hx-av', style: `--uc:${userColor(e.user_id)}`, title: e.user_name }, (e.user_name || '?').trim()[0]?.toUpperCase() || '?'),
        h('div', { class: 'hx-main' },
          h('div', { class: 'hx-top' }, h('b', null, e.user_name || 'Unbekannt'), h('span', { title: new Date(e.at).toLocaleString('de-DE') }, hhmm(e.at))),
          h('div', { class: 'hx-what' }, entryLabel(e), e.target && e.kind !== 'restore' ? h('span', { class: 'hx-target' }, ' · ' + short(e.target, 50)) : e.kind === 'restore' ? h('span', { class: 'hx-target' }, ' · ' + e.target) : null),
          lines.length ? h('div', { class: 'hx-diff' }, lines.map(([f, b, a]) => h('div', null, h('span', { class: 'f' }, f), h('span', { class: 'b' }, b), icon('arrowLeft', 'arr'), h('span', { class: 'a' }, a)))) : null,
          e.kind === 'import' && e.flag === 'do' ? h('div', { class: 'hx-note' }, `${e.ops.filter((o) => o.t === 'item').length} Zeilen, ${e.ops.filter((o) => o.t === 'col').length} neue Spalten`) : null,
          e.kind === 'restore' && e.flag === 'do' ? h('div', { class: 'hx-note' }, 'Alle späteren Änderungen wurden zurückgenommen') : null,
          e.undone_by ? h('div', { class: 'hx-note' }, icon('rotate'), redone ? 'Rückgängig gemacht und wiederholt' : `Rückgängig gemacht${undoneBy ? ' von ' + undoneBy.user_name + ' · ' + hhmm(undoneBy.at) : ''}`) : null),
        h('div', { class: 'hx-act' },
          !e.undone_by ? h('button', { class: 'btn sm ghost', title: 'Diese Änderung rückgängig machen', onclick: () => undoEntry(e) }, icon('rotate'), 'Rückgängig') : null,
          h('button', { class: 'icon-btn', title: 'Mehr', onclick: (ev) => menu(ev.currentTarget, [
            { label: `Stand vor ${hhmm(e.at)} Uhr wiederherstellen …`, icon: 'history', onClick: () => restore(e) },
          ]) }, icon('more')))));
    }
    if (st.more) out.push(h('button', { class: 'btn ghost hx-more', onclick: () => load(true) }, 'Ältere Änderungen laden'));
    list.replaceChildren(...out);
  }

  async function undoEntry(e, force = false) {
    ctx.flush();
    try {
      const r = await ctx.api('POST', `/api/history/${e.id}/undo`, { force });
      ctx.applyPayload(r);
      toast('Rückgängig gemacht', 'ok');
      load();
    } catch (err) {
      if (err.data?.conflict && !force) {
        const by = err.data.conflict.by?.length ? ` (zuletzt von ${err.data.conflict.by.join(', ')})` : '';
        if (await confirmDialog(`${err.message}${by}. Beim Rückgängigmachen wird die spätere Änderung überschrieben.`, { title: 'Seitdem geändert', okLabel: 'Trotzdem rückgängig machen' })) undoEntry(e, true);
      } else toast(err.message, 'err');
    }
  }

  async function restore(e) {
    const later = st.entries.filter((x) => x.id >= e.id).length;
    const ok = await confirmDialog(
      `Der Rundown wird auf den Stand vor ${hhmm(e.at)} Uhr (${dayLabel(e.at)}) zurückgesetzt. ${later > 1 ? `Alle ${later} Änderungen` : 'Die Änderung'} ab diesem Zeitpunkt werden zurückgenommen – auch die von anderen. Vorher wird automatisch ein Backup erstellt; das Zurücksetzen lässt sich außerdem selbst wieder rückgängig machen.`,
      { title: 'Stand wiederherstellen?', okLabel: 'Wiederherstellen', danger: true });
    if (!ok) return;
    ctx.flush();
    try {
      const r = await ctx.api('POST', `/api/history/${e.id}/restore`, {});
      ctx.applyPayload(r);
      toast(`Stand vor ${hhmm(e.at)} Uhr wiederhergestellt`, 'ok');
      load();
    } catch (err) { toast(err.message, 'err'); }
  }

  function close() {
    document.removeEventListener('keydown', onKey);
    panel.classList.remove('open');
    setTimeout(() => panel.remove(), 200);
    ctx.onClose?.();
  }

  load();
  return { refresh: debounce(() => load(), 400), close, el: panel };
}

/** Strg+Z / Strg+Umschalt+Z: eigene letzte Änderung rückgängig machen bzw. wiederholen */
export async function undoOwn(ctx, action, force = false) {
  const rd = ctx.rd();
  if (!rd) return;
  ctx.flush();
  await new Promise((r) => setTimeout(r, 60)); // laufende Speichervorgänge abwarten
  try {
    const r = await ctx.api('POST', `/api/rundowns/${rd.rundown.id}/history/${action}`, { force });
    if (r.nothing) { toast(action === 'undo' ? 'Nichts zum Rückgängigmachen' : 'Nichts zum Wiederholen'); return; }
    ctx.applyPayload(r);
    const what = (KIND[r.entry.kind] || 'Änderung') + (r.entry.target && r.entry.kind !== 'restore' ? ` · ${short(r.entry.target, 40)}` : '');
    toast((action === 'undo' ? 'Rückgängig: ' : 'Wiederholt: ') + what, 'ok');
  } catch (err) {
    if (err.data?.conflict && !force) {
      if (await confirmDialog(`${err.message}. Beim Rückgängigmachen wird die spätere Änderung überschrieben.`, { title: 'Seitdem geändert', okLabel: 'Trotzdem rückgängig machen' })) undoOwn(ctx, action, true);
    } else toast(err.message, 'err');
  }
}
