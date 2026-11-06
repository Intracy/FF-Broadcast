// Drehrad wie SwiftUI Picker(.wheel): senkrecht scrollen, rastet auf jeden Wert ein.
// Bedienbar per Touch (Scroll-Snap), Tastatur (Pfeile) und VoiceOver (spinbutton).

const ITEM_H = 44;

export function createWheel(el, o) {
  return new Wheel(el, o);
}

export class Wheel {
  /**
   * @param {HTMLElement} el
   * @param {object} o
   * @param {number} [o.max]
   * @param {string} [o.label]
   * @param {(v:number)=>void} [o.onChange]
   */
  constructor(el, { max = 99, label = '', onChange = () => {} } = {}) {
    this.el = el;
    this.max = max;
    this.onChange = onChange;
    this.value = 0;
    el.classList.add('wheel');
    el.tabIndex = 0;
    el.setAttribute('role', 'spinbutton');
    el.setAttribute('aria-label', label);
    el.setAttribute('aria-valuemin', '0');
    el.setAttribute('aria-valuemax', String(max));
    const list = document.createElement('div');
    list.className = 'wheel-list';
    for (let i = 0; i <= max; i++) {
      const d = document.createElement('div');
      d.className = 'wheel-item';
      d.textContent = String(i).padStart(2, '0');
      d.addEventListener('click', () => this.set(i, true));
      list.appendChild(d);
    }
    el.appendChild(list);
    this.items = list.children;
    el.addEventListener('scroll', () => this.read(), { passive: true });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp') this.set(this.value - 1, true);
      else if (e.key === 'ArrowDown') this.set(this.value + 1, true);
      else return;
      e.preventDefault();
    });
    this.mark();
  }

  /** Nach dem Sichtbarwerden (z. B. Dialog geöffnet) den aktuellen Wert wieder einrasten. */
  sync() {
    this.el.scrollTo({ top: this.value * ITEM_H, behavior: 'auto' });
    this.mark();
  }

  /** Wert aus der Scrollposition lesen. */
  read() {
    if (!this.el.clientHeight) return; // unsichtbar: Scrollposition ist bedeutungslos
    const v = Math.max(0, Math.min(this.max, Math.round(this.el.scrollTop / ITEM_H)));
    if (v === this.value) return;
    this.value = v;
    this.mark();
    this.onChange(v);
  }

  mark() {
    for (let i = 0; i < this.items.length; i++) this.items[i].classList.toggle('sel', i === this.value);
    this.el.setAttribute('aria-valuenow', String(this.value));
    this.el.setAttribute('aria-valuetext', String(this.value).padStart(2, '0'));
  }

  set(v, smooth = false) {
    v = Math.max(0, Math.min(this.max, v));
    this.el.scrollTo({ top: v * ITEM_H, behavior: smooth ? 'smooth' : 'auto' });
    if (v !== this.value) {
      this.value = v;
      this.mark();
      this.onChange(v);
    }
  }
}
