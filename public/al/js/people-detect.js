// Personen aus der GFX-Spalte (Bauchbinden/Namen) und optionalen Personen-Spalten.
// Ergebnis je Cue: [{ name, role: 'host' | 'guest' }], Moderation zuerst.
//
// Moderation erkennt der Server auf drei Wegen (in dieser Reihenfolge):
//   1. ausdrücklich im Text: „Moderation: Anna Beispiel“, „Anna Beispiel (Mod)“
//   2. Namen aus der Moderationsliste (Startseite › Personen bzw. HOSTS in .env)
//   3. häufig: wer in mindestens einem Viertel der Cues mit Personen auftaucht (mind. 3 Cues)
// Alle übrigen Namen gelten als Gäste. Wer auf der Startseite als Gast markiert ist, bleibt Gast.

const HOST_WORDS = /^(moderation|moderator(?:in|en|innen)?|mod|mods|host|hosts|co-?host|co-?moderation|anmoderation|präsentation|presenter|kommentar|kommentator(?:in|en)?|caster|cast)$/i;
const GUEST_WORDS = /^(gast|gäste|guest|guests|interview|interviewgast|talkgast|talk|panel|studiogast|studiogäste)$/i;
const NEUTRAL_WORDS = /^(lt|l3|bb|bauchbinde|bauchbinden|lower ?thirds?|name|namen|names?|insert|einblender|einblendung|person|personen|gfx|grafik|cg|on ?stage|bühne)$/i;

// Begriffe, die in GFX-Spalten vorkommen, aber keine Personen sind
const STOP = new Set(
  [
    'logo', 'logos', 'countdown', 'timer', 'uhr', 'bauchbinde', 'bauchbinden', 'lower third', 'lower thirds', 'fullscreen', 'vollbild',
    'insert', 'grafik', 'grafiken', 'gfx', 'overlay', 'overlays', 'ticker', 'scoreboard', 'score', 'bracket', 'tabelle', 'ranking',
    'ergebnis', 'ergebnisse', 'intro', 'outro', 'opener', 'stinger', 'trailer', 'video', 'videos', 'clip', 'clips', 'mvp', 'sponsor',
    'sponsoren', 'sponsoring', 'team', 'teams', 'spiel', 'spiele', 'game', 'games', 'finale', 'winner', 'sieger', 'pause', 'werbung',
    'live', 'replay', 'highlights', 'highlight', 'bild', 'kamera', 'cam', 'webcam', 'stream', 'chat', 'qr', 'qr-code', 'hashtag',
    'titel', 'title', 'schrift', 'text', 'keine', 'kein', 'none', 'n/a', 'na', 'tbd', 'tba', 'offen', 'siehe', 'wie', 'oben', 'leer',
    'moderation', 'moderator', 'moderatorin', 'gast', 'gäste', 'guest', 'host', 'hosts', 'mod', 'alle', 'beide', 'publikum', 'zuschauer',
    'jury', 'spieler', 'player', 'players', 'caster', 'kommentar', 'interview', 'talk', 'panel', 'draft', 'analyse', 'fazit', 'stats',
    'statistik', 'map', 'maps', 'runde', 'round', 'match', 'matches', 'quiz', 'umfrage', 'voting', 'gewinnspiel', 'credits', 'abspann',
    'musik', 'sound', 'ton', 'audio', 'mikro', 'mic', 'licht', 'ja', 'nein', 'x', '-', '–',
  ].map((s) => s.toLowerCase()),
);
const PARTICLES = new Set(['von', 'van', 'de', 'der', 'den', 'da', 'di', 'du', 'le', 'la', 'zu', 'vom', 'ter', 'ten', 'del', 'dos', 'al', 'bin', 'el']);

const ROLE_IN_PARENS = /\s*[([]\s*([^)\]]{1,30})\s*[)\]]\s*$/;
const ROLE_SUFFIX = /\s+[-–—|]\s+(.{1,40})$/;

function roleOfWord(w) {
  const t = String(w || '').trim().replace(/[.:]+$/, '');
  if (HOST_WORDS.test(t)) return 'host';
  if (GUEST_WORDS.test(t)) return 'guest';
  return null;
}

/** Sieht der Text nach einem Personennamen aus (auch Gamertags wie „HandOfBlood“)? */
export function looksLikeName(s) {
  const t = String(s || '').trim();
  if (t.length < 2 || t.length > 40) return false;
  if (/[0-9]{3,}|[:=@#*{}<>/\\]|https?/i.test(t)) return false;
  if (STOP.has(t.toLowerCase())) return false;
  const words = t.split(/\s+/);
  if (words.length > 4) return false;
  let named = 0;
  for (const w of words) {
    if (PARTICLES.has(w.toLowerCase())) continue;
    if (STOP.has(w.toLowerCase())) return false;
    // Großbuchstabe am Anfang (inkl. Umlaute), danach Buchstaben, Ziffern, Bindestrich, Apostroph, Punkt
    if (!/^[A-ZÄÖÜÀ-ÝŁŚŽ][\p{L}\p{M}0-9'’.\-_]*$/u.test(w)) return false;
    named++;
  }
  return named > 0;
}

/** Zerlegt einen GFX-Text in Personen mit ausdrücklicher Rolle (oder null). */
export function parsePeopleText(text, defaultRole = null) {
  const out = [];
  if (!text) return out;
  const lines = String(text)
    .replace(/\r/g, '')
    .split(/\n|;|•|·|\|/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (let line of lines) {
    line = line.replace(/^[-–—*+>\s]+/, '').replace(/^\d+[.)]\s+/, '');
    let role = defaultRole;
    // Präfixe wie „Moderation:“, „Gast –“, „LT:“; auch verschachtelt („LT: Gast: Name“)
    for (let i = 0; i < 3; i++) {
      const m = line.match(/^([\p{L}\s-]{1,24}?)\s*[:–—-]\s+(.+)$/u) || line.match(/^([\p{L}-]{1,24}):\s*(.+)$/u);
      if (!m) break;
      const w = m[1].trim();
      const r = roleOfWord(w);
      if (r) role = r;
      else if (!NEUTRAL_WORDS.test(w)) break;
      line = m[2].trim();
    }
    for (let part of line.split(/\s*,\s*|\s+&\s+|\s+\+\s+|\s+und\s+|\s+\/\s+/)) {
      part = part.trim().replace(/^["„“'']+|["„“''.]+$/g, '');
      if (!part) continue;
      // Rolle mitten in der Zeile („Anna, Ben, Gast: Carla, Dana“) gilt ab hier
      const mid = part.match(/^([\p{L}-]{2,24}(?:\s[\p{L}-]{2,24})?)\s*:\s*(.+)$/u);
      if (mid) {
        const r0 = roleOfWord(mid[1]);
        if (r0) role = r0;
        if (r0 || NEUTRAL_WORDS.test(mid[1].trim())) part = mid[2].trim();
      }
      let r = role;
      const p = part.match(ROLE_IN_PARENS);
      if (p) {
        r = roleOfWord(p[1]) || r;
        part = part.slice(0, p.index).trim();
      }
      const s = part.match(ROLE_SUFFIX);
      if (s) {
        r = roleOfWord(s[1]) || r;
        part = part.slice(0, s.index).trim();
      }
      if (looksLikeName(part)) out.push({ name: part, role: r });
    }
  }
  return out;
}

const keyOf = (n) => n.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Personen für alle Cues bestimmen.
 * @param {Array<{columns: Record<string,string>}>} cues
 * @param {{hosts?: string[], guests?: string[]}} opts  Moderations-/Gästeliste (Groß-/Kleinschreibung egal);
 *   die Listen gewinnen gegen Text und Häufigkeit
 * @returns {Array<Array<{name:string, role:'host'|'guest'}>>} je Cue
 */
export function derivePeople(cues, opts = {}) {
  const listed = new Set((opts.hosts || []).map(keyOf).filter(Boolean));
  const listedGuest = new Set((opts.guests || []).map(keyOf).filter(Boolean));
  const raw = cues.map((c) => {
    const found = [];
    for (const [col, val] of Object.entries(c.columns || {})) {
      const name = col.trim();
      if (/^gfx$/i.test(name) || /grafik|bauchbinde|lower ?third/i.test(name)) found.push(...parsePeopleText(val));
      else if (/moderation|moderator|host/i.test(name)) found.push(...parsePeopleText(val, 'host'));
      else if (/^(gast|gäste|guests?|talkgäste|personen|people|on ?stage)$/i.test(name)) found.push(...parsePeopleText(val));
    }
    // doppelte Namen je Cue zusammenführen (ausdrückliche Rolle gewinnt)
    const m = new Map();
    for (const p of found) {
      const k = keyOf(p.name);
      const prev = m.get(k);
      if (!prev) m.set(k, { ...p });
      else if (!prev.role && p.role) prev.role = p.role;
    }
    return [...m.values()];
  });

  // Moderation: ausdrücklich irgendwo genannt, gelistet oder häufig
  const explicitHost = new Set();
  const count = new Map();
  let withPeople = 0;
  for (const list of raw) {
    if (list.length) withPeople++;
    for (const p of list) {
      const k = keyOf(p.name);
      count.set(k, (count.get(k) || 0) + 1);
      if (p.role === 'host') explicitHost.add(k);
    }
  }
  const minFreq = Math.max(3, Math.ceil(withPeople * 0.25));
  const isHost = (k) => listed.has(k) || explicitHost.has(k) || (count.get(k) || 0) >= minFreq;

  return raw.map((list) =>
    list
      .map((p) => {
        const k = keyOf(p.name);
        const role = listedGuest.has(k) ? 'guest' : listed.has(k) ? 'host' : p.role === 'guest' ? 'guest' : isHost(k) ? 'host' : 'guest';
        return { name: p.name, role };
      })
      .sort((a, b) => (a.role === b.role ? 0 : a.role === 'host' ? -1 : 1))
      .slice(0, 12),
  );
}
