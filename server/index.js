import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { db, Q, tx, updateRow, randomToken, getSecret, DATA_DIR } from './db.js';
import * as hist from './history.js';
import { hashPassword, verifyPassword, signToken, verifyToken, parseCookies, serializeCookie, ROLES, can, rank } from './auth.js';
import { applyLiveAction, parseLive } from './live.js';
import * as backup from './backup.js';
import { liveStatus, fmtDuration, fmtCountdown, fmtTime, fmtClock, parseClock, parseDuration, computeSchedule } from '../shared/timing.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const SECRET = getSecret();
const COOKIE = 'ffr_session';
const TRUST_PROXY = /^(1|true|yes)$/i.test(process.env.TRUST_PROXY || '');
const COOKIE_SECURE = process.env.COOKIE_SECURE; // 'true' | 'false' | undefined (auto)
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, msg) => { throw new HttpError(status, msg); };

/* ------------------------------------------------------------------ Router */
const routes = [];
const route = (method, pattern, ...handlers) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  routes.push({ method, re, keys, handlers });
};
const rawRoute = (method, p, ...h) => { route(method, p, ...h); routes[routes.length - 1].raw = true; };
const GET = (p, ...h) => route('GET', p, ...h);
const POST = (p, ...h) => route('POST', p, ...h);
const PATCH = (p, ...h) => route('PATCH', p, ...h);
const DELETE = (p, ...h) => route('DELETE', p, ...h);
const PUT = (p, ...h) => route('PUT', p, ...h);

/** Effektive Rolle eines Benutzers für einen Rundown (null = kein Zugriff) */
const SHARE_ROLES = ['viewer', 'operator', 'editor'];
function roleFor(user, rid) {
  if (!user) return null;
  if (user.role === 'admin') return 'admin';
  const share = Q.accessGet.get(rid, user.id)?.role || null;
  if (user.restricted) return share;
  return share && rank(share) > rank(user.role) ? share : user.role;
}

/** Rechte auf einen bestimmten Rundown prüfen; ridOf liefert die Rundown-ID aus der Anfrage */
const needRd = (role, ridOf = (req) => req.params.id) => (req) => {
  if (!req.user) fail(401, 'Nicht angemeldet');
  const rid = Number(ridOf(req));
  const r = rid ? roleFor(req.user, rid) : null;
  if (!rid || !r || !Q.rdById.get(rid)) fail(404, 'Rundown nicht gefunden');
  if (rank(r) < rank(role)) fail(403, 'Keine Berechtigung für diese Aktion in diesem Rundown');
  req.rdRole = r;
};
const ridOfItem = (req) => Q.itemById.get(Number(req.params.id))?.rundown_id;
const ridOfColumn = (req) => Q.colById.get(Number(req.params.id))?.rundown_id;
const needCreator = (req) => {
  if (!req.user) fail(401, 'Nicht angemeldet');
  if (req.user.restricted || !can(req.user, 'editor')) fail(403, 'Keine Berechtigung, Rundowns anzulegen');
};

/** Benutzer über geänderte Rechte informieren (Ansicht lädt neu; ohne Zugriff wird die Verbindung getrennt) */
function notifyAccess(userId) {
  const u = Q.userById.get(userId);
  for (const c of clients) {
    if (!c.user || c.user.id !== userId) continue;
    if (c.rundownId && !roleFor(u, c.rundownId)) { sse(c, 'deleted', { id: c.rundownId, reason: 'access' }); c.res.end(); }
    else sse(c, 'access', {});
  }
}

const need = (role) => (req) => {
  if (!req.user) fail(401, 'Nicht angemeldet');
  if (!can(req.user, role)) fail(403, 'Keine Berechtigung für diese Aktion');
};

function send(res, status, data, headers = {}) {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': typeof data === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Datei zu groß')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Anfrage zu groß')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      const raw = Buffer.concat(chunks).toString('utf8');
      if ((req.headers['content-type'] || '').includes('application/json')) {
        try { resolve(JSON.parse(raw)); } catch { reject(new HttpError(400, 'Ungültiges JSON')); }
      } else if ((req.headers['content-type'] || '').includes('application/x-www-form-urlencoded')) {
        resolve(Object.fromEntries(new URLSearchParams(raw)));
      } else {
        try { resolve(JSON.parse(raw)); } catch { resolve({ raw }); }
      }
    });
    req.on('error', reject);
  });
}

const clientIp = (req) =>
  (TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress;
const isSecure = (req) =>
  COOKIE_SECURE ? COOKIE_SECURE === 'true' : !!req.socket.encrypted || (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https');

/* ------------------------------------------------------------------ Static */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain',
};
const STATIC_DIRS = [['/shared/', path.join(ROOT, 'shared')], ['/', path.join(ROOT, 'public')]];

function serveFile(req, res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, { error: 'Nicht gefunden' });
    const etag = `W/"${st.size}-${st.mtimeMs.toString(36)}"`;
    if (req.headers['if-none-match'] === etag) { res.writeHead(304); return res.end(); }
    const ext = path.extname(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      ETag: etag,
      'Cache-Control': ext === '.woff2' || ext === '.woff' ? 'public, max-age=86400' : 'no-cache', // immer neu prüfen (ETag) – Updates kommen sofort an
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

function tryStatic(req, res, pathname) {
  for (const [prefix, dir] of STATIC_DIRS) {
    if (!pathname.startsWith(prefix)) continue;
    const rel = decodeURIComponent(pathname.slice(prefix.length)) || 'index.html';
    const file = path.normalize(path.join(dir, rel));
    if (!file.startsWith(dir)) return false;
    if (fs.existsSync(file) && fs.statSync(file).isFile()) { serveFile(req, res, file); return true; }
  }
  return false;
}

/* ------------------------------------------------------------------ Helpers */
const NO_PASSWORD = 'none$';
const userOut = (u) => {
  const open = Q.resetOpenForUser.get(u.id, Date.now());
  return {
    id: u.id, email: u.email, name: u.name, role: u.role, created_at: u.created_at, last_login: u.last_login,
    must_change: !!u.must_change,
    restricted: !!u.restricted && u.role !== 'admin',
    share_count: Q.accessCount.get(u.id).n,
    pending: String(u.password_hash).startsWith(NO_PASSWORD), // Einladung noch nicht angenommen
    open_link: open ? { purpose: open.purpose, expires_at: open.expires_at } : null,
  };
};
const sha256 = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const LINK_HOURS = [1, 24, 72, 168];

/** Erzeugt einen Einmal-Link (Reset oder Einladung) – frühere offene Links des Benutzers werden ungültig */
function createResetLink(userId, purpose, hours, createdBy) {
  const h = LINK_HOURS.includes(Number(hours)) ? Number(hours) : 24;
  Q.revokeResets.run(userId);
  const token = randomToken(32);
  const expires = Date.now() + h * 3600 * 1000;
  Q.insertReset.run(userId, sha256(token), purpose, createdBy || null, expires);
  Q.cleanupResets.run(Date.now() - 7 * 86400 * 1000);
  return { token, expires_at: expires, hours: h, purpose };
}

function resetRecord(token) {
  const r = Q.resetByHash.get(sha256(token));
  if (!r || r.used_at || r.expires_at < Date.now()) return null;
  const u = Q.userById.get(r.user_id);
  return u ? { r, u } : null;
}
const json = (s, fb) => { try { return JSON.parse(s); } catch { return fb; } };
const itemOut = (i) => ({ id: i.id, type: i.type, title: i.title, description: i.description, script: i.script || '', duration: i.duration, color: i.color, cells: json(i.cells, {}) });
const colOut = (c) => ({ id: c.id, name: c.name, position: c.position, is_public: !!c.is_public });
const loadItems = (rid) => Q.itemsByRd.all(rid).map(itemOut);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const COLOR_RE = /^(#[0-9a-fA-F]{6})?$/;
const TIME_RE = /^\d{1,2}:\d{2}(:\d{2})?$/;
const DATE_RE = /^(\d{4}-\d{2}-\d{2})?$/;

function getRundown(id) {
  const rd = Q.rdById.get(Number(id));
  if (!rd) fail(404, 'Rundown nicht gefunden');
  return rd;
}

function payload(rd, { publicView = false } = {}) {
  let columns = Q.colsByRd.all(rd.id).map(colOut);
  let items = loadItems(rd.id);
  if (publicView) {
    columns = columns.filter((c) => c.is_public);
    const allowed = new Set(columns.map((c) => String(c.id)));
    items = items.map((i) => ({ ...i, cells: Object.fromEntries(Object.entries(i.cells).filter(([k]) => allowed.has(k))) }));
  }
  const r = { id: rd.id, title: rd.title, event_date: rd.event_date, start_time: rd.start_time, updated_at: rd.updated_at };
  if (!publicView) { r.public_enabled = !!rd.public_enabled; r.public_token = rd.public_token; }
  return { rundown: r, columns, items, live: parseLive(rd.live), serverNow: Date.now(), public: publicView };
}

/* ------------------------------------------------------------------ Echtzeit (Server-Sent Events) */
const clients = new Set(); // {res, id, user, rundownId, isPublic, lobby}
let clientSeq = 0;

function sse(client, event, data) {
  try { client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* ignore */ }
}

function broadcast(rid, except) {
  const rd = Q.rdById.get(rid);
  if (!rd) return;
  let full, pub;
  for (const c of clients) {
    if (c.rundownId !== rid || c.id === except) continue;
    if (c.isPublic) { if (!rd.public_enabled) continue; sse(c, 'rundown', (pub ||= payload(rd, { publicView: true }))); }
    else sse(c, 'rundown', (full ||= payload(rd)));
  }
  broadcastLobby();
}

function broadcastLive(rid) {
  const rd = Q.rdById.get(rid);
  if (!rd) return;
  const msg = { rundownId: rid, live: parseLive(rd.live), serverNow: Date.now() };
  for (const c of clients) if (c.rundownId === rid && (!c.isPublic || rd.public_enabled)) sse(c, 'live', msg);
  broadcastLobby();
}

let lobbyTimer = null;
function broadcastLobby() {
  clearTimeout(lobbyTimer);
  lobbyTimer = setTimeout(() => { for (const c of clients) if (c.lobby) { sse(c, 'rundowns', { t: Date.now() }); sse(c, 'online', { t: Date.now() }); } }, 300);
}

function kickUser(userId) {
  for (const c of clients) if (c.user && c.user.id === userId) { sse(c, 'logout', {}); c.res.end(); }
}

/* ------------------------------------------------------------------ Präsenz: Wer ist gerade online? */
// Jede offene Verbindung (Tab/Gerät) ist ein Client. Angemeldete Clients zählen als Person,
// öffentliche Links nur als anonyme Zuschauer. Der Fokus zeigt, welches Feld gerade bearbeitet wird.
const FOCUS_FIELD_RE = /^(title|description|script|duration|cell:\d+)$/;

function presenceFor(rid) {
  const people = new Map();
  let viewers = 0;
  for (const c of clients) {
    if (c.rundownId !== rid) continue;
    if (c.isPublic || !c.user) { viewers++; continue; }
    let p = people.get(c.user.id);
    if (!p) {
      p = { id: c.user.id, name: c.user.name || c.user.email.split('@')[0], email: c.user.email, role: c.user.role, devices: 0, views: [], since: c.since, focus: [] };
      people.set(c.user.id, p);
    }
    p.devices++;
    if (!p.views.includes(c.view)) p.views.push(c.view);
    p.since = Math.min(p.since, c.since);
    if (c.focus) p.focus.push({ ...c.focus, clientId: c.id });
  }
  return { rundownId: rid, users: [...people.values()].sort((a, b) => a.since - b.since), viewers };
}

/** Wer ist in welchem Rundown (für die Übersicht) bzw. überhaupt online (für die Benutzerliste) */
function onlineSummary() {
  const byRundown = {};
  const users = {};
  for (const c of clients) {
    if (!c.user) continue;
    const u = (users[c.user.id] ||= { id: c.user.id, rundowns: new Set(), devices: 0 });
    u.devices++;
    if (c.rundownId) {
      u.rundowns.add(c.rundownId);
      const list = (byRundown[c.rundownId] ||= new Map());
      if (!list.has(c.user.id)) list.set(c.user.id, { id: c.user.id, name: c.user.name || c.user.email.split('@')[0], role: c.user.role });
    }
  }
  return { byRundown, users };
}

const presenceTimers = new Map();
function broadcastPresence(rid) {
  if (!rid) return;
  clearTimeout(presenceTimers.get(rid));
  presenceTimers.set(rid, setTimeout(() => {
    presenceTimers.delete(rid);
    const msg = presenceFor(rid);
    for (const c of clients) if (c.rundownId === rid && !c.isPublic) sse(c, 'presence', msg);
  }, 120));
  broadcastLobby();
}

setInterval(() => { for (const c of clients) { try { c.res.write(`: ping ${Date.now()}\n\n`); } catch { /* */ } } }, 20000).unref();

function changed(rid, req) {
  Q.touchRd.run(rid);
  broadcast(rid, req?.headers['x-client-id']);
}

/* ------------------------------------------------------------------ Login-Schutz */
const attempts = new Map();
function checkRate(ip) {
  const a = attempts.get(ip);
  if (a && a.until > Date.now()) fail(429, `Zu viele Fehlversuche. Bitte in ${Math.ceil((a.until - Date.now()) / 1000)} s erneut versuchen.`);
}
function noteFail(ip) {
  const a = attempts.get(ip) || { n: 0, until: 0 };
  a.n++;
  if (a.n >= 5) { a.until = Date.now() + Math.min(15 * 60, 15 * 2 ** (a.n - 5)) * 1000; }
  attempts.set(ip, a);
}

function setSession(req, res, u) {
  const token = signToken({ uid: u.id, tv: u.token_version }, SECRET);
  res.setHeader('Set-Cookie', serializeCookie(COOKIE, token, { maxAge: 30 * 24 * 3600, secure: isSecure(req) }));
  return token;
}

/* ================================================================== API */

const BOOT_ID = randomToken(6);
GET('/api/health', () => ({ ok: true, version: VERSION, boot: BOOT_ID }));

// ---------- Auth
GET('/api/auth/status', (req) => ({ needsSetup: Q.userCount.get().n === 0, user: req.user ? userOut(req.user) : null, version: VERSION }));

POST('/api/auth/setup', async (req, res) => {
  if (Q.userCount.get().n > 0) fail(400, 'Setup bereits abgeschlossen');
  const { email, password, name } = req.body;
  if (!EMAIL_RE.test(email || '')) fail(400, 'Bitte gültige E-Mail-Adresse angeben');
  if (String(password || '').length < 8) fail(400, 'Passwort muss mindestens 8 Zeichen haben');
  const { lastInsertRowid } = Q.insertUser.run(email.trim(), (name || '').trim(), await hashPassword(password), 'admin');
  const u = Q.userById.get(lastInsertRowid);
  const token = setSession(req, res, u);
  return { user: userOut(u), token };
});

POST('/api/auth/login', async (req, res) => {
  const ip = clientIp(req);
  checkRate(ip);
  const { email, password } = req.body;
  const u = Q.userByEmail.get(String(email || '').trim());
  if (!u || !(await verifyPassword(String(password || ''), u.password_hash))) {
    noteFail(ip);
    fail(401, 'E-Mail oder Passwort falsch');
  }
  attempts.delete(ip);
  Q.touchLogin.run(u.id);
  const token = setSession(req, res, u);
  return { user: userOut(u), token };
});

POST('/api/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', serializeCookie(COOKIE, '', { maxAge: 0, secure: isSecure(req) }));
  return { ok: true };
});

POST('/api/auth/password', need('viewer'), async (req, res) => {
  const { current, password } = req.body;
  if (!(await verifyPassword(String(current || ''), req.user.password_hash))) fail(400, 'Aktuelles Passwort ist falsch');
  if (String(password || '').length < 8) fail(400, 'Neues Passwort muss mindestens 8 Zeichen haben');
  if (password === current) fail(400, 'Das neue Passwort muss sich vom bisherigen unterscheiden');
  db.prepare('UPDATE users SET password_hash=?, must_change=0, token_version=token_version+1 WHERE id=?').run(await hashPassword(password), req.user.id);
  const u = Q.userById.get(req.user.id);
  kickUser(u.id);
  setSession(req, res, u);
  return { ok: true };
});

// Pflicht-Passwortwechsel nach temporärem Passwort (ohne erneute Eingabe des alten)
POST('/api/auth/initial-password', need('viewer'), async (req, res) => {
  if (!req.user.must_change) fail(400, 'Kein Passwortwechsel erforderlich');
  const { password } = req.body;
  if (String(password || '').length < 8) fail(400, 'Neues Passwort muss mindestens 8 Zeichen haben');
  if (await verifyPassword(String(password), req.user.password_hash)) fail(400, 'Bitte ein anderes Passwort als das temporäre wählen');
  db.prepare('UPDATE users SET password_hash=?, must_change=0, token_version=token_version+1 WHERE id=?').run(await hashPassword(password), req.user.id);
  const u = Q.userById.get(req.user.id);
  kickUser(u.id);
  setSession(req, res, u);
  return { user: userOut(u) };
});

// ---------- Einmal-Links (öffentlich erreichbar, nur mit gültigem Token)
GET('/api/reset/:token', (req) => {
  const ip = clientIp(req);
  checkRate(ip);
  const rec = resetRecord(req.params.token);
  if (!rec) { noteFail(ip); fail(404, 'Dieser Link ist ungültig, abgelaufen oder wurde bereits verwendet. Bitte einen neuen Link beim Admin anfordern.'); }
  return { email: rec.u.email, name: rec.u.name, purpose: rec.r.purpose, expires_at: rec.r.expires_at };
});

POST('/api/reset/:token', async (req, res) => {
  const ip = clientIp(req);
  checkRate(ip);
  const rec = resetRecord(req.params.token);
  if (!rec) { noteFail(ip); fail(404, 'Dieser Link ist ungültig, abgelaufen oder wurde bereits verwendet.'); }
  const { password } = req.body;
  if (String(password || '').length < 8) fail(400, 'Passwort muss mindestens 8 Zeichen haben');
  Q.markResetUsed.run(rec.r.id);
  db.prepare('UPDATE users SET password_hash=?, must_change=0, token_version=token_version+1 WHERE id=?').run(await hashPassword(password), rec.u.id);
  Q.touchLogin.run(rec.u.id);
  const u = Q.userById.get(rec.u.id);
  kickUser(u.id);
  setSession(req, res, u);
  console.log(`[Sicherheit] Passwort für ${u.email} über ${rec.r.purpose === 'invite' ? 'Einladungslink' : 'Reset-Link'} gesetzt`);
  return { user: userOut(u) };
});

// ---------- Freigaben pro Rundown (nur Admin)
function setShare(rid, userId, role) {
  const u = Q.userById.get(Number(userId));
  if (!u) fail(404, 'Benutzer nicht gefunden');
  if (!Q.rdById.get(Number(rid))) fail(404, 'Rundown nicht gefunden');
  if (role) {
    if (!SHARE_ROLES.includes(role)) fail(400, 'Ungültige Rolle');
    Q.accessSet.run(Number(rid), u.id, role);
  } else Q.accessDel.run(Number(rid), u.id);
  notifyAccess(u.id);
}

GET('/api/rundowns/:id/access', need('admin'), (req) => {
  const rd = getRundown(req.params.id);
  const shares = new Map(Q.accessByRundown.all(rd.id).map((a) => [a.user_id, a.role]));
  return Q.users.all().map((u) => ({
    id: u.id, email: u.email, name: u.name, role: u.role, restricted: !!u.restricted && u.role !== 'admin',
    share: shares.get(u.id) || null, effective: roleFor(u, rd.id),
  }));
});

PUT('/api/rundowns/:id/access/:userId', need('admin'), (req) => {
  setShare(getRundown(req.params.id).id, req.params.userId, req.body.role || null);
  return { ok: true };
});

GET('/api/users/:id/access', need('admin'), (req) => {
  const u = Q.userById.get(Number(req.params.id));
  if (!u) fail(404, 'Benutzer nicht gefunden');
  const shares = new Map(Q.accessByUser.all(u.id).map((a) => [a.rundown_id, a.role]));
  return Q.rundowns.all().map((r) => ({ id: r.id, title: r.title, event_date: r.event_date, share: shares.get(r.id) || null, effective: roleFor(u, r.id) }));
});

PUT('/api/users/:id/access/:rundownId', need('admin'), (req) => {
  setShare(req.params.rundownId, req.params.id, req.body.role || null);
  return { ok: true };
});

// ---------- Benutzer (Admin)
POST('/api/users/:id/reset-link', need('admin'), (req) => {
  const u = Q.userById.get(Number(req.params.id));
  if (!u) fail(404, 'Benutzer nicht gefunden');
  const purpose = String(u.password_hash).startsWith(NO_PASSWORD) ? 'invite' : 'reset';
  const link = createResetLink(u.id, purpose, req.body.hours, req.user.email);
  return { ...link, user: userOut(Q.userById.get(u.id)) };
});

DELETE('/api/users/:id/reset-link', need('admin'), (req) => {
  const u = Q.userById.get(Number(req.params.id));
  if (!u) fail(404, 'Benutzer nicht gefunden');
  Q.revokeResets.run(u.id);
  return userOut(u);
});

GET('/api/users', need('admin'), () => {
  const { users } = onlineSummary();
  return Q.users.all().map((u) => {
    const o = users[u.id];
    return { ...userOut(u), online: !!o, online_devices: o?.devices || 0, online_rundowns: o ? [...o.rundowns] : [] };
  });
});

POST('/api/users', need('admin'), async (req) => {
  const { email, name, password, role, invite, must_change, hours, restricted } = req.body;
  if (!EMAIL_RE.test(email || '')) fail(400, 'Bitte gültige E-Mail-Adresse angeben');
  if (!ROLES.includes(role)) fail(400, 'Ungültige Rolle');
  if (Q.userByEmail.get(email.trim())) fail(409, 'Diese E-Mail-Adresse existiert bereits');
  if (invite) {
    // Konto ohne Passwort – der Benutzer legt es über den Einladungslink selbst fest
    const { lastInsertRowid } = Q.insertUserFull.run(email.trim(), (name || '').trim(), NO_PASSWORD + randomToken(16), role, 0);
    if (restricted && role !== 'admin') db.prepare('UPDATE users SET restricted=1 WHERE id=?').run(lastInsertRowid);
    const link = createResetLink(Number(lastInsertRowid), 'invite', hours ?? 168, req.user.email);
    return { ...userOut(Q.userById.get(lastInsertRowid)), link };
  }
  if (String(password || '').length < 8) fail(400, 'Passwort muss mindestens 8 Zeichen haben');
  const { lastInsertRowid } = Q.insertUserFull.run(email.trim(), (name || '').trim(), await hashPassword(password), role, must_change === false ? 0 : 1);
  if (restricted && role !== 'admin') db.prepare('UPDATE users SET restricted=1 WHERE id=?').run(lastInsertRowid);
  return userOut(Q.userById.get(lastInsertRowid));
});

PATCH('/api/users/:id', need('admin'), async (req) => {
  const u = Q.userById.get(Number(req.params.id));
  if (!u) fail(404, 'Benutzer nicht gefunden');
  const { email, name, role, password } = req.body;
  const upd = {};
  if (email !== undefined) {
    if (!EMAIL_RE.test(email)) fail(400, 'Ungültige E-Mail-Adresse');
    const other = Q.userByEmail.get(email.trim());
    if (other && other.id !== u.id) fail(409, 'Diese E-Mail-Adresse existiert bereits');
    upd.email = email.trim();
  }
  if (name !== undefined) upd.name = String(name).trim();
  if (role !== undefined) {
    if (!ROLES.includes(role)) fail(400, 'Ungültige Rolle');
    if (u.role === 'admin' && role !== 'admin' && Q.adminCount.get().n <= 1) fail(400, 'Der letzte Admin kann nicht herabgestuft werden');
    upd.role = role;
  }
  if (password) {
    if (String(password).length < 8) fail(400, 'Passwort muss mindestens 8 Zeichen haben');
    upd.password_hash = await hashPassword(password);
    upd.must_change = req.body.must_change === false || u.id === req.user.id ? 0 : 1;
    Q.revokeResets.run(u.id);
  }
  if (req.body.restricted !== undefined) upd.restricted = req.body.restricted ? 1 : 0;
  if ((upd.role ?? u.role) === 'admin') upd.restricted = 0;
  if (upd.role !== undefined || upd.password_hash) upd.token_version = u.token_version + 1;
  updateRow('users', u.id, upd, ['email', 'name', 'role', 'password_hash', 'token_version', 'must_change', 'restricted']);
  if (upd.token_version) kickUser(u.id);
  else if (upd.restricted !== undefined && upd.restricted !== u.restricted) notifyAccess(u.id);
  return userOut(Q.userById.get(u.id));
});

DELETE('/api/users/:id', need('admin'), (req) => {
  const u = Q.userById.get(Number(req.params.id));
  if (!u) fail(404, 'Benutzer nicht gefunden');
  if (u.id === req.user.id) fail(400, 'Du kannst dich nicht selbst löschen');
  if (u.role === 'admin' && Q.adminCount.get().n <= 1) fail(400, 'Der letzte Admin kann nicht gelöscht werden');
  Q.deleteUser.run(u.id);
  kickUser(u.id);
  return { ok: true };
});

// ---------- Rundowns
GET('/api/rundowns', need('viewer'), (req) => {
  const summary = onlineSummary();
  return Q.rundowns.all().filter((r) => roleFor(req.user, r.id)).map((r) => {
    const live = parseLive(r.live);
    const online = summary.byRundown[r.id] ? [...summary.byRundown[r.id].values()] : [];
    const out = {
      online,
      id: r.id, title: r.title, event_date: r.event_date, start_time: r.start_time, item_count: r.item_count, total: r.total,
      end_time: fmtClock(parseClock(r.start_time) + (r.total || 0)),
      live: !!live.running, updated_at: r.updated_at, public_enabled: !!r.public_enabled,
      my_role: roleFor(req.user, r.id),
      block_count: Q.blockCount.get(r.id).n, column_count: Q.colCount.get(r.id).n,
    };
    if (live.running) {
      const st = liveStatus(loadItems(r.id), live, Date.now());
      if (st.running) Object.assign(out, { live_probe: !!st.probe, live_title: st.current.title, live_index: st.index + 1, live_remaining: Math.round(st.remaining), live_progress: Math.round(st.progress * 100), live_delta: Math.round(st.delta) });
    }
    return out;
  });
});

const DEFAULT_COLUMNS = ['Notizen', 'GFX', 'Ort', 'Ton'];

POST('/api/rundowns', needCreator, (req) => {
  const { title, event_date, start_time } = req.body;
  if (!String(title || '').trim()) fail(400, 'Bitte einen Titel angeben');
  if (event_date && !DATE_RE.test(event_date)) fail(400, 'Ungültiges Datum');
  if (start_time && !TIME_RE.test(start_time)) fail(400, 'Ungültige Startzeit');
  const id = tx(() => {
    const { lastInsertRowid: rid } = Q.insertRd.run(String(title).trim(), event_date || null, start_time || '10:00', randomToken(), randomToken(24), req.user.id);
    DEFAULT_COLUMNS.forEach((n, i) => Q.insertCol.run(rid, n, i, 1));
    Q.insertItem.run(rid, 0, 'item', 'Programmpunkt', '', 300, '', '{}');
    return Number(rid);
  });
  broadcastLobby();
  return { id };
});

GET('/api/rundowns/:id', needRd('viewer'), (req) => ({ ...payload(getRundown(req.params.id)), my_role: req.rdRole }));

PATCH('/api/rundowns/:id', needRd('editor'), (req) => {
  const rd = getRundown(req.params.id);
  const { title, event_date, start_time } = req.body;
  const upd = {};
  if (title !== undefined) { if (!String(title).trim()) fail(400, 'Titel darf nicht leer sein'); upd.title = String(title).trim(); }
  if (event_date !== undefined) { if (!DATE_RE.test(event_date || '')) fail(400, 'Ungültiges Datum'); upd.event_date = event_date || null; }
  if (start_time !== undefined) { if (!TIME_RE.test(start_time)) fail(400, 'Ungültige Startzeit'); upd.start_time = start_time; }
  const d = hist.fieldDiff(rd, upd, ['title', 'event_date', 'start_time']);
  updateRow('rundowns', rd.id, upd, ['title', 'event_date', 'start_time']);
  if (d) hist.record(rd.id, req.user, 'rd.edit', upd.title || rd.title, [{ t: 'rd', ...d }], 'rd:' + Object.keys(d.a).sort().join());
  changed(rd.id, req);
  return payload(Q.rdById.get(rd.id));
});

DELETE('/api/rundowns/:id', needRd('editor'), (req) => {
  const rd = getRundown(req.params.id);
  try { backup.create('vor-loeschen', rd.title); } catch (e) { console.error('  Sicherung vor dem Löschen fehlgeschlagen:', e.message); }
  Q.deleteRd.run(rd.id);
  for (const c of clients) if (c.rundownId === rd.id) sse(c, 'deleted', { id: rd.id });
  broadcastLobby();
  return { ok: true };
});

POST('/api/rundowns/:id/duplicate', needCreator, needRd('viewer'), (req) => {
  const rd = getRundown(req.params.id);
  const id = tx(() => {
    const { lastInsertRowid: rid } = Q.insertRd.run(`${rd.title} (Kopie)`, rd.event_date, rd.start_time, randomToken(), randomToken(24), req.user.id);
    const map = {};
    for (const c of Q.colsByRd.all(rd.id)) map[c.id] = Number(Q.insertCol.run(rid, c.name, c.position, c.is_public).lastInsertRowid);
    for (const i of Q.itemsByRd.all(rd.id)) {
      const cells = Object.fromEntries(Object.entries(json(i.cells, {})).filter(([k]) => map[k]).map(([k, v]) => [map[k], v]));
      const nid = Q.insertItem.run(rid, i.position, i.type, i.title, i.description, i.duration, i.color, JSON.stringify(cells)).lastInsertRowid;
      if (i.script) Q.setItemScript.run(i.script, nid);
    }
    return Number(rid);
  });
  broadcastLobby();
  return { id };
});

// ---------- Programmpunkte / Blöcke
function resequence(rid, ids) {
  ids.forEach((id, pos) => Q.setItemPos.run(pos, id, rid));
}

POST('/api/rundowns/:id/items', needRd('editor'), (req) => {
  const rd = getRundown(req.params.id);
  const { type = 'item', afterId, title, duration, color } = req.body;
  if (!['item', 'block', 'block_end'].includes(type)) fail(400, 'Ungültiger Typ');
  const defaults = { item: ['Neuer Programmpunkt', 300], block: ['Neuer Block', 0], block_end: ['', 0] }[type];
  let newId;
  tx(() => {
    const ids = Q.itemsByRd.all(rd.id).map((i) => i.id);
    newId = Number(Q.insertItem.run(rd.id, 0, type, title ?? defaults[0], '', type === 'item' ? Math.max(0, parseInt(duration ?? defaults[1], 10) || 0) : 0, COLOR_RE.test(color || '') ? color || '' : '', '{}').lastInsertRowid);
    const at = afterId != null ? ids.indexOf(Number(afterId)) : -1;
    if (at >= 0) ids.splice(at + 1, 0, newId); else ids.push(newId);
    resequence(rd.id, ids);
    const it = Q.itemById.get(newId);
    hist.record(rd.id, req.user, type === 'item' ? 'item.add' : type === 'block' ? 'block.add' : 'blockend.add', it.title, [{ t: 'item', id: newId, b: null, a: hist.itemFull(it) }]);
  });
  changed(rd.id, req);
  return { id: newId, ...payload(Q.rdById.get(rd.id)) };
});

// Block (inkl. aller Punkte bis Block-Ende) oder einzelnen Punkt duplizieren – die Kopie kommt direkt dahinter
POST('/api/items/:id/duplicate', needRd('editor', (req) => Q.itemById.get(Number(req.params.id))?.rundown_id), (req) => {
  const src = getItem(req.params.id);
  const rid = src.rundown_id;
  const rows = Q.itemsByRd.all(rid);
  const start = rows.findIndex((r) => r.id === src.id);
  let end = start; // letzter Index, der mitkopiert wird
  if (src.type === 'block') {
    for (let i = start + 1; i < rows.length; i++) {
      if (rows[i].type === 'block') break;
      end = i;
      if (rows[i].type === 'block_end') break;
    }
  } else if (src.type === 'block_end') fail(400, 'Ein Block-Ende allein kann nicht dupliziert werden');
  const part = rows.slice(start, end + 1);
  if (rows.length + part.length > 5000) fail(400, 'Zu viele Einträge');
  const ops = [];
  let firstId = null;
  tx(() => {
    const ids = rows.map((r) => r.id);
    const fresh = part.map((r, i) => {
      const title = i === 0 && r.title ? `${r.title} (Kopie)`.slice(0, 2000) : r.title;
      const nid = Number(Q.insertItem.run(rid, 0, r.type, title, r.description, r.duration, r.color, r.cells || '{}').lastInsertRowid);
      if (r.script) Q.setItemScript.run(r.script, nid);
      return nid;
    });
    firstId = fresh[0];
    ids.splice(end + 1, 0, ...fresh);
    resequence(rid, ids);
    const order = Q.itemsByRd.all(rid).map((r) => r.id);
    for (const nid of fresh) ops.push({ t: 'item', id: nid, b: null, a: hist.itemFull(Q.itemById.get(nid), order) });
  });
  hist.record(rid, req.user, src.type === 'block' ? 'block.dup' : 'item.dup', src.title, ops);
  changed(rid, req);
  return { id: firstId, count: part.length, ...payload(Q.rdById.get(rid)) };
});

POST('/api/rundowns/:id/reorder', needRd('editor'), (req) => {
  const rd = getRundown(req.params.id);
  const current = new Set(Q.itemsByRd.all(rd.id).map((i) => i.id));
  const ids = (req.body.ids || []).map(Number).filter((id) => current.has(id));
  if (ids.length !== current.size) fail(400, 'Reihenfolge unvollständig – bitte neu laden');
  const before = [...current];
  tx(() => resequence(rd.id, ids));
  if (before.join() !== ids.join()) {
    const moved = ids.reduce((best, id, i) => (Math.abs(i - before.indexOf(id)) > Math.abs(ids.indexOf(best) - before.indexOf(best)) ? id : best), ids[0]);
    hist.record(rd.id, req.user, 'order', Q.itemById.get(moved)?.title || '', [{ t: 'order', b: before, a: ids }], 'order');
  }
  changed(rd.id, req);
  return payload(Q.rdById.get(rd.id));
});

/** Wird der laufende Punkt gelöscht, springt Live zum nächsten */
function skipLiveIfCurrent(rid, itemId) {
  const rd = Q.rdById.get(rid);
  const live = parseLive(rd.live);
  if (live.running && live.currentId === itemId) {
    const nl = applyLiveAction(loadItems(rd.id), live, 'next');
    Q.setLive.run(JSON.stringify(nl), rd.id);
  }
}
hist.setHooks({ beforeDeleteItem: skipLiveIfCurrent });

function getItem(id) {
  const it = Q.itemById.get(Number(id));
  if (!it) fail(404, 'Eintrag nicht gefunden');
  return it;
}

PATCH('/api/items/:id', needRd('editor', ridOfItem), (req) => {
  const it = getItem(req.params.id);
  const { title, description, script, duration, color, cells } = req.body;
  const upd = {};
  if (title !== undefined) upd.title = String(title).slice(0, 2000);
  if (description !== undefined) upd.description = String(description).slice(0, 10000);
  if (script !== undefined) upd.script = String(script).slice(0, 50000);
  if (duration !== undefined) upd.duration = Math.max(0, Math.min(24 * 3600, parseInt(duration, 10) || 0));
  if (color !== undefined) { if (!COLOR_RE.test(color)) fail(400, 'Ungültige Farbe'); upd.color = color; }
  if (cells && typeof cells === 'object') {
    const merged = { ...json(it.cells, {}) };
    for (const [k, v] of Object.entries(cells)) merged[k] = String(v ?? '').slice(0, 10000);
    upd.cells = JSON.stringify(merged);
  }
  const d = hist.itemDiff(it, upd);
  updateRow('items', it.id, upd, ['title', 'description', 'script', 'duration', 'color', 'cells']);
  if (d) hist.record(it.rundown_id, req.user, 'item.edit', upd.title ?? it.title, [{ t: 'item', id: it.id, ...d }], `item:${it.id}:${[...Object.keys(d.a).filter((k) => k !== 'cells'), ...Object.keys(d.a.cells || {}).map((k) => 'c' + k)].sort().join()}`);
  changed(it.rundown_id, req);
  return { ok: true, item: itemOut(Q.itemById.get(it.id)) };
});

DELETE('/api/items/:id', needRd('editor', ridOfItem), (req) => {
  const it = getItem(req.params.id);
  const full = hist.itemFull(it);
  skipLiveIfCurrent(it.rundown_id, it.id);
  Q.deleteItem.run(it.id);
  hist.record(it.rundown_id, req.user, it.type === 'item' ? 'item.del' : it.type === 'block' ? 'block.del' : 'blockend.del', it.title, [{ t: 'item', id: it.id, b: full, a: null }]);
  changed(it.rundown_id, req);
  broadcastLive(it.rundown_id);
  return payload(Q.rdById.get(it.rundown_id));
});

// ---------- Spalten
POST('/api/rundowns/:id/columns', needRd('editor'), (req) => {
  const rd = getRundown(req.params.id);
  const name = String(req.body.name || '').trim();
  if (!name) fail(400, 'Bitte Spaltennamen angeben');
  const pos = Q.colsByRd.all(rd.id).length;
  const cid = Number(Q.insertCol.run(rd.id, name.slice(0, 60), pos, req.body.is_public === false ? 0 : 1).lastInsertRowid);
  hist.record(rd.id, req.user, 'col.add', name.slice(0, 60), [{ t: 'col', id: cid, b: null, a: hist.colFull(Q.colById.get(cid)) }]);
  changed(rd.id, req);
  return payload(Q.rdById.get(rd.id));
});

PATCH('/api/columns/:id', needRd('editor', ridOfColumn), (req) => {
  const c = Q.colById.get(Number(req.params.id));
  if (!c) fail(404, 'Spalte nicht gefunden');
  const upd = {};
  if (req.body.name !== undefined) { const n = String(req.body.name).trim(); if (!n) fail(400, 'Name darf nicht leer sein'); upd.name = n.slice(0, 60); }
  if (req.body.is_public !== undefined) upd.is_public = req.body.is_public ? 1 : 0;
  const d = hist.fieldDiff(c, upd, ['name', 'is_public']);
  updateRow('columns', c.id, upd, ['name', 'is_public']);
  if (d) hist.record(c.rundown_id, req.user, 'col.edit', upd.name || c.name, [{ t: 'col', id: c.id, ...d }], `col:${c.id}:${Object.keys(d.a).sort().join()}`);
  changed(c.rundown_id, req);
  return payload(Q.rdById.get(c.rundown_id));
});

DELETE('/api/columns/:id', needRd('editor', ridOfColumn), (req) => {
  const c = Q.colById.get(Number(req.params.id));
  if (!c) fail(404, 'Spalte nicht gefunden');
  const full = hist.colFull(c);
  Q.deleteCol.run(c.id);
  hist.record(c.rundown_id, req.user, 'col.del', c.name, [{ t: 'col', id: c.id, b: full, a: null }]);
  changed(c.rundown_id, req);
  return payload(Q.rdById.get(c.rundown_id));
});

POST('/api/rundowns/:id/columns/reorder', needRd('editor'), (req) => {
  const rd = getRundown(req.params.id);
  const before = Q.colsByRd.all(rd.id).map((c) => c.id);
  tx(() => (req.body.ids || []).forEach((id, i) => Q.setColPos.run(i, Number(id), rd.id)));
  const after = Q.colsByRd.all(rd.id).map((c) => c.id);
  if (before.join() !== after.join()) hist.record(rd.id, req.user, 'col.order', '', [{ t: 'corder', b: before, a: after }], 'corder');
  changed(rd.id, req);
  return payload(Q.rdById.get(rd.id));
});

// ---------- Import (Excel/CSV) – Zeilen werden im Browser eingelesen und hier in einem Rutsch gespeichert
const IMPORT_MAX = 5000;
function importRows(rid, body, user) {
  const rows = Array.isArray(body.items) ? body.items : [];
  if (!rows.length) fail(400, 'Keine Zeilen zum Importieren');
  if (rows.length > IMPORT_MAX) fail(400, `Zu viele Zeilen (höchstens ${IMPORT_MAX})`);
  const colIds = new Map(Q.colsByRd.all(rid).map((c) => [c.name.trim().toLowerCase(), c.id]));
  let pos = Q.itemsByRd.all(rid).length, newCols = 0;
  const ops = [];
  const colId = (name) => {
    const n = String(name || '').trim().slice(0, 60);
    if (!n) return null;
    const k = n.toLowerCase();
    if (!colIds.has(k)) { const cid = Number(Q.insertCol.run(rid, n, colIds.size, 1).lastInsertRowid); colIds.set(k, cid); newCols++; ops.push({ t: 'col', id: cid, b: null, a: hist.colFull(Q.colById.get(cid)) }); }
    return colIds.get(k);
  };
  for (const n of Array.isArray(body.columns) ? body.columns : []) colId(n);
  let added = 0;
  for (const r of rows) {
    const type = ['item', 'block', 'block_end'].includes(r?.type) ? r.type : 'item';
    const cells = {};
    if (r.cells && typeof r.cells === 'object') {
      for (const [name, v] of Object.entries(r.cells)) {
        const val = String(v ?? '').slice(0, 10000);
        const id = val ? colId(name) : null;
        if (id) cells[id] = val;
      }
    }
    const dur = type === 'item' ? Math.max(0, Math.min(24 * 3600, parseInt(r.duration, 10) || 0)) : 0;
    const color = COLOR_RE.test(r.color || '') ? r.color || '' : '';
    const nid = Q.insertItem.run(rid, pos++, type, String(r.title ?? '').slice(0, 2000), String(r.description ?? '').slice(0, 10000), dur, color, JSON.stringify(cells)).lastInsertRowid;
    if (r.script) Q.setItemScript.run(String(r.script).slice(0, 50000), nid);
    ops.push({ t: 'item', id: Number(nid), b: null, a: { ...hist.itemFull(Q.itemById.get(nid), []), index: pos - 1 } });
    added++;
  }
  hist.record(rid, user, 'import', `${added} Zeilen`, ops);
  return { added, newColumns: newCols };
}

POST('/api/rundowns/import', needCreator, (req) => {
  const { title, event_date, start_time } = req.body.rundown || {};
  if (!String(title || '').trim()) fail(400, 'Bitte einen Titel angeben');
  if (event_date && !DATE_RE.test(event_date)) fail(400, 'Ungültiges Datum');
  if (start_time && !TIME_RE.test(start_time)) fail(400, 'Ungültige Startzeit');
  const res = tx(() => {
    const rid = Number(Q.insertRd.run(String(title).trim().slice(0, 200), event_date || null, start_time || '10:00', randomToken(), randomToken(24), req.user.id).lastInsertRowid);
    return { id: rid, ...importRows(rid, req.body, req.user) };
  });
  broadcastLobby();
  return res;
});

POST('/api/rundowns/:id/import', needRd('editor'), (req) => {
  const rd = getRundown(req.params.id);
  const res = tx(() => importRows(rd.id, req.body, req.user));
  changed(rd.id, req);
  return { id: rd.id, ...res, ...payload(Q.rdById.get(rd.id)) };
});

// ---------- Änderungsverlauf (nur Editoren und Admins)
const ridOfChange = (req) => hist.getEntry(req.params.cid)?.rundown_id;
GET('/api/rundowns/:id/history', needRd('editor'), (req) => hist.list(getRundown(req.params.id).id, { before: Number(req.query.before) || undefined, limit: Math.min(200, Number(req.query.limit) || 80) }));

function afterUndo(rid, req) {
  changed(rid, req);
  broadcastLive(rid);
  return payload(Q.rdById.get(rid));
}
function runUndo(entry, req) {
  try { return hist.undo(entry, req.user, { force: !!req.body.force }); }
  catch (e) { if (e.conflict) throw Object.assign(new HttpError(409, e.message), { extra: { conflict: e.conflict } }); throw e.status ? new HttpError(e.status, e.message) : e; }
}

POST('/api/history/:cid/undo', needRd('editor', ridOfChange), (req) => {
  const entry = hist.getEntry(req.params.cid);
  const id = runUndo(entry, req);
  return { id, ...afterUndo(entry.rundown_id, req) };
});

// Strg+Z / Strg+Umschalt+Z: eigene letzte Änderung rückgängig machen bzw. wiederholen
POST('/api/rundowns/:id/history/:action', needRd('editor'), (req) => {
  const rd = getRundown(req.params.id);
  if (!['undo', 'redo'].includes(req.params.action)) fail(404, 'Unbekannte Aktion');
  const entry = hist.findOwn(rd.id, req.user.id, req.params.action);
  if (!entry) return { id: null, nothing: true };
  const id = runUndo(entry, req);
  return { id, entry: { kind: entry.kind, target: entry.target }, ...afterUndo(rd.id, req) };
});

POST('/api/history/:cid/restore', needRd('editor', ridOfChange), (req) => {
  const entry = hist.getEntry(req.params.cid);
  const rd = Q.rdById.get(entry.rundown_id);
  try { backup.create('vor-wiederherstellung', rd.title); } catch (e) { console.error('  Sicherung vor dem Wiederherstellen fehlgeschlagen:', e.message); }
  const r = hist.restoreBefore(entry, req.user);
  return { ...r, ...afterUndo(rd.id, req) };
});

GET('/api/history/settings', need('admin'), () => hist.status());
PATCH('/api/history/settings', need('admin'), (req) => {
  try { return hist.setRetention(req.body.retention_days); } catch (e) { fail(400, e.message); }
});

// ---------- Öffentlicher Link & Companion-Token
POST('/api/rundowns/:id/public', needRd('editor'), (req) => {
  const rd = getRundown(req.params.id);
  const upd = {};
  if (req.body.enabled !== undefined) upd.public_enabled = req.body.enabled ? 1 : 0;
  if (req.body.regenerate) upd.public_token = randomToken();
  updateRow('rundowns', rd.id, upd, ['public_enabled', 'public_token']);
  if (upd.public_enabled === 0 || upd.public_token) {
    for (const c of clients) if (c.isPublic && c.rundownId === rd.id) { sse(c, 'gone', {}); c.res.end(); }
  }
  changed(rd.id, req);
  return payload(Q.rdById.get(rd.id));
});

const companionInfo = (rd) => ({ token: rd.companion_token, rotated_at: rd.companion_rotated_at, rotated_by: rd.companion_rotated_by });
GET('/api/rundowns/:id/companion', needRd('editor'), (req) => companionInfo(getRundown(req.params.id)));

// Notfall: API-/Companion-Token sofort ungültig machen und neu erzeugen (nur mit ausdrücklicher Bestätigung)
POST('/api/rundowns/:id/companion/regenerate', needRd('editor'), (req) => {
  const rd = getRundown(req.params.id);
  if (req.body.confirm !== true) fail(400, 'Bestätigung fehlt: {"confirm": true} mitsenden');
  updateRow('rundowns', rd.id, {
    companion_token: randomToken(24),
    companion_rotated_at: new Date().toISOString(),
    companion_rotated_by: req.user.email,
  }, ['companion_token', 'companion_rotated_at', 'companion_rotated_by']);
  console.log(`[Sicherheit] Companion-/API-Token für Rundown ${rd.id} („${rd.title}“) neu erzeugt von ${req.user.email}`);
  return companionInfo(Q.rdById.get(rd.id));
});

// ---------- Live-Steuerung
const AL_LOG_MAX = 5000;
/** Ereignisse der Aufnahmeleitung (für Nachbericht und Marker-Export) anhängen */
function appendAlLog(rid, events) {
  let log;
  try { log = JSON.parse(Q.alLog.get(rid)?.al_log || '[]'); } catch { log = []; }
  if (!Array.isArray(log)) log = [];
  log.push(...events);
  if (log.length > AL_LOG_MAX) log = log.slice(-AL_LOG_MAX);
  Q.setAlLog.run(JSON.stringify(log), rid);
}
function alLogOf(rid) {
  try { const l = JSON.parse(Q.alLog.get(rid)?.al_log || '[]'); return Array.isArray(l) ? l : []; } catch { return []; }
}

function doLive(rid, action, arg) {
  const rd = Q.rdById.get(rid);
  const next = applyLiveAction(loadItems(rid), parseLive(rd.live), action, arg, Date.now());
  const events = next._events;
  delete next._events;
  if (events?.length) appendAlLog(rid, events);
  Q.setLive.run(JSON.stringify(next), rid);
  broadcastLive(rid);
  return next;
}

POST('/api/rundowns/:id/live/:action', needRd('operator'), (req) => {
  const rd = getRundown(req.params.id);
  const body = { ...(req.body || {}) };
  const t = readSeconds(body);
  if (t != null) body.seconds = t;
  const live = doLive(rd.id, req.params.action, body);
  return { live, serverNow: Date.now() };
});

// Gemessene Zeiten eines gesicherten Laufs (Show oder Probe) als neue Soll-Dauern übernehmen
POST('/api/rundowns/:id/apply-times', needRd('editor'), (req) => {
  const rd = getRundown(req.params.id);
  const live = parseLive(rd.live);
  const run = req.body.source === 'probe' ? (live.probes || [])[Number(req.body.index)] : req.body.source === 'current' ? { history: live.history || {} } : live.show;
  if (!run || !Object.keys(run.history || {}).length) fail(404, 'Für diesen Lauf gibt es keine gemessenen Zeiten');
  const only = Array.isArray(req.body.ids) ? new Set(req.body.ids.map(Number)) : null;
  const ops = [];
  tx(() => {
    for (const it of loadItems(rd.id)) {
      const sec = run.history[it.id];
      if (it.type !== 'item' || sec == null || (only && !only.has(it.id))) continue;
      const dur = Math.max(0, Math.min(24 * 3600, Math.round(sec)));
      const d = hist.itemDiff(it, { duration: dur });
      if (!d) continue;
      updateRow('items', it.id, { duration: dur }, ['duration']);
      ops.push({ t: 'item', id: it.id, ...d });
    }
  });
  if (ops.length) hist.record(rd.id, req.user, 'times.apply', req.body.source === 'probe' ? 'Probezeiten' : req.body.source === 'current' ? 'Gemessene Zeiten' : 'Showzeiten', ops);
  changed(rd.id, req);
  return { changed: ops.length, ...payload(Q.rdById.get(rd.id)) };
});

// Protokoll der Aufnahmeleitung (Nachbericht, Marker-Export als EDL)
GET('/api/rundowns/:id/al-log', needRd('viewer'), (req) => ({ log: alLogOf(getRundown(req.params.id).id), serverNow: Date.now() }));

// ---------- Öffentlich (nur lesen)
function publicRundown(token) {
  const rd = Q.rdByPublic.get(String(token));
  if (!rd || !rd.public_enabled) fail(404, 'Dieser Link ist nicht (mehr) gültig');
  return rd;
}
GET('/api/public/:token', (req) => payload(publicRundown(req.params.token), { publicView: true }));
GET('/api/public/:token/al-log', (req) => ({ log: alLogOf(publicRundown(req.params.token).id), serverNow: Date.now() }));

// ---------- Companion / externe Steuerung
function companionRundown(token) {
  const rd = Q.rdByCompanion.get(String(token));
  if (!rd) fail(404, 'Unbekannter oder gesperrter API-Token');
  return rd;
}

/** Zeitangabe aus Query/Body lesen: seconds=90 | minutes=1.5 | time=01:30 / 1:00:00 / 5m / 90s */
function readSeconds(q, key = 'seconds') {
  if (q[key] !== undefined && q[key] !== '') { const n = Number(q[key]); if (Number.isFinite(n)) return Math.round(n); }
  if (q.minutes !== undefined && q.minutes !== '') { const n = Number(String(q.minutes).replace(',', '.')); if (Number.isFinite(n)) return Math.round(n * 60); }
  if (q.time !== undefined && q.time !== '') return parseDuration(String(q.time));
  return null;
}

/** Ein Programmpunkt mit berechneten Plan- und Ist-Werten */
function cueOut(it, ctx) {
  if (!it) return null;
  const { sched, cols, live, st } = ctx;
  const s = sched.map.get(it.id) || {};
  const hist = live.history?.[it.id];
  const isLive = st.running && st.current.id === it.id;
  const base = {
    id: it.id,
    type: it.type,
    title: it.title,
    color: it.color || null,
  };
  if (it.type === 'block') return { ...base, planned_start: fmtClock(s.start, true), planned_end: fmtClock(s.end, true), duration_sec: s.duration || 0, duration: fmtDuration(s.duration || 0, { hours: true }), item_count: s.count || 0 };
  if (it.type === 'block_end') return { ...base, block: s.block?.title ?? null };
  const out = {
    ...base,
    nr: s.nr,
    description: it.description,
    script: it.script || '',
    block: s.block?.title ?? null,
    duration_sec: it.duration,
    duration: fmtDuration(it.duration),
    planned_start: fmtClock(s.start, true),
    planned_end: fmtClock(s.end, true),
    status: isLive ? 'live' : st.running && st.next?.id === it.id ? 'next' : hist != null ? 'done' : 'upcoming',
    actual_duration_sec: hist ?? null,
    actual_duration: hist != null ? fmtDuration(hist) : null,
    deviation_sec: hist != null ? hist - it.duration : null,
    cells: Object.fromEntries(cols.map((c) => [c.name, it.cells?.[c.id] || ''])),
    cells_by_id: it.cells || {},
  };
  if (isLive) {
    Object.assign(out, {
      started_at: new Date(live.itemStartedAt).toISOString(),
      started_clock: fmtTime(live.itemStartedAt),
      elapsed_sec: Math.round(st.elapsed),
      elapsed: fmtDuration(st.elapsed),
      remaining_sec: Math.round(st.remaining),
      remaining: fmtCountdown(st.remaining),
      effective_duration_sec: Math.round(st.eff),
      effective_duration: fmtDuration(st.eff),
      adjust_sec: st.adjust,
      progress: Math.round(st.progress * 100),
      overtime: st.remaining < 0,
      state: st.paused ? 'paused' : st.remaining < 0 ? 'overtime' : st.remaining <= 60 ? 'warning' : 'running',
      paused: !!st.paused,
    });
  }
  return out;
}

function apiContext(rd) {
  const items = loadItems(rd.id);
  const live = parseLive(rd.live);
  const now = Date.now();
  const st = liveStatus(items, live, now);
  const sched = computeSchedule(items, parseClock(rd.start_time));
  const cols = Q.colsByRd.all(rd.id).map(colOut);
  return { rd, items, live, now, st, sched, cols };
}

function liveSummary(ctx) {
  const { st, live, now } = ctx;
  return {
    running: !!st.running,
    state: st.running ? (st.paused ? 'paused' : st.remaining < 0 ? 'overtime' : st.remaining <= 60 ? 'warning' : 'running') : live.endedAt ? 'ended' : 'stopped',
    mode: st.running ? (st.probe ? 'probe' : 'show') : null,
    paused: !!st.paused,
    paused_for_sec: st.paused ? Math.round(st.pausedFor) : 0,
    current_id: st.running ? st.current.id : null,
    next_id: st.running ? st.next?.id ?? null : null,
    started_at: st.running ? new Date(st.startedAt).toISOString() : null,
    live_since: st.running ? fmtTime(st.startedAt, false) : null,
    delta_sec: st.running ? Math.round(st.delta) : 0,
    delta: st.running ? fmtDuration(st.delta, { sign: true }).replace('−', '-') : '00:00',
    projected_end: st.running ? fmtTime(st.projectedEnd) : null,
    ended_at: live.endedAt ? new Date(live.endedAt).toISOString() : null,
    server_time: new Date(now).toISOString(),
    clock: fmtTime(now),
  };
}

/** Aktueller Cue inkl. vorherigem und nächstem Punkt */
function cueInfo(rd) {
  const ctx = apiContext(rd);
  const play = ctx.items.filter((i) => i.type === 'item');
  const idx = ctx.st.running ? ctx.st.index : -1;
  return {
    rundown: { id: rd.id, title: rd.title },
    live: liveSummary(ctx),
    current: idx >= 0 ? cueOut(play[idx], ctx) : null,
    next: idx >= 0 ? cueOut(play[idx + 1], ctx) : cueOut(play[0], ctx),
    previous: idx > 0 ? cueOut(play[idx - 1], ctx) : null,
    position: idx >= 0 ? idx + 1 : 0,
    count: play.length,
  };
}

/** Kompletter Rundown mit berechneten Zeiten */
function rundownExport(rd) {
  const ctx = apiContext(rd);
  return {
    rundown: {
      id: rd.id, title: rd.title, date: rd.event_date, start_time: rd.start_time,
      total_sec: ctx.sched.total, total: fmtDuration(ctx.sched.total, { hours: true }),
      planned_end: fmtClock(ctx.sched.end, true), item_count: ctx.sched.count, updated_at: rd.updated_at,
    },
    columns: ctx.cols.map((c) => ({ id: c.id, name: c.name, public: c.is_public })),
    live: liveSummary(ctx),
    items: ctx.items.map((i) => cueOut(i, ctx)),
  };
}

function companionStatus(rd) {
  const ctx = apiContext(rd);
  const { st, sched, items, now } = ctx;
  const first = items.find((i) => i.type === 'item');
  const remaining = st.running ? st.remaining : 0;
  return {
    rundown: rd.title,
    running: !!st.running,
    state: st.running ? (st.paused ? 'paused' : st.remaining < 0 ? 'overtime' : st.remaining <= 60 ? 'warning' : 'running') : 'stopped',
    mode: st.running ? (st.probe ? 'probe' : 'show') : null,
    paused: !!st.paused,
    cue_id: st.running ? st.current.id : null,
    title: st.running ? st.current.title : '',
    description: st.running ? st.current.description : '',
    next: st.running ? st.next?.title || '' : first?.title || '',
    next_id: st.running ? st.next?.id ?? null : first?.id ?? null,
    remaining: st.running ? fmtCountdown(remaining) : '--:--',
    remaining_sec: st.running ? Math.round(remaining) : 0,
    elapsed: st.running ? fmtDuration(st.elapsed) : '--:--',
    elapsed_sec: st.running ? Math.round(st.elapsed) : 0,
    duration: st.running ? fmtDuration(st.eff) : '--:--',
    duration_sec: st.running ? Math.round(st.eff) : 0,
    adjust_sec: st.running ? st.adjust : 0,
    delta: st.running ? fmtDuration(st.delta, { sign: true }).replace('−', '-') : '00:00',
    delta_sec: st.running ? Math.round(st.delta) : 0,
    live_since: st.running ? fmtTime(st.startedAt, false) : '',
    projected_end: st.running ? fmtTime(st.projectedEnd) : '',
    item_number: st.running ? st.index + 1 : 0,
    item_count: sched.count,
    progress: st.running ? Math.round(st.progress * 100) : 0,
    clock: fmtTime(now),
  };
}

const needTime = (v) => { if (v == null) fail(400, 'Zeitangabe fehlt: seconds=…, minutes=… oder time=mm:ss'); return v; };
const COMPANION_ACTIONS = {
  start: ['start', (q) => ({ itemId: q.item ?? q.itemId, mode: q.mode })], probe: ['start', (q) => ({ itemId: q.item ?? q.itemId, mode: 'probe' })], pause: ['pause'], resume: ['resume'], toggle: ['toggle'], playpause: ['toggle'], next: ['next'], prev: ['prev'], back: ['prev'], stop: ['stop'], reset: ['reset'],
  plus: ['adjust', (q) => ({ seconds: Math.abs(readSeconds(q) ?? 60) })],
  minus: ['adjust', (q) => ({ seconds: -Math.abs(readSeconds(q) ?? 60) })],
  add: ['adjust', (q) => ({ seconds: needTime(readSeconds(q)) })], // vorzeichenbehaftet, z. B. seconds=-30
  set: ['setRemaining', (q) => ({ seconds: needTime(readSeconds(q, q.remaining !== undefined ? 'remaining' : 'seconds')) })],
  setremaining: ['setRemaining', (q) => ({ seconds: needTime(readSeconds(q, q.remaining !== undefined ? 'remaining' : 'seconds')) })],
  setduration: ['setDuration', (q) => ({ seconds: needTime(readSeconds(q, q.duration !== undefined ? 'duration' : 'seconds')) })],
  goto: ['goto', (q) => ({ itemId: q.item ?? q.itemId })],
};

const companionGet = (req) => companionStatus(companionRundown(req.params.token));
GET('/api/companion/:token', companionGet);
GET('/api/companion/:token/status', companionGet);
GET('/api/companion/:token/cue', (req) => cueInfo(companionRundown(req.params.token)));
GET('/api/companion/:token/rundown', (req) => rundownExport(companionRundown(req.params.token)));
GET('/api/companion/:token/text/:field', (req, res) => {
  const s = companionStatus(companionRundown(req.params.token));
  if (!(req.params.field in s)) fail(404, 'Unbekanntes Feld. Verfügbar: ' + Object.keys(s).join(', '));
  send(res, 200, String(s[req.params.field] ?? ''));
});

function companionAction(req) {
  const rd = companionRundown(req.params.token);
  const a = COMPANION_ACTIONS[req.params.action.toLowerCase()];
  if (!a) fail(404, 'Unbekannte Aktion. Erlaubt: ' + Object.keys(COMPANION_ACTIONS).join(', ') + ' (GET: status, cue, rundown, text/<feld>)');
  const q = { ...req.query, ...req.body };
  const arg = a[1] ? a[1](q) : {};
  if (['adjust', 'setRemaining', 'setDuration'].includes(a[0]) && !parseLive(rd.live).running) fail(409, 'Kein laufender Punkt – Zeit kann nur während Live geändert werden');
  doLive(rd.id, a[0], arg);
  return cueInfo(Q.rdById.get(rd.id));
}
POST('/api/companion/:token/:action', companionAction);
GET('/api/companion/:token/:action', companionAction); // GET erlaubt, da manche Tools nur GET können

// Gleiche Abfragen für angemeldete Benutzer (Cookie oder Bearer-Token)
GET('/api/rundowns/:id/cue', needRd('viewer'), (req) => cueInfo(getRundown(req.params.id)));
GET('/api/rundowns/:id/export', needRd('viewer'), (req) => rundownExport(getRundown(req.params.id)));

// ---------- Backups (nur Admin – Backups enthalten Benutzer, Passwort-Hashes und Tokens)
GET('/api/backups', need('admin'), () => ({ status: backup.status(), backups: backup.list() }));

PATCH('/api/backups/settings', need('admin'), (req) => ({ settings: backup.saveSettings(req.body), status: backup.status() }));

POST('/api/backups', need('admin'), (req) => {
  const b = backup.create('manuell', req.body.label);
  console.log(`[Backup] Manuelles Backup von ${req.user.email}: ${b.name}`);
  return { backup: b, status: backup.status() };
});

GET('/api/backups/:name/download', need('admin'), (req, res) => {
  const file = backup.fileFor(req.params.name);
  const st = fs.statSync(file);
  res.writeHead(200, {
    'Content-Type': 'application/vnd.sqlite3',
    'Content-Length': st.size,
    'Content-Disposition': `attachment; filename="${req.params.name}"`,
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(file).pipe(res);
  return undefined;
});

DELETE('/api/backups/:name', need('admin'), (req) => { backup.remove(req.params.name); return { ok: true, status: backup.status() }; });

rawRoute('POST', '/api/backups/upload', need('admin'), async (req) => {
  const buf = await readRaw(req, 500 * 1024 * 1024);
  if (!buf.length) fail(400, 'Leere Datei');
  const b = backup.importUpload(buf, String(req.query.name || ''));
  console.log(`[Backup] Hochgeladen von ${req.user.email}: ${b.name}`);
  return { backup: b };
});

POST('/api/backups/:name/restore', need('admin'), (req, res) => {
  if (req.body.confirm !== true) fail(400, 'Bestätigung fehlt');
  const { summary, safety } = backup.prepareRestore(req.params.name);
  console.log(`[Backup] Wiederherstellung von ${req.params.name} durch ${req.user.email} – aktueller Stand gesichert als ${safety.name}. Server startet neu …`);
  res.on('finish', () => setTimeout(() => shutdown(backup.RESTART_EXIT_CODE), 300));
  return { ok: true, summary, safety: safety.name, restarting: true };
});

// ---------- Präsenz
POST('/api/presence/focus', need('viewer'), (req) => {
  const c = [...clients].find((x) => x.id === String(req.body.clientId || req.headers['x-client-id'] || ''));
  if (!c || !c.user || c.user.id !== req.user.id) fail(404, 'Verbindung nicht gefunden');
  const itemId = Number(req.body.itemId);
  const f = String(req.body.field || '');
  const next = itemId && FOCUS_FIELD_RE.test(f) ? { itemId, field: f } : null;
  if (JSON.stringify(next) !== JSON.stringify(c.focus)) { c.focus = next; broadcastPresence(c.rundownId); }
  return { ok: true };
});

GET('/api/presence/:id', needRd('viewer'), (req) => presenceFor(getRundown(req.params.id).id));

// ---------- Echtzeit-Stream
GET('/api/events', (req, res) => {
  const q = req.query;
  const client = { res, id: `c${++clientSeq}-${randomToken(4)}`, user: req.user || null, rundownId: null, isPublic: false, lobby: false,
    view: ['editor', 'live', 'prompter', 'timer', 'aufnahmeleitung', 'regie', 'stapel', 'schild', 'overview', 'users'].includes(q.view) ? q.view : 'editor', since: Date.now(), focus: null };
  if (q.public) {
    const rd = publicRundown(q.public);
    client.rundownId = rd.id;
    client.isPublic = true;
  } else {
    if (!req.user) fail(401, 'Nicht angemeldet');
    if (q.rundown) {
      const rd = getRundown(q.rundown);
      if (!roleFor(req.user, rd.id)) fail(404, 'Rundown nicht gefunden');
      client.rundownId = rd.id;
    }
    else client.lobby = true;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`retry: 2000\n\n`);
  clients.add(client);
  sse(client, 'hello', { clientId: client.id, serverNow: Date.now(), version: VERSION });
  if (client.rundownId) sse(client, 'presence', presenceFor(client.rundownId));
  broadcastPresence(client.rundownId);
  if (!client.rundownId && client.user) broadcastLobby();
  req.on('close', () => { clients.delete(client); broadcastPresence(client.rundownId); if (!client.rundownId && client.user) broadcastLobby(); });
  return undefined;
});

/* ================================================================== HTTP-Server */
const MUST_CHANGE_ALLOWED = ['/api/auth/status', '/api/auth/logout', '/api/auth/initial-password', '/api/auth/password', '/api/health', '/api/reset', '/api/public', '/api/companion'];

const PAGES = [
  [/^\/p\/[^/]+\/?$/, 'index.html'],
  [/^\/timer\/p\/[^/]+\/?$/, 'timer.html'],
  [/^\/timer\/\d+\/?$/, 'timer.html'],
  [/^\/live\/p\/[^/]+\/?$/, 'live.html'],
  [/^\/live\/\d+\/?$/, 'live.html'],
  [/^\/prompter\/p\/[^/]+\/?$/, 'prompter.html'],
  [/^\/prompter\/\d+\/?$/, 'prompter.html'],
  [/^\/print\/p\/[^/]+\/?$/, 'print.html'],
  [/^\/print\/\d+\/?$/, 'print.html'],
  // Aufnahmeleitung (Bedienung + Schild), Regie, Vollbild-Stapel, Schild – aus FF-Aufnahmeleitung-Tool
  [/^\/(aufnahmeleitung|regie|stapel|schild)\/p\/[^/]+\/?$/, 'al.html'],
  [/^\/(aufnahmeleitung|regie|stapel|schild)\/\d+\/?$/, 'al.html'],
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  // Allgemeine API-Adresse /api/v1/<token>/… (gleichwertig zu /api/companion/<token>/…)
  const pathname = url.pathname.startsWith('/api/v1/') ? '/api/companion/' + url.pathname.slice(8) : url.pathname;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');

  // CORS nur für Companion-/Status-Endpunkte (z. B. für Overlays oder andere Tools)
  if (pathname.startsWith('/api/companion/')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  }

  if (pathname.startsWith('/api/')) {
    const r = routes.find((x) => x.method === req.method && x.re.test(pathname));
    if (!r) return send(res, 404, { error: 'Endpunkt nicht gefunden' });
    try {
      const m = pathname.match(r.re);
      req.params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      req.query = Object.fromEntries(url.searchParams);
      // Benutzer aus Cookie oder Bearer-Token
      const cookies = parseCookies(req.headers.cookie);
      let token = cookies[COOKIE];
      const auth = req.headers.authorization || '';
      if (auth.startsWith('Bearer ')) token = auth.slice(7);
      const p = verifyToken(token, SECRET);
      if (p) {
        const u = Q.userById.get(p.uid);
        if (u && u.token_version === p.tv) req.user = u;
      }
      if (req.user?.must_change && !MUST_CHANGE_ALLOWED.some((x) => pathname === x || pathname.startsWith(x + '/'))) {
        fail(403, 'Bitte zuerst ein neues Passwort festlegen');
      }
      // CSRF-Schutz: schreibende Anfragen mit Cookie müssen JSON oder vom selben Origin sein
      if (req.method !== 'GET' && !pathname.startsWith('/api/companion/') && cookies[COOKIE] && !auth) {
        const origin = req.headers.origin;
        const host = req.headers['x-forwarded-host'] || req.headers.host;
        if (origin && new URL(origin).host !== host) fail(403, 'Ungültiger Ursprung');
      }
      req.body = req.method === 'GET' || r.raw ? {} : await readBody(req);
      let result;
      for (const h of r.handlers) {
        result = await h(req, res);
        if (res.writableEnded || res.headersSent) return;
      }
      if (result === undefined) return;
      return send(res, 200, result);
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error(e);
      if (!res.headersSent) send(res, status, { error: status >= 500 ? 'Interner Serverfehler' : e.message, ...(status < 500 && e.extra ? e.extra : {}) });
      return;
    }
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Methode nicht erlaubt' });
  for (const [re, file] of PAGES) if (re.test(pathname)) return serveFile(req, res, path.join(ROOT, 'public', file));
  if (tryStatic(req, res, pathname)) return;
  // SPA-Fallback
  serveFile(req, res, path.join(ROOT, 'public', 'index.html'));
});

server.keepAliveTimeout = 65000;
server.listen(PORT, HOST, () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  console.log(`\n  FF Rundown v${VERSION} läuft`);
  console.log(`  Lokal:     http://localhost:${PORT}`);
  for (const ip of ips) console.log(`  Netzwerk:  http://${ip}:${PORT}`);
  console.log(`  Daten:     ${DATA_DIR}`);
  console.log(`  Backups:   ${backup.BACKUP_DIR} (${backup.getSettings().enabled ? `alle ${backup.getSettings().interval_hours} Std., ${backup.getSettings().keep} behalten` : 'automatisch aus'})`);
  backup.startScheduler();
  if (Q.userCount.get().n === 0) console.log('\n  → Erster Start: Im Browser öffnen und Admin-Konto anlegen.');
  console.log('');
});

function shutdown(code = 0) {
  for (const c of clients) { try { c.res.end(); } catch { /* */ } }
  server.close(() => { try { db.close(); } catch { /* */ } process.exit(code); });
  setTimeout(() => process.exit(code), 3000).unref();
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
