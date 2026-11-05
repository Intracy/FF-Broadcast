// Einstieg: Rolle aus der URL, Verbindung, Ansichten, Ausrichtung.
// Übernommen aus FF-Aufnahmeleitung-Tool; statt des Relays liefert FF-Broadcast Rundown und
// Live-Zustand (ff-source.js). Adressen: /aufnahmeleitung/<id>, /regie/<id>, /stapel/<id>,
// /schild/<id> – jeweils auch /…/p/<token> für den öffentlichen Link (nur lesen).

import { FFSource, parseRoute } from './ff-source.js';
import { reportCsv, markersEdl } from './exports.js';
import { settings } from './settings.js';
import { buildVM } from './viewmodel.js';
import { OperatorView } from './views/operator.js';
import { RundownSheet } from './views/rundown.js';
import { SignView } from './views/sign.js';
import { StackView } from './views/stack.js';
import { LocalFallback } from './local.js';
import { initWakeLock } from './ui/wakelock.js';
import { bindHold, bindTap } from './ui/hold.js';
import { formatTimeOfDay, formatSigned, formatClock } from './shared/timing.js';
import { createWheel } from './ui/wheel.js';
import { sanitize, plainText, safeGifUrl, gifFromGiphyLink } from './ui/richtext.js';

const route = parseRoute();
const ROLES = { aufnahmeleitung: 'al', regie: 'regie', stapel: 'stapel', schild: 'schild' };
const VIEW_TITLE = { al: 'Aufnahmeleitung', regie: 'Regie', stapel: 'Vollbild-Stapel', schild: 'Schild' };
const role = ROLES[route?.view] || 'al';
const $ = (s) => document.querySelector(s);
const dlg = $('#settings'); // früh anlegen: frame() liest es schon beim Start

// ---------- Erscheinungsbild ----------
const applyAppearance = () => {
  document.documentElement.dataset.appearance = role === 'al' || role === 'regie' ? settings.get('appearance') : 'dark';
};
applyAppearance();

// ---------- LEA MODE: alle Farben in Pastell (rosé, lila, orange, pink), pro Gerät ----------
const applyLea = () => {
  const on = !!settings.get('lea');
  if (on) document.documentElement.dataset.lea = 'on';
  else delete document.documentElement.dataset.lea;
  const b = document.getElementById('op-lea');
  if (b) b.setAttribute('aria-pressed', String(on));
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = on ? '#1d1020' : '#000000';
};
applyLea();
document.getElementById('op-lea')?.addEventListener('click', () => {
  settings.set('lea', !settings.get('lea'));
  toast(settings.get('lea') ? 'LEA MODE an' : 'LEA MODE aus');
});

/** Seite ersetzen, wenn der Rundown nicht geladen werden kann (Anmeldung, gelöscht, Link aus) */
function fatal(text) {
  document.body.replaceChildren();
  const m = document.createElement('main');
  m.className = 'fatal';
  m.style.cssText = 'position:fixed;inset:0;display:grid;place-items:center;padding:24px;text-align:center;font:17px/1.5 -apple-system,system-ui,sans-serif;color:#ebebf5;background:#000';
  const box = document.createElement('div');
  const t = document.createElement('p');
  t.textContent = text;
  const a = document.createElement('a');
  a.href = '/';
  a.textContent = 'Zu FF-Broadcast';
  a.style.color = '#0a84ff';
  box.append(t, a);
  m.append(box);
  document.body.append(m);
}
if (!route) fatal('Ungültige Adresse.');

// ---------- Toast / Widerrufen ----------
let toastTimer;
function toast(text, ms = 2500) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}
let undoTimer;
let undoFn = null;
function undo(text, fn) {
  $('#undo-text').textContent = `${text} gewählt`;
  $('#undo').hidden = false;
  undoFn = fn;
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => ($('#undo').hidden = true), 5000);
}
bindTap($('#undo-btn'), () => {
  $('#undo').hidden = true;
  undoFn?.();
  undoFn = null;
});

// ---------- Verbindung und Daten ----------
const conn = new FFSource({ route: route || { view: 'aufnahmeleitung', rundownId: 0 } });
const data = { rundown: null, state: null };
const local = new LocalFallback();
let wake = null;
conn.addEventListener('fatal', (e) => {
  if (!data.state || e.detail?.code === 401) fatal(e.detail?.message || 'Rundown konnte nicht geladen werden.');
  else toast(e.detail?.message || 'Verbindung unterbrochen');
});
conn.addEventListener('failed', (e) => toast(`Nicht übernommen: ${e.detail}`, 3500));

let seenEdit = undefined; // Version der zuletzt gemeldeten Website-Änderung
conn.addEventListener('rundown', (e) => {
  const d = e.detail;
  data.rundown = d.rundown ? { ...d.rundown, groups: d.groups } : null;
  if (data.rundown) document.title = `${VIEW_TITLE[role]} · ${data.rundown.title}`;
  // Änderung auf der Website: kurz melden (nicht beim ersten Empfang nach dem Verbinden)
  const ed = d.lastEdit;
  if (seenEdit !== undefined && ed && ed.version !== seenEdit && (role === 'al' || role === 'regie')) {
    toast(`Rundown aktualisiert: ${ed.summary}`, 4500);
  }
  if (ed || seenEdit === undefined) seenEdit = ed ? ed.version : null;
});
let lastEventId = null;
conn.addEventListener('state', (e) => {
  data.state = e.detail;
  if (local.active) {
    for (const m of local.drain()) conn.send(m);
    local.exit();
    toast('Verbindung wieder da – FF-Broadcast übernimmt');
  }
  const le = data.state.lastEvent;
  if (le && le.id !== lastEventId) {
    if (lastEventId !== null && le.type === 'marker') toast(`Marker gesetzt · ${formatTimeOfDay(le.at, data.state.timeZone, true)}`);
    if (lastEventId !== null && le.type === 'timeSync' && !le.ok) toast(`Rundown: Zeit nicht übertragen (${le.error || 'Fehler'}) – gilt nur hier`);
    lastEventId = le.id;
  }
  frame();
});
conn.addEventListener('status', () => frame());
if (route) conn.connect();

/** Befehl der AL: an FF-Broadcast, ohne Verbindung an den lokalen Rückfall. */
function act(msg) {
  // Regie darf strecken und Marker setzen, sonst nur die AL
  if (role !== 'al' && !(role === 'regie' && (msg.type === 'stretch' || msg.type === 'marker'))) return;
  if (!conn.canOperate) {
    toast(route?.publicToken ? 'Öffentlicher Link – nur lesen' : 'Keine Berechtigung für die Live-Steuerung');
    return;
  }
  if (local.active) {
    local.handle(msg, conn.showNow());
    if (msg.type === 'marker') toast('Marker vorgemerkt – wird nachgereicht');
    frame();
    return;
  }
  if (!conn.send(msg)) toast('Keine Verbindung zu FF-Broadcast');
}

function onManual(cmd) {
  const now = conn.showNow();
  if (cmd === 'enter') {
    if (conn.open) conn.send({ type: 'manual', cmd: 'enter' });
    else {
      local.enter(data.state, data.rundown, now);
      toast('Lokaler Modus – Cues mit ◀ ▶ schalten');
    }
  } else if (local.active && (cmd === 'prev' || cmd === 'next')) {
    local.step(cmd === 'next' ? 1 : -1, now);
  } else {
    conn.send({ type: 'manual', cmd });
  }
  frame();
}

// ---------- Ansichten ----------
const signEl = $('#sign');
const opEl = $('#operator');
const signView = new SignView(signEl);
let opView = null;
let signShown = false;
const stackEl = $('#stack');
const stackView = new StackView(stackEl);
let stackShown = false;

/** Vollbild-Stapel ein-/ausblenden (überlagert Bedienung und Schild). */
function showStack(show) {
  stackShown = show;
  stackEl.hidden = !show;
  if (show && signShown) {
    signShown = false;
    signEl.hidden = true;
  }
  const hint = $('#stk-hint');
  hint.hidden = !show || role === 'stapel';
  hint.classList.remove('fade');
  if (show) setTimeout(() => hint.classList.add('fade'), 2500);
  syncGear();
  frame();
}

function showSign(show) {
  signShown = show;
  signEl.hidden = !show;
  if (role === 'al') {
    const hint = $('#sign-hint');
    hint.hidden = !show;
    hint.classList.remove('fade');
    if (show) setTimeout(() => hint.classList.add('fade'), 2500);
  }
  syncGear();
  frame();
}

// Links zu den anderen Ansichten und zurück zum Rundown
document.querySelectorAll('[data-route]').forEach((a) => (a.href = conn.link(a.dataset.route)));
const gearFloat = $('#mode-gear-float');
/** Häuschen über Schild/Stapel nur zeigen, wenn die Bedienleiste nicht sichtbar ist. */
function syncGear() {
  gearFloat.hidden = !(signShown || stackShown);
}

if (role === 'schild') {
  showSign(true);
  wake = initWakeLock(() => {});
} else if (role === 'stapel') {
  showStack(true);
  wake = initWakeLock(() => {});
} else {
  opEl.hidden = false;
  opView = new OperatorView({
    root: opEl,
    act,
    onSign: () => showSign(true),
    onSettings: openSettings,
    onStretch: openStretch,
    onText: openText,
    onRundown: () => rundownSheet.open(),
    onControl: control,
    onManual,
    undo,
    readonly: role === 'regie',
  });
  opView.setGrip(settings.get('grip'));
  wake = initWakeLock(() => frame());

  if (role === 'al') {
    // Drehen ist der Moduswechsel: quer = Schild, hoch = Bedienung.
    const landscape = matchMedia('(orientation: landscape)');
    const onOrientation = () => {
      if (!settings.get('rotateToSign')) return;
      showSign(landscape.matches);
    };
    landscape.addEventListener('change', onOrientation);
    if (landscape.matches && settings.get('rotateToSign')) showSign(true);
    // Schild verlassen: 1 s irgendwo halten.
    bindHold(signEl, () => showSign(false), 1000);
  }
  // Vollbild-Stapel verlassen: ebenfalls 1 s halten
  bindHold(stackEl, () => showStack(false), 1000);
  $('#set-stack').addEventListener('click', () => {
    dlg.close();
    showStack(true);
  });
  if (role === 'regie') {
    // Regie auf dem iPhone: quer = Vollbild-Stapel, hoch = Regieansicht
    const phoneLandscape = matchMedia('(orientation: landscape) and (max-height: 500px)');
    const onPhone = () => showStack(phoneLandscape.matches);
    phoneLandscape.addEventListener('change', onPhone);
    if (phoneLandscape.matches) showStack(true);
  }
}

// ---------- Strecken: Zeit wählen ----------
const stretchDlg = $('#stretch-sheet');
function openStretch() {
  const st = local.active ? local.state() : data.state;
  const cue = st?.cue;
  if (!cue) return;
  const parts = [`${cue.emoji ? cue.emoji + ' ' : ''}${cue.title}`];
  if (cue.startedAt != null && cue.kind !== 'open') {
    const left = cue.effectiveMs - (conn.showNow() - cue.startedAt);
    parts.push(left >= 0 ? `Restzeit ${formatClock(left)}` : `überzogen ${formatClock(-left, true)}`);
  }
  if (cue.stretchMs) parts.push(`bisher ${formatSigned(cue.stretchMs)}`);
  $('#stretch-info').textContent = parts.join(' · ');
  stretchDlg.returnValue = '';
  stretchDlg.showModal();
  requestAnimationFrame(() => {
    wheelMin.sync();
    wheelSec.sync();
  });
}
// Zeit: zwei Scrollräder MM:SS (je 00–99), Schnellwahl stellt die Räder.
// Bestätigen: um die Zeit erweitern (add) oder die Restzeit darauf setzen (set).
const customTime = { m: 0, s: 0 };
const pad2 = (n) => String(n).padStart(2, '0');
const customMs = () => (customTime.m * 60 + customTime.s) * 1000;
function updateCustom() {
  const t = `${pad2(customTime.m)}:${pad2(customTime.s)}`;
  $('#stretch-add-btn').disabled = customMs() <= 0;
  $('#stretch-set-btn').disabled = customMs() <= 0;
  $('#stretch-add-text').textContent = `Um ${t} erweitern`;
  $('#stretch-set-text').textContent = `Auf ${t} setzen`;
  document.querySelectorAll('#stretch-presets [data-ms]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.ms) === customMs())));
}
const wheelMin = createWheel($('#wheel-min'), { label: 'Minuten', onChange: (v) => ((customTime.m = v), updateCustom()) });
const wheelSec = createWheel($('#wheel-sec'), { label: 'Sekunden', onChange: (v) => ((customTime.s = v), updateCustom()) });
updateCustom();
document.querySelectorAll('#stretch-presets [data-ms]').forEach((b) =>
  b.addEventListener('click', () => {
    const sec = Number(b.dataset.ms) / 1000;
    customTime.m = Math.floor(sec / 60);
    customTime.s = sec % 60;
    wheelMin.set(customTime.m, true);
    wheelSec.set(customTime.s, true);
    updateCustom();
  }),
);
stretchDlg.addEventListener('close', () => {
  const rv = stretchDlg.returnValue;
  const ms = customMs();
  if ((rv !== 'add' && rv !== 'set') || ms <= 0) return;
  act({ type: 'stretch', mode: rv, ms });
  const t = `${pad2(customTime.m)}:${pad2(customTime.s)}`;
  toast(rv === 'add' ? `Um ${t} erweitert` : `Restzeit auf ${t} gesetzt`);
});
// Tippen neben das Sheet schließt es (wie in iPadOS)
stretchDlg.addEventListener('click', (e) => {
  if (e.target === stretchDlg) stretchDlg.close('cancel');
});

// ---------- Rundown im Backend steuern (Start, Next, Pause, Zurück, Beenden) ----------
const CONTROL_TOAST = { start: 'Show gestartet', next: 'Nächster Cue', toggle: 'Pause / Weiter', prev: 'Zurück', finish: 'Show beendet' };
async function control(action) {
  const st = local.active ? local.state() : data.state;
  const wasPaused = !!st?.show?.isPaused;
  const r = await conn.control(action);
  const label = action === 'toggle' ? (wasPaused ? 'Rundown läuft weiter' : 'Rundown pausiert') : CONTROL_TOAST[action];
  toast(r.ok ? label : `Rundown: ${r.error || 'Fehler'}`);
}

// ---------- Kompletter Rundown (Tipp auf den Cue-Kasten) ----------
const rundownSheet = new RundownSheet({
  dialog: $('#rundown-sheet'),
  getRundown: () => data.rundown,
  getState: () => (local.active ? local.state() : data.state),
  now: () => conn.showNow(),
  fetchRun: async () => conn.runView(),
});

// ---------- Custom Text fürs Schild ----------
const textDlg = $('#text-sheet');
const editor = $('#text-editor');
const draft = { gif: null, upper: false, only: false };
let giphyEnabled = false;
conn.addEventListener('hello', (e) => (giphyEnabled = !!e.detail.giphy));

function currentState() {
  return local.active ? local.state() : data.state;
}
function syncTextUi() {
  editor.classList.toggle('upper', draft.upper);
  $('#fmt-upper').setAttribute('aria-pressed', String(draft.upper));
  syncSegmented('msg-mode', draft.only ? 'only' : 'with');
  const sel = $('#gif-selected');
  sel.hidden = !draft.gif;
  if (draft.gif) $('#gif-selected-img').src = draft.gif.url;
  else $('#gif-selected-img').removeAttribute('src');
  $('#text-show').disabled = !plainText(sanitize(editor.innerHTML)) && !draft.gif;
}
function openText() {
  const m = currentState()?.message;
  if (m) {
    editor.innerHTML = sanitize(m.html);
    draft.gif = m.gif && safeGifUrl(m.gif.url) ? m.gif : null;
    draft.upper = !!m.upper;
    draft.only = !!m.only;
  }
  $('#text-hide').hidden = !m;
  $('#text-show').textContent = m ? 'Aktualisieren' : 'Anzeigen';
  syncTextUi();
  textDlg.returnValue = '';
  textDlg.showModal();
  $('#gif-type').hidden = !giphyEnabled;
  if (giphyEnabled) requestAnimationFrame(() => renderGifGrid());
  else $('#gif-hint').textContent = 'GIF-Suche gibt es hier nicht – einen Giphy-Link (giphy.com/gifs/…) einfügen funktioniert.';
}

// Nur Text: Schild zeigt ausschließlich den Custom Text (ohne Restzeit, Cue und Zustandsfarben)
document.querySelectorAll('#msg-mode [data-value]').forEach((b) =>
  b.addEventListener('click', () => {
    draft.only = b.dataset.value === 'only';
    syncTextUi();
  }),
);

// Formatierung: Knöpfe nehmen dem Editor den Fokus nicht weg, damit die Auswahl bleibt.
document.querySelectorAll('#text-sheet .fmt-bar button').forEach((b) => {
  b.addEventListener('pointerdown', (e) => e.preventDefault());
  b.addEventListener('click', () => {
    if (b.id === 'fmt-upper') {
      draft.upper = !draft.upper;
      syncTextUi();
      return;
    }
    editor.focus();
    document.execCommand('styleWithCSS', false, false);
    if (b.dataset.color) document.execCommand('foreColor', false, b.dataset.color);
    else if (b.dataset.cmd) document.execCommand(b.dataset.cmd, false, null);
    syncTextUi();
  });
});
editor.addEventListener('input', syncTextUi);
editor.addEventListener('paste', (e) => {
  // Nur reinen Text einfügen, keine fremde Formatierung
  e.preventDefault();
  const t = e.clipboardData?.getData('text/plain') || '';
  document.execCommand('insertText', false, t);
});
$('#quick-texts').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  editor.textContent = b.textContent;
  syncTextUi();
});

// GIFs: FF-Broadcast hat keinen Giphy-Schlüssel, deshalb bleibt die Suche (Giphy-SDK-Gitter) aus.
// Ein eingefügter Giphy-Link (https://giphy.com/gifs/…) funktioniert trotzdem.
let gifTimer;
let gifQuery = '';
let gifType = 'gifs';
let gifSdk = null;
let gifGridRemove = null;
let gifGridKey = '';

function gifRendition(gif) {
  const im = gif.images || {};
  const big = im.downsized_medium || im.downsized || im.original || {};
  return { url: safeGifUrl(big.url), width: Number(big.width) || 0, height: Number(big.height) || 0 };
}

function gifColumns(w) {
  return w >= 560 ? 3 : 2;
}

async function renderGifGrid(force = false) {
  const grid = $('#gif-grid');
  const hint = $('#gif-hint');
  const width = grid.clientWidth;
  if (!giphyEnabled || !width) return;
  const key = `${gifType}|${gifQuery}|${width}`;
  if (!force && key === gifGridKey) return;
  gifGridKey = key;
  try {
    gifSdk ||= await import('../vendor/giphy.js');
  } catch {
    hint.textContent = 'GIF-Suche konnte nicht geladen werden.';
    return;
  }
  gifGridRemove?.();
  grid.replaceChildren();
  grid.classList.toggle('stickers', gifType === 'stickers');
  hint.textContent = '';
  const q = gifQuery;
  const type = gifType;
  gifGridRemove = gifSdk.renderGrid(
    {
      width,
      columns: gifColumns(width),
      gutter: 8,
      borderRadius: 10,
      noLink: true,
      hideAttribution: true,
      noResultsMessage: 'Keine GIFs gefunden.',
      fetchGifs: async (offset) => {
        const r = await fetch((`/api/giphy?q=${encodeURIComponent(q)}&type=${type}&offset=${offset}&limit=24`), { cache: 'no-store' });
        const j = await r.json();
        if (!r.ok) {
          hint.textContent = j.error || 'GIF-Suche nicht verfügbar.';
          throw new Error(j.error || 'giphy');
        }
        return j;
      },
      onGifClick: (gif, e) => {
        e?.preventDefault?.();
        const r = gifRendition(gif);
        if (!r.url) return;
        draft.gif = { ...r, id: gif.id, title: gif.title || '' };
        grid.querySelectorAll('.giphy-gif.is-selected').forEach((n) => n.classList.remove('is-selected'));
        e?.currentTarget?.classList?.add('is-selected');
        syncTextUi();
        $('#gif-selected').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      },
      onGifKeyPress: (gif, e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        const r = gifRendition(gif);
        if (!r.url) return;
        draft.gif = { ...r, id: gif.id, title: gif.title || '' };
        syncTextUi();
      },
    },
    grid,
  );
}

async function searchGifs(q) {
  const hint = $('#gif-hint');
  const link = gifFromGiphyLink(q);
  if (link) {
    draft.gif = { url: link, width: 0, height: 0 };
    hint.textContent = 'GIF aus dem Link übernommen.';
    syncTextUi();
    return;
  }
  if (!giphyEnabled) return;
  gifQuery = q;
  renderGifGrid();
}

document.querySelectorAll('#gif-type [data-value]').forEach((b) =>
  b.addEventListener('click', () => {
    gifType = b.dataset.value;
    syncSegmented('gif-type', gifType);
    renderGifGrid();
  }),
);
// Breite ändert sich beim Drehen des iPads: Gitter neu aufbauen
new ResizeObserver(() => textDlg.open && renderGifGrid()).observe($('#gif-grid'));
$('#gif-query').addEventListener('input', (e) => {
  clearTimeout(gifTimer);
  gifTimer = setTimeout(() => searchGifs(e.target.value.trim()), 400);
});
$('#gif-query').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault(); // sonst schickt Enter das Formular ab und schließt den Dialog
  clearTimeout(gifTimer);
  searchGifs(e.target.value.trim());
  e.target.blur();
});
bindTap($('#gif-remove'), () => {
  draft.gif = null;
  syncTextUi();
});
textDlg.addEventListener('close', () => {
  const rv = textDlg.returnValue;
  if (rv === 'hide') {
    act({ type: 'message', clear: true });
    return;
  }
  if (rv !== 'show') return;
  const html = sanitize(editor.innerHTML);
  const text = plainText(html);
  if (!text && !draft.gif) return;
  act({ type: 'message', html, text, gif: draft.gif, upper: draft.upper, only: draft.only });
  toast('Text auf dem Schild');
});

// ---------- Einstellungen ----------
function syncSegmented(id, value) {
  document.querySelectorAll(`#${id} [data-value]`).forEach((b) => b.setAttribute('aria-checked', String(b.dataset.value === value)));
}
// Exporte: Nachbericht (CSV) und Marker (EDL) entstehen im Browser aus dem AL-Protokoll von FF-Broadcast
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
async function exportFile(kind) {
  try {
    const src = await conn.exportSource();
    const day = data.rundown?.eventDate || 'show';
    if (kind === 'csv') download(`nachbericht-${day}.csv`, reportCsv(src), 'text/csv;charset=utf-8');
    else download(`marker-${day}${kind === 'tod' ? '-uhrzeit' : ''}.edl`, markersEdl(src, { fps: settings.get('fps'), mode: kind === 'tod' ? 'tod' : 'rec' }), 'text/plain;charset=utf-8');
  } catch (e) {
    toast(`Export fehlgeschlagen: ${e.message || e}`);
  }
}
$('#exp-csv').addEventListener('click', () => exportFile('csv'));
$('#exp-edl').addEventListener('click', () => exportFile('edl'));
$('#exp-edl-tod').addEventListener('click', () => exportFile('tod'));
function exportLinks() {}
function openSettings() {
  syncSegmented('set-grip', settings.get('grip'));
  syncSegmented('set-appearance', settings.get('appearance'));
  syncSegmented('set-fps', settings.get('fps'));
  $('#set-rotate').checked = !!settings.get('rotateToSign');
  renderSettingsInfo();
  dlg.showModal();
}
function renderSettingsInfo() {
  if (!dlg.open) return;
  $('#set-wake').textContent = wake?.status ?? '–';
  const s = conn.syncInfo();
  $('#set-sync').textContent = s ? `±${s.accuracyMs} ms (Laufzeit ${s.rttMs} ms)` : conn.open ? 'läuft …' : 'getrennt';
  const src = data.state?.source;
  $('#set-source').textContent = !src ? '–' : conn.open ? `FF-Broadcast · ok · ${src.latencyMs ?? '–'} ms` : 'FF-Broadcast · getrennt';
  $('#set-starthow').textContent = 'Live-Steuerung von FF-Broadcast';
  $('#set-version').textContent = `${VIEW_TITLE[role]} · ${conn.canOperate ? 'darf steuern' : route?.publicToken ? 'öffentlicher Link, nur lesen' : 'nur lesen (keine Live-Rechte)'}`;
}
for (const [id, k] of [
  ['set-grip', 'grip'],
  ['set-appearance', 'appearance'],
  ['set-fps', 'fps'],
]) {
  document.getElementById(id).addEventListener('click', (e) => {
    const b = e.target.closest('[data-value]');
    if (!b) return;
    settings.set(k, b.dataset.value);
    syncSegmented(id, b.dataset.value);
  });
}
$('#set-rotate').addEventListener('change', (e) => settings.set('rotateToSign', e.target.checked));
settings.onChange((k) => {
  if (k === 'grip') opView?.setGrip(settings.get('grip'));
  if (k === 'appearance') applyAppearance();
  if (k === 'lea') applyLea();
  if (k === 'fps') exportLinks();
});

// ---------- Darstellung ----------
function frame() {
  const now = conn.showNow();
  const state = local.active ? local.state() : data.state;
  const vm = buildVM(state, now);
  const meta = {
    timeZone: data.state?.timeZone || 'Europe/Berlin',
    offlineMs: conn.offlineForMs(),
    sync: conn.syncInfo(),
    local: local.active,
    wakeBad: !!wake && /blockiert|freigegeben|HTTPS/.test(wake.status || ''),
  };
  if (stackShown) stackView.render(vm, meta);
  else if (signShown) signView.render(vm, meta);
  if (opView && !signShown && !stackShown) opView.render(vm, meta);
  renderSettingsInfo();
}
setInterval(frame, 100);
frame();
