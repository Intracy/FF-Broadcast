// Excel (.xlsx) und CSV lesen/schreiben – ohne Fremdbibliothek.
// .xlsx ist ein ZIP mit XML-Dateien: Entpacken über DecompressionStream, Schreiben unkomprimiert (Store).

/* ================================================================== ZIP */
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

async function inflateRaw(data) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** ZIP lesen -> Map(name -> Uint8Array) */
export async function unzip(buf) {
  const b = new Uint8Array(buf);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (u32(b, i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Datei ist keine gültige Excel-Datei (.xlsx)');
  const count = u16(b, eocd + 10);
  let p = u32(b, eocd + 16);
  const files = new Map();
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (u32(b, p) !== 0x02014b50) throw new Error('Excel-Datei ist beschädigt');
    const method = u16(b, p + 10), csize = u32(b, p + 20), nlen = u16(b, p + 28), xlen = u16(b, p + 30), clen = u16(b, p + 32), off = u32(b, p + 42);
    const name = dec.decode(b.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    const start = off + 30 + u16(b, off + 26) + u16(b, off + 28);
    const raw = b.subarray(start, start + csize);
    if (method === 0) files.set(name, raw);
    else if (method === 8) files.set(name, raw);
    else continue;
    files.get(name).method = method;
  }
  return {
    has: (name) => files.has(name),
    async text(name) {
      const raw = files.get(name);
      if (!raw) return null;
      return dec.decode(raw.method === 8 ? await inflateRaw(raw) : raw);
    },
  };
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (d) => { let c = 0xffffffff; for (let i = 0; i < d.length; i++) c = CRC[(c ^ d[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

/** ZIP schreiben (unkomprimiert): files = [[name, string]] -> Uint8Array */
export function zip(files) {
  const enc = new TextEncoder();
  const now = new Date();
  const dtime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const ddate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const parts = [], central = [];
  let offset = 0;
  for (const [name, content] of files) {
    const nb = enc.encode(name), data = typeof content === 'string' ? enc.encode(content) : content;
    const crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, dtime, true); lh.setUint16(12, ddate, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, nb.length, true); lh.setUint16(28, 0, true);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, dtime, true); ch.setUint16(14, ddate, true); ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, nb.length, true); ch.setUint32(42, offset, true);
    parts.push(new Uint8Array(lh.buffer), nb, data);
    central.push(new Uint8Array(ch.buffer), nb);
    offset += 30 + nb.length + data.length;
  }
  const csize = central.reduce((a, x) => a + x.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, csize, true); end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((a, x) => a + x.length, 0));
  let o = 0;
  for (const x of all) { out.set(x, o); o += x.length; }
  return out;
}

/* ================================================================== Excel lesen */
const pad2 = (n) => String(n).padStart(2, '0');
const XML_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const parseXml = (s) => new DOMParser().parseFromString(s, 'application/xml');
const byTag = (el, tag) => [...el.getElementsByTagNameNS('*', tag)];

const BUILTIN_FMT = { 14: 'dd.mm.yyyy', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy', 18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss', 22: 'dd.mm.yyyy h:mm', 45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mm:ss.0' };

/** Zahlenformat einordnen: null | {time, date, sec, h, elapsed} */
function fmtKind(code) {
  if (!code || code === 'General' || code === '@') return null;
  const c = code.replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/\[(?![hms]+\])[^\]]*\]/gi, '').toLowerCase();
  const time = /[hs]/.test(c), date = /[dy]/.test(c) || (/m/.test(c) && !time);
  if (!time && !date) return null;
  return { time, date, sec: /s/.test(c), h: /h/.test(c), elapsed: /\[[hm]+\]/.test(c) };
}

/** Excel-Zahl mit Datums-/Zeitformat so anzeigen wie in Excel (z. B. "5:00", "10:30:00", "31.12.2026") */
function excelDisplay(v, kind) {
  if (kind.time) {
    const total = Math.round((kind.elapsed ? v : v - Math.floor(v)) * 86400);
    const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
    let t = kind.h ? `${h}:${pad2(m)}${kind.sec ? ':' + pad2(s) : ''}` : `${pad2(Math.floor(total / 60))}:${pad2(s)}`;
    if (kind.date && v >= 1) t = excelDate(v) + ' ' + t;
    return t;
  }
  return excelDate(v);
}
function excelDate(v) {
  const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 86400000);
  return `${pad2(d.getUTCDate())}.${pad2(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
}

const colIndex = (ref) => { let n = 0; for (const ch of ref.replace(/\d+$/, '')) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
const numStr = (v) => String(Math.round(v * 1e6) / 1e6);

/** .xlsx einlesen -> [{name, rows: string[][]}] */
export async function readXlsx(buf) {
  const z = await unzip(buf);
  const wbXml = await z.text('xl/workbook.xml');
  if (!wbXml) throw new Error('Keine Excel-Arbeitsmappe gefunden. Alte .xls-Dateien bitte vorher in Excel als .xlsx speichern.');
  const wb = parseXml(wbXml);
  const rels = parseXml((await z.text('xl/_rels/workbook.xml.rels')) || '<Relationships/>');
  const target = Object.fromEntries(byTag(rels, 'Relationship').map((r) => [r.getAttribute('Id'), r.getAttribute('Target')]));
  const ss = [];
  const ssXml = await z.text('xl/sharedStrings.xml');
  if (ssXml) for (const si of byTag(parseXml(ssXml), 'si')) ss.push(byTag(si, 't').filter((t) => t.parentNode.localName !== 'rPh').map((t) => t.textContent).join(''));
  const styles = [];
  const stXml = await z.text('xl/styles.xml');
  if (stXml) {
    const st = parseXml(stXml);
    const custom = Object.fromEntries(byTag(st, 'numFmt').map((f) => [f.getAttribute('numFmtId'), f.getAttribute('formatCode')]));
    const xfs = byTag(st, 'cellXfs')[0];
    if (xfs) for (const xf of [...xfs.children].filter((x) => x.localName === 'xf')) {
      const id = xf.getAttribute('numFmtId') || '0';
      styles.push(fmtKind(custom[id] || BUILTIN_FMT[id]));
    }
  }
  const sheets = [];
  for (const s of byTag(wb, 'sheet')) {
    const rid = s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') || s.getAttribute('r:id');
    let t = target[rid];
    if (!t) continue;
    t = t.startsWith('/') ? t.slice(1) : 'xl/' + t.replace(/^\.\//, '');
    const xml = await z.text(t);
    if (!xml) continue;
    const doc = parseXml(xml);
    const rows = [];
    for (const row of byTag(doc, 'row')) {
      const r = Number(row.getAttribute('r') || rows.length + 1) - 1;
      const out = [];
      let ci = 0;
      for (const c of [...row.children].filter((x) => x.localName === 'c')) {
        const ref = c.getAttribute('r');
        if (ref) ci = colIndex(ref);
        const type = c.getAttribute('t');
        const v = [...c.children].find((x) => x.localName === 'v')?.textContent ?? '';
        let val = '';
        if (type === 's') val = ss[Number(v)] ?? '';
        else if (type === 'inlineStr') val = byTag(c, 't').map((x) => x.textContent).join('');
        else if (type === 'b') val = v === '1' ? 'WAHR' : 'FALSCH';
        else if (type === 'str' || type === 'e') val = v;
        else if (v !== '') {
          const num = Number(v), kind = styles[Number(c.getAttribute('s') || 0)];
          val = kind && Number.isFinite(num) ? excelDisplay(num, kind) : numStr(num);
        }
        out[ci++] = val;
      }
      rows[r] = Array.from(out, (x) => (x ?? '').replace(/_x([0-9A-Fa-f]{4})_/g, (_, hx) => String.fromCharCode(parseInt(hx, 16))).replace(/\r\n?/g, '\n'));
    }
    sheets.push({ name: s.getAttribute('name') || `Tabelle ${sheets.length + 1}`, rows: Array.from(rows, (x) => x || []) });
  }
  if (!sheets.length) throw new Error('Die Excel-Datei enthält keine Tabellenblätter.');
  return sheets;
}

/* ================================================================== CSV */
/** Text dekodieren: UTF-8, sonst Windows-1252 (ältere Excel-Exporte) */
export function decodeText(buf) {
  const b = new Uint8Array(buf);
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b);
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(b).replace(/^﻿/, ''); }
  catch { return new TextDecoder('windows-1252').decode(b); }
}

/** Trennzeichen erraten (; , Tab |) anhand der ersten Zeilen außerhalb von Anführungszeichen */
export function guessDelimiter(text) {
  const sample = text.slice(0, 20000).split(/\r?\n/).slice(0, 10).join('\n').replace(/"[^"]*"/g, '');
  let best = ',', n = -1;
  for (const d of [';', '\t', ',', '|']) {
    const c = sample.split(d).length - 1;
    if (c > n) { n = c; best = d; }
  }
  return best;
}

/** CSV nach RFC 4180 (Anführungszeichen, Zeilenumbrüche in Feldern) */
export function parseCsv(text, delim = guessDelimiter(text)) {
  const rows = [];
  let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else if (ch === '\r') { f += '\n'; if (text[i + 1] === '\n') i++; }
      else f += ch;
    } else if (ch === '"' && f === '') q = true;
    else if (ch === delim) { row.push(f); f = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(f); rows.push(row); row = []; f = '';
    } else f += ch;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows;
}

export function toCsv(rows, delim = ';') {
  const esc = (v) => { const s = String(v ?? ''); return /[";\r\n,\t]/.test(s) || s !== s.trim() ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return '﻿' + rows.map((r) => r.map(esc).join(delim)).join('\r\n') + '\r\n';
}

/* ================================================================== Excel schreiben */
const xesc = (s) => String(s ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const colName = (i) => { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };

// Stile: 0 Standard · 1 Kopfzeile · 2 Text (umbrechen) · 3 Block (fett) · 4 Text-Format "@" (für Zeiten, damit Excel "5:00" nicht in eine Uhrzeit umwandelt)
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="${XML_NS}">
<fonts count="3"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>
<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF45197A"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFECE7F7"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="6">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="49" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyNumberFormat="1"><alignment vertical="center"/></xf>
<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1" applyNumberFormat="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="49" fontId="2" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1" applyNumberFormat="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="top"/></xf>
<xf numFmtId="49" fontId="2" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1" applyNumberFormat="1" applyAlignment="1"><alignment vertical="top"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Standard" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

/**
 * Arbeitsmappe schreiben.
 * sheets: [{name, columns:[{title, width, text?}], rows:[[...]], blockRows?:Set<index>}]
 */
export function writeXlsx(sheets) {
  const files = [];
  files.push(['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`]);
  files.push(['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`]);
  files.push(['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="${XML_NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${xesc(s.name.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`]);
  files.push(['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`]);
  files.push(['xl/styles.xml', STYLES]);
  sheets.forEach((s, si) => {
    const cols = s.columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width || 14}" style="${c.wrap ? 2 : 4}" customWidth="1"/>`).join('');
    const cell = (v, r, c, st) => `<c r="${colName(c)}${r}" s="${st}" t="inlineStr"><is><t xml:space="preserve">${xesc(v)}</t></is></c>`;
    const head = `<row r="1" ht="22" customHeight="1">${s.columns.map((c, i) => cell(c.title, 1, i, 1)).join('')}</row>`;
    const body = s.rows.map((row, ri) => {
      const blk = s.blockRows?.has(ri);
      return `<row r="${ri + 2}">${row.map((v, ci) => (v === '' || v == null) && !blk ? '' : cell(v ?? '', ri + 2, ci, blk ? (s.columns[ci]?.wrap ? 3 : 5) : (s.columns[ci]?.wrap ? 2 : 4))).join('')}</row>`;
    }).join('');
    files.push([`xl/worksheets/sheet${si + 1}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="${XML_NS}"><sheetViews><sheetView workbookViewId="0"${si === 0 ? ' tabSelected="1"' : ''}>${s.freeze === false ? '' : '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'}</sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols>${cols}</cols><sheetData>${head}${body}</sheetData></worksheet>`]);
  });
  return zip(files);
}

/** Datei im Browser herunterladen */
export function download(name, data, type) {
  const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
