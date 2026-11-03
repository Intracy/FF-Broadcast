import { parseDuration, fmtDuration, fmtCountdown, parseClock, fmtClock, fmtTime, computeSchedule, liveStatus } from '/shared/timing.js';
import { qrSvg, qrPng } from '/js/qr.js';
import { h, fill, icon, themeToggle, $, $$, toast, modal, confirmDialog, confirmTyped, formModal, popover, closePop, menu, copyText, autosize, debounce } from '/js/ui.js';

/* ================================================================== Zustand */
const ROLES = ['viewer', 'operator', 'editor', 'admin'];
const ROLE_LABEL = { admin: 'Admin', editor: 'Editor', operator: 'Operator', viewer: 'Viewer' };
const ROLE_HELP = {
  admin: 'Voller Zugriff inkl. Benutzerverwaltung.',
  editor: 'Rundowns anlegen, bearbeiten, löschen, Links & Companion verwalten, Live steuern.',
  operator: 'Rundowns ansehen und die Live-Steuerung bedienen (Start, Weiter, ±Zeit).',
  viewer: 'Rundowns und Live-Status nur ansehen.',
};
const COLORS = ['#45197a', '#6d28d9', '#1e40af', '#0369a1', '#0e7490', '#0f766e', '#166534', '#4d7c0f', '#a16207', '#c2410c', '#b91c1c', '#be185d', '#86198f', '#3f3f46', '#1f2937'];

const S = {
  user: null, needsSetup: false, version: '',
  es: null, clientId: null, helloCount: 0,
  rd: null, offset: 0, publicToken: null,
  readMode: false, step: 60, focusId: null, liveKey: '', dragging: false, deferred: null,
  hidden: new Set(), prefs: {},
};
let R = {}; // DOM-Referenzen der aktuellen Seite
let tickTimer = null;

const rank = (r) => ROLES.indexOf(r);
const can = (role) => !!S.user && !S.publicToken && rank(S.user.role) >= rank(role);
const canEdit = () => can('editor') && !S.readMode;
const canOperate = () => can('operator');

/* ================================================================== API */
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Client-Id': S.clientId || '' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data = null;
  try { data = await res.json(); } catch { /* leer */ }
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith('/api/auth') && !S.publicToken) { S.user = null; router(); }
    throw new Error(data?.error || `Fehler ${res.status}`);
  }
  return data;
}

/* ================================================================== Echtzeit */
function connect(params, handlers) {
  disconnect();
  S.helloCount = 0;
  const es = new EventSource('/api/events?' + new URLSearchParams(params));
  S.es = es;
  let banner = null;
  es.addEventListener('hello', (e) => {
    const d = JSON.parse(e.data);
    S.clientId = d.clientId;
    if (d.version && S.version && d.version !== S.version) showUpdateBanner(d.version);
    banner?.remove(); banner = null;
    focusSent = 'null';
    if (S.helloCount++ > 0) handlers.reconnect?.();
  });
  es.onerror = () => {
    if (!banner && S.es === es) banner = document.body.appendChild(h('div', { class: 'conn' }, 'Verbindung unterbrochen – verbinde neu …'));
  };
  for (const [ev, fn] of Object.entries(handlers)) if (ev !== 'reconnect') es.addEventListener(ev, (e) => fn(JSON.parse(e.data || '{}')));
  es.addEventListener('logout', () => { disconnect(); S.user = null; toast('Sitzung beendet – bitte neu anmelden'); router(); });
}
function showUpdateBanner(v) {
  if ($('.update-banner')) return;
  document.body.append(h('div', { class: 'update-banner' },
    icon('rotate'), h('span', null, `Neue Version ${v} verfügbar`),
    h('button', { class: 'btn sm primary', onclick: () => location.reload() }, 'Jetzt neu laden')));
}
function disconnect() {
  S.es?.close(); S.es = null; S.clientId = null;
  $('.conn')?.remove();
}

/* ================================================================== Theme & Prefs */
function setTheme(t) {
  document.documentElement.dataset.theme = t;
  localStorage.setItem('ffr.theme', t);
}
const theme = () => document.documentElement.dataset.theme || 'dark';
function loadPrefs(rid) {
  try { S.hidden = new Set(JSON.parse(localStorage.getItem('ffr.hidden.' + rid) || '[]')); } catch { S.hidden = new Set(); }
  try { S.prefs = JSON.parse(localStorage.getItem('ffr.prefs') || '{}'); } catch { S.prefs = {}; }
  S.step = S.prefs.step || 60;
}
function savePrefs() {
  if (S.rd) localStorage.setItem('ffr.hidden.' + S.rd.rundown.id, JSON.stringify([...S.hidden]));
  localStorage.setItem('ffr.prefs', JSON.stringify({ ...S.prefs, step: S.step }));
}

/* ================================================================== Router */
window.addEventListener('hashchange', () => router());

function teardown() {
  flushSaves();
  disconnect();
  clearInterval(tickTimer); tickTimer = null;
  closePop();
  S.rd = null; R = {}; S.presence = null; focusSent = 'null';
  $$('.modal-back').forEach((m) => m.remove());
}

async function router() {
  teardown();
  const pm = location.pathname.match(/^\/p\/([^/]+)/);
  if (pm) return viewPublic(decodeURIComponent(pm[1]));
  const rm = location.hash.match(/^#\/reset\/([A-Za-z0-9_-]+)/);
  if (rm) return viewReset(rm[1]);
  if (S.needsSetup) return viewSetup();
  if (!S.user) return viewLogin();
  if (S.user.must_change) return viewMustChange();
  const hash = location.hash || '#/rundowns';
  let m;
  if ((m = hash.match(/^#\/rundown\/(\d+)/))) return viewRundown(Number(m[1]));
  if (hash === '#/users' && can('admin')) return viewUsers();
  if (hash === '#/system' && can('admin')) return viewSystem();
  if (hash !== '#/rundowns') history.replaceState(null, '', '#/rundowns');
  return viewRundowns();
}

const go = (hash) => { if (location.hash === hash) router(); else location.hash = hash; };

/* ================================================================== Gerüst */
function userMenu(anchor) {
  const u = S.user;
  popover(anchor, [
    h('div', { class: 'um-head' },
      h('div', { class: `avatar role-${u.role}` }, initials(u)),
      h('div', { class: 'um-who' }, h('b', null, u.name || u.email.split('@')[0]), h('span', null, u.email)),
      h('span', { class: `role-badge role-${u.role}` }, ROLE_LABEL[u.role])),
    h('div', { class: 'pop-sep' }),
    h('button', { class: 'mi', onclick: () => { closePop(); changePassword(); } }, icon('key'), 'Passwort ändern'),
    can('admin') ? h('button', { class: 'mi', onclick: () => { closePop(); go('#/users'); } }, icon('users'), 'Benutzer verwalten') : null,
    can('admin') ? h('button', { class: 'mi', onclick: () => { closePop(); go('#/system'); } }, icon('database'), 'System & Backups') : null,
    h('button', { class: 'mi', onclick: () => { closePop(); document.querySelector('.topbar .theme-toggle')?.click(); } }, icon(theme() === 'dark' ? 'sun' : 'moon'), theme() === 'dark' ? 'Helles Design' : 'Dunkles Design'),
    h('div', { class: 'pop-sep' }),
    h('button', { class: 'mi danger-mi', onclick: () => { closePop(); logout(); } }, icon('logout'), 'Abmelden'),
    S.version ? h('div', { class: 'um-ver' }, `FF Rundown v${S.version}`) : null,
  ]);
}

function topbar(active) {
  const brand = (tag, attrs) => h(tag, { class: 'brand', ...attrs }, h('span', { class: 'brand-mark' }, icon('logo')), h('span', { class: 'brand-name' }, h('b', null, 'Frankenfinals'), h('span', null, 'Rundown')));
  if (S.publicToken) {
    return h('header', { class: 'topbar' },
      brand('div'),
      h('span', { class: 'badge ro-badge' }, icon('eye'), h('span', null, 'Nur Lesen')),
      h('div', { class: 'spacer' }), themeToggle());
  }
  return h('header', { class: 'topbar' },
    brand('a', { href: '#/rundowns' }),
    h('nav', { class: 'nav' },
      h('a', { href: '#/rundowns', class: active === 'rundowns' ? 'active' : '' }, icon('list'), h('span', null, 'Rundowns')),
      can('admin') ? h('a', { href: '#/users', class: active === 'users' ? 'active' : '' }, icon('users'), h('span', null, 'Benutzer')) : null,
      can('admin') ? h('a', { href: '#/system', class: active === 'system' ? 'active' : '' }, icon('database'), h('span', null, 'System')) : null),
    h('div', { class: 'spacer' }),
    themeToggle(),
    h('button', { class: 'user-btn', title: 'Konto', onclick: (e) => userMenu(e.currentTarget) },
      h('span', { class: `avatar sm role-${S.user.role}` }, initials(S.user)),
      h('span', { class: 'user-btn-txt' }, h('b', null, S.user.name || S.user.email.split('@')[0]), h('span', null, ROLE_LABEL[S.user.role])),
      icon('chevronDown')));
}

function shell(active, ...content) {
  document.body.replaceChildren(topbar(active), h('main', null, ...content));
  window.scrollTo(0, 0);
}

async function logout() {
  await api('POST', '/api/auth/logout').catch(() => {});
  S.user = null;
  location.hash = '#/rundowns';
  router();
}

function changePassword() {
  formModal({
    title: 'Passwort ändern',
    fields: [
      { name: 'current', label: 'Aktuelles Passwort', type: 'password', required: true, autocomplete: 'current-password' },
      { name: 'password', label: 'Neues Passwort', type: 'password', required: true, minlength: 8, autocomplete: 'new-password', hint: 'Mindestens 8 Zeichen. Andere Sitzungen werden abgemeldet.' },
      { name: 'repeat', label: 'Neues Passwort wiederholen', type: 'password', required: true, autocomplete: 'new-password' },
    ],
    onSubmit: async (v) => {
      if (v.password !== v.repeat) throw new Error('Die Passwörter stimmen nicht überein');
      await api('POST', '/api/auth/password', { current: v.current, password: v.password });
      toast('Passwort geändert', 'ok');
    },
  });
}

/* ================================================================== Login & Setup */
function authPage(subtitle, fields, submitLabel, onSubmit, opts = {}) {
  const err = h('div', { class: 'form-error' });
  const inputs = fields.map((f) => h('input', { class: 'input', ...f }));
  const btn = h('button', { class: 'btn primary', type: 'submit' }, submitLabel);
  const form = h('form', { class: 'auth-card' },
    h('div', { class: 'brand auth-brand-m' }, h('span', { class: 'brand-mark' }, icon('logo')), h('span', { class: 'brand-name' }, h('b', null, 'Frankenfinals'), h('span', null, 'Rundown'))),
    h('h1', { class: 'auth-title' }, opts.title || (submitLabel === 'Anmelden' ? 'Anmelden' : 'Einrichtung')),
    h('p', null, subtitle),
    inputs.map((i, n) => h('label', { class: 'field' }, h('span', null, fields[n]['aria-label']), i)),
    err, btn, opts.extra || null);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    btn.disabled = true;
    try { await onSubmit(Object.fromEntries(inputs.map((i) => [i.name, i.value]))); }
    catch (ex) { err.textContent = ex.message; }
    finally { btn.disabled = false; }
  });
  document.body.replaceChildren(h('div', { class: 'auth-wrap' },
    h('div', { class: 'auth-theme' }, themeToggle()),
    h('aside', { class: 'auth-side' },
      h('div', { class: 'brand' }, h('span', { class: 'brand-mark' }, icon('logo')), h('span', { class: 'brand-name' }, h('b', null, 'Frankenfinals'), h('span', null, 'Rundown'))),
      h('h2', null, 'Ablauf im Griff –', h('br'), 'live auf jedem Gerät.'),
      h('ul', null,
        h('li', null, icon('list'), 'Rundowns mit Blöcken, Farben & eigenen Spalten'),
        h('li', null, icon('radio'), 'Live-Steuerung mit Restzeit und Abweichung'),
        h('li', null, icon('globe'), 'Öffentlicher Link & QR-Code für Zuschauer'),
        h('li', null, icon('code'), 'API für Companion, Stream Deck & Overlays'))),
    form));
  setTimeout(() => inputs[0]?.focus(), 20);
}

function viewLogin() {
  authPage('Melde dich mit deiner E-Mail-Adresse an.', [
    { name: 'email', type: 'email', 'aria-label': 'E-Mail', autocomplete: 'username', required: true },
    { name: 'password', type: 'password', 'aria-label': 'Passwort', autocomplete: 'current-password', required: true },
  ], 'Anmelden', async (v) => {
    const r = await api('POST', '/api/auth/login', v);
    S.user = r.user;
    router();
  }, { extra: h('p', { class: 'auth-forgot' }, icon('info'), h('span', null, h('b', null, 'Passwort vergessen?'), ' Ein Admin kann dir unter „Benutzer“ einen Link zum Zurücksetzen erzeugen.')) });
}

/** Seite für Reset- und Einladungslinks */
async function viewReset(token) {
  let info;
  try { info = await api('GET', '/api/reset/' + encodeURIComponent(token)); }
  catch (e) {
    authPage(e.message, [], 'Zur Anmeldung', async () => { history.replaceState(null, '', '#/rundowns'); router(); }, { title: 'Link ungültig' });
    return;
  }
  const invite = info.purpose === 'invite';
  authPage(
    invite ? `Hallo${info.name ? ' ' + info.name : ''}! Lege dein Passwort für ${info.email} fest, um FF Rundown zu nutzen.` : `Neues Passwort für ${info.email} festlegen.`,
    [
      { name: 'password', type: 'password', 'aria-label': 'Neues Passwort (mind. 8 Zeichen)', autocomplete: 'new-password', required: true, minlength: 8 },
      { name: 'repeat', type: 'password', 'aria-label': 'Passwort wiederholen', autocomplete: 'new-password', required: true, minlength: 8 },
    ],
    invite ? 'Passwort festlegen & loslegen' : 'Passwort speichern',
    async (v) => {
      if (v.password !== v.repeat) throw new Error('Die Passwörter stimmen nicht überein');
      const r = await api('POST', '/api/reset/' + encodeURIComponent(token), { password: v.password });
      S.user = r.user;
      history.replaceState(null, '', '#/rundowns');
      toast(invite ? 'Willkommen! Dein Passwort ist gespeichert.' : 'Neues Passwort gespeichert', 'ok');
      router();
    },
    { title: invite ? 'Einladung annehmen' : 'Passwort zurücksetzen' });
}

/** Pflicht-Passwortwechsel nach temporärem Passwort */
function viewMustChange() {
  authPage(`Du hast dich mit einem temporären Passwort angemeldet. Bitte lege jetzt ein eigenes Passwort fest.`,
    [
      { name: 'password', type: 'password', 'aria-label': 'Neues Passwort (mind. 8 Zeichen)', autocomplete: 'new-password', required: true, minlength: 8 },
      { name: 'repeat', type: 'password', 'aria-label': 'Passwort wiederholen', autocomplete: 'new-password', required: true, minlength: 8 },
    ],
    'Passwort speichern',
    async (v) => {
      if (v.password !== v.repeat) throw new Error('Die Passwörter stimmen nicht überein');
      const r = await api('POST', '/api/auth/initial-password', { password: v.password });
      S.user = r.user;
      toast('Neues Passwort gespeichert', 'ok');
      router();
    },
    { title: 'Neues Passwort', extra: h('button', { class: 'btn ghost', type: 'button', style: { marginTop: '8px' }, onclick: logout }, icon('logout'), 'Abmelden') });
}

function viewSetup() {
  authPage('Willkommen! Lege das erste Admin-Konto an.', [
    { name: 'name', type: 'text', 'aria-label': 'Name', autocomplete: 'name' },
    { name: 'email', type: 'email', 'aria-label': 'E-Mail', autocomplete: 'username', required: true },
    { name: 'password', type: 'password', 'aria-label': 'Passwort (mind. 8 Zeichen)', autocomplete: 'new-password', required: true, minlength: 8 },
  ], 'Admin anlegen', async (v) => {
    const r = await api('POST', '/api/auth/setup', v);
    S.user = r.user;
    S.needsSetup = false;
    go('#/rundowns');
  });
}

/* ================================================================== Übersicht */
const fmtDate = (d) => (d ? d.split('-').reverse().join('.') : '–');

const MONTHS = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
function rdStatus(r) {
  if (r.live) return 'live';
  if (!r.event_date) return 'nodate';
  const t = todayStr();
  return r.event_date === t ? 'today' : r.event_date > t ? 'upcoming' : 'past';
}
const STATUS = {
  live: ['Live', 'Live jetzt'], today: ['Heute', 'Heute'], upcoming: ['Kommend', 'Kommende Events'],
  past: ['Vergangen', 'Vergangen'], nodate: ['Ohne Datum', 'Ohne Datum / Vorlagen'],
};
function daysUntil(date) {
  const a = new Date(todayStr() + 'T00:00:00'), b = new Date(date + 'T00:00:00');
  return Math.round((b - a) / 86400000);
}
function whenText(r) {
  if (!r.event_date) return 'Kein Datum';
  const n = daysUntil(r.event_date);
  if (n === 0) return 'Heute';
  if (n === 1) return 'Morgen';
  if (n === -1) return 'Gestern';
  if (n > 1 && n < 60) return `in ${n} Tagen`;
  if (n < -1 && n > -60) return `vor ${-n} Tagen`;
  return fmtDate(r.event_date);
}

async function viewRundowns() {
  const P = (() => { try { return JSON.parse(localStorage.getItem('ffr.overview') || '{}'); } catch { return {}; } })();
  P.view ||= 'grid'; P.sort ||= 'date'; P.filter ||= 'all';
  const saveP = () => localStorage.setItem('ffr.overview', JSON.stringify(P));
  let rds = [], fetchedAt = Date.now(), query = '';

  const content = h('div', { class: 'ov-content' });
  const sub = h('div', { class: 'muted', style: { marginTop: '4px' } });
  const chips = h('div', { class: 'chips' });
  const viewToggle = h('div', { class: 'seg' });
  const sortSel = h('select', { class: 'input sort-sel', 'aria-label': 'Sortierung', onchange: (e) => { P.sort = e.target.value; saveP(); draw(); } },
    [['date', 'Nach Datum'], ['updated', 'Zuletzt geändert'], ['title', 'Nach Name']].map(([v, l]) => h('option', { value: v, selected: P.sort === v }, l)));
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Rundown suchen …', oninput: (e) => { query = e.target.value.trim().toLowerCase(); draw(); } });

  shell('rundowns', h('div', { class: 'page ov-page' },
    h('div', { class: 'page-head' },
      h('div', null, h('div', { class: 'label' }, 'Übersicht'), h('h1', null, 'Rundowns'), sub),
      can('editor') ? h('button', { class: 'btn primary', onclick: newRundown }, icon('plus'), 'Neuer Rundown') : null),
    h('div', { class: 'ov-tools' },
      h('div', { class: 'search' }, icon('search'), search),
      chips,
      h('div', { class: 'ov-tools-right' }, sortSel, viewToggle)),
    content));

  const actionsMenu = (anchor, r) => menu(anchor, [
    { label: 'Öffnen', icon: 'edit', onClick: () => go('#/rundown/' + r.id) },
    { label: 'Live-Ansicht', icon: 'external', onClick: () => window.open('/live/' + r.id, '_blank') },
    ...(can('editor') ? [
      { label: 'Duplizieren', icon: 'copy', onClick: async () => { const d = await api('POST', `/api/rundowns/${r.id}/duplicate`); toast('Rundown dupliziert', 'ok'); go('#/rundown/' + d.id); } },
      { label: 'Löschen', icon: 'trash', onClick: async () => { if (await confirmDialog(`„${r.title}“ wird mit allen Programmpunkten gelöscht.`, { title: 'Rundown löschen?' })) { await api('DELETE', '/api/rundowns/' + r.id); toast('Gelöscht', 'ok'); load(); } } },
    ] : []),
  ]);

  const dateTile = (r) => {
    if (!r.event_date) return h('div', { class: 'date-tile none' }, icon('calendar'));
    const d = new Date(r.event_date + 'T12:00:00');
    return h('div', { class: 'date-tile' }, h('span', { class: 'wd' }, WEEKDAYS[d.getDay()]), h('b', null, String(d.getDate())), h('span', { class: 'mo' }, MONTHS[d.getMonth()]));
  };
  const statusBadge = (r) => {
    const st = rdStatus(r);
    return h('span', { class: `st-badge st-${st}` }, st === 'live' ? null : null, st === 'upcoming' || st === 'past' ? whenText(r) : STATUS[st][0]);
  };
  const livePanel = (r) => r.live ? h('div', { class: 'ov-live' },
    h('div', { class: 'ov-live-top' },
      h('span', { class: 'dot' }),
      h('span', { class: 'ov-live-title' }, r.live_title ? `${r.live_index}. ${r.live_title}` : 'Live'),
      h('span', { class: 'ov-live-rem mono', 'data-rem': r.live_remaining ?? '' })),
    h('div', { class: 'progress' }, h('span', { style: { width: (r.live_progress || 0) + '%' } }))) : null;

  const othersOnline = (r) => (r.online || []).filter((p) => p.id !== S.user.id);
  const card = (r) => h('article', { class: `ov-card st-${rdStatus(r)}`, onclick: () => go('#/rundown/' + r.id) },
    h('div', { class: 'ov-card-head' }, dateTile(r),
      h('div', { class: 'ov-card-title' },
        h('div', { class: 'ov-badges' }, statusBadge(r), r.public_enabled ? h('span', { class: 'st-badge st-public', title: 'Öffentlicher Link aktiv' }, icon('globe'), 'Öffentlich') : null),
        h('h3', null, r.title)),
      h('button', { class: 'icon-btn ov-more', title: 'Aktionen', onclick: (e) => { e.stopPropagation(); actionsMenu(e.currentTarget, r); } }, icon('more'))),
    livePanel(r),
    h('div', { class: 'ov-stats' },
      h('div', null, h('span', null, 'Zeit'), h('b', null, `${r.start_time.slice(0, 5)}–${r.end_time}`)),
      h('div', null, h('span', null, 'Dauer'), h('b', { class: 'mono' }, fmtDuration(r.total, { hours: true }))),
      h('div', null, h('span', null, 'Punkte'), h('b', null, String(r.item_count)))),
    h('div', { class: 'ov-foot' },
      othersOnline(r).length ? h('span', { class: 'ov-online' }, avatarStack(othersOnline(r), { title: 'Gerade geöffnet von ' + othersOnline(r).map((p) => p.name).join(', ') }), `${othersOnline(r).length} online`)
        : h('span', { class: 'muted' }, `${r.block_count} ${r.block_count === 1 ? 'Block' : 'Blöcke'} · ${r.column_count} Spalten`),
      h('span', { class: 'muted' }, 'geändert ' + relTime(r.updated_at))));

  const row = (r) => h('div', { class: `ov-row st-${rdStatus(r)}`, onclick: () => go('#/rundown/' + r.id) },
    dateTile(r),
    h('div', { class: 'ov-row-main' },
      h('div', { class: 'ov-row-title' }, h('b', null, r.title), statusBadge(r), r.public_enabled ? h('span', { class: 'st-badge st-public' }, icon('globe')) : null,
        avatarStack(othersOnline(r), { title: 'Gerade geöffnet von ' + othersOnline(r).map((p) => p.name).join(', ') })),
      r.live ? h('div', { class: 'ov-row-live' }, h('span', { class: 'dot' }), r.live_title ? `${r.live_index}. ${r.live_title}` : 'Live', h('span', { class: 'ov-live-rem mono', 'data-rem': r.live_remaining ?? '' }))
        : h('div', { class: 'ov-row-sub' },
          h('span', { class: 'sub-d' }, `${r.block_count} ${r.block_count === 1 ? 'Block' : 'Blöcke'} · geändert ${relTime(r.updated_at)}`),
          h('span', { class: 'sub-m' }, `${r.start_time.slice(0, 5)}–${r.end_time} · ${fmtDuration(r.total, { hours: true })} · ${r.item_count} Punkte`))),
    h('div', { class: 'ov-cell' }, h('span', null, 'Zeit'), `${r.start_time.slice(0, 5)}–${r.end_time}`),
    h('div', { class: 'ov-cell mono' }, h('span', null, 'Dauer'), fmtDuration(r.total, { hours: true })),
    h('div', { class: 'ov-cell' }, h('span', null, 'Punkte'), String(r.item_count)),
    h('div', { class: 'ov-row-act', onclick: (e) => e.stopPropagation() },
      h('button', { class: 'icon-btn', title: 'Live-Ansicht', onclick: () => window.open('/live/' + r.id, '_blank') }, icon('external')),
      h('button', { class: 'icon-btn', title: 'Aktionen', onclick: (e) => actionsMenu(e.currentTarget, r) }, icon('more'))));

  const draw = () => {
    const counts = { all: rds.length };
    for (const r of rds) counts[rdStatus(r)] = (counts[rdStatus(r)] || 0) + 1;
    sub.textContent = `${rds.length} ${rds.length === 1 ? 'Rundown' : 'Rundowns'}` + (counts.live ? ` · ${counts.live} live` : '') + (counts.upcoming ? ` · ${counts.upcoming} kommend` : '');
    chips.replaceChildren(...[['all', 'Alle'], ['live', 'Live'], ['today', 'Heute'], ['upcoming', 'Kommend'], ['past', 'Vergangen'], ['nodate', 'Ohne Datum']]
      .filter(([k]) => k === 'all' || counts[k] || P.filter === k)
      .map(([k, l]) => h('button', { class: 'chip' + (P.filter === k ? ' sel' : '') + (k === 'live' ? ' chip-live' : ''), onclick: () => { P.filter = k; saveP(); draw(); } }, l, h('span', { class: 'n' }, String(counts[k] || 0)))));
    viewToggle.replaceChildren(
      h('button', { class: P.view === 'grid' ? 'sel' : '', title: 'Kacheln', onclick: () => { P.view = 'grid'; saveP(); draw(); } }, icon('grid')),
      h('button', { class: P.view === 'list' ? 'sel' : '', title: 'Liste', onclick: () => { P.view = 'list'; saveP(); draw(); } }, icon('rows')));

    let shown = rds.filter((r) => (P.filter === 'all' || rdStatus(r) === P.filter) && (!query || r.title.toLowerCase().includes(query)));
    if (!rds.length) {
      content.replaceChildren(h('div', { class: 'ov-empty' }, icon('list'), h('b', null, 'Noch keine Rundowns'),
        h('span', null, can('editor') ? 'Lege deinen ersten Rundown an – Programmpunkte, Blöcke und Spalten kannst du danach frei gestalten.' : 'Sobald ein Editor einen Rundown anlegt, erscheint er hier.'),
        can('editor') ? h('button', { class: 'btn primary', onclick: newRundown }, icon('plus'), 'Neuer Rundown') : null));
      return;
    }
    if (!shown.length) { content.replaceChildren(h('div', { class: 'ov-empty' }, icon('search'), h('b', null, 'Keine Treffer'), h('span', null, 'Ändere Suche oder Filter.'))); return; }

    const render = (list) => P.view === 'grid' ? h('div', { class: 'ov-grid' }, list.map(card)) : h('div', { class: 'ov-list' }, list.map(row));
    if (P.sort === 'date') {
      const order = ['live', 'today', 'upcoming', 'nodate', 'past'];
      const groups = order.map((g) => [g, shown.filter((r) => rdStatus(r) === g)]).filter(([, l]) => l.length);
      groups.forEach(([g, l]) => l.sort((a, b) => g === 'past' ? (b.event_date || '').localeCompare(a.event_date || '') || b.start_time.localeCompare(a.start_time)
        : (a.event_date || '').localeCompare(b.event_date || '') || a.start_time.localeCompare(b.start_time) || a.title.localeCompare(b.title)));
      content.replaceChildren(...groups.map(([g, l]) => h('section', { class: 'ov-group' },
        h('div', { class: `ov-group-head st-${g}` }, h('span', null, STATUS[g][1]), h('span', { class: 'n' }, String(l.length))), render(l))));
    } else {
      shown = shown.slice().sort((a, b) => P.sort === 'title' ? a.title.localeCompare(b.title, 'de') : b.updated_at.localeCompare(a.updated_at));
      content.replaceChildren(render(shown));
    }
    tickRem();
  };

  const tickRem = () => {
    const el = (Date.now() - fetchedAt) / 1000;
    for (const x of content.querySelectorAll('[data-rem]')) {
      if (x.dataset.rem === '') continue;
      const rem = Number(x.dataset.rem) - el;
      x.textContent = fmtCountdown(rem);
      x.classList.toggle('red', rem < 0);
      x.classList.toggle('yellow', rem >= 0 && rem <= 60);
      const pr = x.closest('.ov-live')?.querySelector('.progress');
      if (pr) pr.className = 'progress' + (rem < 0 ? ' over' : rem <= 60 ? ' warn' : '');
    }
  };
  tickTimer = setInterval(tickRem, 1000);

  const load = async () => { rds = await api('GET', '/api/rundowns'); fetchedAt = Date.now(); draw(); };
  await load();
  connect({ view: 'overview' }, { rundowns: debounce(load, 200), reconnect: load });
}

function newRundown() {
  const today = new Date().toISOString().slice(0, 10);
  formModal({
    title: 'Neuer Rundown',
    submitLabel: 'Anlegen',
    fields: [
      { name: 'title', label: 'Titel', required: true, placeholder: 'z. B. FF Offline Finale 2026' },
      { name: 'event_date', label: 'Datum', type: 'date', value: today },
      { name: 'start_time', label: 'Startzeit', type: 'time', value: '10:00', required: true },
    ],
    onSubmit: async (v) => {
      const r = await api('POST', '/api/rundowns', v);
      go('#/rundown/' + r.id);
    },
  });
}

/* ================================================================== Benutzer */
const PERMS = [
  ['Rundowns & Live-Status ansehen', ['viewer', 'operator', 'editor', 'admin']],
  ['Live steuern (Start, Weiter, ±Zeit)', ['operator', 'editor', 'admin']],
  ['Rundowns anlegen & bearbeiten', ['editor', 'admin']],
  ['Öffentlicher Link & Companion/API', ['editor', 'admin']],
  ['Benutzer verwalten', ['admin']],
];

function relTime(sqlDate) {
  if (!sqlDate) return 'noch nie';
  const d = new Date(sqlDate.replace(' ', 'T') + (sqlDate.includes('Z') || sqlDate.includes('+') ? '' : 'Z'));
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'gerade eben';
  if (diff < 3600) return `vor ${Math.floor(diff / 60)} Min.`;
  if (diff < 86400) return `vor ${Math.floor(diff / 3600)} Std.`;
  if (diff < 172800) return 'gestern';
  if (diff < 7 * 86400) return `vor ${Math.floor(diff / 86400)} Tagen`;
  return d.toLocaleDateString('de-DE');
}

const PRESENCE_COLORS = ['#a78bfa', '#60a5fa', '#34d399', '#fbbf24', '#f472b6', '#22d3ee', '#fb923c', '#a3e635'];
const userColor = (id) => PRESENCE_COLORS[Math.abs(Number(id) || 0) % PRESENCE_COLORS.length];
const VIEW_LABEL = { editor: 'im Rundown', live: 'in der Live-Ansicht', overview: 'in der Übersicht', users: 'in der Benutzerverwaltung' };

/** Kleiner Avatar-Stapel für eine Liste von Personen */
function avatarStack(people, { max = 4, size = 'xs', title = '' } = {}) {
  if (!people?.length) return null;
  const shown = people.slice(0, max);
  return h('span', { class: `av-stack av-${size}`, title: title || people.map((p) => p.name).join(', ') },
    shown.map((p) => h('span', { class: 'av', style: `--uc:${userColor(p.id)}` }, initials(p))),
    people.length > max ? h('span', { class: 'av av-more' }, '+' + (people.length - max)) : null);
}

function initials(u) {
  const src = (u.name || u.email.split('@')[0]).replace(/[._-]+/g, ' ').trim();
  const parts = src.split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

function genPassword(len = 14) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!$%&?#';
  const arr = crypto.getRandomValues(new Uint32Array(len));
  return Array.from(arr, (n) => chars[n % chars.length]).join('');
}

/** Passwortfeld mit Anzeigen & Generieren */
function passwordField(label, hint) {
  const input = h('input', { class: 'input', type: 'password', name: 'password', minlength: 8, required: true, autocomplete: 'new-password' });
  const eye = h('button', { class: 'icon-btn', type: 'button', title: 'Anzeigen', onclick: () => { input.type = input.type === 'password' ? 'text' : 'password'; eye.replaceChildren(icon(input.type === 'password' ? 'eye' : 'eyeOff')); } }, icon('eye'));
  const gen = h('button', { class: 'btn sm', type: 'button', onclick: () => { input.value = genPassword(); input.type = 'text'; eye.replaceChildren(icon('eyeOff')); copyText(input.value); } }, icon('rotate'), 'Generieren');
  return { input, el: h('label', { class: 'field' }, h('span', null, label), h('div', { class: 'pw-row' }, input, eye, gen), hint ? h('small', { class: 'hint' }, hint) : null) };
}

function rolePicker(value) {
  let current = value;
  const wrap = h('div', { class: 'role-pick' });
  const draw = () => wrap.replaceChildren(...ROLES.slice().reverse().map((r) => h('button', {
    type: 'button', class: `role-opt role-${r}` + (r === current ? ' sel' : ''), onclick: () => { current = r; draw(); },
  }, h('span', { class: 'role-dot' }), h('span', null, h('b', null, ROLE_LABEL[r]), h('small', null, ROLE_HELP[r])))));
  draw();
  return { el: wrap, get: () => current };
}

async function viewUsers() {
  let users = [];
  let filter = 'all';
  let query = '';
  const list = h('div', { class: 'user-list' });
  const sub = h('div', { class: 'muted', style: { marginTop: '4px' } });
  const chips = h('div', { class: 'chips' });
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Name oder E-Mail suchen …', oninput: (e) => { query = e.target.value.trim().toLowerCase(); draw(); } });

  shell('users', h('div', { class: 'page page-narrow users-page' },
    h('div', { class: 'page-head' },
      h('div', null, h('div', { class: 'label' }, 'Verwaltung'), h('h1', null, 'Benutzer'), sub),
      h('button', { class: 'btn primary', onclick: () => userForm() }, icon('plus'), 'Benutzer hinzufügen')),
    h('div', { class: 'user-tools' }, h('div', { class: 'search' }, icon('users'), search), chips),
    list,
    h('section', { class: 'card perm-card' },
      h('h2', null, 'Rollen & Rechte'),
      h('div', { class: 'perm-scroll' }, h('table', { class: 'perm-table' },
        h('thead', null, h('tr', null, h('th', null, ''), ROLES.slice().reverse().map((r) => h('th', null, h('span', { class: `role-badge role-${r}` }, ROLE_LABEL[r]))))),
        h('tbody', null, PERMS.map(([label, roles]) => h('tr', null, h('td', null, label),
          ROLES.slice().reverse().map((r) => h('td', null, roles.includes(r) ? h('span', { class: 'perm-yes' }, icon('check')) : h('span', { class: 'perm-no' }, '–')))))))))));

  const draw = () => {
    const counts = Object.fromEntries(ROLES.map((r) => [r, users.filter((u) => u.role === r).length]));
    const on = users.filter((u) => u.online).length;
    sub.textContent = `${users.length} Benutzer · ${counts.admin} Admin${counts.admin === 1 ? '' : 's'}` + (on ? ` · ${on} online` : '');
    chips.replaceChildren(...[['all', 'Alle', users.length], ...ROLES.slice().reverse().map((r) => [r, ROLE_LABEL[r], counts[r]])].map(([k, l, n]) =>
      h('button', { class: 'chip' + (filter === k ? ' sel' : ''), onclick: () => { filter = k; draw(); } }, l, h('span', { class: 'n' }, String(n)))));
    const shown = users.filter((u) => (filter === 'all' || u.role === filter) && (!query || u.email.toLowerCase().includes(query) || (u.name || '').toLowerCase().includes(query)));
    if (!shown.length) { list.replaceChildren(h('div', { class: 'empty' }, users.length ? 'Keine Treffer.' : 'Noch keine Benutzer.')); return; }
    list.replaceChildren(...shown.map((u) => {
      const me = u.id === S.user.id;
      const sel = h('select', {
        class: `role-select role-${u.role}`, 'aria-label': 'Rolle', onchange: async (e) => {
          const val = e.target.value;
          if (me && val !== 'admin' && !(await confirmDialog('Du entziehst dir selbst die Admin-Rechte und kannst danach keine Benutzer mehr verwalten.', { okLabel: 'Trotzdem ändern', title: 'Eigene Rolle ändern?' }))) { e.target.value = u.role; return; }
          try {
            await api('PATCH', '/api/users/' + u.id, { role: val });
            toast(`${u.name || u.email}: jetzt ${ROLE_LABEL[val]}`, 'ok');
            if (me) { const st = await api('GET', '/api/auth/status'); S.user = st.user; return router(); }
            load();
          } catch (ex) { toast(ex.message, 'err'); e.target.value = u.role; }
        },
      }, ROLES.slice().reverse().map((r) => h('option', { value: r, selected: r === u.role }, ROLE_LABEL[r])));
      return h('div', { class: 'user-row' },
        h('div', { class: `avatar role-${u.role}` + (u.online ? ' is-online' : '') }, initials(u)),
        h('div', { class: 'u-info' },
          h('div', { class: 'u-name' }, u.name || u.email.split('@')[0], me ? h('span', { class: 'tag' }, 'Du') : null,
            u.pending ? h('span', { class: 'st-badge st-upcoming', title: u.open_link ? 'Einladungslink gültig bis ' + new Date(u.open_link.expires_at).toLocaleString('de-DE') : 'Einladungslink abgelaufen – neuen erzeugen' }, icon('send'), u.open_link ? 'Einladung offen' : 'Einladung abgelaufen') : null,
            !u.pending && u.must_change ? h('span', { class: 'st-badge st-today', title: 'Muss beim nächsten Login ein neues Passwort festlegen' }, icon('key'), 'Temp. Passwort') : null,
            !u.pending && u.open_link ? h('span', { class: 'st-badge st-public', title: 'Reset-Link gültig bis ' + new Date(u.open_link.expires_at).toLocaleString('de-DE') }, icon('link'), 'Reset-Link aktiv') : null),
          h('div', { class: 'u-mail' }, u.email)),
        h('div', { class: 'u-role' }, sel),
        u.online
          ? h('div', { class: 'u-last is-online', title: `${u.online_devices} ${u.online_devices === 1 ? 'Gerät' : 'Geräte'}` }, h('span', { class: 'lbl' }, 'Status'), h('span', { class: 'online-txt' }, h('i', { class: 'on-dot' }), 'Jetzt online'))
          : h('div', { class: 'u-last', title: u.last_login ? new Date(u.last_login.replace(' ', 'T') + 'Z').toLocaleString('de-DE') : '' }, h('span', { class: 'lbl' }, 'Letzter Login'), relTime(u.last_login)),
        h('div', { class: 'u-actions' },
          h('button', { class: 'icon-btn', title: 'Bearbeiten', onclick: () => userForm(u) }, icon('edit')),
          h('button', { class: 'icon-btn', title: 'Zugang zurücksetzen (Reset-Link oder temporäres Passwort)', onclick: () => resetPassword(u) }, icon('key')),
          h('button', { class: 'icon-btn del', title: me ? 'Du kannst dich nicht selbst löschen' : 'Löschen', disabled: me, onclick: async () => {
            if (!(await confirmDialog(`${u.name || u.email} (${u.email}) wird gelöscht und sofort abgemeldet.`, { title: 'Benutzer löschen?' }))) return;
            try { await api('DELETE', '/api/users/' + u.id); toast('Benutzer gelöscht', 'ok'); load(); } catch (ex) { toast(ex.message, 'err'); }
          } }, icon('trash'))));
    }));
  };

  const load = async () => { users = await api('GET', '/api/users'); draw(); };
  connect({ view: 'users' }, { online: debounce(load, 300), reconnect: load });

  const HOURS = [[1, '1 Stunde'], [24, '24 Stunden'], [72, '3 Tage'], [168, '7 Tage']];
  const linkUrl = (token) => `${location.origin}/#/reset/${token}`;
  const fmtUntil = (ms) => new Date(ms).toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

  /** Zeigt einen frisch erzeugten Link mit Kopieren / Teilen / QR */
  const linkResult = (link, u) => {
    const url = linkUrl(link.token);
    let qr = false;
    const box = h('div', { class: 'link-result' });
    const draw = () => fill(box,
      h('div', { class: 'lr-head' }, icon('checkCircle'), h('div', null,
        h('b', null, link.purpose === 'invite' ? 'Einladungslink erstellt' : 'Reset-Link erstellt'),
        h('span', null, `Einmalig nutzbar · gültig bis ${fmtUntil(link.expires_at)}`))),
      h('div', { class: 'link-box' },
        h('input', { class: 'input mono', readonly: true, value: url, onfocus: (e) => e.target.select() }),
        h('button', { class: 'btn primary', type: 'button', onclick: () => copyText(url) }, icon('copy'), 'Kopieren'),
        navigator.share ? h('button', { class: 'btn', type: 'button', title: 'Teilen', onclick: () => navigator.share({ title: 'FF Rundown – Zugang', text: `Hallo${u.name ? ' ' + u.name : ''}, hier kannst du dein Passwort für FF Rundown festlegen:`, url }).catch(() => {}) }, icon('share')) : null,
        h('button', { class: 'btn' + (qr ? ' active-toggle' : ''), type: 'button', title: 'QR-Code', onclick: () => { qr = !qr; draw(); } }, icon('qr'))),
      qr ? h('div', { class: 'qr-panel' }, h('div', { class: 'qr-img', html: qrSvg(url, { border: 2 }), onclick: () => qrFullscreen(url, `Zugang für ${u.name || u.email}`) }),
        h('div', { class: 'qr-side' }, h('b', null, 'Mit dem Handy scannen'), h('span', { class: 'hint' }, 'Der Benutzer scannt den Code und legt direkt sein Passwort fest.'))) : null,
      h('p', { class: 'hint', style: { marginTop: '10px' } }, 'Schick den Link z. B. per Messenger oder Mail. Er wird nicht gespeichert und kann hier nicht erneut angezeigt werden – bei Bedarf einfach einen neuen erzeugen (der alte wird dann ungültig).'));
    draw();
    return box;
  };

  const accessToggle = (opts, value, onChange) => {
    let cur = value;
    const seg = h('div', { class: 'seg seg-wide' });
    const draw = () => seg.replaceChildren(...opts.map(([k, l, ic]) => h('button', { type: 'button', class: cur === k ? 'sel' : '', onclick: () => { cur = k; draw(); onChange(k); } }, icon(ic), l)));
    draw();
    return seg;
  };

  const userForm = (u) => {
    const err = h('div', { class: 'form-error' });
    const email = h('input', { class: 'input', type: 'email', name: 'email', required: true, value: u?.email || '', autocomplete: 'off' });
    const name = h('input', { class: 'input', name: 'name', value: u?.name || '', placeholder: 'z. B. Max Mustermann', autocomplete: 'off' });
    const role = rolePicker(u?.role || 'viewer');
    let mode = 'invite';
    const pw = passwordField('Start-Passwort', 'Mindestens 8 Zeichen. „Generieren“ erstellt ein sicheres Passwort und kopiert es.');
    const must = h('input', { type: 'checkbox', checked: true });
    const hours = h('select', { class: 'input sort-sel' }, HOURS.map(([v, l]) => h('option', { value: v, selected: v === 168 }, l)));
    const accessBox = h('div');
    const drawAccess = () => {
      pw.input.required = mode === 'password';
      fill(accessBox, mode === 'invite'
        ? h('div', { class: 'access-info' }, icon('send'), h('div', null,
            h('b', null, 'Der Benutzer legt sein Passwort selbst fest.'),
            h('span', null, 'Nach dem Anlegen bekommst du einen Einladungslink zum Weiterschicken.'),
            h('label', { class: 'inline-field' }, 'Link gültig für', hours)))
        : h('div', null, pw.el, h('label', { class: 'switch' }, must, h('span', null, 'Muss beim ersten Login geändert werden (empfohlen)'))));
    };
    drawAccess();
    const form = h('form', null,
      h('div', { class: 'form-grid' },
        h('label', { class: 'field' }, h('span', null, 'Name'), name),
        h('label', { class: 'field' }, h('span', null, 'E-Mail (Login)'), email)),
      u ? null : h('div', { class: 'field' }, h('span', null, 'Zugang'),
        accessToggle([['invite', 'Einladungslink', 'link'], ['password', 'Passwort festlegen', 'key']], mode, (k) => { mode = k; drawAccess(); }),
        accessBox),
      h('div', { class: 'field' }, h('span', null, 'Rolle'), role.el),
      err,
      h('div', { class: 'modal-foot', style: { padding: '6px 0 0' } },
        h('button', { class: 'btn ghost', type: 'button', onclick: () => m.close() }, 'Abbrechen'),
        h('button', { class: 'btn primary', type: 'submit' }, u ? 'Speichern' : 'Benutzer anlegen')));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.textContent = '';
      const body = { email: email.value, name: name.value, role: role.get() };
      if (!u) {
        if (mode === 'invite') Object.assign(body, { invite: true, hours: Number(hours.value) });
        else Object.assign(body, { password: pw.input.value, must_change: must.checked });
      }
      try {
        if (u && u.id === S.user.id && body.role !== 'admin' && !(await confirmDialog('Du entziehst dir selbst die Admin-Rechte.', { okLabel: 'Trotzdem speichern', title: 'Eigene Rolle ändern?' }))) return;
        const res = u ? await api('PATCH', '/api/users/' + u.id, body) : await api('POST', '/api/users', body);
        m.close();
        if (u && u.id === S.user.id) { const st = await api('GET', '/api/auth/status'); S.user = st.user; return router(); }
        load();
        if (res.link) modal({ title: 'Benutzer angelegt', body: h('div', null, h('p', null, `${res.name || res.email} wurde als ${ROLE_LABEL[res.role]} angelegt.`), linkResult(res.link, res)) });
        else toast(u ? 'Gespeichert' : 'Benutzer angelegt', 'ok');
      } catch (ex) { err.textContent = ex.message; }
    });
    const m = modal({ title: u ? 'Benutzer bearbeiten' : 'Benutzer hinzufügen', body: form, wide: true });
  };

  /** Zugang zurücksetzen: Reset-Link (A) oder temporäres Passwort (D) */
  const resetPassword = (u) => {
    const me = u.id === S.user.id;
    let mode = me ? 'password' : 'link';
    const body = h('div');
    const content = h('div');
    const draw = () => {
      if (mode === 'link') {
        const hours = h('select', { class: 'input sort-sel' }, HOURS.map(([v, l]) => h('option', { value: v, selected: v === 24 }, l)));
        const out = h('div');
        fill(content,
          h('div', { class: 'access-info' }, icon('link'), h('div', null,
            h('b', null, u.pending ? 'Neuen Einladungslink erzeugen' : 'Der Benutzer legt ein neues Passwort selbst fest.'),
            h('span', null, 'Du kennst das neue Passwort nicht – am sichersten. Das bisherige Passwort gilt weiter, bis der Link benutzt wird.'))),
          u.open_link ? h('div', { class: 'hint', style: { margin: '10px 2px' } }, `Es gibt bereits einen offenen Link (gültig bis ${fmtUntil(u.open_link.expires_at)}). Ein neuer Link macht ihn ungültig.`, ' ',
            h('button', { class: 'btn sm ghost', type: 'button', onclick: async () => { await api('DELETE', `/api/users/${u.id}/reset-link`); u.open_link = null; toast('Link widerrufen', 'ok'); load(); draw(); } }, 'Jetzt widerrufen')) : null,
          h('div', { class: 'link-gen' },
            h('label', { class: 'inline-field' }, 'Gültig für', hours),
            h('button', { class: 'btn primary', type: 'button', onclick: async () => {
              try {
                const r = await api('POST', `/api/users/${u.id}/reset-link`, { hours: Number(hours.value) });
                u.open_link = { purpose: r.purpose, expires_at: r.expires_at };
                fill(out, linkResult(r, u));
                load();
              } catch (ex) { toast(ex.message, 'err'); }
            } }, icon('link'), 'Link erzeugen')),
          out);
      } else {
        const err = h('div', { class: 'form-error' });
        const pw = passwordField(me ? 'Neues Passwort' : `Temporäres Passwort für ${u.email}`, me ? 'Mindestens 8 Zeichen.' : 'Mindestens 8 Zeichen. „Generieren“ erstellt eins und kopiert es in die Zwischenablage.');
        const must = h('input', { type: 'checkbox', checked: !me, disabled: me });
        const form = h('form', null, pw.el,
          me ? null : h('label', { class: 'switch', style: { marginBottom: '6px' } }, must, h('span', null, 'Muss beim nächsten Login geändert werden (empfohlen)')),
          h('p', { class: 'hint' }, 'Der Benutzer wird auf allen Geräten abgemeldet. Offene Reset-Links werden ungültig.'),
          err,
          h('div', { class: 'modal-foot', style: { padding: '6px 0 0' } },
            h('button', { class: 'btn ghost', type: 'button', onclick: () => m.close() }, 'Abbrechen'),
            h('button', { class: 'btn primary', type: 'submit' }, 'Passwort setzen')));
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          try {
            await api('PATCH', '/api/users/' + u.id, { password: pw.input.value, must_change: must.checked });
            m.close();
            toast(me ? 'Passwort geändert' : must.checked ? 'Temporäres Passwort gesetzt – muss beim Login geändert werden' : 'Passwort gesetzt', 'ok');
            if (me) { const st = await api('GET', '/api/auth/status'); S.user = st.user; }
            load();
          } catch (ex) { err.textContent = ex.message; }
        });
        fill(content, form);
      }
    };
    fill(body,
      me ? null : accessToggle([['link', 'Reset-Link (empfohlen)', 'link'], ['password', 'Temporäres Passwort', 'key']], mode, (k) => { mode = k; draw(); }),
      h('div', { style: { marginTop: me ? '0' : '14px' } }, content));
    draw();
    const m = modal({ title: me ? 'Eigenes Passwort setzen' : `Zugang zurücksetzen · ${u.name || u.email}`, body, wide: true });
  };

  await load();
}

/* ================================================================== System & Backups */
const fmtBytes = (b) => b == null ? '–' : b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(0)} KB` : b < 1073741824 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1073741824).toFixed(1)} GB`;
const fmtDateTime = (ms) => new Date(ms).toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
function relFuture(ms) {
  const d = (ms - Date.now()) / 1000;
  if (d < 60) return 'in Kürze';
  if (d < 3600) return `in ${Math.round(d / 60)} Min.`;
  if (d < 86400) return `in ${Math.round(d / 3600)} Std.`;
  return `in ${Math.round(d / 86400)} Tagen`;
}
const KIND_ICON = { auto: 'history', manuell: 'user', 'vor-wiederherstellung': 'shield', 'vor-loeschen': 'trash', upload: 'upload' };

async function viewSystem() {
  let data;
  const head = h('div', { class: 'page-head' },
    h('div', null, h('div', { class: 'label' }, 'Verwaltung'), h('h1', null, 'System & Backups'), h('div', { class: 'muted', style: { marginTop: '4px' } }, 'Sicherungen der kompletten Datenbank: Rundowns, Benutzer, Links und Tokens.')),
    h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
      h('button', { class: 'btn', onclick: () => fileIn.click() }, icon('upload'), 'Backup hochladen'),
      h('button', { class: 'btn primary', onclick: () => backupNow() }, icon('database'), 'Jetzt sichern')));
  const fileIn = h('input', { type: 'file', accept: '.db,application/vnd.sqlite3,application/octet-stream', style: { display: 'none' }, onchange: (e) => upload(e.target.files[0]) });
  const statusBox = h('div', { class: 'bk-status' });
  const listBox = h('div', { class: 'bk-list' });
  shell('system', h('div', { class: 'page page-narrow' }, head, fileIn, statusBox,
    h('div', { class: 'bk-list-head' }, h('h2', null, 'Vorhandene Backups'), h('span', { class: 'muted bk-sum' })), listBox,
    h('div', { class: 'sec-info', style: { marginTop: '22px' } },
      h('div', null, icon('shield'), h('span', null, h('b', null, 'Backups enthalten alle Daten'), ' inkl. E-Mail-Adressen, Passwort-Hashes, API-Tokens und öffentlicher Links. Heruntergeladene Dateien bitte sicher aufbewahren.')),
      h('div', null, icon('hardDrive'), h('span', null, h('b', null, 'Tipp: '), 'Backups zusätzlich auf einem anderen Datenträger ablegen (USB-Stick, NAS), z. B. mit der Umgebungsvariable ', h('code', null, 'BACKUP_DIR'), ' – fällt die SD-Karte oder Festplatte aus, sind sie sonst mit weg.')))));

  const load = async () => { data = await api('GET', '/api/backups'); draw(); };
  const draw = () => {
    const st = data.status, s = st.settings, lock = st.env_locked;
    const sel = (key, opts, fmt) => h('select', { class: 'input sort-sel', disabled: lock[key], title: lock[key] ? 'Per Umgebungsvariable festgelegt' : '', onchange: (e) => save({ [key]: Number(e.target.value) }) },
      opts.map((v) => h('option', { value: v, selected: v === s[key] }, fmt(v))));
    fill(statusBox,
      h('div', { class: 'card bk-card' },
        h('div', { class: 'bk-card-top' },
          h('div', { class: 'bk-ico' + (s.enabled ? ' on' : '') }, icon('history')),
          h('div', { class: 'bk-title' },
            h('b', null, s.enabled ? 'Automatische Backups sind aktiv' : 'Automatische Backups sind aus'),
            h('span', null, s.enabled ? `Alle ${s.interval_hours === 168 ? '7 Tage' : s.interval_hours + ' Std.'} · die letzten ${s.keep} automatischen werden behalten` : 'Es werden nur manuelle Backups und Sicherungen vor dem Löschen erstellt.')),
          h('label', { class: 'switch', title: lock.enabled ? 'Per Umgebungsvariable festgelegt' : '' }, h('input', { type: 'checkbox', checked: s.enabled, disabled: lock.enabled, onchange: (e) => save({ enabled: e.target.checked }) }))),
        h('div', { class: 'bk-grid' },
          h('div', null, h('span', null, 'Letztes Backup'), h('b', null, st.last ? relTime(new Date(st.last.created_at).toISOString().replace('T', ' ').slice(0, 19)) : 'noch keins'), st.last ? h('small', null, fmtDateTime(st.last.created_at)) : null),
          h('div', null, h('span', null, 'Nächstes automatisch'), h('b', null, st.next_at ? relFuture(st.next_at) : '–'), st.next_at ? h('small', null, fmtDateTime(st.next_at)) : null),
          h('div', null, h('span', null, 'Intervall'), sel('interval_hours', st.intervals, (v) => v === 168 ? 'wöchentlich' : v === 1 ? 'stündlich' : `alle ${v} Std.`)),
          h('div', null, h('span', null, 'Aufbewahren'), sel('keep', st.keeps, (v) => `letzte ${v}`)),
          h('div', { class: 'bk-wide' }, h('span', null, 'Speicherort'), h('code', { title: st.dir }, st.dir), h('small', null, `${st.count} Backups · ${fmtBytes(st.total_bytes)}` + (st.free_bytes != null ? ` · ${fmtBytes(st.free_bytes)} frei` : '') + (st.dir_is_default ? '' : ' · eigener Speicherort (BACKUP_DIR)')))),
        st.last_error ? h('div', { class: 'danger-box', style: { marginTop: '12px', marginBottom: 0 } }, icon('alert'), h('div', null, h('b', null, 'Letztes Backup fehlgeschlagen'), `${fmtDateTime(st.last_error.at)}: ${st.last_error.message}`)) : null));

    $('.bk-sum').textContent = data.backups.length ? `${data.backups.length} Dateien` : '';
    if (!data.backups.length) { fill(listBox, h('div', { class: 'ov-empty' }, icon('database'), h('b', null, 'Noch keine Backups'), h('span', null, 'Das erste automatische Backup entsteht kurz nach dem Start – oder jetzt mit „Jetzt sichern“.'))); return; }
    fill(listBox, data.backups.map((b, i) => h('div', { class: 'bk-row' + (b.valid ? '' : ' invalid') },
      h('div', { class: `bk-kind k-${b.kind}` }, icon(KIND_ICON[b.kind] || 'database')),
      h('div', { class: 'bk-main' },
        h('div', { class: 'bk-name' }, h('b', null, fmtDateTime(b.created_at)), h('span', { class: `st-badge bk-badge k-${b.kind}` }, b.kind_label), i === 0 ? h('span', { class: 'st-badge st-public' }, 'Neuestes') : null),
        h('div', { class: 'bk-meta' },
          b.label ? h('span', { class: 'bk-label' }, '„' + b.label + '“') : null,
          b.valid ? h('span', null, `${b.summary.rundowns} Rundowns · ${b.summary.items} Punkte · ${b.summary.users} Benutzer`) : h('span', { class: 'red' }, 'Datei beschädigt oder unvollständig'),
          h('span', null, fmtBytes(b.size)))),
      h('div', { class: 'bk-act' },
        h('a', { class: 'icon-btn', title: 'Herunterladen', href: `/api/backups/${encodeURIComponent(b.name)}/download`, download: b.name }, icon('download')),
        b.valid ? h('button', { class: 'btn sm', onclick: () => restore(b) }, icon('rotate'), 'Wiederherstellen') : null,
        h('button', { class: 'icon-btn del', title: 'Löschen', onclick: async () => {
          if (!(await confirmDialog(`Backup vom ${fmtDateTime(b.created_at)} endgültig löschen?`, { title: 'Backup löschen?' }))) return;
          try { await api('DELETE', '/api/backups/' + encodeURIComponent(b.name)); toast('Backup gelöscht', 'ok'); load(); } catch (e) { toast(e.message, 'err'); }
        } }, icon('trash'))))));
  };

  const save = async (patch) => {
    try { const r = await api('PATCH', '/api/backups/settings', patch); data.status = r.status; draw(); toast('Einstellungen gespeichert', 'ok'); }
    catch (e) { toast(e.message, 'err'); load(); }
  };

  const backupNow = () => formModal({
    title: 'Backup jetzt erstellen',
    submitLabel: 'Sichern',
    fields: [{ name: 'label', label: 'Bezeichnung (optional)', placeholder: 'z. B. vor dem Finale' }],
    onSubmit: async (v) => { await api('POST', '/api/backups', { label: v.label }); toast('Backup erstellt', 'ok'); load(); },
  });

  const upload = async (file) => {
    fileIn.value = '';
    if (!file) return;
    try {
      const res = await fetch('/api/backups/upload?name=' + encodeURIComponent(file.name), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file, credentials: 'same-origin' });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Upload fehlgeschlagen');
      toast('Backup hochgeladen und geprüft', 'ok');
      await load();
      if (await confirmDialog(`Die Datei enthält ${d.backup.summary.rundowns} Rundowns und ${d.backup.summary.users} Benutzer. Jetzt wiederherstellen?`, { okLabel: 'Weiter zur Wiederherstellung', danger: false, title: 'Hochgeladen' })) restore(d.backup);
    } catch (e) { toast(e.message, 'err'); }
  };

  const restore = async (b) => {
    const ok = await confirmTyped({
      title: 'Backup wiederherstellen',
      intro: `Stand vom ${fmtDateTime(b.created_at)} (${b.summary.rundowns} Rundowns, ${b.summary.users} Benutzer) ersetzt die aktuellen Daten.`,
      points: [
        'Alle Änderungen seit diesem Backup gehen verloren – der aktuelle Stand wird vorher automatisch als Backup „Vor Wiederherstellung“ gesichert.',
        'Der Server startet neu; alle Benutzer werden kurz getrennt. Ein laufender Live-Durchlauf wird unterbrochen.',
        'Benutzer, Passwörter, öffentliche Links und API-Tokens entsprechen danach dem Stand des Backups.',
      ],
      word: 'WIEDERHERSTELLEN',
      okLabel: 'Jetzt wiederherstellen',
    });
    if (!ok) return;
    let bootBefore = null;
    try { bootBefore = (await (await fetch('/api/health', { cache: 'no-store' })).json()).boot; } catch { /* */ }
    try { await api('POST', `/api/backups/${encodeURIComponent(b.name)}/restore`, { confirm: true }); }
    catch (e) { return toast(e.message, 'err'); }
    disconnect();
    const msg = h('div', { class: 'restart-msg' }, 'Server startet neu …');
    document.body.append(h('div', { class: 'restart-overlay' }, h('div', { class: 'restart-box' }, h('div', { class: 'spinner' }), h('b', null, 'Backup wird wiederhergestellt'), msg)));
    const t0 = Date.now();
    const poll = async () => {
      try {
        const r = await (await fetch('/api/health', { cache: 'no-store' })).json();
        if (r.boot && r.boot !== bootBefore) { msg.textContent = 'Fertig – lade neu …'; setTimeout(() => location.reload(), 600); return; }
      } catch { /* Server noch nicht da */ }
      if (Date.now() - t0 > 30000) msg.innerHTML = 'Der Server ist noch nicht wieder erreichbar.<br>Falls er nicht als Dienst läuft, bitte von Hand neu starten – die Wiederherstellung wird beim Start übernommen.';
      setTimeout(poll, 1000);
    };
    setTimeout(poll, 1500);
  };

  try { await load(); } catch (e) { toast(e.message, 'err'); }
}

/* ================================================================== Rundown-Ansicht */
async function viewPublic(token) {
  S.publicToken = token;
  S.user = null;
  let p;
  try { p = await api('GET', '/api/public/' + encodeURIComponent(token)); }
  catch (e) {
    document.body.replaceChildren(topbar(), h('main', null, h('div', { class: 'page page-narrow' }, h('div', { class: 'empty' }, e.message))));
    return;
  }
  openRundown(p);
  connect({ public: token }, rundownHandlers(() => api('GET', '/api/public/' + encodeURIComponent(token))));
}

async function viewRundown(id) {
  let p;
  try { p = await api('GET', '/api/rundowns/' + id); }
  catch (e) { toast(e.message, 'err'); return go('#/rundowns'); }
  openRundown(p);
  connect({ rundown: id, view: 'editor' }, rundownHandlers(() => api('GET', '/api/rundowns/' + id)));
}

function rundownHandlers(fetcher) {
  return {
    rundown: (p) => applyPayload(p),
    presence: (p) => { if (S.rd && p.rundownId === S.rd.rundown.id) { S.presence = p; renderPresence(); } },
    live: (m) => {
      if (!S.rd || m.rundownId !== S.rd.rundown.id) return;
      S.rd.live = m.live; S.offset = m.serverNow - Date.now(); S.liveKey = ''; tick();
    },
    deleted: () => { toast('Dieser Rundown wurde gelöscht'); go('#/rundowns'); },
    gone: () => { disconnect(); document.body.replaceChildren(topbar(), h('main', null, h('div', { class: 'page page-narrow' }, h('div', { class: 'empty' }, 'Dieser öffentliche Link wurde deaktiviert.')))); },
    reconnect: async () => { try { applyPayload(await fetcher()); } catch { /* */ } },
  };
}

function openRundown(p) {
  S.rd = p;
  S.offset = p.serverNow - Date.now();
  S.readMode = false;
  S.lastFollow = null;
  loadPrefs(p.rundown.id);
  buildRundownPage();
  renderAll();
  tickTimer = setInterval(tick, 250);
}

function applyPayload(p) {
  if (!S.rd || !p?.rundown || p.rundown.id !== S.rd.rundown.id) return;
  if (S.dragging) { S.deferred = p; return; }
  // lokale, noch nicht gespeicherte Eingaben behalten
  for (const job of pending.values()) {
    const it = p.items.find((i) => i.id === job.id);
    if (it) setVal(it, job.f, job.v);
  }
  S.rd = p;
  S.offset = p.serverNow - Date.now();
  renderAll();
}

const item = (id) => S.rd.items.find((i) => i.id === id);
const visCols = () => S.rd.columns.filter((c) => !S.hidden.has('c' + c.id));
const showB = (k) => !S.hidden.has(k);
const hasActions = () => canEdit() || canOperate();

/* ---------- Seitenaufbau */
function buildRundownPage() {
  const rd = S.rd.rundown;
  const editable = can('editor');

  R.title = editable
    ? h('input', { class: 'rd-title-input', value: rd.title, 'aria-label': 'Titel', oninput: debounce((e) => saveRundown({ title: e.target.value }), 500), onkeydown: (e) => { if (e.key === 'Enter') e.target.blur(); } })
    : h('h1', null, rd.title);

  R.date = editable ? h('input', { type: 'date', value: rd.event_date || '', onchange: (e) => saveRundown({ event_date: e.target.value }) }) : h('span', { class: 'mono' }, fmtDate(rd.event_date));
  R.start = editable ? h('input', { type: 'time', value: rd.start_time, onchange: (e) => e.target.value && saveRundown({ start_time: e.target.value }) }) : h('span', { class: 'mono' }, rd.start_time);
  R.total = h('b', { style: { fontWeight: 500 } });
  R.end = h('span');

  const headActions = h('div', { class: 'rd-head-actions' },
    h('button', { class: 'btn', onclick: () => window.open(S.publicToken ? `/live/p/${encodeURIComponent(S.publicToken)}` : `/live/${rd.id}`, '_blank') }, icon('external'), h('span', { class: 'lbl' }, 'Live-Ansicht')),
    h('button', { class: 'btn', onclick: (e) => viewMenu(e.currentTarget) }, icon('eye'), h('span', { class: 'lbl' }, 'Ansicht')),
    !S.publicToken ? h('button', { class: 'btn', onclick: publicLinkModal }, icon('share'), h('span', { class: 'lbl' }, 'Öffentlicher Link')) : null,
    can('editor') ? h('button', { class: 'btn', onclick: apiModal }, icon('code'), h('span', { class: 'lbl' }, 'API')) : null);

  R.toolbar = h('div', { class: 'toolbar' },
    h('button', { class: 'btn', onclick: () => addItem('item') }, icon('plus'), 'Programmpunkt'),
    h('button', { class: 'btn ghost', onclick: () => addItem('block') }, icon('folderPlus'), 'Block'),
    h('button', { class: 'btn ghost', onclick: () => addItem('block_end') }, icon('minus'), 'Block-Ende'),
    h('button', { class: 'btn ghost', onclick: columnsModal }, icon('columns'), 'Spalten'));

  R.grid = h('div', { class: 'rd-grid' });
  R.header = h('div', { class: 'row rd-header' });
  R.rows = h('div', { id: 'rows' });
  R.grid.append(R.header, R.rows);
  initRowEvents();

  R.page = h('div', { class: 'page rd-page' },
    S.publicToken ? h('div', { class: 'public-banner' }, icon('globe'), 'Öffentliche Ansicht · nur Lesezugriff') : null,
    h('div', { class: 'rd-head' },
      h('div', { style: { flex: '1', minWidth: '280px' } },
        !S.publicToken ? h('a', { class: 'back', href: '#/rundowns' }, icon('arrowLeft'), 'Übersicht') : null,
        R.title,
        R.presence = h('div', { class: 'presence-bar' }),
        h('div', { class: 'rd-meta' },
          h('div', { class: 'grp' }, h('span', { class: 'label' }, 'Datum'), R.date),
          h('div', { class: 'grp' }, h('span', { class: 'label' }, 'Start'), R.start),
          h('span', { class: 'stat' }, 'Gesamtdauer ', R.total),
          h('span', { class: 'stat', title: 'Geplantes Ende' }, icon('clock'), R.end))),
      headActions),
    R.toolbar,
    buildLiveBar(),
    h('section', { class: 'card rd-table' }, h('div', { class: 'rd-scroll' }, R.grid)));

  shell('rundowns', R.page);
  applyPageClasses();
}

function applyPageClasses() {
  R.page.classList.toggle('compact', !!S.prefs.compact);
  R.page.classList.toggle('hide-done', !!S.prefs.hideDone);
  R.toolbar.classList.toggle('hidden', !canEdit());
}

async function saveRundown(fields) {
  try { const p = await api('PATCH', '/api/rundowns/' + S.rd.rundown.id, fields); applyPayload(p); }
  catch (e) { toast(e.message, 'err'); }
}

function renderAll() {
  if (!S.rd || !R.rows) return;
  const rd = S.rd.rundown;
  if (R.title.tagName === 'INPUT') { if (document.activeElement !== R.title) R.title.value = rd.title; } else R.title.textContent = rd.title;
  if (R.date.tagName === 'INPUT') { if (document.activeElement !== R.date) R.date.value = rd.event_date || ''; } else R.date.textContent = fmtDate(rd.event_date);
  if (R.start.tagName === 'INPUT') { if (document.activeElement !== R.start) R.start.value = rd.start_time; } else R.start.textContent = rd.start_time;
  document.title = rd.title + ' · Rundown';
  renderHeader();
  renderRows();
}

/* ---------- Tabelle */
function gridTemplate() {
  const p = ['20px', '44px'];
  if (showB('start')) p.push('72px');
  p.push('118px');
  if (showB('end')) p.push('72px');
  p.push('minmax(200px, 1.3fr)');
  visCols().forEach(() => p.push('minmax(140px, 1fr)'));
  if (hasActions()) p.push(canEdit() ? '64px' : '36px');
  const min = p.reduce((a, x) => a + parseInt(x.replace('minmax(', ''), 10), 0) + (p.length - 1) * 6;
  R.grid.style.minWidth = min + 'px';
  return p.join(' ');
}

function renderHeader() {
  R.grid.style.setProperty('--cols', gridTemplate());
  R.header.replaceChildren(...[
    h('div'),
    h('div', { class: 'center' }, 'Nr.'),
    showB('start') ? h('div', { class: 'center' }, 'Start') : null,
    h('div', { class: 'center' }, 'Dauer'),
    showB('end') ? h('div', { class: 'center' }, 'Ende') : null,
    h('div', null, 'Programmpunkt'),
    visCols().map((c) => h('div', null, c.name)),
    hasActions() ? h('div', { class: 'center' }, 'Aktion') : null].flat().filter(Boolean));
}

const rowSig = () => [canEdit(), canOperate(), showB('start'), showB('end'), visCols().map((c) => c.id).join(',')].join('|');

function renderRows() {
  const rows = R.rows;
  const sig = rowSig();
  if (R.sig !== sig) { rows.replaceChildren(); R.sig = sig; }
  rows.querySelector('.empty')?.remove();
  const sched = computeSchedule(S.rd.items, parseClock(S.rd.rundown.start_time));
  S.sched = sched;
  const existing = new Map([...rows.children].map((el) => [el.dataset.id, el]));
  const keep = new Set();
  let prev = null;
  for (const it of S.rd.items) {
    const key = String(it.id);
    let el = existing.get(key);
    if (!el || el.dataset.type !== it.type) { el?.remove(); el = buildRow(it); }
    fillRow(el, it, sched);
    keep.add(key);
    const want = prev ? prev.nextSibling : rows.firstChild;
    if (want !== el) rows.insertBefore(el, want);
    prev = el;
  }
  for (const [k, el] of existing) if (!keep.has(k)) el.remove();
  if (!S.rd.items.length) rows.append(h('div', { class: 'empty' }, canEdit() ? 'Noch keine Programmpunkte – füge oben einen hinzu.' : 'Noch keine Programmpunkte.'));
  requestAnimationFrame(() => rows.querySelectorAll('textarea').forEach(autosize));

  renderPresence();
  R.total.textContent = fmtDuration(sched.total, { hours: true });
  R.end.textContent = fmtClock(sched.end, true);
  S.liveKey = '';
  tick();
}

function field(cls, f, placeholder) {
  return canEdit()
    ? h('textarea', { class: cls, 'data-f': f, rows: 1, placeholder, spellcheck: 'false' })
    : h('div', { class: 'ro-text ' + cls, 'data-f': f });
}

function actionsCell(it, { play = false, insert = true, palette = true } = {}) {
  if (!hasActions()) return null;
  const ed = canEdit();
  return h('div', { class: 'c row-actions' },
    play && canOperate() ? h('button', { class: 'icon-btn', title: 'Diesen Punkt live schalten', onclick: () => liveAction('goto', { itemId: it.id }) }, icon('play')) : null,
    ed && palette ? h('button', { class: 'icon-btn palette', title: 'Farbe', onclick: (e) => colorPicker(e.currentTarget, it.id) }, icon('palette')) : null,
    ed && play ? h('button', { class: 'icon-btn m-only expand', title: 'Alle Felder anzeigen', onclick: (e) => e.currentTarget.closest('.row').classList.toggle('open') }, icon('chevronDown')) : null,
    ed && insert ? h('button', { class: 'icon-btn', title: 'Programmpunkt darunter einfügen', onclick: () => addItem('item', it.id) }, icon('listPlus')) : null,
    ed ? h('button', { class: 'icon-btn del', title: 'Löschen', onclick: () => delItem(it.id) }, icon('trash')) : null);
}

function buildRow(it) {
  const ed = canEdit();
  const span = { gridColumn: `2 / ${hasActions() ? -2 : -1}` };
  const grip = h('div', { class: 'c grip' + (ed ? '' : ' no-drag'), title: ed ? 'Ziehen zum Verschieben' : null }, ed ? icon('grip') : null);
  let row;
  if (it.type === 'block') {
    row = h('div', { class: 'row block-row' }, grip,
      h('div', { class: 'c block-cell', style: span },
        h('span', { class: 'block-tag' }, 'Block'),
        ed ? h('input', { 'data-f': 'title', placeholder: 'Blockname', spellcheck: 'false' }) : h('div', { class: 'ro-text', 'data-f': 'title' }),
        h('span', { class: 'bmeta', 'data-r': 'bmeta' })),
      actionsCell(it));
  } else if (it.type === 'block_end') {
    row = h('div', { class: 'row block-end-row' }, grip,
      h('div', { class: 'c block-end', style: span }, h('span', { 'data-r': 'bename' })),
      actionsCell(it, { palette: false }));
  } else {
    row = h('div', { class: 'row item-row' }, grip,
      h('div', { class: 'c cell center nr', 'data-label': 'Nr.' }, h('span', { 'data-r': 'nr' })),
      showB('start') ? h('div', { class: 'c cell center c-start', 'data-label': 'Start' }, h('span', { class: 'big', 'data-r': 'start' })) : null,
      h('div', { class: 'c cell center c-dur', 'data-label': 'Dauer' },
        ed ? h('input', { class: 'dur-in', 'data-f': 'duration', autocomplete: 'off', 'aria-label': 'Dauer', title: 'Dauer: mm:ss, h:mm:ss oder Minuten (z. B. 5)' }) : h('span', { class: 'dur-ro', 'data-f': 'duration' }),
        h('div', { class: 'delta', 'data-r': 'delta' })),
      showB('end') ? h('div', { class: 'c cell center c-end', 'data-label': 'Ende' }, h('span', { class: 'big', 'data-r': 'end' })) : null,
      h('div', { class: 'c cell title' }, field('t1', 'title', 'Titel'), field('t2', 'description', 'Beschreibung …'), h('div', { class: 'row-prog' }, h('span'))),
      visCols().map((c) => h('div', { class: 'c cell txt', 'data-label': c.name }, field('', 'cell:' + c.id, c.name))),
      actionsCell(it, { play: true }));
  }
  row.dataset.id = it.id;
  row.dataset.type = it.type;
  return row;
}

function valueOf(it, f) {
  if (f === 'duration') return fmtDuration(it.duration);
  if (f.startsWith('cell:')) return it.cells?.[f.slice(5)] || '';
  return it[f] || '';
}
function setVal(it, f, v) {
  if (f.startsWith('cell:')) { it.cells ||= {}; it.cells[f.slice(5)] = v; }
  else it[f] = v;
}

/** Leere Felder markieren (für die kompakte Handy-/Tablet-Ansicht) */
function markEmpty(el, v) {
  const f = el.dataset.f;
  if (f?.startsWith('cell:')) el.closest('.cell')?.classList.toggle('is-empty', !v);
  else if (f === 'description') el.closest('.cell')?.classList.toggle('no-desc', !v);
}

function fillRow(row, it, sched) {
  const s = sched.map.get(it.id) || {};
  if (it.color) row.style.setProperty('--c', it.color); else row.style.removeProperty('--c');
  row.classList.toggle('has-color', !!it.color);
  const blockColor = it.type === 'block' ? null : s.block ? (s.block.color || 'var(--border-2)') : null;
  if (blockColor) row.style.setProperty('--block', blockColor); else row.style.removeProperty('--block');
  const active = document.activeElement;
  for (const el of row.querySelectorAll('[data-f]')) {
    if (el === active) continue;
    const v = valueOf(it, el.dataset.f);
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') { if (el.value !== v) el.value = v; }
    else if (el.textContent !== v) el.textContent = v;
    markEmpty(el, v);
  }
  const set = (r, v) => { const el = row.querySelector(`[data-r="${r}"]`); if (el && el.textContent !== v) el.textContent = v; };
  if (it.type === 'item') {
    set('nr', String(s.nr ?? ''));
    set('start', fmtClock(s.start));
    set('end', fmtClock(s.end));
  } else if (it.type === 'block') {
    set('bmeta', `${s.count || 0} ${s.count === 1 ? 'Punkt' : 'Punkte'} · ${fmtDuration(s.duration || 0, { hours: (s.duration || 0) >= 3600 })} · ${fmtClock(s.start)}–${fmtClock(s.end)}`);
  } else {
    set('bename', 'Ende ' + (s.block?.title || 'Block'));
  }
}

/* ---------- Bearbeiten */
const pending = new Map();
function queueSave(id, f, v) {
  const k = id + ':' + f;
  clearTimeout(pending.get(k)?.t);
  const job = { id, f, v };
  job.t = setTimeout(() => { pending.delete(k); sendSave(job); }, 450);
  pending.set(k, job);
}
function flushSaves() {
  for (const [k, j] of pending) { clearTimeout(j.t); pending.delete(k); sendSave(j); }
}
const saveChains = new Map(); // Speichervorgänge pro Feld nacheinander senden (Reihenfolge garantiert)
function sendSave({ id, f, v }) {
  const k = id + ':' + f;
  const body = f.startsWith('cell:') ? { cells: { [f.slice(5)]: v } } : { [f]: v };
  const p = (saveChains.get(k) || Promise.resolve())
    .then(() => api('PATCH', '/api/items/' + id, body))
    .catch((e) => toast('Speichern fehlgeschlagen: ' + e.message, 'err'))
    .finally(() => { if (saveChains.get(k) === p) saveChains.delete(k); });
  saveChains.set(k, p);
}
window.addEventListener('beforeunload', flushSaves);
window.addEventListener('pagehide', flushSaves);
const rerenderSoon = debounce(() => S.rd && renderRows(), 300);

function initRowEvents() {
  const rows = R.rows;
  rows.addEventListener('input', (e) => {
    const el = e.target, f = el.dataset.f;
    if (!f || !canEdit()) return;
    autosize(el);
    if (f === 'duration') return;
    const id = Number(el.closest('[data-id]').dataset.id);
    const it = item(id);
    if (!it) return;
    setVal(it, f, el.value);
    markEmpty(el, el.value);
    queueSave(id, f, el.value);
    if (it.type === 'block' && f === 'title') rerenderSoon();
  });
  rows.addEventListener('change', (e) => {
    const el = e.target;
    if (el.dataset.f !== 'duration') return;
    const id = Number(el.closest('[data-id]').dataset.id);
    const it = item(id);
    if (!it) return;
    const sec = Math.max(0, parseDuration(el.value));
    it.duration = sec;
    el.value = fmtDuration(sec);
    api('PATCH', '/api/items/' + id, { duration: sec }).catch((ex) => toast(ex.message, 'err'));
    renderRows();
  });
  rows.addEventListener('keydown', (e) => {
    const f = e.target.dataset?.f;
    if (!f) return;
    if ((f === 'duration' || e.target.tagName === 'INPUT') && e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
    if (e.key === 'Escape') e.target.blur();
  });
  rows.addEventListener('focusin', (e) => {
    const fr = e.target.closest('[data-id]');
    if (fr && e.target.dataset?.f) reportFocus(Number(fr.dataset.id), e.target.dataset.f);
    const row = e.target.closest('[data-id]');
    if (row) S.focusId = Number(row.dataset.id);
    if (e.target.dataset?.f === 'duration') setTimeout(() => e.target.select(), 0);
  });
  rows.addEventListener('focusout', () => { setTimeout(flushSaves, 0); setTimeout(() => { if (!R.rows?.contains(document.activeElement)) reportFocus(null); }, 50); });
  rows.addEventListener('pointerdown', (e) => {
    const grip = e.target.closest('.grip');
    if (!grip || grip.classList.contains('no-drag') || !canEdit() || e.button > 0) return;
    e.preventDefault();
    startDrag(grip.closest('.row'), e);
  });
}

async function addItem(type, afterId = S.focusId) {
  if (afterId != null && !item(afterId)) afterId = null;
  try {
    flushSaves();
    const p = await api('POST', `/api/rundowns/${S.rd.rundown.id}/items`, { type, afterId });
    applyPayload(p);
    const row = R.rows.querySelector(`[data-id="${p.id}"]`);
    if (row) {
      row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      const t = row.querySelector('[data-f="title"]');
      if (t) { t.focus(); t.select?.(); }
      S.focusId = p.id;
    }
  } catch (e) { toast(e.message, 'err'); }
}

async function delItem(id) {
  const it = item(id);
  const label = it.type === 'block' ? 'diesen Block (die Programmpunkte bleiben erhalten)' : it.type === 'block_end' ? 'dieses Block-Ende' : `„${it.title || 'Programmpunkt'}“`;
  if (!(await confirmDialog(`Möchtest du ${label} löschen?`))) return;
  try { applyPayload(await api('DELETE', '/api/items/' + id)); }
  catch (e) { toast(e.message, 'err'); }
}

function colorPicker(anchor, id) {
  const it = item(id);
  const set = (c) => {
    closePop();
    it.color = c;
    renderRows();
    api('PATCH', '/api/items/' + id, { color: c }).catch((e) => toast(e.message, 'err'));
  };
  popover(anchor, [
    h('div', { class: 'swatches' },
      h('button', { class: 'swatch none' + (!it.color ? ' sel' : ''), title: 'Keine Farbe', onclick: () => set('') }),
      COLORS.map((c) => h('button', { class: 'swatch' + (it.color === c ? ' sel' : ''), style: `--sw:${c}`, title: c, onclick: () => set(c) }))),
    h('label', { class: 'swatch-custom' }, h('input', { type: 'color', value: it.color || '#45197a', onchange: (e) => set(e.target.value) }), 'Eigene Farbe wählen'),
  ]);
}

/* ---------- Drag & Drop (Maus & Touch) */
function startDrag(row, e) {
  flushSaves();
  const rect = row.getBoundingClientRect();
  const ghost = row.cloneNode(true);
  const src = row.querySelectorAll('textarea,input');
  ghost.querySelectorAll('textarea,input').forEach((el, i) => { el.value = src[i].value; });
  ghost.classList.add('drag-ghost');
  Object.assign(ghost.style, { width: rect.width + 'px', left: rect.left + 'px', top: rect.top + 'px' });
  ghost.style.setProperty('--cols', R.grid.style.getPropertyValue('--cols'));
  document.body.append(ghost);
  row.classList.add('dragging');
  S.dragging = true;
  const dy = e.clientY - rect.top;
  let lastY = e.clientY, raf = null;
  const scroller = () => {
    const edge = 70;
    if (lastY < edge) window.scrollBy(0, -14);
    else if (lastY > window.innerHeight - edge) window.scrollBy(0, 14);
    place();
    raf = requestAnimationFrame(scroller);
  };
  const place = () => {
    ghost.style.top = lastY - dy + 'px';
    let before = null;
    for (const s of R.rows.children) {
      if (s === row) continue;
      const r = s.getBoundingClientRect();
      if (lastY < r.top + r.height / 2) { before = s; break; }
    }
    if (before !== row.nextSibling && before !== row) R.rows.insertBefore(row, before);
  };
  const move = (ev) => { lastY = ev.clientY; place(); };
  const up = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    document.removeEventListener('pointercancel', up);
    cancelAnimationFrame(raf);
    ghost.remove();
    row.classList.remove('dragging');
    S.dragging = false;
    const ids = [...R.rows.children].map((x) => Number(x.dataset.id)).filter(Boolean);
    const before = S.rd.items.map((i) => i.id);
    if (ids.join() !== before.join()) {
      const byId = new Map(S.rd.items.map((i) => [i.id, i]));
      S.rd.items = ids.map((i) => byId.get(i));
      renderRows();
      api('POST', `/api/rundowns/${S.rd.rundown.id}/reorder`, { ids }).then(applyPayload).catch((ex) => toast(ex.message, 'err'));
    } else if (S.deferred) { const d = S.deferred; S.deferred = null; applyPayload(d); }
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
  document.addEventListener('pointercancel', up);
  raf = requestAnimationFrame(scroller);
}

/* ================================================================== Live-Steuerung */
const stepLabel = (s) => (s < 60 ? `${s} s` : `${s / 60} min`);

function buildLiveBar() {
  const op = canOperate();
  R.lv = {};
  const L = R.lv;
  const stepBtn = (sign) => {
    const lbl = h('span', { class: 'lbl-step' }, stepLabel(S.step));
    const main = h('button', { class: 'btn', title: sign > 0 ? 'Zeit zum aktuellen Punkt hinzufügen' : 'Zeit vom aktuellen Punkt abziehen', onclick: () => liveAction('adjust', { seconds: sign * S.step }) }, icon(sign > 0 ? 'plus' : 'minus'), lbl);
    const chev = h('button', {
      class: 'btn', title: 'Schrittweite', onclick: (e) => menu(e.currentTarget, [10, 30, 60, 120, 300, 600].map((s) => ({ label: stepLabel(s), active: s === S.step, onClick: () => { S.step = s; savePrefs(); $$('.lbl-step').forEach((x) => (x.textContent = stepLabel(s))); } }))),
    }, icon('chevronDown'));
    const g = h('div', { class: 'btn-group' }, main, chev);
    (L.adjust ||= []).push(main, chev);
    return g;
  };
  L.since = h('b', null, '--:--');
  L.delta = h('b', null, '--:--');
  L.deltaWrap = h('span', null, 'Gesamt ', L.delta);
  L.point = h('b', null, '--:--');
  L.pointWrap = h('span', null, 'Punkt ', L.point);
  L.endT = h('b', null, '--:--');
  L.now = h('b', null, '–');
  L.next = h('b', null, '–');
  L.prog = h('div', { class: 'progress' }, h('span'));
  L.start = h('button', { class: 'btn green', onclick: () => liveAction('start') }, icon('skipFwd'), h('span', { class: 'lbl' }, 'Start'));
  L.prev = h('button', { class: 'btn', onclick: () => liveAction('prev') }, icon('skipBack'), h('span', { class: 'lbl' }, 'Zurück'));
  L.nextBtn = h('button', { class: 'btn next-btn', onclick: () => liveAction('next') }, icon('play'), h('span', { class: 'lbl' }, 'Weiter'));
  L.stop = h('button', { class: 'btn red', onclick: async () => { if (await confirmDialog('Live-Modus beenden? Die gemessenen Zeiten bleiben sichtbar.', { okLabel: 'Beenden', title: 'Live beenden' })) liveAction('stop'); } }, icon('square'), h('span', { class: 'lbl' }, 'Beenden'));
  L.reset = op ? h('button', { class: 'icon-btn', title: 'Gemessene Zeiten zurücksetzen', onclick: async () => { if (await confirmDialog('Live-Status und alle gemessenen Zeiten zurücksetzen?', { okLabel: 'Zurücksetzen', title: 'Zurücksetzen' })) liveAction('reset'); } }, icon('rotate')) : null;

  return L.bar = h('section', { class: 'card live-bar' },
    h('div', { class: 'live-row' },
      h('span', { class: 'title' }, 'Live-Steuerung'),
      L.follow = h('button', { class: 'follow-chip', title: 'Aktuellen Punkt automatisch ganz oben halten', onclick: () => toggleFollow() }, icon('follow'), h('span', null, 'Mitlaufen')),
      op ? [stepBtn(-1), L.prev, L.start, L.nextBtn, stepBtn(1), L.stop] : h('span', { class: 'muted' }, 'Nur Anzeige'),
      h('div', { class: 'live-stats' },
        h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } }, 'Live seit ', L.since, L.reset),
        L.deltaWrap, L.pointWrap,
        h('span', { title: 'Voraussichtliches Ende' }, 'Ende ', L.endT))),
    L.prog,
    h('div', { class: 'live-now' }, h('span', null, 'Jetzt: ', L.now), h('span', null, 'Als Nächstes: ', L.next)));
}

async function liveAction(action, body = {}) {
  try {
    const r = await api('POST', `/api/rundowns/${S.rd.rundown.id}/live/${action}`, body);
    S.rd.live = r.live;
    S.offset = r.serverNow - Date.now();
    S.liveKey = '';
    tick();
  } catch (e) { toast(e.message, 'err'); }
}

/* ================================================================== Präsenz */
let focusSent = 'null', focusTimer = null;
function reportFocus(itemId, field) {
  if (S.publicToken || !S.clientId) return;
  const key = JSON.stringify(itemId ? [itemId, field] : null);
  if (key === focusSent) return;
  clearTimeout(focusTimer);
  focusTimer = setTimeout(() => {
    focusSent = key;
    api('POST', '/api/presence/focus', { clientId: S.clientId, itemId, field }).catch(() => {});
  }, itemId ? 120 : 400);
}

function presenceMenu(anchor) {
  const p = S.presence || { users: [], viewers: 0 };
  const fieldName = (f) => f === 'title' ? 'Titel' : f === 'description' ? 'Beschreibung' : f === 'duration' ? 'Dauer'
    : (S.rd.columns.find((c) => 'cell:' + c.id === f)?.name || 'Spalte');
  const itemName = (id) => { const it = S.rd.items.find((i) => i.id === id); const nr = S.sched?.map.get(id)?.nr; return it ? `${nr ? nr + '. ' : ''}${it.title || (it.type === 'block' ? 'Block' : 'Ohne Titel')}` : ''; };
  popover(anchor, [
    h('div', { class: 'pres-head' }, h('b', null, 'Gerade in diesem Rundown'), h('span', null, `${p.users.length} ${p.users.length === 1 ? 'Person' : 'Personen'}` + (p.viewers ? ` · ${p.viewers} öffentl. Zuschauer` : ''))),
    ...p.users.map((u) => h('div', { class: 'pres-row' },
      h('span', { class: 'av av-sm', style: `--uc:${userColor(u.id)}` }, initials(u)),
      h('div', { class: 'pres-info' },
        h('b', null, u.name, u.id === S.user?.id ? h('span', { class: 'tag' }, 'Du') : null),
        h('span', null, [ROLE_LABEL[u.role], u.views.map((v) => VIEW_LABEL[v] || v).join(' + '), u.devices > 1 ? `${u.devices} Geräte` : null].filter(Boolean).join(' · ')),
        u.focus.length ? h('span', { class: 'pres-focus' }, icon('edit'), `bearbeitet ${itemName(u.focus[0].itemId)} · ${fieldName(u.focus[0].field)}`) : null),
      h('span', { class: 'on-dot' }))),
    p.users.length ? null : h('div', { class: 'muted', style: { padding: '8px 12px' } }, 'Niemand sonst online.'),
  ]);
}

function renderPresence() {
  if (!R.rows || !S.rd) return;
  const p = S.presence || { users: [], viewers: 0 };
  const me = S.user?.id;
  const others = p.users.filter((u) => u.id !== me);
  // Kopfzeile: Avatare aller anderen + Zuschauer
  if (R.presence) {
    fill(R.presence,
      others.length || p.viewers ? h('button', { class: 'presence-btn', title: 'Wer ist gerade online?', onclick: (e) => presenceMenu(e.currentTarget) },
        others.length ? avatarStack(others, { max: 5, size: 'sm' }) : null,
        h('span', { class: 'pres-txt' },
          others.length ? `${others.length} ${others.length === 1 ? 'weitere Person' : 'weitere Personen'} online` : '',
          others.length && p.viewers ? ' · ' : '',
          p.viewers ? h('span', { class: 'pres-viewers' }, icon('eye'), String(p.viewers)) : null)) : null);
  }
  // Zellen markieren, die andere gerade bearbeiten
  for (const el of R.rows.querySelectorAll('.peer-edit')) { el.classList.remove('peer-edit'); el.style.removeProperty('--uc'); el.removeAttribute('data-peer'); }
  for (const u of others) for (const f of u.focus) {
    const row = R.rows.querySelector(`[data-id="${f.itemId}"]`);
    const input = row?.querySelector(`[data-f="${f.field}"]`);
    const cell = input?.closest('.cell, .block-cell');
    if (!cell) continue;
    cell.classList.add('peer-edit');
    cell.style.setProperty('--uc', userColor(u.id));
    cell.dataset.peer = u.name;
  }
}

const followOn = () => S.prefs.follow !== false;
function toggleFollow() {
  S.prefs.follow = !followOn();
  savePrefs();
  S.lastFollow = null;
  S.liveKey = '';
  if (R.lv?.follow) R.lv.follow.classList.toggle('on', followOn());
  tick();
  toast(followOn() ? 'Mitlaufen an – der aktuelle Punkt bleibt oben' : 'Mitlaufen aus');
}

/** Scrollt so, dass der laufende Punkt ganz oben steht */
function followCurrent(st) {
  const id = st.running ? st.current.id : null;
  R.page?.classList.toggle('following', !!id && followOn());
  if (!id || !followOn()) { S.lastFollow = id; return; }
  if (S.lastFollow === id) return;
  if (S.dragging) return;
  const a = document.activeElement;
  if (a && R.rows.contains(a) && /^(TEXTAREA|INPUT)$/.test(a.tagName)) return; // nicht wegspringen, während jemand tippt
  const row = R.rows.querySelector(`.item-row[data-id="${id}"]`);
  if (!row) return;
  S.lastFollow = id;
  const bar = document.querySelector('.topbar');
  let offset = (bar ? bar.getBoundingClientRect().height : 0) + 12;
  const lb = R.lv?.bar;
  if (lb && getComputedStyle(lb).position === 'sticky') offset += lb.getBoundingClientRect().height + 10;
  requestAnimationFrame(() => {
    const top = row.getBoundingClientRect().top + window.scrollY - offset;
    window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  });
}

function tick() {
  if (!S.rd || !R.rows) return;
  const now = Date.now() + S.offset;
  const live = S.rd.live || {};
  const st = liveStatus(S.rd.items, live, now);
  const L = R.lv;

  if (L) {
    const play = S.rd.items.filter((i) => i.type === 'item');
    L.bar?.classList.toggle('is-live', !!st.running);
    L.bar?.classList.toggle('is-over', !!st.running && st.remaining < 0);
    if (st.running) {
      L.since.textContent = fmtTime(st.startedAt, false);
      L.delta.textContent = fmtDuration(st.delta, { sign: true });
      L.deltaWrap.className = st.delta > 0.5 ? 'red' : 'green';
      L.point.textContent = fmtCountdown(st.remaining);
      L.pointWrap.className = st.remaining < 0 ? 'red' : st.remaining <= 60 ? 'yellow' : '';
      L.endT.textContent = fmtTime(st.projectedEnd, false);
      L.now.textContent = `${st.index + 1}. ${st.current.title || 'Ohne Titel'}${st.adjust ? ` (${fmtDuration(st.adjust, { sign: true })})` : ''}`;
      L.next.textContent = st.next ? st.next.title || 'Ohne Titel' : 'Ende';
      L.prog.firstChild.style.width = st.progress * 100 + '%';
      L.prog.className = 'progress' + (st.remaining < 0 ? ' over' : st.remaining <= 60 ? ' warn' : '');
    } else {
      L.since.textContent = '--:--';
      L.delta.textContent = '--:--'; L.deltaWrap.className = '';
      L.point.textContent = '--:--'; L.pointWrap.className = '';
      L.endT.textContent = live.endedAt ? 'beendet ' + fmtTime(live.endedAt, false) : '--:--';
      L.now.textContent = 'nicht live';
      L.next.textContent = play[0]?.title || '–';
      L.prog.firstChild.style.width = '0';
      L.prog.className = 'progress';
    }
    if (L.start) {
      L.start.disabled = st.running || !play.length;
      L.prev.disabled = L.stop.disabled = !st.running;
      L.nextBtn.disabled = !play.length;
      (L.adjust || []).forEach((b) => (b.disabled = !st.running));
    }
  }

  const hist = live.history || {};
  const key = (st.running ? st.current.id : '-') + '|' + (st.next?.id || '') + '|' + JSON.stringify(hist) + '|' + S.rd.items.length;
  if (R.lv?.follow) R.lv.follow.classList.toggle('on', followOn());
  if (key !== S.liveKey) {
    S.liveKey = key;
    setTimeout(() => followCurrent(st), 0);
    for (const row of R.rows.querySelectorAll('.item-row')) {
      const id = Number(row.dataset.id);
      const isLive = st.running && st.current.id === id;
      row.classList.toggle('is-live', isLive);
      row.classList.toggle('is-next', !!(st.running && st.next?.id === id));
      row.classList.toggle('is-done', hist[id] != null && !isLive);
      if (!isLive) row.classList.remove('over');
      const d = row.querySelector('[data-r="delta"]');
      if (!d) continue;
      if (hist[id] != null && !isLive) {
        const diff = hist[id] - (item(id)?.duration || 0);
        d.textContent = Math.abs(diff) < 1 ? '±00:00' : fmtDuration(diff, { sign: true });
        d.className = 'delta ' + (diff > 0 ? 'red' : 'green');
        d.title = `Tatsächlich: ${fmtDuration(hist[id])}`;
      } else { d.textContent = ''; d.className = 'delta'; d.title = ''; }
      const pb = row.querySelector('.row-prog > span');
      if (pb && !isLive) pb.style.width = '0';
    }
  }
  if (st.running) {
    const row = R.rows.querySelector(`.item-row[data-id="${st.current.id}"]`);
    if (row) {
      row.classList.toggle('over', st.remaining < 0);
      const d = row.querySelector('[data-r="delta"]');
      d.textContent = fmtCountdown(st.remaining);
      d.className = 'delta ' + (st.remaining < 0 ? 'red' : st.remaining <= 60 ? 'yellow' : 'green');
      d.title = 'Restzeit';
      row.querySelector('.row-prog > span').style.width = st.progress * 100 + '%';
    }
  }
}

/* ================================================================== Menüs & Dialoge */
function viewMenu(anchor) {
  const items = [];
  if (can('editor')) items.push({ label: S.readMode ? 'Bearbeiten aktivieren' : 'Nur-Lesen-Modus', icon: S.readMode ? 'edit' : 'eye', onClick: () => { S.readMode = !S.readMode; R.sig = null; applyPageClasses(); renderAll(); } });
  items.push(
    { label: 'Kompakte Zeilen', icon: S.prefs.compact ? 'check' : 'list', active: S.prefs.compact, onClick: () => { S.prefs.compact = !S.prefs.compact; savePrefs(); applyPageClasses(); requestAnimationFrame(() => R.rows.querySelectorAll('textarea').forEach(autosize)); } },
    { label: 'Mitlaufen (aktueller Punkt oben)', icon: followOn() ? 'check' : 'follow', active: followOn(), onClick: toggleFollow },
    { label: 'Erledigte Punkte ausblenden', icon: S.prefs.hideDone ? 'check' : 'eyeOff', active: S.prefs.hideDone, onClick: () => { S.prefs.hideDone = !S.prefs.hideDone; savePrefs(); applyPageClasses(); } },
    { label: 'Spalten ein-/ausblenden …', icon: 'columns', onClick: columnsModal },
    { label: 'Live-Ansicht im Vollbild', icon: 'monitor', onClick: () => window.open(S.publicToken ? `/live/p/${encodeURIComponent(S.publicToken)}` : `/live/${S.rd.rundown.id}`, '_blank') });
  menu(anchor, items);
}

function columnsModal() {
  const body = h('div');
  const editable = can('editor') && !S.publicToken;
  const toggle = (key) => {
    if (S.hidden.has(key)) S.hidden.delete(key); else S.hidden.add(key);
    savePrefs(); renderAll(); draw();
  };
  const eyeBtn = (key) => h('button', { class: 'icon-btn' + (S.hidden.has(key) ? ' off' : ''), title: S.hidden.has(key) ? 'Einblenden' : 'Ausblenden', onclick: () => toggle(key) }, icon(S.hidden.has(key) ? 'eyeOff' : 'eye'));
  const draw = () => {
    const cols = S.rd.columns;
    const newName = h('input', { class: 'input', placeholder: 'Neue Spalte, z. B. Kamera, Licht, Moderation …' });
    const add = async () => {
      if (!newName.value.trim()) return;
      try { applyPayload(await api('POST', `/api/rundowns/${S.rd.rundown.id}/columns`, { name: newName.value })); draw(); body.querySelector('input[placeholder^="Neue Spalte"]')?.focus(); }
      catch (e) { toast(e.message, 'err'); }
    };
    newName.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
    const move = async (idx, dir) => {
      const ids = cols.map((c) => c.id);
      const [x] = ids.splice(idx, 1);
      ids.splice(idx + dir, 0, x);
      applyPayload(await api('POST', `/api/rundowns/${S.rd.rundown.id}/columns/reorder`, { ids }));
      draw();
    };
    fill(body, 
      h('p', null, 'Ein- und Ausblenden gilt nur für dich (in diesem Browser).' + (editable ? ' Spalten anlegen, umbenennen und löschen gilt für alle.' : '')),
      h('div', { class: 'col-sep' }, 'Feste Spalten'),
      h('div', { class: 'col-list' },
        [['start', 'Start'], ['end', 'Ende']].map(([k, n]) => h('div', { class: 'col-item' }, h('span', { class: 'name' }, n), eyeBtn(k)))),
      h('div', { class: 'col-sep' }, 'Eigene Spalten'),
      h('div', { class: 'col-list' },
        cols.length ? cols.map((c, i) => h('div', { class: 'col-item' },
          editable
            ? h('input', { class: 'input', value: c.name, onchange: async (e) => { try { applyPayload(await api('PATCH', '/api/columns/' + c.id, { name: e.target.value })); } catch (ex) { toast(ex.message, 'err'); } } })
            : h('span', { class: 'name' }, c.name),
          editable ? h('label', { class: 'switch', title: 'Im öffentlichen Link sichtbar' },
            h('input', { type: 'checkbox', checked: c.is_public, onchange: async (e) => { applyPayload(await api('PATCH', '/api/columns/' + c.id, { is_public: e.target.checked })); } }),
            h('span', { class: 'tag' }, 'öffentlich')) : null,
          editable ? h('button', { class: 'icon-btn', title: 'Nach links', disabled: i === 0, onclick: () => move(i, -1) }, icon('chevronUp')) : null,
          editable ? h('button', { class: 'icon-btn', title: 'Nach rechts', disabled: i === cols.length - 1, onclick: () => move(i, 1) }, icon('chevronDown')) : null,
          eyeBtn('c' + c.id),
          editable ? h('button', { class: 'icon-btn', style: { color: 'var(--red-text)' }, title: 'Spalte löschen', onclick: async () => { if (await confirmDialog(`Spalte „${c.name}“ mit allen Inhalten löschen?`)) { applyPayload(await api('DELETE', '/api/columns/' + c.id)); draw(); } } }, icon('trash')) : null))
          : h('div', { class: 'muted' }, 'Keine eigenen Spalten.')),
      editable ? h('div', { style: { display: 'flex', gap: '8px', marginTop: '14px' } }, newName, h('button', { class: 'btn primary', onclick: add }, icon('plus'), 'Hinzufügen')) : null);
  };
  draw();
  modal({ title: 'Spalten', body, wide: true });
}

function downloadFile(name, href) {
  const a = h('a', { href, download: name });
  document.body.append(a); a.click(); a.remove();
}

function qrFullscreen(url, label) {
  const ov = h('div', { class: 'qr-full', onclick: () => ov.remove() },
    h('div', { class: 'qr-full-box', onclick: (e) => e.stopPropagation() },
      h('div', { class: 'qr-img', html: qrSvg(url, { border: 2 }) }),
      h('div', { class: 'qr-full-label' }, label),
      h('div', { class: 'qr-full-url' }, url.replace(/^https?:\/\//, ''))),
    h('button', { class: 'icon-btn qr-full-x', onclick: () => ov.remove(), title: 'Schließen' }, icon('x')));
  const onKey = (e) => { if (e.key === 'Escape') { ov.remove(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
  document.body.append(ov);
}

function publicLinkModal() {
  const body = h('div', { class: 'pub' });
  let which = 'rundown';
  let showQr = localStorage.getItem('ffr.qr') === '1';
  const draw = () => {
    const rd = S.rd.rundown;
    const links = {
      rundown: { url: `${location.origin}/p/${rd.public_token}`, label: 'Rundown', desc: 'Komplette Ablaufübersicht, nur lesend' },
      live: { url: `${location.origin}/live/p/${rd.public_token}`, label: 'Live-Ansicht', desc: 'Statusleiste, Restzeit & Karten – ideal für Bildschirme' },
    };
    const cur = links[which];
    const editable = can('editor');
    const enabled = rd.public_enabled;

    const statusCard = h('div', { class: 'pub-status' + (enabled ? ' on' : '') },
      h('div', { class: 'pub-status-ico' }, icon('globe')),
      h('div', { class: 'pub-status-txt' },
        h('b', null, enabled ? 'Öffentlicher Link ist aktiv' : 'Öffentlicher Link ist aus'),
        h('span', null, enabled ? 'Jeder mit dem Link kann zusehen – ohne Login, nur lesend.' : 'Niemand kann den Rundown ohne Anmeldung sehen.')),
      editable ? h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: enabled, onchange: async (e) => {
        try { applyPayload(await api('POST', `/api/rundowns/${rd.id}/public`, { enabled: e.target.checked })); draw(); } catch (ex) { toast(ex.message, 'err'); }
      } })) : null);

    if (!enabled) {
      fill(body, statusCard, h('p', { class: 'hint', style: { marginTop: '14px' } },
        editable ? 'Aktivieren, um einen Link (und QR-Code) zum Teilen zu erhalten. Spalten ohne Markierung „öffentlich“ bleiben verborgen.' : 'Ein Editor kann den öffentlichen Link aktivieren.'));
      return;
    }

    const qrPanel = showQr ? h('div', { class: 'qr-panel' },
      h('div', { class: 'qr-img', html: qrSvg(cur.url, { border: 2 }), title: 'Klicken für Vollbild', onclick: () => qrFullscreen(cur.url, `${rd.title} · ${cur.label}`) }),
      h('div', { class: 'qr-side' },
        h('b', null, `QR-Code · ${cur.label}`),
        h('span', { class: 'hint' }, 'Mit der Handy-Kamera scannen, um den Link direkt zu öffnen. Zum Ausdrucken oder Einblenden herunterladen.'),
        h('div', { class: 'qr-btns' },
          h('button', { class: 'btn sm', onclick: () => qrFullscreen(cur.url, `${rd.title} · ${cur.label}`) }, icon('maximize'), 'Vollbild'),
          h('button', { class: 'btn sm', onclick: () => downloadFile(`qr-${which}-${rd.id}.png`, qrPng(cur.url, { scale: 20 })) }, icon('download'), 'PNG'),
          h('button', { class: 'btn sm', onclick: () => downloadFile(`qr-${which}-${rd.id}.svg`, 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(qrSvg(cur.url))) }, icon('download'), 'SVG')))) : null;

    fill(body,
      statusCard,
      h('div', { class: 'seg seg-wide', style: { marginTop: '16px' } },
        Object.entries(links).map(([k, l]) => h('button', { class: which === k ? 'sel' : '', onclick: () => { which = k; draw(); } }, icon(k === 'live' ? 'monitor' : 'list'), l.label))),
      h('div', { class: 'hint', style: { margin: '8px 2px 10px' } }, cur.desc),
      h('div', { class: 'link-box' },
        h('input', { class: 'input mono', readonly: true, value: cur.url, onfocus: (e) => e.target.select() }),
        h('button', { class: 'btn primary', onclick: () => copyText(cur.url) }, icon('copy'), 'Kopieren'),
        navigator.share ? h('button', { class: 'btn', title: 'Teilen', onclick: () => navigator.share({ title: rd.title, url: cur.url }).catch(() => {}) }, icon('share')) : null,
        h('button', { class: 'btn', title: 'Öffnen', onclick: () => window.open(cur.url, '_blank') }, icon('external'))),
      h('div', { class: 'pub-actions' },
        h('button', { class: 'btn sm' + (showQr ? ' active-toggle' : ''), onclick: () => { showQr = !showQr; localStorage.setItem('ffr.qr', showQr ? '1' : '0'); draw(); } }, icon('qr'), showQr ? 'QR-Code ausblenden' : 'QR-Code anzeigen'),
        editable ? h('button', { class: 'btn sm ghost', onclick: async () => {
          if (await confirmDialog('Es wird ein neuer Link erzeugt. Der bisherige Link und alte QR-Codes funktionieren dann nicht mehr; offene Ansichten werden getrennt.', { okLabel: 'Neu erzeugen', title: 'Neuen Link erzeugen?' })) {
            applyPayload(await api('POST', `/api/rundowns/${rd.id}/public`, { regenerate: true })); toast('Neuer Link erzeugt', 'ok'); draw();
          }
        } }, icon('rotate'), 'Neuen Link erzeugen') : null),
      qrPanel,
      h('p', { class: 'hint', style: { marginTop: '14px' } }, 'Nur Spalten mit Markierung „öffentlich“ (unter „Spalten“) sind sichtbar.'));
  };
  draw();
  modal({ title: 'Öffentlicher Link', body, wide: true });
}

async function apiModal() {
  const rd = S.rd.rundown;
  let token, info, reveal = false;
  try { info = await api('GET', `/api/rundowns/${rd.id}/companion`); token = info.token; } catch (e) { return toast(e.message, 'err'); }
  const rotate = async () => {
    const ok = await confirmTyped({
      title: 'API-Token sperren & neu erzeugen',
      intro: `Der aktuelle Token für „${rd.title}“ wird sofort ungültig.`,
      points: [
        'Alle Companion-Buttons, Stream Decks, Skripte und Tools mit dem alten Token verlieren sofort den Zugriff (Steuern und Auslesen).',
        'Ein laufender Live-Durchlauf wird dadurch nicht unterbrochen – er lässt sich weiter hier im Browser bedienen.',
        'Alle berechtigten Geräte müssen danach mit der neuen URL eingerichtet werden.',
        'Benutzer-Logins und der öffentliche Link sind davon nicht betroffen.',
      ],
      word: 'NEU',
      okLabel: 'Token jetzt sperren',
    });
    if (!ok) return;
    try {
      info = await api('POST', `/api/rundowns/${rd.id}/companion/regenerate`, { confirm: true });
      token = info.token;
      toast('Alter Token gesperrt – neuer Token ist aktiv', 'ok');
      draw();
    } catch (e) { toast(e.message, 'err'); }
  };

  const body = h('div', { class: 'apim' });
  let tab = 'control';
  let result = null; // { path, status, ms, text }
  const baseReal = () => `${location.origin}/api/v1/${token}`;
  const baseShown = () => `${location.origin}/api/v1/${reveal ? token : token.slice(0, 4) + '••••••••••••'}`;

  const tryIt = async (path) => {
    const t0 = performance.now();
    try {
      const r = await fetch(baseReal() + path, { cache: 'no-store' });
      const txt = await r.text();
      let pretty = txt;
      try { pretty = JSON.stringify(JSON.parse(txt), null, 2); } catch { /* Text */ }
      result = { path, status: r.status, ms: Math.round(performance.now() - t0), text: pretty };
    } catch (e) { result = { path, status: 0, ms: 0, text: e.message }; }
    draw();
    body.querySelector('.api-result')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };

  const ep = (method, path, title, desc, { test = false } = {}) => h('div', { class: 'ep' },
    h('span', { class: 'method m-' + method.toLowerCase() }, method),
    h('div', { class: 'ep-main' },
      h('div', { class: 'ep-title' }, title),
      h('code', { class: 'ep-path' }, path),
      desc ? h('div', { class: 'ep-desc' }, desc) : null),
    h('div', { class: 'ep-act' },
      test ? h('button', { class: 'btn sm', title: 'Antwort anzeigen', onclick: () => tryIt(path) }, icon('play'), 'Testen') : null,
      h('button', { class: 'icon-btn', title: 'URL kopieren', onclick: () => copyText(baseReal() + path) }, icon('copy'))));

  const snippet = (title, code) => h('div', { class: 'snip' },
    h('div', { class: 'snip-head' }, h('span', null, title), h('button', { class: 'icon-btn', title: 'Kopieren', onclick: () => copyText(code) }, icon('copy'))),
    h('pre', null, code));

  const draw = () => {
    const tabs = [['control', 'Steuern', 'play'], ['read', 'Auslesen', 'eye'], ['items', 'Punkte', 'list'], ['integr', 'Integrationen', 'gamepad'], ['security', 'Sicherheit', 'shield']];
    let content;
    if (tab === 'control') {
      content = h('div', { class: 'ep-list' },
        h('div', { class: 'ep-group' }, 'Ablauf'),
        ep('POST', '/start', 'Start', 'Startet beim ersten Punkt (optional ?item=ID)'),
        ep('POST', '/next', 'Weiter', 'Nächster Punkt – startet, falls noch nicht live'),
        ep('POST', '/prev', 'Zurück', 'Vorheriger Punkt'),
        ep('POST', '/goto?item=ID', 'Springen', 'Direkt zu einem Punkt (IDs unter „Punkte“)'),
        ep('POST', '/stop', 'Beenden', 'Live-Modus beenden, gemessene Zeiten bleiben'),
        ep('POST', '/reset', 'Zurücksetzen', 'Live-Status und Messwerte löschen'),
        h('div', { class: 'ep-group' }, 'Zeit am laufenden Punkt'),
        ep('POST', '/add?seconds=30', 'Zeit addieren', 'Mit Vorzeichen: seconds=-30 oder time=-1:00'),
        ep('POST', '/set?time=05:00', 'Restzeit setzen', 'Countdown steht danach exakt auf dem Wert'),
        ep('POST', '/setduration?time=10:00', 'Dauer setzen', 'Gesamtdauer des laufenden Punkts für diesen Durchlauf'),
        ep('POST', '/plus?seconds=60', '+ Zeit', null), ep('POST', '/minus?seconds=60', '− Zeit', null));
    } else if (tab === 'read') {
      content = h('div', { class: 'ep-list' },
        h('div', { class: 'ep-group' }, 'JSON'),
        ep('GET', '/cue', 'Aktueller Cue', 'Laufender Punkt mit allen Spalten, Restzeit, Startzeit, Fortschritt + vorheriger/nächster', { test: true }),
        ep('GET', '/rundown', 'Kompletter Rundown', 'Alle Punkte, Blöcke & Spalten mit Plan-/Ist-Zeiten und Status', { test: true }),
        ep('GET', '/status', 'Status (flach)', 'Einfache Werte für Variablen: title, next, remaining, delta, state …', { test: true }),
        h('div', { class: 'ep-group' }, 'Reiner Text – z. B. für Button-Beschriftungen'),
        ep('GET', '/text/remaining', 'Restzeit', null, { test: true }), ep('GET', '/text/title', 'Titel', null, { test: true }),
        ep('GET', '/text/next', 'Nächster Punkt', null, { test: true }), ep('GET', '/text/delta', 'Abweichung', null, { test: true }),
        ep('GET', '/text/state', 'Zustand', 'running | warning | overtime | stopped', { test: true }));
    } else if (tab === 'items') {
      const play = S.rd.items.filter((i) => i.type === 'item');
      content = h('div', { class: 'ep-list' },
        h('div', { class: 'ep-group' }, 'Direkt zu einem Punkt springen'),
        play.length ? play.map((it, n) => ep('POST', `/goto?item=${it.id}`, `${n + 1}. ${it.title || 'Ohne Titel'}`, `ID ${it.id} · ${fmtDuration(it.duration)}`)) : h('div', { class: 'muted' }, 'Noch keine Programmpunkte.'));
    } else if (tab === 'integr') {
      const b = baseReal();
      content = h('div', { class: 'integr' },
        h('div', { class: 'integr-card' },
          h('div', { class: 'integr-head' }, icon('gamepad'), h('b', null, 'Bitfocus Companion / Stream Deck')),
          h('ol', null,
            h('li', null, 'Modul ', h('b', null, 'Generic: HTTP Requests'), ' hinzufügen und als Base-URL die oben angezeigte Basis-URL eintragen.'),
            h('li', null, 'Buttons mit Aktion ', h('b', null, 'POST'), ' anlegen, URL z. B. ', h('code', null, '/next'), ', ', h('code', null, '/add?seconds=30'), '.'),
            h('li', null, 'Feedback/Restzeit: per Trigger jede Sekunde ', h('code', null, 'GET /status'), ' abfragen und in eine Custom-Variable schreiben – oder ', h('code', null, '/text/remaining'), ' nutzen.'))),
        snippet('curl', `curl -X POST "${b}/next"\ncurl -X POST "${b}/set?time=05:00"\ncurl "${b}/cue"`),
        snippet('JavaScript', `const base = "${b}";\n\n// aktuellen Cue lesen\nconst cue = await (await fetch(base + "/cue")).json();\nconsole.log(cue.current?.title, cue.current?.remaining);\n\n// 30 Sekunden hinzufügen\nawait fetch(base + "/add?seconds=30", { method: "POST" });`),
        snippet('Python', `import requests\nbase = "${b}"\nprint(requests.get(base + "/cue").json()["current"])\nrequests.post(base + "/next")`),
        h('p', { class: 'hint' }, 'Alle Endpunkte akzeptieren GET und POST, Parameter als Query oder JSON-Body. CORS ist freigegeben, damit Overlays (OBS, vMix, eigene Web-Seiten) direkt abfragen können.'));
    } else {
      content = h('div', null,
        h('div', { class: 'sec-info' },
          h('div', null, icon('key'), h('span', null, h('b', null, 'Der Token ist wie ein Passwort.'), ' Wer ihn kennt, kann diesen Rundown live steuern und auslesen – ohne Login.')),
          h('div', null, icon('shield'), h('span', null, 'Nur Editoren und Admins sehen den Token. Gib ihn nur an Geräte und Personen weiter, die ihn brauchen.')),
          h('div', null, icon('globe'), h('span', null, 'Über das Internet erreichbar? Dann unbedingt HTTPS (Reverse-Proxy) verwenden, damit der Token verschlüsselt übertragen wird.'))),
        h('div', { class: 'danger-zone' },
          h('div', { class: 'txt' }, h('b', null, 'Notfall: API-Token sperren'),
            'Macht den aktuellen Token sofort ungültig – z. B. wenn er in falsche Hände geraten ist.',
            info.rotated_at ? h('div', { class: 'hint', style: { marginTop: '4px' } }, `Zuletzt neu erzeugt: ${new Date(info.rotated_at).toLocaleString('de-DE')}${info.rotated_by ? ' von ' + info.rotated_by : ''}`) : null),
          h('button', { class: 'btn red sm', onclick: rotate }, icon('lock'), 'Token sperren & neu erzeugen')));
    }

    const res = result && (tab === 'read') ? h('div', { class: 'api-result' },
      h('div', { class: 'api-result-head' },
        h('span', { class: 'method m-get' }, 'GET'), h('code', null, result.path),
        h('span', { class: 'res-status ' + (result.status >= 200 && result.status < 300 ? 'ok' : 'bad') }, result.status ? `${result.status}` : 'Fehler'),
        h('span', { class: 'muted' }, `${result.ms} ms`),
        h('button', { class: 'icon-btn', title: 'Kopieren', onclick: () => copyText(result.text) }, icon('copy')),
        h('button', { class: 'icon-btn', title: 'Schließen', onclick: () => { result = null; draw(); } }, icon('x'))),
      h('pre', null, result.text)) : null;

    fill(body,
      h('div', { class: 'api-hero' },
        h('div', { class: 'api-hero-top' },
          h('span', { class: 'label' }, 'Basis-URL'),
          h('div', { class: 'api-tags' }, h('span', null, 'REST'), h('span', null, 'GET & POST'), h('span', null, 'JSON'), h('span', null, 'CORS'))),
        h('div', { class: 'api-base' },
          h('code', null, baseShown()),
          h('button', { class: 'icon-btn', title: reveal ? 'Token verbergen' : 'Token anzeigen', onclick: () => { reveal = !reveal; draw(); } }, icon(reveal ? 'eyeOff' : 'eye')),
          h('button', { class: 'btn sm primary', onclick: () => copyText(baseReal()) }, icon('copy'), 'Kopieren')),
        h('div', { class: 'hint' }, 'Endpunkte unten an diese URL anhängen. Ältere Companion-Adressen (/api/companion/…) funktionieren weiterhin.')),
      h('div', { class: 'seg seg-wide api-tabs' }, tabs.map(([k, l, ic]) => h('button', { class: tab === k ? 'sel' : '', onclick: () => { tab = k; draw(); } }, icon(ic), h('span', null, l)))),
      content,
      res);
  };
  draw();
  modal({ title: 'API & Integrationen', body, wide: true });
}

/* ================================================================== Start */
// Regelmäßig prüfen, ob auf dem Server eine neue Version läuft (alle Ansichten)
async function checkVersion() {
  try {
    const r = await fetch('/api/health', { cache: 'no-store' });
    const d = await r.json();
    if (d.version && S.version && d.version !== S.version) showUpdateBanner(d.version);
  } catch { /* offline */ }
}
setInterval(checkVersion, 30000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkVersion(); });

(async function init() {
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('/sw.js').catch(() => {});
  if (location.pathname.startsWith('/p/')) return router();
  try {
    const st = await api('GET', '/api/auth/status');
    S.user = st.user; S.needsSetup = st.needsSetup; S.version = st.version;
  } catch { /* offline */ }
  router();
})();
