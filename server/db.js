const [NODE_MAJOR, NODE_MINOR] = process.versions.node.split('.').map(Number);
if (NODE_MAJOR < 22 || (NODE_MAJOR === 22 && NODE_MINOR < 13)) {
  console.error(`\n  FF Rundown benötigt Node.js 22.13 oder neuer (gefunden: ${process.version}).\n  Download: https://nodejs.org\n`);
  process.exit(1);
}
const { DatabaseSync } = await import('node:sqlite');
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));

// Datenschutz: Alles, was der Server neu anlegt (Datenbank, WAL-/SHM-Dateien, Schlüssel, Logs),
// ist nur für den Benutzer lesbar, unter dem der Server läuft.
process.umask(0o077);
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

/** Bestehende Rechte nachziehen (z. B. nach einem Update von einer älteren Version) */
export function secureDataDir() {
  if (process.platform === 'win32') return; // Windows nutzt ACLs statt Unix-Rechte
  const fix = (p, mode) => {
    try {
      const st = fs.statSync(p);
      if ((st.mode & 0o777) !== mode) fs.chmodSync(p, mode);
    } catch (e) {
      if (e.code !== 'ENOENT') console.warn(`  Hinweis: Rechte für ${p} konnten nicht gesetzt werden (${e.code}).`);
    }
  };
  fix(DATA_DIR, 0o700);
  for (const f of fs.readdirSync(DATA_DIR)) {
    const p = path.join(DATA_DIR, f);
    try { fix(p, fs.statSync(p).isDirectory() ? 0o700 : 0o600); } catch { /* */ }
  }
}

// Wiederherstellung aus einem Backup (vom Admin angestoßen, wird beim Start übernommen)
{
  const pending = path.join(DATA_DIR, 'restore-pending.db');
  if (fs.existsSync(pending)) {
    const dbFile = path.join(DATA_DIR, 'rundown.db');
    for (const ext of ['-wal', '-shm']) { try { fs.unlinkSync(dbFile + ext); } catch { /* */ } }
    fs.renameSync(pending, dbFile);
    console.log('\n  ✓ Backup wurde wiederhergestellt.');
  }
}

export const db = new DatabaseSync(path.join(DATA_DIR, 'rundown.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
secureDataDir();

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  token_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login TEXT
);
CREATE TABLE IF NOT EXISTS rundowns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  event_date TEXT,
  start_time TEXT NOT NULL DEFAULT '10:00',
  public_token TEXT NOT NULL UNIQUE,
  public_enabled INTEGER NOT NULL DEFAULT 0,
  companion_token TEXT NOT NULL UNIQUE,
  live TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS columns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rundown_id INTEGER NOT NULL REFERENCES rundowns(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  is_public INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rundown_id INTEGER NOT NULL REFERENCES rundowns(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  type TEXT NOT NULL DEFAULT 'item',
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  duration INTEGER NOT NULL DEFAULT 0,
  color TEXT NOT NULL DEFAULT '',
  cells TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_items_rd ON items(rundown_id, position);
CREATE INDEX IF NOT EXISTS idx_cols_rd ON columns(rundown_id, position);
`);

// Migrationen für neuere Versionen
for (const sql of [
  'ALTER TABLE rundowns ADD COLUMN companion_rotated_at TEXT',
  'ALTER TABLE rundowns ADD COLUMN companion_rotated_by TEXT',
  'ALTER TABLE users ADD COLUMN must_change INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE users ADD COLUMN restricted INTEGER NOT NULL DEFAULT 0',
]) { try { db.exec(sql); } catch { /* Spalte existiert bereits */ } }

// Freigaben einzelner Rundowns für einzelne Benutzer (z. B. externe Dienstleister)
db.exec(`CREATE TABLE IF NOT EXISTS rundown_access (
  rundown_id INTEGER NOT NULL REFERENCES rundowns(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (rundown_id, user_id)
)`);

// Einmal-Links zum Zurücksetzen/Einladen (gespeichert wird nur der SHA-256-Fingerabdruck)
db.exec(`CREATE TABLE IF NOT EXISTS reset_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL DEFAULT 'reset',
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at INTEGER NOT NULL,
  used_at TEXT
)`);

export function randomToken(bytes = 18) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Geheimer Schlüssel für Login-Tokens – wird beim ersten Start erzeugt und im Datenordner gespeichert */
export function getSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const f = path.join(DATA_DIR, 'secret.key');
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(48).toString('hex'), { mode: 0o600 });
  return fs.readFileSync(f, 'utf8').trim();
}

export function tx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export const Q = {
  userCount: db.prepare('SELECT COUNT(*) AS n FROM users'),
  adminCount: db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin'"),
  userById: db.prepare('SELECT * FROM users WHERE id=?'),
  userByEmail: db.prepare('SELECT * FROM users WHERE email=?'),
  users: db.prepare('SELECT * FROM users ORDER BY email'),
  insertUser: db.prepare('INSERT INTO users (email,name,password_hash,role) VALUES (?,?,?,?)'),
  accessGet: db.prepare('SELECT role FROM rundown_access WHERE rundown_id=? AND user_id=?'),
  accessSet: db.prepare('INSERT INTO rundown_access (rundown_id,user_id,role) VALUES (?,?,?) ON CONFLICT(rundown_id,user_id) DO UPDATE SET role=excluded.role'),
  accessDel: db.prepare('DELETE FROM rundown_access WHERE rundown_id=? AND user_id=?'),
  accessByUser: db.prepare('SELECT a.rundown_id, a.role, r.title, r.event_date FROM rundown_access a JOIN rundowns r ON r.id=a.rundown_id WHERE a.user_id=? ORDER BY COALESCE(r.event_date,\'9999\') DESC, r.id DESC'),
  accessByRundown: db.prepare('SELECT user_id, role FROM rundown_access WHERE rundown_id=?'),
  accessCount: db.prepare('SELECT COUNT(*) AS n FROM rundown_access WHERE user_id=?'),
  insertUserFull: db.prepare('INSERT INTO users (email,name,password_hash,role,must_change) VALUES (?,?,?,?,?)'),
  insertReset: db.prepare('INSERT INTO reset_tokens (user_id,token_hash,purpose,created_by,expires_at) VALUES (?,?,?,?,?)'),
  resetByHash: db.prepare('SELECT * FROM reset_tokens WHERE token_hash=?'),
  resetOpenForUser: db.prepare('SELECT * FROM reset_tokens WHERE user_id=? AND used_at IS NULL AND expires_at>? ORDER BY id DESC LIMIT 1'),
  revokeResets: db.prepare("UPDATE reset_tokens SET used_at=datetime('now') WHERE user_id=? AND used_at IS NULL"),
  markResetUsed: db.prepare("UPDATE reset_tokens SET used_at=datetime('now') WHERE id=?"),
  cleanupResets: db.prepare('DELETE FROM reset_tokens WHERE expires_at<? OR (used_at IS NOT NULL AND used_at < datetime(\'now\', \'-30 days\'))'),
  deleteUser: db.prepare('DELETE FROM users WHERE id=?'),
  touchLogin: db.prepare("UPDATE users SET last_login=datetime('now') WHERE id=?"),

  rundowns: db.prepare(`SELECT r.*,
      (SELECT COUNT(*) FROM items i WHERE i.rundown_id=r.id AND i.type='item') AS item_count,
      (SELECT COALESCE(SUM(duration),0) FROM items i WHERE i.rundown_id=r.id AND i.type='item') AS total
    FROM rundowns r ORDER BY COALESCE(r.event_date,'9999') DESC, r.id DESC`),
  rdById: db.prepare('SELECT * FROM rundowns WHERE id=?'),
  rdByPublic: db.prepare('SELECT * FROM rundowns WHERE public_token=?'),
  rdByCompanion: db.prepare('SELECT * FROM rundowns WHERE companion_token=?'),
  insertRd: db.prepare('INSERT INTO rundowns (title,event_date,start_time,public_token,companion_token,created_by) VALUES (?,?,?,?,?,?)'),
  deleteRd: db.prepare('DELETE FROM rundowns WHERE id=?'),
  touchRd: db.prepare("UPDATE rundowns SET updated_at=datetime('now') WHERE id=?"),
  setLive: db.prepare('UPDATE rundowns SET live=? WHERE id=?'),

  blockCount: db.prepare("SELECT COUNT(*) AS n FROM items WHERE rundown_id=? AND type='block'"),
  colCount: db.prepare('SELECT COUNT(*) AS n FROM columns WHERE rundown_id=?'),
  colsByRd: db.prepare('SELECT * FROM columns WHERE rundown_id=? ORDER BY position, id'),
  colById: db.prepare('SELECT * FROM columns WHERE id=?'),
  insertCol: db.prepare('INSERT INTO columns (rundown_id,name,position,is_public) VALUES (?,?,?,?)'),
  deleteCol: db.prepare('DELETE FROM columns WHERE id=?'),
  setColPos: db.prepare('UPDATE columns SET position=? WHERE id=? AND rundown_id=?'),

  itemsByRd: db.prepare('SELECT * FROM items WHERE rundown_id=? ORDER BY position, id'),
  itemById: db.prepare('SELECT * FROM items WHERE id=?'),
  insertItem: db.prepare('INSERT INTO items (rundown_id,position,type,title,description,duration,color,cells) VALUES (?,?,?,?,?,?,?,?)'),
  deleteItem: db.prepare('DELETE FROM items WHERE id=?'),
  setItemPos: db.prepare('UPDATE items SET position=? WHERE id=? AND rundown_id=?'),
};

/** Dynamisches UPDATE mit Whitelist */
export function updateRow(table, id, fields, allowed) {
  const keys = Object.keys(fields).filter((k) => allowed.includes(k));
  if (!keys.length) return;
  const sql = `UPDATE ${table} SET ${keys.map((k) => `${k}=?`).join(', ')}${table === 'items' ? ", updated_at=datetime('now')" : ''} WHERE id=?`;
  db.prepare(sql).run(...keys.map((k) => fields[k]), id);
}
