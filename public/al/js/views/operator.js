// Bedienansicht der AL: oben lesen, unten drücken.

import { formatClock, formatSigned, formatTimeOfDay, formatDuration, KINDS } from '../shared/timing.js';
import { bindHold, bindTap } from '../ui/hold.js';
import { safeGifUrl } from '../ui/richtext.js';
import { headsHtml } from '../ui/people.js';

const $ = (root, sel) => root.querySelector(sel);

function setText(el, v) {
  const s = v == null ? '' : String(v);
  if (el.textContent !== s) el.textContent = s;
}
function setHtml(el, html) {
  if (el.dataset.html !== html) {
    el.innerHTML = html;
    el.dataset.html = html;
  }
}
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export class OperatorView {
  /**
   * @param {object} o
   * @param {HTMLElement} o.root
   * @param {(msg:object)=>void} o.act        Befehl an Relay bzw. lokalen Rückfall
   * @param {()=>void} o.onSign               Schild zeigen
   * @param {()=>void} o.onSettings
   * @param {()=>void} o.onStretch            Auswahl der Streckzeit öffnen
   * @param {()=>void} o.onText               Custom-Text-Editor öffnen
   * @param {(cmd:string)=>void} o.onManual   enter | exit | prev | next
   * @param {(text:string, undo?:()=>void)=>void} o.undo
   * @param {boolean} o.readonly
   */
  constructor(o) {
    Object.assign(this, o);
    const r = o.root;
    this.el = {
      modePill: $(r, '#op-mode'),
      modeText: $(r, '#op-mode-text'),
      alert: $(r, '#op-alert'),
      title: $(r, '#op-title'),
      now: $(r, '#now'),
      cat: $(r, '#now-cat'),
      num: $(r, '#now-num'),
      cueTitle: $(r, '#now-title'),
      kind: $(r, '#now-kind'),
      sub: $(r, '#now-sub'),
      word: $(r, '#now-word'),
      digits: $(r, '#now-digits'),
      aside: $(r, '#now-aside'),
      bar: $(r, '#now-bar'),
      nextNum: $(r, '#next-num'),
      nextTitle: $(r, '#next-title'),
      people: $(r, '#now-people'),
      nextPeople: $(r, '#next-people'),
      nextJump: $(r, '#next-jump'),
      nextDur: $(r, '#next-dur'),
      stMod: $(r, '#st-mod'),
      stGame: $(r, '#st-game'),
      stClock: $(r, '#st-clock'),
      stConn: $(r, '#st-conn'),
      ends: $(r, '#st-ends'),
      context: $(r, '#context'),
      controls: $(r, '#controls'),
      bSign: $(r, '#b-sign'),
      bText: $(r, '#b-text'),
      bStretch: $(r, '#b-stretch'),
      bStandby: $(r, '#b-standby'),
      bCut: $(r, '#b-cut'),
      bCutText: $(r, '#b-cut-text'),
      bMarker: $(r, '#b-marker'),
      peekPrev: $(r, '#peek-prev'),
      peekNext: $(r, '#peek-next'),
      tStart: $(r, '#t-start'),
      tNext: $(r, '#t-next'),
      tPause: $(r, '#t-pause'),
      tPauseText: $(r, '#t-pause-text'),
      tPauseUse: $(r, '#t-pause use'),
      tPrev: $(r, '#t-prev'),
      tStartText: $(r, '#t-start-text'),
      tStartUse: $(r, '#t-start use'),
      bManual: $(r, '#b-manual'),
      bPrev: $(r, '#b-prev'),
      bNext: $(r, '#b-next'),
    };
    // Kontext in festen Teilbereichen, damit Antippen nie durch ein Neuzeichnen unterbrochen wird.
    this.ctx = {};
    for (const k of ['banner', 'message', 'scenarios', 'info', 'notes']) {
      const d = document.createElement('div');
      d.className = `ctx-${k}`;
      d.style.display = 'contents';
      this.el.context.appendChild(d);
      this.ctx[k] = d;
    }
    // Vorheriger und nächster Cue als Karten hinter dem aktuellen (AL und Regie)
    this.el.peekPrev.hidden = false;
    this.el.peekNext.hidden = false;
    if (o.readonly) {
      // Regieansicht: nur Rundown-Steuerung, Zeit + und Marker.
      // Zwei Spalten-Container, damit im Querformat alles lückenlos untereinander steht
      // (im Hochformat sind sie per display:contents unsichtbar).
      r.dataset.readonly = '';
      const left = document.createElement('div');
      left.className = 'regie-col regie-left';
      const right = document.createElement('div');
      right.className = 'regie-col regie-right';
      this.el.now.before(left);
      left.append(this.el.peekPrev, this.el.now, this.el.peekNext);
      const status = r.querySelector('.status');
      status.before(right);
      right.append(status, this.el.controls, this.el.context);
    }
    this.signals = {};
    this.bind();
  }

  bind() {
    const e = this.el;
    bindTap(e.bSign, () => this.onSign());
    bindTap(e.now, () => this.onRundown?.());
    e.now.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      ev.preventDefault();
      this.onRundown?.();
    });
    bindTap($(this.root, '#op-settings'), () => this.onSettings());
    bindTap(e.bText, () => this.onText());
    bindTap(e.bStandby, () => this.act({ type: 'signal', kind: 'standby', on: !this.signals.standby }));
    bindTap(e.bStretch, () => this.onStretch());
    bindTap(e.bMarker, () => this.act({ type: 'marker' }));
    // Rundown im Backend steuern – alle Aktionen 0,6 s halten, damit nichts aus Versehen passiert
    // START wird zu BEENDEN, sobald die Show läuft (und danach wieder zu START)
    bindHold(e.tStart, () => this.onControl?.(this.running ? 'finish' : 'start'));
    bindHold(e.tNext, () => this.onControl?.('next'));
    bindHold(e.tPause, () => this.onControl?.('toggle'));
    bindHold(e.tPrev, () => this.onControl?.('prev'));
    bindHold(e.bCut, () => this.act({ type: 'signal', kind: 'cut', on: !this.signals.cut }));
    bindHold(e.bManual, () => this.onManual('enter'));
    bindHold(e.bPrev, () => this.onManual('prev'));
    bindHold(e.bNext, () => this.onManual('next'));

    // Szenario-Auswahl (Picker .segmented) – Ereignisdelegation
    this.ctx.scenarios.addEventListener('click', (ev) => {
      const b = ev.target.closest('button[data-option]');
      if (!b || b.disabled || this.readonly) return;
      const group = b.closest('[data-group]').dataset.group;
      const option = b.dataset.option || null;
      const g = this.groups?.find((x) => x.id === group);
      const before = g?.selected ?? null;
      if (before === option) return;
      this.act({ type: 'scenario', group, option });
      const label = option ? g.options.find((o) => o.id === option)?.label : 'offen';
      this.undo(`${g.short} ${label}`, () => this.act({ type: 'scenario', group, option: before }));
    });
    this.ctx.banner.addEventListener('pointerdown', () => {}, { passive: true });
  }

  setGrip(grip) {
    this.el.controls.dataset.grip = grip;
    this.root.dataset.grip = grip;
  }

  render(vm, meta) {
    const e = this.el;
    const st = vm.state;
    const cue = vm.cue;
    const ev = vm.ev;
    this.groups = st?.groups || [];
    this.signals = st?.signals || {};

    // ---- Navigationsleiste
    let mode = { cls: 'pill', text: 'VERBINDE …' };
    if (meta.local) mode = { cls: 'pill bad', text: 'LOKAL · OHNE RELAY' };
    else if (meta.offlineMs > 1500) mode = { cls: 'pill bad', text: `OFFLINE ${formatClock(meta.offlineMs, true)}` };
    else if (st?.manual?.active) mode = { cls: 'pill warn', text: 'MANUELL' };
    else if (st?.mode === 'live' && st.source?.stale) mode = { cls: 'pill warn', text: `QUELLE ${formatClock(st.source.staleForMs ?? 0, true)}` };
    else if (st?.mode === 'live') mode = { cls: 'pill ok', text: 'LIVE' };
    else if (st?.mode === 'replay') mode = { cls: 'pill info', text: `REPLAY ×${st.speed}` };
    if (e.modePill.className !== mode.cls) e.modePill.className = mode.cls;
    setText(e.modeText, mode.text);
    const alert = st?.show?.isPaused ? 'PAUSIERT' : '';
    e.alert.hidden = !alert;
    setText(e.alert, alert);
    setText(e.title, st?.rundown?.title || 'Aufnahmeleitung');

    // ---- Aktueller Cue
    if (e.now.dataset.state !== ev.state) e.now.dataset.state = ev.state;
    e.cat.style.background = cue?.color || '';
    setText(e.num, cue ? cue.number : '');
    setText(e.cueTitle, cue ? [cue.emoji, cue.title].filter(Boolean).join(' ') : st?.next ? 'Show noch nicht gestartet' : 'Kein Cue aktiv');
    e.kind.hidden = !cue;
    setText(e.kind, cue ? KINDS[cue.kind] || cue.kind : '');
    setText(e.sub, cue ? [cue.subtitle, cue.block].filter(Boolean).join(' · ') : '');
    setHtml(e.people, cue ? headsHtml(cue.people, { max: 8 }) : '');
    const badge = ev.state === 'dark' ? 'LÄUFT SEIT' : ev.state === 'neutral' ? ev.word : ev.word;
    setText(e.word, ev.state === 'run' ? '' : badge);

    let digits = '–:––';
    if (ev.state === 'idle' && st?.next?.plannedStartAt) digits = formatTimeOfDay(st.next.plannedStartAt, meta.timeZone);
    else if (cue && ev.state === 'cut') digits = formatClock(Math.abs(ev.remainingMs), ev.remainingMs < 0);
    else if (cue && ev.digitsMs != null) digits = formatClock(ev.digitsMs, ev.countUp);
    else if (cue) digits = formatClock(Math.max(0, ev.remainingMs), false);
    setText(e.digits, digits);

    let aside = '';
    if (cue) {
      const parts = [];
      if (cue.kind === 'anchor' && cue.anchorAt) parts.push(`bis ${formatTimeOfDay(cue.anchorAt, meta.timeZone, true)}`);
      else parts.push(`Plan ${formatDuration(cue.durationMs)}`);
      if (cue.stretchMs) parts.push(`gestreckt ${formatSigned(cue.stretchMs)}`);
      if (cue.kind === 'open') parts.push(ev.remainingMs >= 0 ? `Rest ~${formatClock(ev.remainingMs)}` : `über Plan ${formatClock(-ev.remainingMs, true)}`);
      parts.push(`seit ${formatTimeOfDay(cue.startedAt, meta.timeZone, true)}`);
      aside = parts.map((p) => `<span>${esc(p)}</span>`).join('');
    } else if (st?.next) {
      aside = '<span>geplanter Start</span>';
    }
    setHtml(e.aside, aside);

    const p = ev.state === 'over' ? 1 : ev.progress ?? 0;
    const w = `${(Math.max(0, Math.min(1, p)) * 100).toFixed(2)}%`;
    if (e.bar.style.width !== w) e.bar.style.width = w;

    const nx = vm.next;
    setText(e.nextNum, nx ? nx.number : '');
    setText(e.nextTitle, nx ? [nx.emoji, nx.title].filter(Boolean).join(' ') : '–');
    setHtml(e.nextPeople, nx ? headsHtml(nx.people, { max: 5, cls: 'sm' }) : '');
    e.nextJump.hidden = st?.nextReason !== 'jump';
    setText(e.nextDur, nx ? (nx.kind === 'anchor' && nx.anchorAt ? `bis ${formatTimeOfDay(nx.anchorAt, meta.timeZone)}` : formatDuration(nx.durationMs)) : '');

    // ---- Status
    const bal = st?.balance || {};
    this.renderBalance(e.stMod, bal.moderationMs);
    this.renderBalance(e.stGame, bal.gameMs);
    setText(e.stClock, formatTimeOfDay(vm.now, meta.timeZone, true));
    setText(e.stConn, meta.local ? 'lokal' : meta.offlineMs > 1500 ? 'getrennt' : meta.sync ? `${meta.sync.rttMs} ms` : '…');
    setHtml(e.ends, this.endsHtml(st, meta));

    // ---- Kontext
    this.renderContext(vm, meta);

    // ---- Steuerung
    this.renderControls(vm, meta);
    this.renderPeeks(vm, meta);
  }

  renderBalance(el, ms) {
    setText(el, formatSigned(ms ?? 0));
    const s = Math.round((ms ?? 0) / 1000);
    el.classList.toggle('pos', s > 0);
    el.classList.toggle('neg', s < 0);
  }

  endsHtml(st, meta) {
    const ends = st?.backtime?.ends || [];
    if (!ends.length) return st?.local ? '<span class="tertiary">ohne Relay nicht berechnet</span>' : '–';
    return ends
      .map((x) => {
        const lbl = x.label ? `<span class="lbl">${esc(x.label)}</span>` : '';
        const delta = ends.length === 1 ? `<span class="delta">${esc(formatSigned(x.deltaMs))}</span>` : '';
        return `<span class="end-chip">${lbl}${esc(formatTimeOfDay(x.endAt, meta.timeZone, ends.length === 1))}${delta}</span>`;
      })
      .join('');
  }

  renderContext(vm, meta) {
    const st = vm.state;
    const cue = vm.cue;

    // Banner: Manuell / lokal
    let banner = '';
    if (meta.local) {
      banner = `<div class="banner"><span><b>Ohne Relay.</b> Cues lokal mit ◀ ▶ schalten. Marker werden nachgereicht.</span></div>`;
    } else if (st?.manual?.active) {
      const ok = st.source && !st.source.stale;
      banner = `<div class="banner"><span><b>Manuell-Modus.</b> ${ok ? 'Quelle ist wieder da.' : 'Quelle antwortet nicht.'}</span><button class="btn tint-green" type="button" data-hold="exit-manual" ${ok ? '' : 'disabled'}><span class="btn-label"><span>QUELLE ÜBERNEHMEN</span><small>halten</small></span></button></div>`;
    }
    if (this.ctx.banner.dataset.html !== banner) {
      setHtml(this.ctx.banner, banner);
      const b = this.ctx.banner.querySelector('[data-hold="exit-manual"]');
      if (b) bindHold(b, () => this.onManual('exit'));
    }

    // Custom Text, der gerade auf dem Schild steht (ohne innerHTML: Inhalt kommt vom Gerät der AL)
    const m = st?.message;
    const msgKey = m ? `${m.at}|${this.readonly}` : '';
    if (this.ctx.message.dataset.key !== msgKey) {
      this.ctx.message.dataset.key = msgKey;
      this.ctx.message.replaceChildren();
      if (m) {
        const card = document.createElement('div');
        card.className = 'card ctx-card';
        const head = document.createElement('div');
        head.className = 'ctx-title';
        head.textContent = m.only ? 'Auf dem Schild · nur Text' : 'Auf dem Schild';
        const row = document.createElement('div');
        row.className = 'msg-preview';
        const gif = safeGifUrl(m.gif?.url);
        if (gif) {
          const img = document.createElement('img');
          img.src = gif;
          img.alt = 'GIF';
          row.append(img);
        }
        const txt = document.createElement('div');
        txt.className = `msg-text${m.upper ? ' upper' : ''}`;
        txt.textContent = m.text || (gif ? 'GIF' : '');
        row.append(txt);
        if (!this.readonly) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'btn tint-red';
          b.textContent = 'AUSBLENDEN';
          bindTap(b, () => this.act({ type: 'message', clear: true }));
          row.append(b);
        }
        card.append(head, row);
        this.ctx.message.append(card);
      }
    }

    // Szenarien
    const groups = (st?.groups || []).filter((g) => g.visible);
    const scen = groups
      .map(
        (g) => `<div class="card ctx-card" data-group="${esc(g.id)}">
          <div class="ctx-title"><span>${esc(g.label)} · Ausgang</span><span>${g.selected ? 'gewählt' : 'offen'}</span></div>
          <div class="segmented" role="radiogroup" aria-label="${esc(g.label)}">
            <button type="button" role="radio" data-option="" aria-checked="${!g.selected}" ${this.readonly ? 'disabled' : ''}>Offen</button>
            ${g.options
              .map(
                (o) =>
                  `<button type="button" role="radio" data-option="${esc(o.id)}" aria-checked="${g.selected === o.id}" ${!o.possible || this.readonly ? 'disabled' : ''}>${esc(o.label)}</button>`,
              )
              .join('')}
          </div></div>`,
      )
      .join('');
    setHtml(this.ctx.scenarios, scen);

    // Hinweise: Sprünge, Anker, Pause
    const lines = [];
    for (const h of st?.jumpHints || []) {
      if (h.selected) lines.push({ warn: true, icon: 'i-jump', text: `${h.group} ${h.option}: nach diesem Cue weiter mit ${h.to} · ${h.toTitle}` });
      else if (!h.decided) lines.push({ icon: 'i-jump', text: `Bei ${h.group} ${h.option}: nach diesem Cue weiter mit ${h.to} · ${h.toTitle}` });
    }
    for (const a of st?.backtime?.anchors || []) {
      const v = a.variants
        .map((x) => `${x.bufferMs >= 0 ? 'Puffer' : 'Verzug'} ${formatClock(Math.abs(x.bufferMs), true)}${x.label ? ` (${x.label})` : ''}`)
        .join(' · ');
      const warn = a.variants.some((x) => x.bufferMs < 0);
      lines.push({ warn, icon: 'i-anchor', text: `Anker ${formatTimeOfDay(a.anchorAt, meta.timeZone, true)} (Cue ${a.number}): ${v}` });
    }
    if (cue?.kind === 'anchor' && cue.anchorAt) lines.push({ icon: 'i-anchor', text: `Pause bis ${formatTimeOfDay(cue.anchorAt, meta.timeZone, true)} – danach fester Start` });
    if (st?.show?.isPaused) lines.push({ warn: true, icon: 'i-warn', text: 'Rundown ist pausiert – Zeit steht.' });
    if (st?.mode === 'live' && st?.source?.stale && !meta.local) lines.push({ warn: true, icon: 'i-warn', text: `Rundown-Quelle antwortet nicht${st.source.error ? ` (${st.source.error})` : ''}.` });
    const info = lines.length
      ? `<div class="card ctx-card">${lines
          .map((l) => `<div class="ctx-line t-body${l.warn ? ' warn' : ''}"><svg class="i"><use href="#${l.icon}"/></svg><span>${esc(l.text)}</span></div>`)
          .join('')}</div>`
      : '';
    setHtml(this.ctx.info, info);

    // Notizen
    const notes = [];
    if (cue?.notes) notes.push(`<p class="notes t-body">${esc(cue.notes)}</p>`);
    if (vm.next?.notes) notes.push(`<p class="notes t-subheadline secondary">Danach (${esc(vm.next.number)}): ${esc(vm.next.notes)}</p>`);
    setHtml(this.ctx.notes, notes.length ? `<div class="card ctx-card"><div class="ctx-title"><span>Notizen</span></div>${notes.join('')}</div>` : '');
  }

  /** Vorheriger und nächster Cue halbtransparent hinter dem aktuellen. */
  renderPeeks(vm, meta) {
    const st = vm.state;
    const tz = meta.timeZone;
    const card = (label, c, aside) => {
      if (!c) return `<div class="peek-label">${label}</div><div class="peek-title peek-empty">–</div>`;
      const kind = c.kind && KINDS[c.kind] ? `<span class="kind-badge">${KINDS[c.kind]}</span>` : '';
      return `<div class="peek-label">${label}</div>
<div class="peek-main"><span class="cat-stripe" style="${c.color ? `background:${esc(c.color)}` : ''}"></span><span class="cue-num">${esc(c.number ?? '')}</span><span class="peek-title">${c.emoji ? esc(c.emoji) + ' ' : ''}${esc(c.title)}</span>${kind}${headsHtml(c.people, { max: 5, cls: 'sm' })}</div>
<div class="peek-aside">${aside}</div>`;
    };
    const p = st?.prev;
    let pAside = '';
    if (p) {
      const d = p.deltaMs;
      const cls = d == null ? '' : d > 999 ? 'over' : d < -999 ? 'under' : '';
      pAside = `${p.startedAt != null ? formatTimeOfDay(p.startedAt, tz) + ' · ' : ''}${p.actualMs != null ? formatDuration(p.actualMs) : formatDuration(p.durationMs)}${d != null ? ` <span class="peek-delta ${cls}">${formatSigned(d)}</span>` : ''}`;
    }
    const n = vm.next;
    const nAside = n ? `${st?.nextReason === 'jump' ? '<span class="jump-tag">SPRUNG</span> ' : ''}${formatDuration(n.durationMs)}` : '';
    const ph = card('VORHER', p, pAside);
    const nh = card(st?.nextReason === 'start' ? 'ERSTER CUE' : 'DANACH', n, nAside);
    if (this.el.peekPrev.dataset.html !== ph) {
      this.el.peekPrev.innerHTML = ph;
      this.el.peekPrev.dataset.html = ph;
    }
    if (this.el.peekNext.dataset.html !== nh) {
      this.el.peekNext.innerHTML = nh;
      this.el.peekNext.dataset.html = nh;
    }
  }

  renderControls(vm, meta) {
    const e = this.el;
    const st = vm.state;
    const has = !!vm.cue;
    const sig = st?.signals || {};
    e.bStretch.disabled = !has || vm.cue?.kind === 'anchor';
    e.bStandby.disabled = !has;
    e.bCut.disabled = !has;
    e.bText.setAttribute('aria-pressed', String(!!st?.message));
    e.bStandby.setAttribute('aria-pressed', String(!!sig.standby));
    e.bCut.setAttribute('aria-pressed', String(!!sig.cut));
    setText(e.bCutText, sig.cut ? 'AUFHEBEN' : 'SCHLUSS');

    // Rundown-Steuerung: Start nur, wenn die Show nicht läuft; der Rest nur, wenn sie läuft.
    const paused = !!st?.show?.isPaused;
    // Pausiert zählt als laufend: der linke Button bleibt BEENDEN, fortgesetzt wird nur über PAUSE
    const running = !!st?.show?.isRunning || paused;
    const ctlOff = meta.local || !st;
    this.running = running;
    e.tStart.disabled = ctlOff;
    setText(e.tStartText, running ? 'BEENDEN' : 'START');
    const startIcon = running ? '#i-stop' : '#i-play';
    if (e.tStartUse.getAttribute('href') !== startIcon) {
      e.tStartUse.setAttribute('href', startIcon);
      e.tStart.setAttribute('aria-label', running ? 'Show beenden (halten)' : 'Start: Show starten (halten)');
    }
    e.tStart.classList.toggle('tint-green', !running);
    e.tStart.classList.toggle('tint-red', running);
    e.tNext.disabled = ctlOff || !running || paused;
    e.tPause.disabled = ctlOff || !running;
    e.tPrev.disabled = ctlOff || !running || paused;
    // Toggle: läuft → PAUSE (Pause-Symbol); pausiert → PAUSIERT (Stop-Symbol), erneut halten setzt fort
    setText(e.tPauseText, paused ? 'PAUSIERT' : 'PAUSE');
    const pauseIcon = paused ? '#i-stop' : '#i-pause';
    if (e.tPauseUse.getAttribute('href') !== pauseIcon) {
      e.tPauseUse.setAttribute('href', pauseIcon);
      e.tPauseUse.parentElement.classList.toggle('solid', paused);
      e.tPause.setAttribute('aria-label', paused ? 'Pausiert – halten zum Fortsetzen' : 'Pause (halten)');
      e.tPause.setAttribute('aria-pressed', String(paused));
    }
    e.tPause.classList.toggle('tint-orange', paused);
    e.tPause.classList.toggle('btn-gray', !paused);

    // Manuell-Bereich: nur bei Ausfall der Quelle bzw. des Relays
    const manualActive = !this.readonly && (meta.local || !!st?.manual?.active);
    const sourceDown = !this.readonly && ((st?.mode === 'live' && (st?.source?.staleForMs ?? 0) >= 10_000) || meta.offlineMs >= 10_000);
    e.bPrev.hidden = !manualActive;
    e.bNext.hidden = !manualActive;
    e.bManual.hidden = manualActive || !sourceDown;
    e.controls.classList.toggle('no-manual', !manualActive && !sourceDown);
  }
}
