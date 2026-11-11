// Automatische Backups der SQLite-Datenbank
//
// - Konsistente Schnappschüsse per "VACUUM INTO" (auch während der Server läuft)
// - Ablage in data/backups/ (oder BACKUP_DIR, z. B. USB-Stick / NAS-Freigabe), nur für den Server lesbar
// - Zeitplan + Aufbewahrung einstellbar (Tabelle settings, Umgebungsvariablen haben Vorrang)
// - Wiederherstellen: Datei wird geprüft, aktueller Stand vorher gesichert, dann Neustart (Exit-Code 75)

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { db, DATA_DIR } from './db.js';

export const BACKUP_DIR = path.resolve(process.env.BACKUP_DIR || path.join(DATA_DIR, 'backups'));
export const RESTORE_PENDING = path.join(DATA_DIR, 'restore-pending.db');
export const RESTART_EXIT_CODE = 75;

const NAME_RE = /^ffr-(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})_(auto|manuell|vor-wiederherstellung|vor-loeschen|upload)(?:_([a-z0-9-]{1,40}))?(?:\.(\d+))?\.db$/;
export const KIND_LABEL = {
  auto: 'Automatisch', manuell: 'Manuell', 'vor-wiederherstellung': 'Vor Wiederherstellung',
  'vor-loeschen': 'Vor dem Löschen', upload: 'Hochgeladen',
};
// Aufbewahrung: automatische Arten werden nach "keep" gekürzt, Sicherheits-Backups separat, manuelle nie automatisch
const PRUNE = { auto: 'keep', 'vor-loeschen': 20, 'vor-wiederherstellung': 10 };
export const INTERVALS = [1, 3, 6, 12, 24, 48, 168];
export const KEEPS = [7, 14, 30, 60, 100];

db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
const getS = db.prepare('SELECT value FROM settings WHERE key=?');
const setS = db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');

const envNum = (k) => (process.env[k] !== undefined && process.env[k] !== '' && Number.isFinite(Number(process.env[k])) ? Number(process.env[k]) : null);
export const ENV_LOCKED = {
  enabled: process.env.BACKUP_ENABLED !== undefined,
  interval_hours: envNum('BACKUP_INTERVAL_HOURS') !== null,
  keep: envNum('BACKUP_KEEP') !== null,
};

export function getSettings() {
  const raw = (k, d) => { const r = getS.get('backup.' + k); return r ? JSON.parse(r.value) : d; };
  return {
    enabled: ENV_LOCKED.enabled ? !/^(0|false|no|off)$/i.test(process.env.BACKUP_ENABLED) : raw('enabled', true),
    interval_hours: envNum('BACKUP_INTERVAL_HOURS') ?? raw('interval_hours', 6),
    keep: envNum('BACKUP_KEEP') ?? raw('keep', 30),
  };
}

export function saveSettings(input) {
  const cur = getSettings();
  if (input.enabled !== undefined && !ENV_LOCKED.enabled) setS.run('backup.enabled', JSON.stringify(!!input.enabled));
  if (input.interval_hours !== undefined && !ENV_LOCKED.interval_hours) {
    const v = Number(input.interval_hours);
    if (!INTERVALS.includes(v)) throw Object.assign(new Error('Ungültiges Intervall'), { status: 400 });
    setS.run('backup.interval_hours', JSON.stringify(v));
  }
  if (input.keep !== undefined && !ENV_LOCKED.keep) {
    const v = Number(input.keep);
    if (!KEEPS.includes(v)) throw Object.assign(new Error('Ungültige Anzahl'), { status: 400 });
    setS.run('backup.keep', JSON.stringify(v));
  }
  const next = getSettings();
  if (next.keep !== cur.keep) prune();
  return next;
}

function ensureDir() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') { try { fs.chmodSync(BACKUP_DIR, 0o700); } catch { /* fremdes Laufwerk */ } }
}

const pad = (n) => String(n).padStart(2, '0');
function stamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}
export function slug(s) {
  return String(s || '').toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

/** Prüft eine Backup-Datei: SQLite, unbeschädigt, enthält Benutzer + mindestens einen Admin */
export function inspect(file) {
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  fs.closeSync(fd);
  if (head.toString('latin1') !== 'SQLite format 3\u0000') throw Object.assign(new Error('Keine gültige FF-Rundown-Backupdatei (kein SQLite-Format)'), { status: 400 });
  let b;
  try {
    b = new DatabaseSync(file, { readOnly: true });
    const ok = b.prepare('PRAGMA integrity_check').get();
    if (Object.values(ok)[0] !== 'ok') throw new Error('Datei ist beschädigt');
    const t = new Set(b.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
    for (const need of ['users', 'rundowns', 'items', 'columns']) if (!t.has(need)) throw new Error(`Tabelle „${need}“ fehlt – keine FF-Rundown-Datenbank`);
    const users = b.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    const admins = b.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin'").get().n;
    const rundowns = b.prepare('SELECT COUNT(*) AS n FROM rundowns').get().n;
    const items = b.prepare("SELECT COUNT(*) AS n FROM items WHERE type='item'").get().n;
    if (!admins) throw new Error('Backup enthält keinen Admin – Wiederherstellen würde dich aussperren');
    return { users, admins, rundowns, items };
  } catch (e) {
    throw Object.assign(new Error(e.message.startsWith('Backup') || e.message.startsWith('Tabelle') || e.message.startsWith('Datei') ? e.message : 'Datei kann nicht gelesen werden: ' + e.message), { status: 400 });
  } finally {
    try { b?.close(); } catch { /* */ }
  }
}

const infoCache = new Map();
function describe(name) {
  const m = name.match(NAME_RE);
  if (!m) return null;
  const file = path.join(BACKUP_DIR, name);
  const st = fs.statSync(file);
  const key = name + ':' + st.mtimeMs + ':' + st.size;
  let summary = infoCache.get(key);
  if (summary === undefined) {
    try { summary = inspect(file); } catch { summary = null; }
    infoCache.set(key, summary);
  }
  const [, d, hh, mm, ss, kind, label] = m;
  return {
    name, kind, kind_label: KIND_LABEL[kind], label: label ? label.replace(/-/g, ' ') : '',
    created_at: new Date(`${d}T${hh}:${mm}:${ss}`).getTime(), size: st.size, summary, valid: !!summary,
  };
}

export function list() {
  ensureDir();
  return fs.readdirSync(BACKUP_DIR).filter((n) => NAME_RE.test(n)).map(describe).filter(Boolean).sort((a, b) => b.created_at - a.created_at);
}

export function fileFor(name) {
  if (!NAME_RE.test(String(name))) throw Object.assign(new Error('Ungültiger Dateiname'), { status: 400 });
  const file = path.join(BACKUP_DIR, name);
  if (!fs.existsSync(file)) throw Object.assign(new Error('Backup nicht gefunden'), { status: 404 });
  return file;
}

let lastError = null;
/** Neues Backup erstellen */
export function create(kind = 'manuell', label = '') {
  ensureDir();
  const s = slug(label);
  const base = `ffr-${stamp()}_${kind}${s ? '_' + s : ''}`;
  let name = base + '.db';
  for (let i = 2; fs.existsSync(path.join(BACKUP_DIR, name)); i++) name = `${base}.${i}.db`;
  const file = path.join(BACKUP_DIR, name);
  try {
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    if (process.platform !== 'win32') { try { fs.chmodSync(file, 0o600); } catch { /* */ } }
    lastError = null;
  } catch (e) {
    lastError = { at: Date.now(), message: e.message };
    throw Object.assign(new Error('Backup fehlgeschlagen: ' + e.message), { status: 500 });
  }
  prune();
  return describe(name);
}

export function remove(name) {
  fs.unlinkSync(fileFor(name));
}

/** Alte automatische Backups entfernen */
export function prune() {
  const keep = getSettings().keep;
  const all = list();
  for (const [kind, rule] of Object.entries(PRUNE)) {
    const limit = rule === 'keep' ? keep : rule;
    all.filter((b) => b.kind === kind).slice(limit).forEach((b) => { try { fs.unlinkSync(path.join(BACKUP_DIR, b.name)); } catch { /* */ } });
  }
}

/** Hochgeladene Datei prüfen und als Backup ablegen */
export function importUpload(buf, originalName = '') {
  ensureDir();
  const tmp = path.join(BACKUP_DIR, `.upload-${process.pid}-${Date.now()}.tmp`);
  fs.writeFileSync(tmp, buf, { mode: 0o600 });
  try {
    inspect(tmp);
    const name = `ffr-${stamp()}_upload${slug(originalName.replace(/\.db$/i, '')) ? '_' + slug(originalName.replace(/\.db$/i, '')) : ''}.db`;
    fs.renameSync(tmp, path.join(BACKUP_DIR, name));
    return describe(name);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* */ }
    throw e;
  }
}

/** Wiederherstellung vorbereiten: prüfen, aktuellen Stand sichern, Datei bereitlegen */
export function prepareRestore(name) {
  const file = fileFor(name);
  const summary = inspect(file);
  const safety = create('vor-wiederherstellung');
  fs.copyFileSync(file, RESTORE_PENDING);
  if (process.platform !== 'win32') { try { fs.chmodSync(RESTORE_PENDING, 0o600); } catch { /* */ } }
  return { summary, safety };
}

export function status() {
  const s = getSettings();
  const all = list();
  const lastAuto = all.find((b) => b.kind === 'auto');
  const last = all[0] || null;
  const base = lastAuto ? lastAuto.created_at : bootAt;
  let free = null;
  try { const st = fs.statfsSync(BACKUP_DIR); free = Number(st.bavail) * Number(st.bsize); } catch { /* ältere Node-Version */ }
  return {
    settings: s, env_locked: ENV_LOCKED, intervals: INTERVALS, keeps: KEEPS,
    dir: BACKUP_DIR, dir_is_default: !process.env.BACKUP_DIR, free_bytes: free,
    count: all.length, total_bytes: all.reduce((a, b) => a + b.size, 0),
    last, last_auto: lastAuto || null,
    next_at: s.enabled ? Math.max(Date.now(), base + s.interval_hours * 3600e3) : null,
    last_error: lastError,
  };
}

/* ---------- Zeitplan */
const bootAt = Date.now();
let timer = null;
/** onError(err) wird bei einer Fehlerserie einmal aufgerufen, danach höchstens alle 24 h erneut */
export function startScheduler(log = console.log, onError = null) {
  let alertedAt = 0;
  const tick = () => {
    try {
      const s = getSettings();
      if (!s.enabled) return;
      const lastAuto = list().find((b) => b.kind === 'auto');
      const due = !lastAuto || Date.now() - lastAuto.created_at >= s.interval_hours * 3600e3;
      if (due) { const b = create('auto'); log(`  Backup erstellt: ${b.name}`); alertedAt = 0; }
    } catch (e) {
      const msg = e.message.replace(/^Backup fehlgeschlagen: /, '');
      lastError = { at: Date.now(), message: msg };
      console.error('  Backup-Fehler:', msg);
      if (onError && Date.now() - alertedAt >= 24 * 3600e3) {
        alertedAt = Date.now();
        try { onError(lastError); } catch (err) { console.error('  Backup-Warnung nicht versendet:', err.message); }
      }
    }
  };
  setTimeout(tick, 15000).unref();          // kurz nach dem Start (fehlt ein aktuelles Backup?)
  timer = setInterval(tick, 60000);          // danach minütlich prüfen
  timer.unref();
}
