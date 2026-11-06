// Gemessene Zeiten: letzte Show und Probedurchläufe im Vergleich zur Planung,
// mit „Als Soll-Dauer übernehmen“ (rückgängig über den Änderungsverlauf).
import { fmtDuration, fmtTime } from '/shared/timing.js';
import { h, icon, modal, toast, confirmDialog } from '/js/ui.js';

if (!document.querySelector('link[href="/css/laeufe.css"]')) document.head.append(h('link', { rel: 'stylesheet', href: '/css/laeufe.css' }));

const dayTime = (ms) => {
  const d = new Date(ms), t = new Date();
  const day = d.toDateString() === t.toDateString() ? 'heute' : d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
  return `${day} ${fmtTime(ms, false)}`;
};

/** Alle verfügbaren Läufe: Show, Proben (neueste zuerst), laufender Durchgang */
function runsOf(live) {
  const runs = [];
  if (live.running && Object.keys(live.history || {}).length) runs.push({ key: 'current', source: 'current', label: live.mode === 'probe' ? 'Probe (läuft)' : 'Show (läuft)', probe: live.mode === 'probe', run: { history: live.history, startedAt: live.startedAt }, live: true });
  if (live.show) runs.push({ key: 'show', source: 'show', label: 'Show', probe: false, run: live.show });
  const probes = live.probes || [];
  for (let i = probes.length - 1; i >= 0; i--) runs.push({ key: 'p' + i, source: 'probe', index: i, label: `Probe ${i + 1}`, probe: true, run: probes[i] });
  return runs;
}

export function openRuns(ctx) {
  const body = h('div', { class: 'runs' });
  const m = modal({ title: 'Gemessene Zeiten', wide: true, body, actions: [{ label: 'Schließen', class: 'ghost' }] });
  m.el.classList.add('runs-modal');

  function draw() {
    const rd = ctx.rd();
    const live = rd.live || {};
    const runs = runsOf(live);
    const items = rd.items.filter((i) => i.type === 'item');
    if (!runs.length) {
      body.replaceChildren(h('div', { class: 'runs-empty' }, icon('timer'),
        h('b', null, 'Noch keine gemessenen Zeiten'),
        h('span', null, 'Starte einen Durchlauf mit „Start“ – oder vorher „Probe“ antippen, dann werden die Zeiten als Probe gespeichert und die Show-Zeiten bleiben unberührt.')));
      return;
    }
    const total = (r) => Object.values(r.run.history || {}).reduce((a, b) => a + b, 0);
    const planTotal = items.reduce((a, i) => a + (i.duration || 0), 0);
    const cell = (sec, plan) => {
      if (sec == null) return h('td', { class: 'num muted' }, '–');
      const d = sec - (plan || 0);
      return h('td', { class: 'num' }, fmtDuration(sec), h('small', { class: Math.abs(d) < 1 ? '' : d > 0 ? 'red' : 'green' }, Math.abs(d) < 1 ? '±0' : fmtDuration(d, { sign: true })));
    };
    const head = h('tr', null, h('th', null, 'Programmpunkt'), h('th', { class: 'num' }, 'Plan'),
      runs.map((r) => h('th', { class: 'num' + (r.probe ? ' probe' : ' show') }, h('span', { class: 'run-tag' + (r.probe ? ' probe' : '') }, r.label), r.run.startedAt ? h('small', null, dayTime(r.run.startedAt)) : null)));
    const rows = items.map((it, i) => h('tr', null,
      h('td', { class: 'ttl' }, h('span', { class: 'nr' }, i + 1), it.title || h('i', { class: 'muted' }, 'Ohne Titel')),
      h('td', { class: 'num plan' }, fmtDuration(it.duration || 0)),
      runs.map((r) => cell(r.run.history?.[it.id], it.duration))));
    const sum = h('tr', { class: 'sum' }, h('td', null, 'Gesamt (gemessene Punkte)'), h('td', { class: 'num plan' }, fmtDuration(planTotal)),
      runs.map((r) => {
        const ids = Object.keys(r.run.history || {}).map(Number);
        const plan = items.filter((i) => ids.includes(i.id)).reduce((a, i) => a + (i.duration || 0), 0);
        return cell(total(r), plan);
      }));
    const actions = ctx.can('editor') ? h('tr', { class: 'acts' }, h('td', { colspan: 2 }),
      runs.map((r) => h('td', { class: 'num' },
        h('button', { class: 'btn sm', title: 'Gemessene Zeiten dieses Laufs als neue Soll-Dauern eintragen', onclick: () => apply(r) }, icon('check'), 'Übernehmen')))) : null;

    body.replaceChildren(
      h('p', { class: 'hint' }, 'Show-Zeiten bleiben für Nachbericht und Druck erhalten, auch wenn danach noch geprobt wird. Gespeichert werden die letzte Show und die letzten 10 Proben.'),
      h('div', { class: 'runs-table' }, h('table', null, h('thead', null, head), h('tbody', null, rows, sum, actions))),
      ctx.can('editor') ? h('div', { class: 'runs-foot' },
        (live.probes || []).length ? h('button', { class: 'btn ghost sm', onclick: () => clear('probes') }, icon('trash'), 'Proben löschen') : null,
        live.show ? h('button', { class: 'btn ghost sm', onclick: () => clear('show') }, icon('trash'), 'Show-Zeiten löschen') : null) : null);
  }

  async function apply(r) {
    const n = Object.keys(r.run.history || {}).length;
    if (!(await confirmDialog(`Die gemessenen Zeiten von „${r.label}“ werden bei ${n} Programmpunkt${n === 1 ? '' : 'en'} als neue Dauer eingetragen. Das lässt sich über den Verlauf rückgängig machen.`, { title: 'Zeiten übernehmen?', okLabel: 'Übernehmen' }))) return;
    try {
      const res = await ctx.api('POST', `/api/rundowns/${ctx.rd().rundown.id}/apply-times`, { source: r.source, index: r.index });
      ctx.applyPayload(res);
      toast(res.changed ? `${res.changed} Dauer${res.changed === 1 ? '' : 'n'} übernommen` : 'Alle Dauern waren schon gleich', 'ok');
      draw();
    } catch (e) { toast(e.message, 'err'); }
  }

  async function clear(which) {
    const what = which === 'probes' ? 'alle gespeicherten Proben' : 'die gespeicherten Show-Zeiten';
    if (!(await confirmDialog(`Sollen ${what} gelöscht werden? Das lässt sich nicht rückgängig machen.`, { title: 'Zeiten löschen?', okLabel: 'Löschen', danger: true }))) return;
    await ctx.liveAction('clearRuns', { which });
    draw();
  }

  draw();
  return m;
}
