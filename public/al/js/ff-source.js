// Datenquelle der Aufnahmeleitung in FF-Broadcast.
// Ersetzt die WebSocket-Verbindung zum Relay des FF-Aufnahmeleitung-Tools: liest Rundown und
// Live-Zustand direkt aus FF-Broadcast (REST + Server-Sent Events) und baut daraus genau den
// Zustand, den die Ansichten (Bedienung, Schild, Regie, Vollbild-Stapel) vom Relay kennen.
// Befehle (Start, Next, Pause, Zurück, Beenden, Zeit +, Signale, eigener Text, Marker)
// gehen an die Live-Steuerung von FF-Broadcast und gelten damit für alle Geräte.

import { computeSchedule, parseClock } from '/shared/timing.js';
import { classifyTitle } from './cue-kinds.js';
import { derivePeople } from './people-detect.js';

export const perfNow = () => performance.timeOrigin + performance.now();

const ROLE_RANK = { viewer: 0, operator: 1, editor: 2, admin: 3 };
const firstLine = (s) => String(s ?? '').split('\n')[0].trim();
const restLines = (s) => String(s ?? '').split('\n').slice(1).map((l) => l.trim()).filter(Boolean).join(' · ');
const emptySignals = () => ({ wrap: false, cut: false, standby: false, stretchAt: null });

/** Ansicht und Rundown aus der Adresse: /aufnahmeleitung/12, /regie/p/<token> … */
export function parseRoute(pathname = location.pathname) {
  const m = pathname.match(/^\/(aufnahmeleitung|regie|stapel|schild)\/(?:p\/([^/]+)|(\d+))\/?$/);
  if (!m) return null;
  return { view: m[1], publicToken: m[2] ? decodeURIComponent(m[2]) : null, rundownId: m[3] ? Number(m[3]) : null };
}

export class FFSource extends EventTarget {
  constructor({ route }) {
    super();
    this.route = route;
    this.status = 'connecting';
    this.closedAt = perfNow();
    this.speed = 1;
    this.offset = 0; // Serveruhr − eigene Uhr
    this.rtt = null;
    this.payload = null;
    this.rundown = null; // Cues im Format des AL-Tools
    this.role = 'viewer'; // wird beim Laden aus my_role übernommen
    this.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Berlin';
    this.version = 0;
    this.es = null;
    setInterval(() => this.emitState(), 1000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && (!this.es || this.es.readyState === 2)) this.connect();
    });
  }

  /* ---------------------------------------------------------------- Adressen */
  get base() {
    return this.route.publicToken ? `/api/public/${encodeURIComponent(this.route.publicToken)}` : `/api/rundowns/${this.route.rundownId}`;
  }
  /** Adresse einer anderen Ansicht desselben Rundowns ('editor' = Rundown in FF-Broadcast) */
  link(view) {
    const { publicToken: t, rundownId: id } = this.route;
    if (view === 'editor') return t ? `/p/${encodeURIComponent(t)}` : `/#/rundown/${id}`;
    return t ? `/${view}/p/${encodeURIComponent(t)}` : `/${view}/${id}`;
  }
  /** Darf dieses Gerät die Show steuern? (Rolle „Live-Steuerung“ oder höher, nicht über den öffentlichen Link) */
  get canOperate() {
    return !this.route.publicToken && (ROLE_RANK[this.role] ?? 0) >= ROLE_RANK.operator;
  }

  /* ---------------------------------------------------------------- Verbindung */
  async load() {
    const t0 = perfNow();
    const r = await fetch(this.base, { credentials: 'same-origin', cache: 'no-store' });
    const t1 = perfNow();
    if (r.status === 401) throw Object.assign(new Error('Bitte zuerst in FF-Broadcast anmelden.'), { code: 401 });
    if (!r.ok) throw Object.assign(new Error('Rundown nicht gefunden oder Link deaktiviert.'), { code: r.status });
    const p = await r.json();
    this.rtt = t1 - t0;
    this.offset = p.serverNow - (t0 + t1) / 2;
    if (p.my_role) this.role = p.my_role;
    this.applyPayload(p);
  }

  async connect() {
    try {
      await this.load();
    } catch (e) {
      this.setStatus('closed');
      this.dispatchEvent(new CustomEvent('fatal', { detail: e }));
      if (e.code === 401 || e.code === 404 || e.code === 403) return;
      clearTimeout(this.retry);
      this.retry = setTimeout(() => this.connect(), 3000);
      return;
    }
    this.dispatchEvent(new CustomEvent('hello', { detail: { giphy: false } }));
    this.es?.close();
    const q = this.route.publicToken ? { public: this.route.publicToken } : { rundown: this.route.rundownId, view: this.route.view };
    const es = new EventSource('/api/events?' + new URLSearchParams(q));
    this.es = es;
    let first = true;
    es.addEventListener('hello', () => {
      this.setStatus('open');
      if (!first) this.load().catch(() => {}); // nach einer Unterbrechung alles neu holen
      first = false;
    });
    es.addEventListener('rundown', (e) => this.applyPayload(JSON.parse(e.data)));
    es.addEventListener('live', (e) => {
      const d = JSON.parse(e.data);
      if (!this.payload) return;
      this.offset = d.serverNow - perfNow();
      this.payload.live = d.live || {};
      this.emitState();
    });
    es.addEventListener('gone', () => this.fatal('Dieser Link wurde deaktiviert.'));
    es.addEventListener('deleted', () => this.fatal('Dieser Rundown wurde gelöscht.'));
    es.onerror = () => {
      if (es.readyState === 2) this.setStatus('closed');
      else if (this.status === 'open') this.setStatus('connecting');
    };
  }

  fatal(text) {
    this.es?.close();
    this.setStatus('closed');
    this.dispatchEvent(new CustomEvent('fatal', { detail: new Error(text) }));
  }

  setStatus(s) {
    if (this.status === s) return;
    if (this.status === 'open' && s !== 'open') this.closedAt = perfNow();
    this.status = s;
    this.dispatchEvent(new CustomEvent('status', { detail: s }));
  }

  get open() {
    return this.status === 'open';
  }
  offlineForMs() {
    return this.open ? 0 : perfNow() - this.closedAt;
  }
  showNow() {
    return perfNow() + this.offset;
  }
  syncInfo() {
    return this.rtt == null ? null : { rttMs: Math.round(this.rtt), accuracyMs: Math.round(this.rtt / 2) };
  }

  /* ---------------------------------------------------------------- Modell */
  applyPayload(p) {
    const prev = this.rundown;
    this.payload = p;
    this.rundown = this.buildRundown(p);
    // Änderung im Rundown (nicht beim ersten Laden) kurz melden
    let lastEdit = null;
    if (prev) {
      const sig = (c) => JSON.stringify([c.title, c.subtitle, c.durationMs, c.notes, c.columns, c.color]);
      const before = new Map(prev.cues.map((c) => [c.id, sig(c)]));
      const changed = this.rundown.cues.filter((c) => before.get(c.id) !== sig(c)).map((c) => c.number);
      const removed = prev.cues.length - this.rundown.cues.filter((c) => before.has(c.id)).length;
      if (changed.length || removed || prev.title !== this.rundown.title) {
        this.version++;
        const parts = [];
        if (changed.length) parts.push(changed.length > 4 ? `${changed.length} Cues geändert` : `${changed.length === 1 ? 'Cue' : 'Cues'} ${changed.join(', ')} geändert`);
        if (removed > 0) parts.push(`${removed} ${removed === 1 ? 'Cue' : 'Cues'} entfernt`);
        if (!parts.length) parts.push('Titel geändert');
        lastEdit = { version: this.version, summary: parts.join(' · ') };
      }
    }
    this.lastEdit = lastEdit || this.lastEdit || null;
    this.dispatchEvent(new CustomEvent('rundown', { detail: { rundown: this.rundown, groups: [], lastEdit: this.lastEdit } }));
    this.emitState();
  }

  /** Beginn des Showtags (lokale Mitternacht des Datums bzw. heute) */
  dayStart(p) {
    const d = p.rundown.event_date ? new Date(p.rundown.event_date + 'T00:00:00') : new Date(this.showNow());
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  buildRundown(p) {
    const startSec = parseClock(p.rundown.start_time || '00:00');
    const sched = computeSchedule(p.items, startSec);
    const day = this.dayStart(p);
    const cols = p.columns || [];
    const notesCol = cols.find((c) => /^(notiz|notizen|notes?|anmerkung|anmerkungen|hinweis|hinweise|al)$/i.test(c.name.trim()));
    const cues = [];
    for (const it of p.items) {
      if (it.type !== 'item') continue;
      const s = sched.map.get(it.id) || {};
      const { kind, emoji } = classifyTitle(it.title);
      const columns = {};
      for (const c of cols) {
        if (c === notesCol) continue;
        const v = String(it.cells?.[c.id] ?? '').trim();
        if (v) columns[c.name.slice(0, 60)] = v.slice(0, 500);
      }
      cues.push({
        id: it.id,
        number: s.nr,
        index: cues.length,
        title: firstLine(it.title) || 'Ohne Titel',
        subtitle: [restLines(it.title), firstLine(it.description)].filter(Boolean).join(' · '),
        notes: notesCol ? String(it.cells?.[notesCol.id] ?? '').trim() : '',
        color: it.color || s.block?.color || null,
        kind,
        emoji,
        durationMs: Math.max(0, it.duration || 0) * 1000,
        plannedStartAt: day + (s.start ?? 0) * 1000,
        anchorAt: null,
        block: s.block?.title || null,
        blockId: s.block?.id ?? null,
        columns,
      });
    }
    derivePeople(cues).forEach((list, i) => (cues[i].people = list));
    return {
      id: p.rundown.id,
      title: p.rundown.title,
      eventDate: p.rundown.event_date || null,
      columns: cols.map((c) => c.name),
      version: this.version,
      cues,
      groups: [],
    };
  }

  /** Zustand im Format des Relays (siehe FF-Aufnahmeleitung-Tool, relay.snapshot) */
  snapshot() {
    const p = this.payload;
    const rd = this.rundown;
    if (!p || !rd) return null;
    const now = this.showNow();
    const live = p.live || {};
    const byId = new Map(rd.cues.map((c) => [c.id, c]));
    const idx = live.running ? rd.cues.findIndex((c) => c.id === live.currentId) : -1;
    const cur = idx >= 0 ? rd.cues[idx] : null;
    const al = live.al || {};
    const hist = live.history || {};
    const adjusts = live.adjusts || {};
    const starts = live.starts || {};
    const pausedAt = live.pausedAt || null;

    let cue = null;
    let elapsed = 0;
    if (cur) {
      const stretchMs = (live.adjust || 0) * 1000;
      cue = { ...cur, startedAt: live.itemStartedAt, stretchMs, effectiveMs: cur.durationMs + stretchMs };
      elapsed = Math.max(0, (pausedAt || now) - live.itemStartedAt);
    }
    // Danach / erster Cue
    let next = null;
    let nextReason = null;
    if (cur) {
      next = rd.cues[idx + 1] || null;
      nextReason = next ? 'sequence' : null;
    } else if (!live.endedAt && !live.running && rd.cues.length) {
      next = rd.cues[0];
      nextReason = 'start';
    }
    // Vorher: zuletzt gelaufener Punkt mit Ist-Dauer
    let prev = null;
    if (cur && idx > 0) {
      const c = rd.cues[idx - 1];
      const actualMs = hist[c.id] != null ? hist[c.id] * 1000 : null;
      const stretchMs = (adjusts[c.id] || 0) * 1000;
      prev = { ...c, startedAt: starts[c.id] ?? null, actualMs, stretchMs, deltaMs: actualMs == null ? null : actualMs - c.durationMs - stretchMs };
    }
    // Salden: Moderation (moderierte Cues) und Spiel (offene Cues), wie im Relay
    let moderationMs = 0;
    let gameMs = 0;
    for (const [id, sec] of Object.entries(hist)) {
      const c = byId.get(Number(id));
      if (!c || c.id === cur?.id) continue;
      const actual = sec * 1000;
      if (c.kind === 'moderated') moderationMs += actual - (c.durationMs + (adjusts[id] || 0) * 1000);
      else if (c.kind === 'open') gameMs += actual - c.durationMs;
    }
    if (cur?.kind === 'moderated') moderationMs += Math.max(0, elapsed - cue.effectiveMs);
    if (cur?.kind === 'open') gameMs += Math.max(0, elapsed - cur.durationMs);
    // Back-Time: erwartetes Showende und Abweichung zum Plan
    const ends = [];
    if (rd.cues.length && !live.endedAt) {
      const planEnd = rd.cues[0].plannedStartAt + rd.cues.reduce((a, c) => a + c.durationMs, 0);
      let endAt;
      if (cur) {
        const remaining = cue.effectiveMs - elapsed;
        endAt = now + Math.max(0, remaining) + rd.cues.slice(idx + 1).reduce((a, c) => a + c.durationMs, 0);
      } else if (!live.running) {
        endAt = Math.max(now, rd.cues[0].plannedStartAt) + rd.cues.reduce((a, c) => a + c.durationMs, 0);
      }
      if (endAt != null) ends.push({ endAt, deltaMs: endAt - planEnd, label: '' });
    }
    const signals = { ...emptySignals(), ...(cur ? al.signals || {} : {}) };
    return {
      type: 'state',
      serverTime: now,
      timeZone: this.timeZone,
      mode: 'live',
      speed: 1,
      rundown: { id: rd.id, title: rd.title, eventDate: rd.eventDate, cueCount: rd.cues.length },
      source: { ok: true, stale: false, staleForMs: 0, latencyMs: this.rtt == null ? null : Math.round(this.rtt), error: null, startHow: cur ? 'ff' : null },
      show: { isRunning: !!live.running, isPaused: !!pausedAt, pausedAt, showStartedAt: live.startedAt ?? null },
      manual: { active: false },
      cue,
      next,
      prev,
      nextReason,
      signals,
      message: al.message || null,
      groups: [],
      jumpHints: [],
      balance: { moderationMs, gameMs },
      backtime: { ends, anchors: [] },
      // immer gesetzt, damit schon der erste Marker als neu erkannt und gemeldet wird
      lastEvent: { id: `m${al.markers || 0}`, type: al.markers ? 'marker' : 'none', at: al.lastMarkerAt ?? null },
    };
  }

  emitState() {
    const s = this.snapshot();
    if (s) this.dispatchEvent(new CustomEvent('state', { detail: s }));
  }

  /** Laufdaten für die Rundown-Zeitleiste (wie /api/runview des Relays) */
  runView() {
    const p = this.payload;
    const rd = this.rundown;
    if (!p || !rd) return { rundownId: null, cues: {}, eta: {}, currentId: null };
    const now = this.showNow();
    const live = p.live || {};
    const hist = live.history || {};
    const starts = live.starts || {};
    const adjusts = live.adjusts || {};
    const cues = {};
    for (const c of rd.cues) {
      if (live.running && c.id === live.currentId) {
        cues[c.id] = { startAt: live.itemStartedAt, endAt: null, actualMs: null, stretchMs: (live.adjust || 0) * 1000, deltaMs: null };
        continue;
      }
      if (hist[c.id] == null) continue;
      const actualMs = hist[c.id] * 1000;
      const stretchMs = (adjusts[c.id] || 0) * 1000;
      const startAt = starts[c.id] ?? null;
      cues[c.id] = { startAt, endAt: startAt != null ? startAt + actualMs : null, actualMs, stretchMs, deltaMs: actualMs - c.durationMs - stretchMs };
    }
    const eta = {};
    const idx = live.running ? rd.cues.findIndex((c) => c.id === live.currentId) : -1;
    let t;
    let i;
    if (idx >= 0) {
      const c = rd.cues[idx];
      const eff = c.durationMs + (live.adjust || 0) * 1000;
      const pausedFor = live.pausedAt ? now - live.pausedAt : 0;
      t = Math.max(now, live.itemStartedAt + eff + pausedFor);
      i = idx + 1;
    } else if (!live.endedAt) {
      t = Math.max(now, rd.cues[0]?.plannedStartAt ?? now);
      i = 0;
    } else i = rd.cues.length;
    for (; i < rd.cues.length; i++) {
      eta[rd.cues[i].id] = t;
      t += rd.cues[i].durationMs;
    }
    return { rundownId: rd.id, currentId: live.running ? live.currentId : null, now, cues, eta };
  }

  /* ---------------------------------------------------------------- Befehle */
  async post(action, body = {}) {
    if (!this.canOperate) return { ok: false, error: this.route.publicToken ? 'Öffentlicher Link: nur lesen' : 'Keine Berechtigung für die Live-Steuerung' };
    try {
      const r = await fetch(`/api/rundowns/${this.route.rundownId}/live/${action}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return { ok: false, error: j.error || `Fehler ${r.status}` };
      if (j.live && this.payload) {
        this.payload.live = j.live;
        if (j.serverNow) this.offset = j.serverNow - perfNow();
        this.emitState();
      }
      return { ok: true };
    } catch {
      return { ok: false, error: 'keine Verbindung zum Server' };
    }
  }

  /** Rundown steuern: start | next | toggle | prev | finish */
  control(action) {
    const map = { start: 'start', next: 'next', toggle: 'toggle', prev: 'prev', finish: 'stop' };
    if (!map[action]) return Promise.resolve({ ok: false, error: 'Unbekannte Aktion' });
    return this.post(map[action]);
  }

  /** Befehl der AL (wie conn.send beim Relay). Antwort kommt als Ereignis „result“. */
  send(msg) {
    if (!this.open && !this.payload) return false;
    let job = null;
    switch (msg.type) {
      case 'stretch':
        job = msg.mode === 'set'
          ? this.post('setRemaining', { seconds: Math.round((Number(msg.ms) || 0) / 1000) })
          : this.post('adjust', { seconds: Math.round((Number(msg.ms) || 30_000) / 1000) });
        break;
      case 'signal':
        job = this.post('alSignal', { kind: msg.kind, on: !!msg.on });
        break;
      case 'message':
        job = this.post('alMessage', msg.clear ? { clear: true } : { html: msg.html, text: msg.text, gif: msg.gif || null, upper: !!msg.upper, only: !!msg.only });
        break;
      case 'marker':
        job = this.post('alMarker', { label: msg.label || '' });
        break;
      default:
        return true; // Szenarien, Manuell-Modus, Replay: gibt es in FF-Broadcast nicht
    }
    job.then((r) => { if (!r.ok) this.dispatchEvent(new CustomEvent('failed', { detail: r.error })); });
    return true;
  }

  /* ---------------------------------------------------------------- Exporte */
  async exportSource() {
    const r = await fetch(`${this.base}/al-log`, { credentials: 'same-origin', cache: 'no-store' });
    if (!r.ok) throw new Error('Protokoll nicht verfügbar');
    const { log } = await r.json();
    const rd = this.rundown;
    const byId = new Map(rd.cues.map((c) => [c.id, c]));
    let run = log;
    for (let i = log.length - 1; i >= 0; i--) if (log[i].type === 'reset') { run = log.slice(i + 1); break; }
    const events = run.map((e) => {
      const c = byId.get(e.id);
      return { ...e, cueNumber: c?.number ?? null, cueTitle: c?.title ?? '' };
    });
    const live = this.payload.live || {};
    const hist = live.history || {};
    const adjusts = live.adjusts || {};
    const starts = live.starts || {};
    const seen = new Set();
    const rows = [];
    for (const e of events) {
      if (e.type !== 'cue' || seen.has(e.id)) continue;
      seen.add(e.id);
      const c = byId.get(e.id);
      if (!c) continue;
      const isCur = live.running && live.currentId === c.id;
      const actualMs = hist[c.id] != null ? hist[c.id] * 1000 : isCur ? Math.max(0, (live.pausedAt || this.showNow()) - live.itemStartedAt) : null;
      const stretchMs = ((isCur ? live.adjust : adjusts[c.id]) || 0) * 1000;
      rows.push({
        number: c.number,
        title: c.title,
        kind: c.kind,
        block: c.block || '',
        plannedStartAt: c.plannedStartAt,
        actualStartAt: starts[c.id] ?? e.at,
        plannedMs: c.durationMs,
        stretchMs,
        actualMs,
        deltaMs: actualMs == null || isCur ? null : actualMs - c.durationMs - stretchMs,
        startHow: 'FF-Broadcast',
      });
    }
    return {
      cfg: { timeZone: this.timeZone },
      rundown: { title: rd.title, eventDate: rd.eventDate },
      now: () => this.showNow(),
      report: () => rows,
      runLog: () => events,
    };
  }
}
