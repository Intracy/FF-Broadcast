#!/usr/bin/env node
// Notfall-Werkzeug: Passwort zurücksetzen, wenn kein Admin mehr hineinkommt.
//
//   node server/reset-password.js --list
//   node server/reset-password.js <email>                 (erzeugt ein temporäres Passwort)
//   node server/reset-password.js <email> <neues-passwort>
//   node server/reset-password.js <email> --admin         (zusätzlich zum Admin machen)
//   node server/reset-password.js <email> --link          (Reset-Link statt Passwort, 24 Std. gültig)
//
// Docker:  docker exec -it ff-rundown node server/reset-password.js <email>
// Der Server darf dabei weiterlaufen. Der Benutzer wird auf allen Geräten abgemeldet und muss
// das temporäre Passwort beim nächsten Login ändern.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const [email, newPassword] = args.filter((a) => !a.startsWith('--'));

if (flags.has('--help') || (!email && !flags.has('--list'))) {
  console.log(`
  FF Rundown – Notfall-Passwort-Reset

  node server/reset-password.js --list                 Benutzer anzeigen
  node server/reset-password.js <email>                temporäres Passwort erzeugen
  node server/reset-password.js <email> <passwort>     bestimmtes temporäres Passwort setzen
  node server/reset-password.js <email> --admin        zusätzlich Admin-Rechte geben
  node server/reset-password.js <email> --link         Reset-Link statt Passwort (24 Std.)

  Optional: DATA_DIR=/pfad/zum/data   (Standard: ./data)
`);
  process.exit(email || flags.has('--list') ? 0 : 1);
}

// Als root gestartet (z. B. sudo oder docker exec)? Dann als Besitzer des Datenordners weiterarbeiten,
// damit neue Datenbankdateien nicht root gehören und der Server sie weiter lesen kann.
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
if (!fs.existsSync(path.join(DATA_DIR, 'rundown.db'))) {
  console.error(`\n  Keine Datenbank gefunden unter ${DATA_DIR}/rundown.db\n  Im App-Ordner ausführen oder DATA_DIR=… angeben.\n`);
  process.exit(1);
}
if (process.getuid?.() === 0) {
  const st = fs.statSync(DATA_DIR);
  if (st.uid !== 0) { process.setgid(st.gid); process.setuid(st.uid); }
}

const { db, Q, randomToken } = await import('./db.js');
const { hashPassword } = await import('./auth.js');

if (flags.has('--list')) {
  const rows = Q.users.all();
  console.log('');
  for (const u of rows) console.log(`  ${u.role.padEnd(9)} ${u.email}${u.name ? `  (${u.name})` : ''}${u.must_change ? '  [muss Passwort ändern]' : ''}`);
  console.log(`\n  ${rows.length} Benutzer\n`);
  process.exit(0);
}

const u = Q.userByEmail.get(email.trim());
if (!u) {
  console.error(`\n  Kein Benutzer mit der E-Mail „${email}“. Mit --list alle anzeigen.\n`);
  process.exit(1);
}

if (flags.has('--admin') && u.role !== 'admin') {
  db.prepare("UPDATE users SET role='admin' WHERE id=?").run(u.id);
  console.log(`\n  ${u.email} ist jetzt Admin.`);
}

if (flags.has('--link')) {
  const token = randomToken(32);
  Q.revokeResets.run(u.id);
  Q.insertReset.run(u.id, crypto.createHash('sha256').update(token).digest('hex'), 'reset', 'Kommandozeile', Date.now() + 24 * 3600 * 1000);
  console.log(`\n  Reset-Link für ${u.email} (24 Std. gültig, einmalig):\n\n    <Adresse-der-App>/#/reset/${token}\n\n  z. B. http://192.168.1.50:3000/#/reset/${token}\n`);
  process.exit(0);
}

if (newPassword && newPassword.length < 8) {
  console.error('\n  Das Passwort muss mindestens 8 Zeichen haben.\n');
  process.exit(1);
}
const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const pw = newPassword || Array.from(crypto.randomBytes(14), (b) => chars[b % chars.length]).join('');
db.prepare('UPDATE users SET password_hash=?, must_change=1, token_version=token_version+1 WHERE id=?').run(await hashPassword(pw), u.id);
Q.revokeResets.run(u.id);

console.log(`
  Passwort für ${u.email} wurde zurückgesetzt.

    Temporäres Passwort:  ${pw}

  Der Benutzer ist auf allen Geräten abgemeldet und muss beim nächsten Login ein eigenes Passwort festlegen.
`);
process.exit(0);
