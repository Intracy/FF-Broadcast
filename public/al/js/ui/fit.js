// Passt eine Textzeile in eine Box ein: so groß, wie Breite und Höhe erlauben.
// Gemessen wird mit einem unsichtbaren Klon in derselben Schrift, daher stimmt die
// Rechnung für SF Pro auf dem iPad genauso wie für Ersatzschriften.

/**
 * Mehrzeiligen Text (mit Umbruch) so groß wie möglich in eine Box setzen.
 * Binäre Suche über die Schriftgröße, bis Breite und Höhe passen.
 */
export function fitBlock(el, box, { min = 14, max = 600 } = {}) {
  const w = box.clientWidth;
  const h = box.clientHeight;
  if (!w || !h) return null;
  const key = `${el.innerHTML.length}|${el.innerHTML.slice(0, 200)}|${el.className}|${w}|${h}`;
  // Zwischengespeichert – aber nur, solange der Text wirklich noch passt
  // (z. B. ändert eine nachgeladene fette Schrift die Breite und damit den Umbruch).
  if (el.dataset.fitKey === key && el.scrollHeight <= h + 1 && el.scrollWidth <= w + 1) return Number(el.dataset.fitSize);
  let lo = min;
  let hi = Math.min(max, h);
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    el.style.fontSize = `${mid}px`;
    if (el.scrollHeight <= h && el.scrollWidth <= w) lo = mid;
    else hi = mid;
  }
  // Abrunden mit etwas Luft: genau an der Umbruchgrenze kippt sonst eine Zeile.
  const size = Math.max(min, Math.floor(lo * 0.97 * 10) / 10);
  el.style.fontSize = `${size}px`;
  el.dataset.fitKey = key;
  el.dataset.fitSize = String(size);
  return size;
}

/**
 * @param {HTMLElement} el      Textelement
 * @param {HTMLElement} box     Box, deren Größe zählt
 * @param {string} sample       Mustertext (z. B. "00:00" für tabellarische Ziffern)
 * @param {object} [o]
 * @param {number} [o.heightFactor]  Schriftgröße höchstens Boxhöhe × Faktor
 * @param {number} [o.widthFactor]   genutzter Anteil der Breite
 * @param {number} [o.extraEm]       zusätzliche Breite in em (z. B. Symbol vor dem Wort)
 * @param {number} [o.max]           Obergrenze in px
 */
export function fitText(el, box, sample, o = {}) {
  const { heightFactor = 1.3, widthFactor = 0.96, extraEm = 0, max = Infinity } = o;
  const w = box.clientWidth;
  const h = box.clientHeight;
  if (!w || !h || !sample) return null;
  const key = `${sample}|${w}|${h}|${heightFactor}|${extraEm}|${max}`;
  if (el.dataset.fitKey === key) return Number(el.dataset.fitSize);
  let probe = box.querySelector(':scope > .fit-probe');
  if (!probe) {
    probe = el.cloneNode(false);
    probe.removeAttribute('id');
    probe.removeAttribute('role');
    probe.setAttribute('aria-hidden', 'true');
    probe.classList.add('fit-probe');
    box.appendChild(probe);
  }
  probe.style.fontSize = '100px';
  probe.textContent = sample;
  const sw = probe.getBoundingClientRect().width + extraEm * 100 || 1;
  const size = Math.max(8, Math.min((w * widthFactor * 100) / sw, h * heightFactor, max));
  el.style.fontSize = `${size.toFixed(1)}px`;
  el.dataset.fitKey = key;
  el.dataset.fitSize = String(size);
  return size;
}
