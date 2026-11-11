// Protokoll sicherheitsrelevanter Ereignisse (Anmeldungen, Konten, E-Mails, System).
// Nur für Admins sichtbar; Einträge älter als AUDIT_DAYS (Standard 90) werden automatisch gelöscht.
import fs from 'node:fs';
import path from 'node:path';
import { db, DATA_DIR } from './db.js';

db.exec(`
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  cat TEXT NOT NULL,
  kind TEXT NOT NULL,
  actor_id INTEGER,
  actor TEXT,
  target TEXT,
  detail TEXT,
  ip TEXT,
  ok INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS audit_at ON audit_log(at);
CREATE INDEX IF NOT EXISTS audit_cat ON audit_log(cat, id);
`);

export const RETENTION_DAYS = Math.max(7, parseInt(process.env.AUDIT_DAYS, 10) || 90);

/** Ereignis → Kategorie (auth = Anmeldungen, konto = Konten & Rechte, mail = E-Mails, system = Backups & Einstellungen) */
const CAT = {
  setup: 'auth', login: 'auth', login_fail: 'auth', forgot: 'auth', reset_used: 'auth', invite_accepted: 'auth',
  user_created: 'konto', user_invited: 'konto', user_deleted: 'konto', role_changed: 'konto', restricted_changed: 'konto',
  email_changed: 'konto', password_self: 'konto', password_admin: 'konto', reset_link: 'konto', reset_revoked: 'konto', owner: 'konto',
  mail_sent: 'mail', mail_failed: 'mail',
  backup_manual: 'system', backup_upload: 'system', backup_delete: 'system', backup_restore: 'system', backup_failed: 'system',
  backup_settings: 'system', mail_settings: 'system', notify_settings: 'system', history_settings: 'system', token_new: 'system',
};
export const CATS = ['auth', 'konto', 'mail', 'system'];

const ins = db.prepare('INSERT INTO audit_log (at, cat, kind, actor_id, actor, target, detail, ip, ok) VALUES (?,?,?,?,?,?,?,?,?)');
const name = (u) => (u ? u.name || u.email : null);

/**
 * Eintrag schreiben – wirft nie (das Protokoll darf keine Aktion verhindern).
 * @param kind   Ereignis (siehe CAT)
 * @param o.actor  wer (Benutzer-Objekt), o.target Betroffener (Text, meist E-Mail), o.detail Objekt, o.ip, o.ok
 */
export function log(kind, { actor = null, target = null, detail = null, ip = null, ok = true } = {}) {
  try {
    ins.run(Date.now(), CAT[kind] || 'system', kind, actor?.id ?? null, name(actor), target == null ? null : String(target).slice(0, 300),
      detail ? JSON.stringify(detail).slice(0, 2000) : null, ip ? String(ip).slice(0, 64) : null, ok ? 1 : 0);
  } catch (e) { console.error('  Protokoll-Fehler:', e.message); }
}

/** Liste, neueste zuerst; before = id für „Mehr laden“ */
export function list({ cat = '', q = '', before = 0, limit = 100 } = {}) {
  const where = [], args = [];
  if (CATS.includes(cat)) { where.push('cat=?'); args.push(cat); }
  if (q) { where.push('(actor LIKE ? OR target LIKE ? OR detail LIKE ? OR ip LIKE ?)'); const like = `%${String(q).slice(0, 100)}%`; args.push(like, like, like, like); }
  if (Number(before) > 0) { where.push('id<?'); args.push(Number(before)); }
  const n = Math.min(200, Math.max(1, Number(limit) || 100));
  const rows = db.prepare(`SELECT * FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ${n + 1}`).all(...args);
  return {
    entries: rows.slice(0, n).map((r) => ({ ...r, ok: !!r.ok, detail: r.detail ? safeJson(r.detail) : null })),
    more: rows.length > n,
  };
}
const safeJson = (s) => { try { return JSON.parse(s); } catch { return null; } };

/** Kurzüberblick für das Seitenmenü */
export function summary() {
  const day = Date.now() - 24 * 3600e3;
  return {
    total: db.prepare('SELECT COUNT(*) n FROM audit_log').get().n,
    login_fails_24h: db.prepare("SELECT COUNT(*) n FROM audit_log WHERE kind='login_fail' AND at>?").get(day).n,
    mail_fails_24h: db.prepare("SELECT COUNT(*) n FROM audit_log WHERE kind='mail_failed' AND at>?").get(day).n,
    retention_days: RETENTION_DAYS,
  };
}

function prune() {
  try { db.prepare('DELETE FROM audit_log WHERE at<?').run(Date.now() - RETENTION_DAYS * 24 * 3600e3); } catch { /* */ }
}
prune();
setInterval(prune, 6 * 3600e3).unref();

/* Wiederherstellung: der Eintrag kann erst nach dem Neustart geschrieben werden (die Datenbank wird ersetzt) */
const RESTORE_INFO = path.join(DATA_DIR, 'restore-info.json');
export function noteRestore(info) {
  try { fs.writeFileSync(RESTORE_INFO, JSON.stringify(info), { mode: 0o600 }); } catch { /* */ }
}
try {
  if (fs.existsSync(RESTORE_INFO)) {
    const i = JSON.parse(fs.readFileSync(RESTORE_INFO, 'utf8'));
    fs.unlinkSync(RESTORE_INFO);
    log('backup_restore', { actor: i.actor, target: i.name, detail: { safety: i.safety }, ip: i.ip });
  }
} catch { /* */ }
