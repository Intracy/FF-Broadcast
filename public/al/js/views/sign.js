// Schild für den Moderator: Restzeit so groß wie möglich, ein Wort, ein Balken.
// Jeder Zustand ist dreifach codiert: Farbe, Form (Rahmen/Fläche/Symbol), Wort.

import { formatSignDigits, formatTimeOfDay, formatClock } from '../shared/timing.js';
import { fitText, fitBlock } from '../ui/fit.js';
import { sanitize, safeGifUrl, plainText } from '../ui/richtext.js';

const ICONS = { wrap: '#i-wrap', cut: '#i-cut', stretch: '#i-stretch' };

export class SignView {
  constructor(root) {
    this.root = root;
    this.word = root.querySelector('#sign-word');
    this.top = root.querySelector('#sign-top');
    this.icon = root.querySelector('#sign-icon');
    this.iconUse = this.icon.querySelector('use');
    this.box = root.querySelector('#sign-box');
    this.digits = root.querySelector('#sign-digits');
    this.bar = root.querySelector('#sign-bar');
    this.status = root.querySelector('#sign-status');
    this.msg = root.querySelector('#sign-msg');
    this.msgGif = root.querySelector('#sign-msg-gif');
    this.msgBox = root.querySelector('#sign-msg-textbox');
    this.msgText = root.querySelector('#sign-msg-text');
    this.cueEl = root.querySelector('#sign-cue');
    this.cueKey = null;
    this.msgKey = null;
    this.lastStage = null;
    this.pulseTimer = null;
    const ro = new ResizeObserver(() => {
      delete this.digits.dataset.fitKey;
      delete this.word.dataset.fitKey;
      delete this.msgText.dataset.fitKey;
    });
    ro.observe(this.box);
    ro.observe(this.top);
    ro.observe(this.msgBox);
    this.msgGif.addEventListener('load', () => delete this.msgText.dataset.fitKey);
  }

  /** Custom Text: nur bereinigtes HTML (fett/kursiv/unterstrichen/Farbe) und GIFs von Giphy. */
  renderMessage(m) {
    const key = m ? `${m.at}|${m.only ? 1 : 0}` : null;
    if (key === this.msgKey) return;
    this.msgKey = key;
    this.root.classList.toggle('has-msg', !!m);
    this.root.classList.toggle('msg-only', !!m?.only);
    this.msg.hidden = !m;
    delete this.digits.dataset.fitKey;
    if (!m) {
      this.msgText.replaceChildren();
      this.msgGif.removeAttribute('src');
      return;
    }
    const gif = safeGifUrl(m.gif?.url);
    this.msgGif.hidden = !gif;
    if (gif) this.msgGif.src = gif;
    else this.msgGif.removeAttribute('src');
    const html = sanitize(m.html);
    this.msgText.innerHTML = html;
    this.msgText.classList.toggle('upper', !!m.upper);
    this.msgBox.hidden = !html;
    this.msg.classList.toggle('gif-only', !!gif && !html);
    this.msg.setAttribute('aria-label', plainText(html) || 'GIF');
    delete this.msgText.dataset.fitKey;
  }

  render(vm, meta) {
    const ev = vm.ev;
    const state = ev.state;
    if (this.root.dataset.state !== state) this.root.dataset.state = state;
    this.renderMessage(vm.state?.message || null);
    if (vm.state?.message && !this.msgBox.hidden) fitBlock(this.msgText, this.msgBox);

    // Warnstufe neu erreicht: Rahmen pulst dreimal (1 Hz), dann ruhig.
    const stage = state === 'step' ? ev.stage : null;
    if (stage != null && stage !== this.lastStage) {
      this.root.classList.remove('pulse-3');
      void this.root.offsetWidth;
      this.root.classList.add('pulse-3');
      clearTimeout(this.pulseTimer);
      this.pulseTimer = setTimeout(() => this.root.classList.remove('pulse-3'), 3100);
    }
    this.lastStage = stage;

    let word = ev.word || '';
    let icon = ev.icon;
    let text = '';
    let sample = '';
    if (state === 'idle') {
      text = formatTimeOfDay(vm.now, meta.timeZone);
      sample = '00:00';
    } else if (state === 'cut') {
      text = 'SCHLUSS';
      sample = text;
      word = '';
    } else if (ev.digitsMs != null) {
      const f = formatSignDigits(ev.digitsMs, ev.countUp);
      text = f.text;
      sample = text.replace(/\d/g, '0');
    }
    if (!text && word) {
      text = word;
      sample = word;
      word = '';
    }

    // Wort oben (mit Symbol)
    if (this.word.textContent !== word) this.word.textContent = word;
    const href = icon ? ICONS[icon] : null;
    this.icon.toggleAttribute('hidden', !href); // SVG kennt die hidden-Eigenschaft nicht
    if (href && this.iconUse.getAttribute('href') !== href) this.iconUse.setAttribute('href', href);
    if (word || href) {
      const size = fitText(this.word, this.top, word || 'M', {
        heightFactor: 0.95,
        widthFactor: 0.9,
        extraEm: href && word ? 1.1 : href ? 0 : 0,
      });
      if (size) this.icon.style.fontSize = `${size}px`;
    }

    // Ziffern
    if (this.digits.textContent !== text) this.digits.textContent = text;
    if (sample) fitText(this.digits, this.box, sample, { heightFactor: 1.3, widthFactor: 0.97 });
    this.digits.setAttribute('aria-label', ev.digitsMs != null ? `${ev.word ? ev.word + ', ' : ''}${formatClock(ev.digitsMs, ev.countUp)}` : text);

    // Aktueller Cue klein unter den Ziffern (Symbol, Nummer, Titel)
    const cue = state === 'idle' ? null : vm.state?.cue;
    const cueKey = cue ? `${cue.id}|${cue.emoji}|${cue.number}|${cue.title}` : '';
    if (cueKey !== this.cueKey) {
      this.cueKey = cueKey;
      this.cueEl.replaceChildren();
      if (cue) {
        if (cue.emoji) this.cueEl.append(Object.assign(document.createElement('span'), { className: 'emo', textContent: cue.emoji }));
        if (cue.number != null) this.cueEl.append(Object.assign(document.createElement('span'), { className: 'num', textContent: String(cue.number) }));
        this.cueEl.append(document.createTextNode(cue.title || ''));
      }
      delete this.digits.dataset.fitKey; // Platz für die Ziffern hat sich geändert
    }

    // Balken
    let p = 0;
    if (state === 'over') p = 1;
    else if (ev.progress != null && state !== 'dark' && state !== 'idle') p = ev.progress;
    const w = `${(p * 100).toFixed(2)}%`;
    if (this.bar.style.width !== w) this.bar.style.width = w;

    // Status nur bei Problemen (oder im Replay) – klein in der Ecke
    let html = '';
    if (meta.local) html = '<span class="pill bad">LOKAL</span>';
    else if (meta.offlineMs > 3000) html = `<span class="pill bad">OFFLINE ${formatClock(meta.offlineMs, true)}</span>`;
    else if (vm.state?.source?.stale && vm.state?.mode === 'live') html = '<span class="pill warn">QUELLE ?</span>';
    else if (vm.state?.manual?.active) html = '<span class="pill warn">MANUELL</span>';
    else if (vm.state?.mode === 'replay') html = `<span class="pill info">REPLAY ×${vm.state.speed}</span>`;
    if (this.status.dataset.html !== html) {
      this.status.innerHTML = html;
      this.status.dataset.html = html;
    }
  }
}
