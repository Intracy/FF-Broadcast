// Custom-Text fürs Schild: einfache Formatierung (fett, kursiv, unterstrichen, Farbe),
// sonst nichts. Jeder Text wird vor dem Anzeigen neu aufgebaut, sodass nur diese
// Formatierungen übrig bleiben – fremdes HTML oder Skripte kommen nie aufs Schild.

/** Farbpalette = Systemfarben der HIG (Dunkel). */
export const PALETTE = {
  white: [255, 255, 255],
  yellow: [255, 214, 0],
  orange: [255, 146, 48],
  red: [255, 66, 69],
  green: [48, 209, 88],
  blue: [0, 145, 255],
};

function parseColor(str) {
  if (!str) return null;
  str = String(str).trim();
  let m = str.match(/^#([0-9a-f]{6})$/i);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  m = str.match(/^#([0-9a-f]{3})$/i);
  if (m) return [...m[1]].map((c) => parseInt(c + c, 16));
  m = str.match(/rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)/i);
  if (m) return [+m[1], +m[2], +m[3]];
  return null;
}

function nearestColor(str) {
  const c = parseColor(str);
  if (!c) return null;
  let best = null;
  let bestD = Infinity;
  for (const [name, p] of Object.entries(PALETTE)) {
    const d = (c[0] - p[0]) ** 2 + (c[1] - p[1]) ** 2 + (c[2] - p[2]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = name;
    }
  }
  return best === 'white' ? null : best;
}

const esc = (s) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const BLOCK = new Set(['DIV', 'P', 'LI', 'H1', 'H2', 'H3', 'BLOCKQUOTE']);

/** Baut aus beliebigem HTML sicheres HTML mit <b>, <i>, <u>, <br> und Farb-<span>. */
export function sanitize(html, maxLen = 4000) {
  const doc = new DOMParser().parseFromString(`<body>${String(html || '').slice(0, maxLen * 4)}</body>`, 'text/html');
  let out = '';
  let textLen = 0;
  const walk = (node) => {
    for (const n of node.childNodes) {
      if (textLen > maxLen) return;
      if (n.nodeType === 3) {
        const t = n.nodeValue.slice(0, maxLen - textLen);
        textLen += t.length;
        out += esc(t);
        continue;
      }
      if (n.nodeType !== 1) continue;
      const tag = n.tagName;
      if (tag === 'BR') {
        out += '<br>';
        continue;
      }
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'IFRAME' || tag === 'OBJECT') continue;
      const style = n.getAttribute('style') || '';
      const wrap = [];
      if (tag === 'B' || tag === 'STRONG' || /font-weight\s*:\s*(bold|[6-9]00)/i.test(style)) wrap.push('b');
      if (tag === 'I' || tag === 'EM' || /font-style\s*:\s*italic/i.test(style)) wrap.push('i');
      if (tag === 'U' || /text-decoration[^;]*underline/i.test(style)) wrap.push('u');
      const own = (n.getAttribute('class') || '').match(/(?:^|\s)c-(yellow|orange|red|green|blue)(?:\s|$)/);
      const color = own ? own[1] : nearestColor(n.getAttribute('color') || (n.style && n.style.color));
      if (BLOCK.has(tag) && out && !out.endsWith('<br>')) out += '<br>';
      out += wrap.map((t) => `<${t}>`).join('');
      if (color) out += `<span class="c-${color}">`;
      walk(n);
      if (color) out += '</span>';
      out += wrap
        .reverse()
        .map((t) => `</${t}>`)
        .join('');
    }
  };
  walk(doc.body);
  return out.replace(/(<br>)+$/, '');
}

/** Reiner Text (für Log, Vorschau und Barrierefreiheit). */
export function plainText(html) {
  const doc = new DOMParser().parseFromString(`<body>${String(html || '')}</body>`, 'text/html');
  doc.querySelectorAll('br').forEach((b) => b.replaceWith('\n'));
  return (doc.body.textContent || '').trim();
}

/** Nur GIFs von Giphy zulassen. */
export function safeGifUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && /(^|\.)giphy\.com$/i.test(u.hostname) ? u.href : null;
  } catch {
    return null;
  }
}

/** Giphy-Link (Seite oder Medien-URL) → direkte GIF-URL, ohne API-Schlüssel. */
export function gifFromGiphyLink(input) {
  const s = String(input || '').trim();
  const direct = safeGifUrl(s);
  if (direct && /\.(gif|webp)(\?|$)/i.test(direct)) return direct;
  const m = s.match(/giphy\.com\/(?:gifs|stickers|embed)\/(?:[^/?#]*-)?([A-Za-z0-9]+)(?:[/?#]|$)/) || s.match(/giphy\.com\/media\/([A-Za-z0-9]+)/);
  return m ? `https://media.giphy.com/media/${m[1]}/giphy.gif` : null;
}
