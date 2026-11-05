// Rückfall ohne Relay: Ist das iPad länger als 10 s ohne Verbindung,
// kann die AL die Cues lokal weiterschalten. Das Schild auf demselben iPad läuft weiter.
// Marker werden gesammelt und nach dem Wiederverbinden mit ihrer Zeit nachgereicht.

import { STRETCH_STEP_MS } from './shared/timing.js';

const emptySignals = () => ({ wrap: false, cut: false, standby: false, stretchAt: null });

export class LocalFallback {
  constructor() {
    this.active = false;
    this.queue = [];
  }

  enter(state, rundown, now) {
    this.active = true;
    this.base = state || {};
    this.cues = rundown?.cues || [];
    this.groups = rundown?.groups || [];
    this.selections = Object.fromEntries((state?.groups || []).map((g) => [g.id, g.selected]));
    const cur = state?.cue;
    this.idx = cur ? this.cues.findIndex((c) => c.id === cur.id) : -1;
    this.startedAt = cur?.startedAt ?? now;
    this.stretch = cur?.stretchMs || 0;
    this.signals = { ...emptySignals(), ...(state?.signals || {}) };
    this.message = state?.message || null;
  }

  exit() {
    this.active = false;
  }

  jumps() {
    const m = new Map();
    for (const g of this.groups) {
      const o = g.options.find((x) => x.id === this.selections[g.id]);
      for (const j of o?.jumps || []) m.set(j.after, j.to);
    }
    return m;
  }

  nextIdx(i) {
    if (i < 0) return this.cues.length ? 0 : -1;
    const c = this.cues[i];
    const to = this.jumps().get(c.number);
    if (to != null) {
      const t = this.cues.findIndex((x) => x.number === to);
      if (t >= 0) return t;
    }
    return i + 1 < this.cues.length ? i + 1 : -1;
  }

  step(dir, now) {
    const i = dir > 0 ? this.nextIdx(this.idx) : Math.max(0, this.idx - 1);
    if (i < 0) return;
    this.idx = i;
    this.startedAt = now;
    this.stretch = 0;
    this.signals = emptySignals();
  }

  handle(msg, now) {
    switch (msg.type) {
      case 'signal':
        this.signals[msg.kind] = !!msg.on;
        break;
      case 'stretch':
        if (msg.mode === 'set') {
          const dur = this.cues[this.idx]?.durationMs || 0;
          this.stretch = Math.max(-dur, now - this.startedAt + (Number(msg.ms) || 0) - dur);
        } else this.stretch = Math.max(0, this.stretch + (Number.isFinite(msg.ms) ? msg.ms : STRETCH_STEP_MS));
        this.signals.stretchAt = now;
        break;
      case 'marker':
        this.queue.push({ type: 'marker', label: msg.label || '', at: now });
        break;
      case 'scenario':
        this.selections[msg.group] = msg.option;
        break;
      case 'message':
        this.message = msg.clear ? null : { html: msg.html, text: msg.text, gif: msg.gif || null, upper: !!msg.upper, only: !!msg.only, at: now };
        break;
      default:
        break;
    }
  }

  drain() {
    const q = this.queue;
    this.queue = [];
    return q;
  }

  state() {
    const cue = this.cues[this.idx] || null;
    const ni = this.nextIdx(this.idx);
    const next = ni >= 0 ? this.cues[ni] : null;
    return {
      ...this.base,
      local: true,
      cue: cue ? { ...cue, startedAt: this.startedAt, stretchMs: this.stretch, effectiveMs: cue.durationMs + this.stretch } : null,
      next,
      nextReason: ni >= 0 && ni !== this.idx + 1 ? 'jump' : 'sequence',
      signals: this.signals,
      message: this.message,
      show: { ...(this.base.show || {}), pausedAt: null, isPaused: false },
      backtime: { ends: [], anchors: [] },
      jumpHints: [],
      groups: (this.base.groups || []).map((g) => ({ ...g, selected: this.selections[g.id] ?? null })),
      manual: { active: true, local: true },
    };
  }
}
