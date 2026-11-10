// E-Mail-Versand über SMTP – ohne Fremdpakete (node:net / node:tls).
// Unterstützt STARTTLS (Port 587), SSL/TLS (Port 465) und unverschlüsselt (nur fürs lokale Netz),
// Anmeldung per AUTH PLAIN bzw. LOGIN. Einstellungen in der Tabelle settings (Schlüssel "mail"),
// das Passwort verschlüsselt (AES-256-GCM mit dem Server-Schlüssel). Umgebungsvariablen haben Vorrang.
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import os from 'node:os';
import { db, getSecret } from './db.js';

db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
const getS = db.prepare('SELECT value FROM settings WHERE key=?');
const setS = db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');

/* ------------------------------------------------------------------ Passwort verschlüsseln */
const key = () => crypto.createHash('sha256').update('ffr-mail:' + getSecret()).digest();
function encrypt(text) {
  if (!text) return '';
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}
function decrypt(blob) {
  if (!blob) return '';
  try {
    const [iv, tag, enc] = blob.split('.').map((s) => Buffer.from(s, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
  } catch { return ''; }
}

/* ------------------------------------------------------------------ Einstellungen */
const ENV = {
  host: process.env.SMTP_HOST, port: process.env.SMTP_PORT, secure: process.env.SMTP_SECURE,
  user: process.env.SMTP_USER, pass: process.env.SMTP_PASS,
  from_email: process.env.SMTP_FROM, from_name: process.env.SMTP_FROM_NAME, app_url: process.env.APP_URL,
};
export const envLocked = () => !!ENV.host;

function stored() { try { return JSON.parse(getS.get('mail')?.value || '{}'); } catch { return {}; } }

/** Wirksame Einstellungen (inkl. Passwort im Klartext – nur serverseitig verwenden) */
function config() {
  const s = stored();
  const c = envLocked()
    ? { host: ENV.host, port: Number(ENV.port) || 587, secure: ENV.secure || (Number(ENV.port) === 465 ? 'ssl' : 'starttls'), user: ENV.user || '', pass: ENV.pass || '', from_email: ENV.from_email || ENV.user || '', from_name: ENV.from_name || 'FF Rundown', app_url: ENV.app_url || s.app_url || '' }
    : { host: s.host || '', port: Number(s.port) || 587, secure: s.secure || 'starttls', user: s.user || '', pass: decrypt(s.pass), from_email: s.from_email || '', from_name: s.from_name || 'FF Rundown', app_url: s.app_url || '' };
  c.app_url = String(c.app_url || '').replace(/\/+$/, '');
  return c;
}
export const enabled = () => { const c = config(); return !!(c.host && c.from_email && c.app_url); };
export const appUrl = () => config().app_url;

/** Für die Oberfläche: ohne Passwort */
export function publicSettings() {
  const c = config();
  return { host: c.host, port: c.port, secure: c.secure, user: c.user, has_pass: !!c.pass, from_email: c.from_email, from_name: c.from_name, app_url: c.app_url, enabled: enabled(), env: envLocked() };
}

export function saveSettings(b) {
  if (envLocked()) throw new Error('Der Mailversand ist über Umgebungsvariablen (SMTP_HOST …) festgelegt');
  const old = stored();
  const s = {
    host: String(b.host || '').trim().slice(0, 200),
    port: Math.max(1, Math.min(65535, parseInt(b.port, 10) || 587)),
    secure: ['starttls', 'ssl', 'none'].includes(b.secure) ? b.secure : 'starttls',
    user: String(b.user || '').trim().slice(0, 200),
    pass: b.pass === undefined || b.pass === null ? old.pass || '' : b.pass === '' ? '' : encrypt(String(b.pass).slice(0, 500)),
    from_email: String(b.from_email || '').trim().slice(0, 200),
    from_name: String(b.from_name || '').trim().slice(0, 100),
    app_url: String(b.app_url || '').trim().replace(/\/+$/, '').slice(0, 300),
  };
  if (s.host && !/^[a-z0-9.-]+$/i.test(s.host)) throw new Error('Ungültiger SMTP-Server');
  if (s.from_email && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(s.from_email)) throw new Error('Ungültige Absender-Adresse');
  if (s.app_url && !/^https?:\/\/[^\s/]+/i.test(s.app_url)) throw new Error('Adresse der App muss mit http:// oder https:// beginnen');
  setS.run('mail', JSON.stringify(s));
  return publicSettings();
}

/* ------------------------------------------------------------------ SMTP */
const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
const encHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);
const wrap76 = (s) => s.replace(/.{1,76}/g, '$&\r\n').trimEnd();
const cleanAddr = (s) => String(s || '').replace(/[\r\n<>"]/g, '').trim();

function buildMessage({ from_email, from_name }, { to, subject, text, html }) {
  const boundary = 'ffr-' + crypto.randomBytes(12).toString('hex');
  const domain = from_email.split('@')[1] || 'localhost';
  const headers = [
    `From: ${encHeader(from_name || 'FF Rundown')} <${cleanAddr(from_email)}>`,
    `To: <${cleanAddr(to)}>`,
    `Subject: ${encHeader(subject)}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
    'Auto-Submitted: auto-generated',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const part = (type, body) => [`--${boundary}`, `Content-Type: ${type}; charset=utf-8`, 'Content-Transfer-Encoding: base64', '', wrap76(b64(body))].join('\r\n');
  return [...headers, '', part('text/plain', text), part('text/html', html), `--${boundary}--`, ''].join('\r\n');
}

/** Minimaler SMTP-Dialog; wirft bei Fehlern mit verständlicher Meldung */
function smtpSend(c, to, data) {
  return new Promise((resolve, reject) => {
    let sock, buf = '', waiter = null, done = false;
    const timer = setTimeout(() => fin(new Error('Zeitüberschreitung beim Mailserver')), 20000);
    const fin = (err, val) => {
      if (done) return; done = true; clearTimeout(timer);
      try { sock?.end(); sock?.destroy(); } catch { /* */ }
      err ? reject(err) : resolve(val);
    };
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      if (!waiter) return; // Antwort bleibt im Puffer, bis jemand liest
      // vollständige Antwort: letzte Zeile "NNN Text"
      const lines = buf.split('\r\n');
      for (let i = 0; i < lines.length - 1; i++) {
        if (/^\d{3} /.test(lines[i])) {
          const resp = lines.slice(0, i + 1).join('\n');
          buf = lines.slice(i + 1).join('\r\n');
          const w = waiter; waiter = null;
          w?.(resp);
          return;
        }
      }
    };
    const read = () => new Promise((res) => { waiter = res; if (buf) onData(''); });
    const cmd = async (line, ok, what) => {
      if (line !== null) sock.write(line + '\r\n');
      const r = await read();
      const code = Number(r.slice(0, 3));
      if (!ok.includes(code)) throw new Error(`${what}: ${r.split('\n').pop().slice(4) || r}`);
      return r;
    };
    const attach = (s) => { sock = s; sock.on('data', onData); sock.on('error', (e) => fin(friendly(e))); };
    const hostname = os.hostname().replace(/[^a-z0-9.-]/gi, '') || 'localhost';
    const tlsOpts = { host: c.host, servername: c.host, minVersion: 'TLSv1.2' };

    const run = async () => {
      await cmd(null, [220], 'Begrüßung');
      let ehlo = await cmd(`EHLO ${hostname}`, [250], 'EHLO');
      if (c.secure === 'starttls') {
        if (!/STARTTLS/i.test(ehlo)) throw new Error('Der Server bietet kein STARTTLS an – Port/Verschlüsselung prüfen');
        await cmd('STARTTLS', [220], 'STARTTLS');
        sock.removeAllListeners('data');
        const up = tls.connect({ ...tlsOpts, socket: sock });
        await new Promise((res, rej) => { up.once('secureConnect', res); up.once('error', rej); });
        attach(up);
        ehlo = await cmd(`EHLO ${hostname}`, [250], 'EHLO');
      }
      if (c.user) {
        if (/AUTH[ =][^\n]*PLAIN/i.test(ehlo)) await cmd(`AUTH PLAIN ${b64(`\0${c.user}\0${c.pass}`)}`, [235], 'Anmeldung');
        else {
          await cmd('AUTH LOGIN', [334], 'Anmeldung');
          await cmd(b64(c.user), [334], 'Anmeldung');
          await cmd(b64(c.pass), [235], 'Anmeldung');
        }
      }
      await cmd(`MAIL FROM:<${cleanAddr(c.from_email)}>`, [250], 'Absender');
      await cmd(`RCPT TO:<${cleanAddr(to)}>`, [250, 251], 'Empfänger');
      await cmd('DATA', [354], 'DATA');
      const body = data.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
      await cmd(body + '\r\n.', [250], 'Senden');
      try { sock.write('QUIT\r\n'); } catch { /* */ }
      fin(null, true);
    };

    try {
      const s = c.secure === 'ssl' ? tls.connect({ ...tlsOpts, port: c.port }) : net.connect({ host: c.host, port: c.port });
      attach(s);
      s.once(c.secure === 'ssl' ? 'secureConnect' : 'connect', () => run().catch((e) => fin(e)));
    } catch (e) { fin(friendly(e)); }
  });
}
function friendly(e) {
  const m = { ENOTFOUND: 'SMTP-Server nicht gefunden', ECONNREFUSED: 'Verbindung abgelehnt – Port prüfen', ETIMEDOUT: 'Keine Verbindung zum Mailserver', ECONNRESET: 'Verbindung vom Mailserver getrennt' }[e.code];
  return new Error(m ? `${m} (${e.code})` : e.message);
}

/** Mail senden: { to, subject, text, html } */
export async function send(msg) {
  const c = config();
  if (!c.host || !c.from_email) throw new Error('Mailversand ist nicht eingerichtet (System → E-Mail-Versand)');
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(msg.to || '')) throw new Error('Ungültige Empfänger-Adresse');
  return smtpSend(c, msg.to, buildMessage(c, msg));
}

/* ------------------------------------------------------------------ Vorlagen */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const LOGO = '<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="width:40px;height:40px;border-radius:11px;background:#7c3aed;background-image:linear-gradient(135deg,#9b6cff,#6d28d9);text-align:center;vertical-align:middle;color:#fff;font:700 18px Arial,sans-serif">FF</td><td style="padding-left:12px;font:700 15px Arial,sans-serif;letter-spacing:.06em;color:#111114">FF RUNDOWN</td></tr></table>';

function layout({ title, intro, button, url, outro }) {
  const html = `<!doctype html><html lang="de"><body style="margin:0;background:#f3f3f6;padding:28px 12px;font-family:Arial,Helvetica,sans-serif;color:#121216">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:16px;border:1px solid #e4e4ea">
<tr><td style="padding:26px 28px 6px">${LOGO}</td></tr>
<tr><td style="padding:16px 28px 0"><h1 style="margin:0 0 10px;font-size:21px;line-height:1.3">${esc(title)}</h1>
<p style="margin:0 0 20px;font-size:15px;line-height:1.55;color:#3f3f46">${intro}</p>
${button ? `<p style="margin:0 0 22px"><a href="${esc(url)}" style="display:inline-block;background:#7c3aed;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:12px 22px;border-radius:10px">${esc(button)}</a></p>
<p style="margin:0 0 18px;font-size:12.5px;line-height:1.5;color:#71717a">Falls der Knopf nicht funktioniert, diesen Link in den Browser kopieren:<br><a href="${esc(url)}" style="color:#6d28d9;word-break:break-all">${esc(url)}</a></p>` : ''}
${outro ? `<p style="margin:0 0 24px;font-size:13px;line-height:1.5;color:#71717a">${outro}</p>` : ''}</td></tr>
</table>
<p style="font-size:11.5px;color:#a1a1aa;margin:14px 0 0">Automatisch gesendet von FF Rundown · bitte nicht antworten</p>
</td></tr></table></body></html>`;
  const strip = (s) => String(s).replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const text = [title, '', strip(intro), button ? `\n${button}: ${url}` : '', outro ? `\n${strip(outro)}` : '', '\n—\nAutomatisch gesendet von FF Rundown'].join('\n');
  return { html, text };
}
const validity = (h) => (h >= 48 ? `${Math.round(h / 24)} Tage` : h === 1 ? '1 Stunde' : `${h} Stunden`);

export function inviteMail(u, link, by) {
  const url = `${appUrl()}/#/reset/${link.token}`;
  const hi = u.name ? `Hallo ${esc(u.name)},` : 'Hallo,';
  return {
    to: u.email,
    subject: 'Einladung zu FF Rundown',
    ...layout({
      title: 'Du wurdest zu FF Rundown eingeladen',
      intro: `${hi}<br><br>${by ? esc(by) + ' hat' : 'Es wurde'} für dich ein Zugang zu <b>FF Rundown</b> angelegt – dem Ablaufplan für unsere Produktionen. Lege jetzt dein eigenes Passwort fest, danach kannst du dich mit <b>${esc(u.email)}</b> anmelden.`,
      button: 'Passwort festlegen', url,
      outro: `Der Link ist ${validity(link.hours)} gültig und funktioniert genau einmal. Auf dem Handy kannst du FF Rundown anschließend über „Zum Home-Bildschirm“ wie eine App nutzen.`,
    }),
  };
}

export function resetMail(u, link, { self = false } = {}) {
  const url = `${appUrl()}/#/reset/${link.token}`;
  const hi = u.name ? `Hallo ${esc(u.name)},` : 'Hallo,';
  return {
    to: u.email,
    subject: 'Passwort zurücksetzen – FF Rundown',
    ...layout({
      title: 'Neues Passwort festlegen',
      intro: `${hi}<br><br>${self ? 'für dein Konto wurde „Passwort vergessen“ angefordert.' : 'ein Admin hat dir einen Link zum Zurücksetzen deines Passworts geschickt.'} Über den Knopf legst du ein neues Passwort fest.`,
      button: 'Neues Passwort festlegen', url,
      outro: `Der Link ist ${validity(link.hours)} gültig und funktioniert genau einmal.${self ? ' Wenn du das nicht warst, kannst du diese Mail ignorieren – dein bisheriges Passwort bleibt gültig.' : ''}`,
    }),
  };
}

export function testMail(to) {
  return {
    to,
    subject: 'Testmail von FF Rundown',
    ...layout({
      title: 'Der Mailversand funktioniert',
      intro: `Diese Testmail wurde von FF Rundown verschickt. Einladungen und „Passwort vergessen“ kommen ab jetzt auf diesem Weg.<br><br>Links in den Mails zeigen auf: <b>${esc(appUrl() || '(Adresse der App nicht eingetragen)')}</b>`,
    }),
  };
}
