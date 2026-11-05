// Cue-Art und Emoji aus dem Titel – Regeln aus FF-Aufnahmeleitung-Tool (config/cue-kinds.json).
// FF-Broadcast kennt keine Cue-Art; die erste passende Regel gewinnt, sonst „moderiert“.
// Arten: moderated (Countdown mit Warnstufen), fixed (Zuspieler/Pause), open (zählt hoch),
// special (Countdown ohne Alarm), anchor (zählt auf eine Uhrzeit herunter).

export const DEFAULT_KIND = 'moderated';

const RULES = [
  { kind: 'open', re: new RegExp("^(Draft\\b|SuP3 Game \\d|Finale Game \\d)", 'i') },
  { kind: 'fixed', re: new RegExp("^(TLC Presenter|FF Stinger|Trailer|Highlights|Hypevideo|Winner MAZ|Abspann|Road to Glory|COUNTDOWN|SIGNAL LIVE|STREAM ENDE)", 'i') },
  { kind: 'fixed', re: new RegExp("^(PAUSE|Countdown Pause)$", 'i') },
  { kind: 'special', re: new RegExp("^(Einlauf Teams|M\u00fcnzwurf|Noris Liga|Kahoot)", 'i') },
];

const EMOJIS = [
  { emoji: "⏳", re: new RegExp("^COUNTDOWN", 'i') },
  { emoji: "📡", re: new RegExp("^SIGNAL LIVE", 'i') },
  { emoji: "🔴", re: new RegExp("^STREAM ENDE", 'i') },
  { emoji: "☕", re: new RegExp("^(PAUSE|Pause|Countdown Pause)$", 'i') },
  { emoji: "🎬", re: new RegExp("^TLC Presenter", 'i') },
  { emoji: "✨", re: new RegExp("^FF Stinger", 'i') },
  { emoji: "🎞️", re: new RegExp("^Trailer", 'i') },
  { emoji: "⭐", re: new RegExp("^Highlights", 'i') },
  { emoji: "🔥", re: new RegExp("^Hypevideo", 'i') },
  { emoji: "📣", re: new RegExp("^Hype", 'i') },
  { emoji: "🏆", re: new RegExp("^Winner MAZ", 'i') },
  { emoji: "🥇", re: new RegExp("^Siegerehrung", 'i') },
  { emoji: "🏁", re: new RegExp("^Abspann", 'i') },
  { emoji: "📋", re: new RegExp("^Draft", 'i') },
  { emoji: "🎮", re: new RegExp("^(SuP3|Finale) Game \\d", 'i') },
  { emoji: "🔍", re: new RegExp("^Analyse", 'i') },
  { emoji: "💬", re: new RegExp("^Fazit", 'i') },
  { emoji: "⚔️", re: new RegExp("^Felix vs Felix", 'i') },
  { emoji: "👋", re: new RegExp("^(Begr\u00fc\u00dfung|Wilkommen|Willkommen)", 'i') },
  { emoji: "👋", re: new RegExp("^Verabschiedung", 'i') },
  { emoji: "🙋", re: new RegExp("^Vorstellung", 'i') },
  { emoji: "🗓️", re: new RegExp("^(Tagesprogramm|Weiteres Programm)", 'i') },
  { emoji: "🔄", re: new RegExp("^\u00dcbergabe", 'i') },
  { emoji: "🪙", re: new RegExp("^M\u00fcnzwurf", 'i') },
  { emoji: "🎤", re: new RegExp("^Interview", 'i') },
  { emoji: "🎙️", re: new RegExp("^Einleitung", 'i') },
  { emoji: "🛣️", re: new RegExp("^Road to Glory", 'i') },
  { emoji: "👥", re: new RegExp("^Teamblock", 'i') },
  { emoji: "👀", re: new RegExp("^Champions to Watch", 'i') },
  { emoji: "❓", re: new RegExp("^Frage", 'i') },
  { emoji: "🏟️", re: new RegExp("^Einlauf", 'i') },
  { emoji: "🤔", re: new RegExp("^Erwartungen", 'i') },
  { emoji: "🔮", re: new RegExp("^Predictions", 'i') },
  { emoji: "💭", re: new RegExp("^Gedanken", 'i') },
  { emoji: "🧠", re: new RegExp("^Noris Liga", 'i') },
  { emoji: "🧩", re: new RegExp("^Kahoot", 'i') },
  { emoji: "🙏", re: new RegExp("^Danksagung", 'i') },
];

const EMOJI_BY_KIND = {"moderated": "🎙️", "fixed": "🎬", "open": "🎮", "special": "⭐", "anchor": "⏰"};

/** @returns {{ kind: string, emoji: string }} */
export function classifyTitle(title) {
  const t = String(title ?? '').split('\n')[0].trim();
  const kind = RULES.find((r) => r.re.test(t))?.kind ?? DEFAULT_KIND;
  const emoji = EMOJIS.find((r) => r.re.test(t))?.emoji ?? EMOJI_BY_KIND[kind] ?? '';
  return { kind, emoji };
}
