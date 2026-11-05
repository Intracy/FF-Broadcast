// Vollbild-Stapel: vorheriger, aktueller und nächster Cue – ohne Bedienelemente, lesbar aus
// mehreren Metern. Für ein zweites Gerät (/stapel), die Regie oder die AL zwischendurch.
// Farben und Zustände wie auf dem Schild; bei einem Cue-Wechsel rutschen die Bänder nach oben.

import { formatClock, formatDuration, formatSigned, formatTimeOfDay } from '../shared/timing.js';
import { fitText, fitBlock } from '../ui/fit.js';
import { sanitize, safeGifUrl } from '../ui/richtext.js';
import { headsHtml } from '../ui/people.js';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export class StackView {
  constructor(root) {
    this.root = root;
    this.prev = root.querySelector('#stk-prev');
    this.next = root.querySelector('#stk-next');
    this.nowEl = root.querySelector('#stk-now');
    this.head = root.querySelector('#stk-head');
    this.word = root.querySelector('#stk-word');
    this.box = root.querySelector('#stk-box');
    this.digits = root.querySelector('#stk-digits');
    this.side = root.querySelector('#stk-side');
    this.bar = root.querySelector('#stk-bar');
    this.msg = root.querySelector('#stk-msg');
    this.msgText = root.querySelector('#stk-msg-text');
    this.msgGif = root.querySelector('#stk-msg-gif');
    this.lastCue = undefined;
    this.keys = {};
    new ResizeObserver(() => {
      delete this.digits.dataset.fitKey;
      delete this.msgText.dataset.fitKey;
    }).observe(this.box);
  }

  set(el, key, html) {
    if (this.keys[key] === html) return;
    this.keys[key] = html;
    el.innerHTML = html;
  }

  band(label, c, right) {
    if (!c) return `<span class="stk-lbl">${label}</span><span class="stk-ttl stk-none">–</span>`;
    return `<span class="stk-lbl">${label}</span><span class="stk-num">${esc(c.number ?? '')}</span><span class="stk-ttl">${c.emoji ? esc(c.emoji) + ' ' : ''}${esc(c.title)}</span>${headsHtml(c.people, { max: 6, cls: 'stk-heads' })}<span class="stk-r">${right}</span>`;
  }

  render(vm, meta) {
    const st = vm.state;
    const ev = vm.ev;
    const cue = vm.cue;
    const tz = meta.timeZone;
    const state = ev.state;
    if (this.root.dataset.state !== state) this.root.dataset.state = state;

    // Cue-Wechsel: Bänder rutschen nach oben (ohne Animation bei „Bewegung reduzieren“)
    const cueId = cue?.id ?? null;
    if (this.lastCue !== undefined && cueId !== this.lastCue) {
      this.root.classList.remove('shift');
      void this.root.offsetWidth;
      this.root.classList.add('shift');
      clearTimeout(this.shiftTimer);
      this.shiftTimer = setTimeout(() => this.root.classList.remove('shift'), 600);
    }
    this.lastCue = cueId;

    // Vorher-Band: Ist-Dauer und Abweichung; rechts die Uhrzeit
    const p = st?.prev;
    let pr = '';
    if (p) {
      const d = p.deltaMs;
      const cls = d == null ? '' : d > 999 ? 'over' : d < -999 ? 'under' : 'even';
      pr = `${p.actualMs != null ? formatDuration(p.actualMs) : formatDuration(p.durationMs)}${d != null ? ` <span class="stk-d ${cls}">${Math.abs(d) < 1000 ? '±0:00' : formatSigned(d)}</span>` : ''}`;
    }
    const conn = meta.local || meta.offlineMs > 3000 ? '<span class="stk-dot" title="Verbindung gestört"></span>' : '';
    this.set(this.prev, 'prev', `${this.band('VORHER', p, pr)}<span class="stk-clock">${conn}${formatTimeOfDay(vm.now, tz, true)}</span>`);

    // Danach-Band: Dauer und erwartete Startzeit
    const n = vm.next;
    let nr = '';
    if (n) {
      let eta = null;
      if (cue?.startedAt != null && cue.kind !== 'open') {
        eta = cue.kind === 'anchor' && cue.anchorAt != null ? cue.anchorAt : cue.startedAt + (cue.effectiveMs ?? cue.durationMs);
        eta = Math.max(eta, vm.now);
      }
      nr = `${st?.nextReason === 'jump' ? '<span class="stk-jump">SPRUNG</span> ' : ''}${formatDuration(n.durationMs)}${eta != null ? ` · ~${formatTimeOfDay(eta, tz)}` : ''}`;
    }
    this.set(this.next, 'next', this.band(st?.nextReason === 'start' ? 'ERSTER CUE' : 'DANACH', n, nr));

    // Jetzt: Kopf mit Nummer, Titel, Zustandswort
    const head = cue
      ? `<span class="stk-stripe" style="${cue.color ? `background:${esc(cue.color)}` : ''}"></span><span class="stk-num">${esc(cue.number ?? '')}</span><span class="stk-ttl">${cue.emoji ? esc(cue.emoji) + ' ' : ''}${esc(cue.title)}</span>${headsHtml(cue.people, { max: 8, cls: 'stk-heads' })}`
      : `<span class="stk-ttl stk-none">${st?.show?.isRunning === false ? 'Show läuft nicht' : 'Kein Cue aktiv'}</span>`;
    this.set(this.head, 'head', head);
    const word = state === 'idle' ? '' : state === 'dark' ? 'LÄUFT' : ev.word || '';
    if (this.word.textContent !== word) this.word.textContent = word;
    this.word.hidden = !word;

    // Custom Text als Banner (bzw. statt der Zeit bei „Nur Text“)
    const m = st?.message || null;
    const mkey = m ? `${m.at}|${m.only ? 1 : 0}` : '';
    if (this.keys.msg !== mkey) {
      this.keys.msg = mkey;
      this.root.classList.toggle('has-msg', !!m);
      this.root.classList.toggle('msg-only', !!m?.only);
      this.msg.hidden = !m;
      const gif = m ? safeGifUrl(m.gif?.url) : null;
      this.msgGif.hidden = !gif;
      if (gif) this.msgGif.src = gif;
      else this.msgGif.removeAttribute('src');
      this.msgText.innerHTML = m ? sanitize(m.html) : '';
      this.msgText.classList.toggle('upper', !!m?.upper);
      delete this.msgText.dataset.fitKey;
      delete this.digits.dataset.fitKey;
    }
    if (m && m.only) fitBlock(this.msgText, this.box);

    // Restzeit so groß wie möglich
    let text = '';
    if (state === 'idle') text = formatTimeOfDay(vm.now, tz);
    else if (ev.digitsMs != null) {
      const ms = ev.digitsMs;
      text = ev.countUp ? formatClock(ms, true) : formatClock(ms);
      if (ev.over) text = `+${formatClock(ms, true)}`;
    }
    if (this.digits.textContent !== text) this.digits.textContent = text;
    if (text && !(m && m.only)) fitText(this.digits, this.box, text.replace(/\d/g, '0'), { heightFactor: 1.25, widthFactor: 0.98 });

    // Seitenangaben: Plan, Start, erwartetes Ende
    let side = '';
    if (cue) {
      const parts = [`Plan <b>${formatDuration(cue.durationMs)}</b>`];
      if (cue.stretchMs) parts.push(`gestreckt <b>${formatSigned(cue.stretchMs)}</b>`);
      if (cue.startedAt != null) parts.push(`seit <b>${formatTimeOfDay(cue.startedAt, tz, true)}</b>`);
      if (cue.startedAt != null && cue.kind !== 'open') parts.push(`Ende ~<b>${formatTimeOfDay(cue.startedAt + (cue.effectiveMs ?? cue.durationMs), tz, true)}</b>`);
      side = parts.map((x) => `<span>${x}</span>`).join('');
    }
    this.set(this.side, 'side', side);

    let pr2 = 0;
    if (state === 'over') pr2 = 1;
    else if (ev.progress != null && state !== 'dark' && state !== 'idle') pr2 = ev.progress;
    const w = `${(pr2 * 100).toFixed(2)}%`;
    if (this.bar.style.width !== w) this.bar.style.width = w;
  }
}
