// Änderungsverlauf mit Rückgängig
//
// Jede inhaltliche Änderung wird als Eintrag mit "Operationen" gespeichert. Eine Operation hält den
// Zustand eines Objekts vorher (b) und nachher (a):
//   { t:'item',  id, b, a }   Programmpunkt/Block – b/a = geänderte Felder, ganze Zeile (full:1) oder null
//   { t:'order', b, a }       Reihenfolge der Punkte (Liste von IDs)
//   { t:'col',   id, b, a }   Spalte
//   { t:'corder', b, a }      Reihenfolge der Spalten
//   { t:'rd',    b, a }       Titel/Datum/Startzeit des Rundowns
// Rückgängig = Operationen rückwärts auf "b" setzen; der Rückgängig-Eintrag enthält die umgekehrten
// Operationen und ist damit selbst wieder umkehrbar. Live-Aktionen werden nicht aufgezeichnet.

import { db, Q, tx, updateRow } from './db.js';

db.exec(`CREATE TABLE IF NOT EXISTS changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rundown_id INTEGER NOT NULL REFERENCES rundowns(id) ON DELETE CASCADE,
  user_id INTEGER,
  user_name TEXT NOT NULL DEFAULT '',
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  ckey TEXT NOT NULL DEFAULT '',
  ops TEXT NOT NULL,
  flag TEXT NOT NULL DEFAULT 'do',
  ref_id INTEGER,
  undone_by INTEGER
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_changes_rd ON changes(rundown_id, id)');
db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');

const H = {
  insert: db.prepare('INSERT INTO changes (rundown_id,user_id,user_name,at,kind,target,ckey,ops,flag,ref_id) VALUES (?,?,?,?,?,?,?,?,?,?)'),
  last: db.prepare('SELECT * FROM changes WHERE rundown_id=? ORDER BY id DESC LIMIT 1'),
  byId: db.prepare('SELECT * FROM changes WHERE id=?'),
  merge: db.prepare('UPDATE changes SET ops=?, at=?, target=? WHERE id=?'),
  setUndone: db.prepare('UPDATE changes SET undone_by=? WHERE id=?'),
  list: db.prepare('SELECT * FROM changes WHERE rundown_id=? AND id<? ORDER BY id DESC LIMIT ?'),
  fromId: db.prepare('SELECT * FROM changes WHERE rundown_id=? AND id>=? ORDER BY id DESC'),
  laterTouching: db.prepare('SELECT * FROM changes WHERE rundown_id=? AND id>? ORDER BY id'),
  lastOwnDo: db.prepare("SELECT * FROM changes WHERE rundown_id=? AND user_id=? AND flag IN ('do','redo') AND undone_by IS NULL ORDER BY id DESC LIMIT 1"),
  lastOwnNew: db.prepare("SELECT MAX(id) AS id FROM changes WHERE rundown_id=? AND user_id=? AND flag='do'"),
  lastOwnUndo: db.prepare("SELECT * FROM changes WHERE rundown_id=? AND user_id=? AND flag='undo' AND undone_by IS NULL AND id>? ORDER BY id DESC LIMIT 1"),
  prune: db.prepare('DELETE FROM changes WHERE at<?'),
  count: db.prepare('SELECT COUNT(*) AS n, MIN(at) AS oldest FROM changes'),
  getS: db.prepare('SELECT value FROM settings WHERE key=?'),
  setS: db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'),
  insItem: db.prepare('INSERT INTO items (id,rundown_id,position,type,title,description,duration,color,cells,script) VALUES (?,?,?,?,?,?,?,?,?,?)'),
  insCol: db.prepare('INSERT INTO columns (id,rundown_id,name,position,is_public) VALUES (?,?,?,?,?)'),
};

const MERGE_MS = 60_000;
export const RETENTIONS = [7, 14, 30, 90, 180, 365, 0]; // Tage, 0 = unbegrenzt
const json = (s, fb) => { try { return JSON.parse(s); } catch { return fb; } };

/* ------------------------------------------------------------------ Einstellungen & Aufräumen */
export function getRetention() {
  const r = H.getS.get('history.retention_days');
  const v = r ? Number(JSON.parse(r.value)) : 30;
  return RETENTIONS.includes(v) ? v : 30;
}
export function setRetention(days) {
  const v = Number(days);
  if (!RETENTIONS.includes(v)) throw new Error('Ungültige Aufbewahrungsdauer');
  H.setS.run('history.retention_days', JSON.stringify(v));
  prune();
  return status();
}
export function prune() {
  const d = getRetention();
  if (d > 0) H.prune.run(Date.now() - d * 86400000);
}
export function status() {
  const c = H.count.get();
  return { retention_days: getRetention(), retentions: RETENTIONS, entries: c.n, oldest: c.oldest };
}
setTimeout(prune, 5000).unref();
setInterval(prune, 6 * 3600 * 1000).unref();

/* ------------------------------------------------------------------ Zustände lesen */
const ITEM_FIELDS = ['type', 'title', 'description', 'script', 'duration', 'color'];
const orderIds = (rid) => Q.itemsByRd.all(rid).map((i) => i.id);
const colOrder = (rid) => Q.colsByRd.all(rid).map((c) => c.id);

/** Komplette Zeile eines Punkts inkl. Position */
export function itemFull(it, ids = orderIds(it.rundown_id)) {
  return { full: 1, type: it.type, title: it.title, description: it.description, script: it.script || '', duration: it.duration, color: it.color, cells: json(it.cells, {}), index: ids.indexOf(it.id) };
}
export function colFull(c, ids = colOrder(c.rundown_id)) {
  return { full: 1, name: c.name, is_public: c.is_public ? 1 : 0, index: ids.indexOf(c.id) };
}

/** Nur die geänderten Felder eines Punkts (vorher/nachher); null, wenn sich nichts ändert */
export function itemDiff(it, upd) {
  const b = {}, a = {};
  for (const k of ITEM_FIELDS) if (upd[k] !== undefined && upd[k] !== it[k] && !(k === 'script' && (upd[k] || '') === (it[k] || ''))) { b[k] = it[k] ?? ''; a[k] = upd[k]; }
  if (upd.cells !== undefined) {
    const oc = json(it.cells, {}), nc = json(upd.cells, {});
    const keys = new Set([...Object.keys(oc), ...Object.keys(nc)]);
    for (const k of keys) {
      if ((oc[k] ?? '') !== (nc[k] ?? '')) { (b.cells ||= {})[k] = oc[k] ?? ''; (a.cells ||= {})[k] = nc[k] ?? ''; }
    }
  }
  return Object.keys(a).length ? { b, a } : null;
}
export function fieldDiff(row, upd, fields) {
  const b = {}, a = {};
  for (const k of fields) if (upd[k] !== undefined && upd[k] !== row[k]) { b[k] = row[k] ?? null; a[k] = upd[k]; }
  return Object.keys(a).length ? { b, a } : null;
}

/* ------------------------------------------------------------------ Aufzeichnen */
const who = (user) => user ? { id: user.id, name: user.name || user.email } : { id: null, name: 'System' };

/**
 * Änderung aufzeichnen. key: gleicher Schlüssel + gleiche Person innerhalb 1 Min. = ein Eintrag.
 */
export function record(rid, user, kind, target, ops, key = '') {
  ops = ops.filter(Boolean);
  if (!ops.length) return null;
  const u = who(user), now = Date.now();
  if (key) {
    const last = H.last.get(rid);
    if (last && last.ckey === key && last.user_id === u.id && last.flag === 'do' && !last.undone_by && now - last.at < MERGE_MS) {
      const old = json(last.ops, []);
      for (const op of ops) {
        const o = old.find((x) => x.t === op.t && x.id === op.id);
        if (!o) { old.push(op); continue; }
        if (op.t === 'order' || op.t === 'corder') { o.a = op.a; continue; }
        o.a = mergeState(o.a, op.a);
        o.b = mergeState(op.b, o.b); // ursprünglicher Vorher-Wert gewinnt
      }
      H.merge.run(JSON.stringify(old), now, String(target || last.target).slice(0, 200), last.id);
      return last.id;
    }
  }
  return Number(H.insert.run(rid, u.id, u.name, now, kind, String(target || '').slice(0, 200), key, JSON.stringify(ops), 'do', null).lastInsertRowid);
}
function mergeState(x, y) {
  if (!x || !y) return y ?? x;
  const out = { ...x, ...y };
  if (x.cells || y.cells) out.cells = { ...(x.cells || {}), ...(y.cells || {}) };
  return out;
}

/* ------------------------------------------------------------------ Anwenden */
let hooks = { beforeDeleteItem: () => {} };
export function setHooks(h) { hooks = { ...hooks, ...h }; }

function placeAt(ids, id, index) {
  const i = ids.indexOf(id);
  if (i >= 0) ids.splice(i, 1);
  ids.splice(Math.max(0, Math.min(index ?? ids.length, ids.length)), 0, id);
  return ids;
}
const resequence = (rid, ids) => ids.forEach((id, pos) => Q.setItemPos.run(pos, id, rid));
const reseqCols = (rid, ids) => ids.forEach((id, pos) => Q.setColPos.run(pos, id, rid));

function reorder(current, wanted) {
  const set = new Set(current);
  const out = wanted.filter((id) => set.has(id));
  const seen = new Set(out);
  current.forEach((id) => { if (!seen.has(id)) out.push(id); });
  return out;
}

/** Objekt in den Zustand `st` versetzen */
function applyState(rid, op, st) {
  if (op.t === 'item') {
    const cur = Q.itemById.get(op.id);
    if (cur && cur.rundown_id !== rid) return;
    if (!st) { if (cur) { hooks.beforeDeleteItem(rid, op.id); Q.deleteItem.run(op.id); } return; }
    if (!cur) {
      if (!st.full) return;
      H.insItem.run(op.id, rid, 0, st.type, st.title, st.description, st.duration, st.color, JSON.stringify(st.cells || {}), st.script || '');
      resequence(rid, placeAt(orderIds(rid).filter((x) => x !== op.id), op.id, st.index));
      return;
    }
    const upd = {};
    for (const k of ITEM_FIELDS) if (st[k] !== undefined) upd[k] = st[k];
    if (st.cells) {
      const cells = st.full ? { ...st.cells } : { ...json(cur.cells, {}), ...st.cells };
      for (const k of Object.keys(cells)) if (cells[k] === '' || cells[k] == null) delete cells[k];
      upd.cells = JSON.stringify(cells);
    }
    updateRow('items', op.id, upd, [...ITEM_FIELDS, 'cells']);
    if (st.full && st.index != null) resequence(rid, placeAt(orderIds(rid), op.id, st.index));
  } else if (op.t === 'order') {
    resequence(rid, reorder(orderIds(rid), st || []));
  } else if (op.t === 'col') {
    const cur = Q.colById.get(op.id);
    if (cur && cur.rundown_id !== rid) return;
    if (!st) { if (cur) Q.deleteCol.run(op.id); return; }
    if (!cur) {
      if (!st.full) return;
      H.insCol.run(op.id, rid, st.name, 0, st.is_public ? 1 : 0);
      reseqCols(rid, placeAt(colOrder(rid).filter((x) => x !== op.id), op.id, st.index));
      return;
    }
    const upd = {};
    if (st.name !== undefined) upd.name = st.name;
    if (st.is_public !== undefined) upd.is_public = st.is_public ? 1 : 0;
    updateRow('columns', op.id, upd, ['name', 'is_public']);
  } else if (op.t === 'corder') {
    reseqCols(rid, reorder(colOrder(rid), st || []));
  } else if (op.t === 'rd') {
    updateRow('rundowns', rid, st || {}, ['title', 'event_date', 'start_time']);
  }
}

/** Weicht der aktuelle Zustand vom "Nachher" der Operation ab? -> Beschreibung des Konflikts.
 *  seen: bereits geprüfte Felder (bei mehreren Operationen zählt nur die letzte pro Feld) */
function conflictOf(rid, op, seen) {
  const key = op.t + ':' + (op.id ?? '');
  if (op.t !== 'item') { if (seen.has(key)) return null; seen.add(key); }
  else if (!op.a) { if (seen.has(key + ':gone')) return null; seen.add(key + ':gone'); }
  else {
    // Punkt: Felder einzeln, damit frühere Zwischenstände nicht als Konflikt zählen
    const fresh = {};
    for (const k of Object.keys(op.a)) {
      if (k === 'cells') { for (const c of Object.keys(op.a.cells || {})) if (!seen.has(key + ':c' + c)) { seen.add(key + ':c' + c); (fresh.cells ||= {})[c] = op.a.cells[c]; } }
      else if (!seen.has(key + ':' + k)) { seen.add(key + ':' + k); fresh[k] = op.a[k]; }
    }
    if (seen.has(key + ':gone')) return null;
    op = { ...op, a: fresh };
  }
  const st = op.a;
  if (op.t === 'item') {
    const cur = Q.itemById.get(op.id);
    if (!st) return cur ? null : null;
    if (!cur) return `„${st.title || op.title || 'Punkt'}“ wurde inzwischen gelöscht`;
    for (const k of ITEM_FIELDS) if (st[k] !== undefined && (st[k] ?? '') !== (cur[k] ?? '')) return `„${cur.title || 'Punkt'}“ wurde seitdem geändert`;
    if (st.cells) { const cc = json(cur.cells, {}); for (const [k, v] of Object.entries(st.cells)) if ((cc[k] ?? '') !== (v ?? '')) return `„${cur.title || 'Punkt'}“ wurde seitdem geändert`; }
  } else if (op.t === 'order') {
    const cur = orderIds(rid).filter((id) => (st || []).includes(id));
    if (cur.join() !== (st || []).filter((id) => cur.includes(id)).join()) return 'Die Reihenfolge wurde seitdem geändert';
  } else if (op.t === 'col') {
    const cur = Q.colById.get(op.id);
    if (!st) return null;
    if (!cur) return `Spalte „${st.name || ''}“ wurde inzwischen gelöscht`;
    if (st.name !== undefined && st.name !== cur.name) return `Spalte „${cur.name}“ wurde seitdem umbenannt`;
  } else if (op.t === 'rd') {
    const rd = Q.rdById.get(rid);
    for (const k of Object.keys(st || {})) if ((st[k] ?? null) !== (rd[k] ?? null)) return 'Titel, Datum oder Startzeit wurden seitdem geändert';
  }
  return null;
}

const inverse = (ops) => ops.slice().reverse().map((o) => ({ ...o, b: o.a, a: o.b }));
const FLAG_AFTER = { do: 'undo', redo: 'undo', undo: 'redo' };

/** Einen Eintrag rückgängig machen. Liefert {id} oder wirft {conflict:[…]} */
export function undo(entry, user, { force = false } = {}) {
  if (entry.undone_by) throw Object.assign(new Error('Diese Änderung wurde bereits rückgängig gemacht'), { status: 409 });
  const ops = json(entry.ops, []);
  const rid = entry.rundown_id;
  if (!force) {
    const seen = new Set();
    const conflicts = [...new Set(ops.slice().reverse().map((o) => conflictOf(rid, o, seen)).filter(Boolean))];
    if (conflicts.length) {
      const later = H.laterTouching.all(rid, entry.id).filter((e) => e.user_id !== null);
      const names = [...new Set(later.map((e) => e.user_name))];
      throw Object.assign(new Error(conflicts.slice(0, 3).join(' · ')), { status: 409, conflict: { messages: conflicts, by: names } });
    }
  }
  return tx(() => {
    for (const op of ops.slice().reverse()) applyState(rid, op, op.b);
    const u = who(user);
    const id = Number(H.insert.run(rid, u.id, u.name, Date.now(), entry.kind, entry.target, '', JSON.stringify(inverse(ops)), FLAG_AFTER[entry.flag] || 'undo', entry.id).lastInsertRowid);
    H.setUndone.run(id, entry.id);
    return id;
  });
}

/** Eigene letzte Änderung rückgängig (Strg+Z) bzw. wiederholen (Strg+Umschalt+Z) */
export function findOwn(rid, userId, action) {
  if (action === 'undo') return H.lastOwnDo.get(rid, userId) || null;
  const lastNew = H.lastOwnNew.get(rid, userId)?.id || 0;
  return H.lastOwnUndo.get(rid, userId, lastNew) || null;
}

/** Stand vor diesem Eintrag wiederherstellen: alle Einträge ab hier rückwärts zurücksetzen */
export function restoreBefore(entry, user) {
  const rid = entry.rundown_id;
  const all = H.fromId.all(rid, entry.id);
  if (!all.length) return null;
  return tx(() => {
    const applied = [];
    for (const e of all) {
      const ops = json(e.ops, []);
      for (const op of ops.slice().reverse()) { applyState(rid, op, op.b); applied.push({ ...op, b: op.a, a: op.b }); }
    }
    const u = who(user);
    const when = new Date(entry.at);
    const id = Number(H.insert.run(rid, u.id, u.name, Date.now(), 'restore', `Stand vor ${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')} Uhr`, '', JSON.stringify(applied), 'do', entry.id).lastInsertRowid);
    for (const e of all) if (!e.undone_by) H.setUndone.run(id, e.id);
    return { id, count: all.length };
  });
}

/* ------------------------------------------------------------------ Liste */
export function list(rid, { before = Number.MAX_SAFE_INTEGER, limit = 80 } = {}) {
  const rows = H.list.all(rid, before, limit + 1);
  const more = rows.length > limit;
  return {
    entries: rows.slice(0, limit).map((e) => ({ id: e.id, at: e.at, user_id: e.user_id, user_name: e.user_name, kind: e.kind, target: e.target, ops: json(e.ops, []), flag: e.flag, ref_id: e.ref_id, undone_by: e.undone_by })),
    more,
    retention_days: getRetention(),
  };
}
export const getEntry = (id) => H.byId.get(Number(id)) || null;
