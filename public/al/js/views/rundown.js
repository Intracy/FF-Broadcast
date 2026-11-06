// Kompletter Rundown als Zeitleiste (Sheet). Öffnet sich per Tipp auf den Cue-Kasten.
// Eine Zeile pro Cue: links die Zeit (Ist bzw. erwartet, darunter Plan), in der Mitte eine Linie
// mit Punkten (gelaufen · jetzt · kommt), rechts nur, was vom Plan abweicht. Gelaufene Cues und
// Cues, die der gewählte Szenario-Weg überspringt, sind zu je einer Zeile zusammengeklappt.
// Daten: /api/rundown (Plan) + /api/runview (Lauf: Ist-Zeiten, ETA entlang der Szenarien).

import { KINDS, formatDuration, formatSigned, formatTimeOfDay, formatClock } from '../shared/timing.js';
import { headsHtml, peopleNamesHtml } from '../ui/people.js';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const SHORT_KIND = { moderated: 'MOD', fixed: 'ZUSP', open: 'OFFEN', special: 'SONDER', anchor: 'ANKER' };
const FILTERS = [
  ['all', 'Alle'],
  ['ahead', 'Ab jetzt'],
  ['moderated', 'Moderiert'],
  ['notes', 'Mit Notizen'],
];

export class RundownSheet {
  /**
   * @param {object} o
   * @param {HTMLDialogElement} o.dialog
   * @param {() => any} o.getRundown   Plan (Cues, Spalten, Szenario-Gruppen)
   * @param {() => any} o.getState     aktueller Zustand (Cue, Zeitzone, Szenario-Wahl)
   * @param {() => number} o.now       Showzeit
   * @param {() => Promise<any>} o.fetchRun  Laufdaten vom Relay
   */
  constructor(o) {
    Object.assign(this, o);
    this.list = this.dialog.querySelector('#rd-list');
    this.scroll = this.dialog.querySelector('.rd-scroll');
    this.info = this.dialog.querySelector('#rd-info');
    this.hint = this.dialog.querySelector('#rd-hint');
    this.nowCard = this.dialog.querySelector('#rd-now');
    this.filtersEl = this.dialog.querySelector('#rd-filters');
    this.run = null;
    this.timer = null;
    this.tick = null;
    this.renderedKey = '';
    this.filter = 'all';
    this.expanded = new Set(); // aufgeklappte Gruppen ('past', 'skip:<idx>', 'block:<name>')
    this.openRows = new Set(); // aufgeklappte Zeilen (Cue-Ids)
    this.folded = new Set(); // eingeklappte Blöcke (Blockname)
    this.blockNames = [];

    this.filtersEl.innerHTML =
      FILTERS.map(([v, l]) => `<button type="button" data-filter="${v}" aria-pressed="${v === 'all'}">${l}</button>`).join('') +
      '<button type="button" class="rd-foldall" data-foldall>Alle Blöcke zu</button>';
    this.foldAllBtn = this.filtersEl.querySelector('[data-foldall]');
    this.filtersEl.addEventListener('click', (e) => {
      if (e.target.closest('[data-foldall]')) {
        // Alle Blöcke ein- bzw. wieder ausklappen
        const allFolded = this.blockNames.length > 0 && this.blockNames.every((k) => this.folded.has(k));
        if (allFolded) this.folded.clear();
        else this.blockNames.forEach((k) => this.folded.add(k));
        this.renderedKey = '';
        this.render();
        if (allFolded) this.scrollToCurrent(false);
        else this.scroll.scrollTo({ top: 0 });
        return;
      }
      const b = e.target.closest('[data-filter]');
      if (!b) return;
      this.filter = b.dataset.filter;
      this.filtersEl.querySelectorAll('[data-filter]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      this.renderedKey = '';
      this.render();
      if (this.filter === 'all' || this.filter === 'ahead') this.scrollToCurrent(false);
      else this.scroll.scrollTo({ top: 0 });
    });
    this.list.addEventListener('click', (e) => {
      const f = e.target.closest('[data-fold]');
      if (f) {
        // Block-Überschrift: alle Cues dieses Blocks ein- oder ausklappen
        const k = f.dataset.fold;
        if (this.folded.has(k)) this.folded.delete(k);
        else this.folded.add(k);
        const y = f.getBoundingClientRect().top;
        this.renderedKey = '';
        this.render();
        // Überschrift bleibt unter dem Finger stehen
        const again = [...this.list.querySelectorAll('[data-fold]')].find((x) => x.dataset.fold === k);
        if (again) this.scroll.scrollTop += again.getBoundingClientRect().top - y;
        return;
      }
      const g = e.target.closest('[data-toggle]');
      if (g) {
        const k = g.dataset.toggle;
        if (this.expanded.has(k)) this.expanded.delete(k);
        else this.expanded.add(k);
        this.renderedKey = '';
        this.render();
        return;
      }
      const row = e.target.closest('.tl-row[data-id]');
      if (row) {
        const id = row.dataset.id;
        if (this.openRows.has(id)) this.openRows.delete(id);
        else this.openRows.add(id);
        row.classList.toggle('open');
        row.setAttribute('aria-expanded', String(row.classList.contains('open')));
      }
    });
    this.nowCard.addEventListener('click', () => this.scrollToCurrent(true));
    this.dialog.querySelector('#rd-jump').addEventListener('click', () => this.scrollToCurrent(true));
    this.dialog.addEventListener('close', () => this.stop());
    // Tippen neben das Sheet schließt es (wie in iPadOS)
    this.dialog.addEventListener('click', (e) => {
      if (e.target === this.dialog) this.dialog.close();
    });
  }

  async open() {
    this.renderedKey = '';
    this.render();
    this.dialog.showModal();
    requestAnimationFrame(() => this.scrollToCurrent(false));
    await this.refresh();
    this.scrollToCurrent(false);
    this.timer = setInterval(() => this.refresh(), 5000);
    this.tick = setInterval(() => this.live(), 500);
  }

  stop() {
    clearInterval(this.timer);
    clearInterval(this.tick);
  }

  async refresh() {
    try {
      this.run = await this.fetchRun();
      this.hint.hidden = true;
    } catch {
      this.hint.hidden = false;
      this.hint.textContent = 'Keine Verbindung zum Relay – Ist-Zeiten und Prognose fehlen.';
    }
    this.render();
  }

  currentId() {
    return this.getState()?.cue?.id ?? this.run?.currentId ?? null;
  }

  /** „bei 3:0 → weiter mit 142“ für Cues, nach denen ein Szenario springt. */
  jumpHints(rd) {
    const m = new Map();
    for (const g of rd.groups || []) {
      for (const o of g.options || []) {
        for (const j of o.jumps || []) {
          const list = m.get(j.after) || [];
          list.push(`${o.label} → ${j.to}`);
          m.set(j.after, list);
        }
      }
    }
    return m;
  }

  /** Status je Cue: past | current | next | skipped. */
  statuses(rd, cur, run) {
    const curIndex = rd.cues.findIndex((c) => c.id === cur);
    return rd.cues.map((c, i) => {
      const r = run.cues?.[c.id];
      if (c.id === cur) return 'current';
      if (r?.endAt != null || (r?.actualMs != null && r.startAt == null)) return 'past';
      if (run.eta?.[c.id] != null) return 'next';
      if (curIndex >= 0 && i < curIndex) return 'past';
      return this.run ? 'skipped' : 'next';
    });
  }

  /** Neu zeichnen, wenn sich Lauf, aktueller Cue, Filter oder Aufklappen geändert haben. */
  render() {
    const rd = this.getRundown();
    const tz = this.getState()?.timeZone || 'Europe/Berlin';
    const cur = this.currentId();
    if (!rd?.cues?.length) {
      this.list.innerHTML = '<div class="tl-empty">Noch kein Rundown geladen.</div>';
      this.nowCard.hidden = true;
      return;
    }
    // Läuft ein anderer Cue als in den Laufdaten, gleich nachladen.
    if (this.run && cur !== this.run.currentId && this.dialog.open && !this.pendingRefresh) {
      this.pendingRefresh = true;
      this.refresh().finally(() => (this.pendingRefresh = false));
    }
    const key = JSON.stringify([rd.id, rd.version ?? rd.cues.length, rd.cues.length, cur, this.run?.now ? Math.floor(this.run.now / 5000) : 0, this.filter, [...this.expanded], [...this.folded]]);
    if (key === this.renderedKey) return;
    this.renderedKey = key;

    const run = this.run || { cues: {}, eta: {} };
    const st = this.statuses(rd, cur, run);
    const jumps = this.jumpHints(rd);
    const t = (ms) => (ms == null ? '–' : formatTimeOfDay(ms, tz, true));
    const tShort = (ms) => (ms == null ? '–' : formatTimeOfDay(ms, tz, false));

    // Zeit, die in der Zeitleiste zählt: Ist-Start, sonst ETA, sonst Plan
    const when = (c, i) => {
      const r = run.cues?.[c.id];
      if (st[i] === 'next') return run.eta?.[c.id] ?? c.plannedStartAt;
      return r?.startAt ?? c.plannedStartAt;
    };

    const row = (c, i) => {
      const s = st[i];
      const r = run.cues?.[c.id];
      const w = when(c, i);
      const approx = s === 'next' && run.eta?.[c.id] != null ? '~' : '';
      const plan = c.plannedStartAt;
      const kind = c.kind && KINDS[c.kind] ? `<span class="k k-${esc(c.kind)}"><span class="k-long">${KINDS[c.kind]}</span><span class="k-short">${SHORT_KIND[c.kind] || ''}</span></span>` : '';
      const anchor = c.kind === 'anchor' && c.anchorAt != null ? `<span class="tl-anchor">bis ${tShort(c.anchorAt)}</span>` : '';
      const stretch = r?.stretchMs ? `<span class="tl-stretch">${formatSigned(r.stretchMs)}</span>` : '';
      const chips = Object.entries(c.columns || {})
        .map(([k, v]) => `<span class="tl-chip"><b>${esc(k)}</b> ${esc(String(v).replace(/\s*\n+\s*/g, ' · '))}</span>`)
        .join('');
      const jump = jumps.get(c.number) ? `<span class="tl-jump">bei ${jumps.get(c.number).map(esc).join(' · ')}</span>` : '';
      const sub = c.subtitle ? `<span class="tl-sub">${esc(c.subtitle)}</span>` : '';
      const heads = headsHtml(c.people, { max: 6, cls: 'sm' });
      let right = '';
      if (s === 'current') {
        right = `<span class="tl-live" data-start="${r?.startAt ?? ''}" data-eff="${c.durationMs + (r?.stretchMs || 0)}" data-open="${c.kind === 'open' ? 1 : 0}"></span><span class="tl-rl">${c.kind === 'open' ? 'läuft' : 'Rest'}</span>`;
      } else if (s === 'past' && r?.actualMs != null) {
        const d = r.deltaMs ?? 0;
        const cls = d > 999 ? 'over' : d < -999 ? 'under' : 'even';
        right = `<b>${formatDuration(r.actualMs)}</b><span class="tl-delta ${cls}">${Math.abs(d) < 1000 ? '±0:00' : formatSigned(d)}</span>`;
      } else if (s !== 'skipped') {
        right = `<b>${formatDuration(c.durationMs)}</b>`;
      }
      const details = [
        c.notes ? `<p class="tl-notes">${esc(c.notes)}</p>` : '',
        `<dl class="tl-facts">
          <dt>Plan</dt><dd>${t(plan)} · ${formatDuration(c.durationMs)}</dd>
          ${r?.startAt != null ? `<dt>Ist-Start</dt><dd>${t(r.startAt)}</dd>` : ''}
          ${r?.endAt != null ? `<dt>Ist-Ende</dt><dd>${t(r.endAt)}</dd>` : ''}
          ${r?.stretchMs ? `<dt>Streckung</dt><dd>${formatSigned(r.stretchMs)}</dd>` : ''}
          ${s === 'next' && run.eta?.[c.id] != null ? `<dt>Erwartet</dt><dd>${t(run.eta[c.id])}</dd>` : ''}
          ${c.people?.length ? `<dt>Personen</dt><dd class="tl-people">${peopleNamesHtml(c.people)}</dd>` : ''}
          ${c.block ? `<dt>Block</dt><dd>${esc(c.block)}</dd>` : ''}
        </dl>`,
      ].join('');
      const open = this.openRows.has(c.id);
      return `<div class="tl-row ${s}${open ? ' open' : ''}" data-id="${esc(c.id)}" role="button" tabindex="0" aria-expanded="${open}"${s === 'current' ? ' aria-current="true"' : ''}>
  <div class="tl-time"><b><span class="tl-long">${approx}${t(w)}</span><span class="tl-short">${approx}${tShort(w)}</span></b><span><span class="tl-long">Plan ${t(plan)}</span><span class="tl-short">${formatDuration(c.durationMs)}</span></span></div>
  <div class="tl-rail" style="${c.color ? `--cue:${esc(c.color)}` : ''}"><i></i></div>
  <div class="tl-body">
    <div class="tl-t1"><span class="tl-num">${esc(c.number ?? '')}</span>${c.emoji ? `<span class="tl-emoji">${esc(c.emoji)}</span>` : ''}<span class="tl-title">${esc(c.title)}</span>${s === 'current' ? '<span class="tl-now">JETZT</span>' : ''}${s === 'skipped' ? '<span class="tl-skip">entfällt</span>' : ''}</div>
    <div class="tl-t2">${kind}${heads}${anchor}${stretch}${jump}${sub}${chips}</div>
    <div class="tl-details">${details}</div>
  </div>
  <div class="tl-right">${right}</div>
</div>`;
    };

    const blockHead = (name, idxs) => {
      // Zeitraum und Gesamtdauer der Cues dieses Blocks (ohne entfallende)
      const live = idxs.filter((i) => st[i] !== 'skipped');
      const sum = live.reduce((a, i) => a + rd.cues[i].durationMs, 0);
      const first = live.length ? when(rd.cues[live[0]], live[0]) : null;
      const lastI = live[live.length - 1];
      const end = live.length && when(rd.cues[lastI], lastI) != null ? when(rd.cues[lastI], lastI) + rd.cues[lastI].durationMs : null;
      const approx = live.some((i) => st[i] === 'next') ? '~' : '';
      const range = live.length ? `${approx}${tShort(first)}–${tShort(end)} · ${formatDuration(sum)}` : 'entfällt';
      return { range, live: live.length };
    };

    // Blöcke vorab erfassen (für Köpfe und „Blöcke zu“)
    const blocks = new Map();
    rd.cues.forEach((c, i) => {
      const k = c.block || '';
      if (!blocks.has(k)) blocks.set(k, []);
      blocks.get(k).push(i);
    });

    const out = [];
    let lastBlock;
    this.blockNames = [...blocks.keys()].filter(Boolean);
    for (const k of this.folded) if (!blocks.has(k)) this.folded.delete(k);
    const isFolded = (c) => !!c.block && this.folded.has(c.block);
    // Block-Überschrift als Schalter: Tippen klappt alle Cues des Blocks ein/aus
    const headFor = (c) => {
      const k = c.block || '';
      if (k === lastBlock) return;
      lastBlock = k;
      if (!k) return;
      const idxs = blocks.get(k);
      const h = blockHead(k, idxs);
      const folded = this.folded.has(k);
      const hasNow = idxs.some((i) => st[i] === 'current');
      const count = folded ? ` · ${idxs.length} ${idxs.length === 1 ? 'Cue' : 'Cues'}` : '';
      out.push(
        `<button type="button" class="tl-block${folded ? ' folded' : ''}${hasNow ? ' has-now' : ''}" data-fold="${esc(k)}" aria-expanded="${!folded}"><span><svg class="tl-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 10l4 4 4-4" /></svg>${esc(k)}</span><em>${h.range}${count}</em></button>`,
      );
    };
    const pushRow = (c, i) => {
      if (!isFolded(c)) out.push(row(c, i));
    };

    if (this.filter === 'moderated' || this.filter === 'notes') {
      rd.cues.forEach((c, i) => {
        const ok = this.filter === 'moderated' ? c.kind === 'moderated' : !!c.notes;
        if (!ok) return;
        headFor(c);
        pushRow(c, i);
      });
      if (!out.length) out.push(`<div class="tl-empty">${this.filter === 'notes' ? 'Keine Cues mit Notizen.' : 'Keine moderierten Cues.'}</div>`);
    } else {
      // Alle / Ab jetzt: gelaufene und entfallende Läufe zusammenklappen
      let i = 0;
      while (i < rd.cues.length) {
        const s = st[i];
        if (s === 'past' || s === 'skipped') {
          let j = i;
          while (j + 1 < rd.cues.length && st[j + 1] === s) j++;
          const idxs = Array.from({ length: j - i + 1 }, (_, n) => i + n);
          if (s === 'past' && this.filter === 'ahead') {
            i = j + 1;
            continue;
          }
          const tk = s === 'past' ? 'past' : `skip:${i}`;
          const isOpen = this.expanded.has(tk);
          if (s === 'past') {
            const withData = idxs.map((n) => run.cues?.[rd.cues[n].id]).filter((r) => r?.deltaMs != null);
            const saldo = withData.reduce((a, r) => a + r.deltaMs, 0);
            const from = when(rd.cues[i], i);
            const to = when(rd.cues[j], j);
            const sal = withData.length ? ` <span class="tl-g-r">Saldo <b class="${saldo > 999 ? 'over' : saldo < -999 ? 'under' : ''}">${formatSigned(saldo)}</b></span>` : '';
            out.push(`<button type="button" class="tl-group" data-toggle="past" aria-expanded="${isOpen}"><span>${isOpen ? '▾' : '▸'} <b>${idxs.length} ${idxs.length === 1 ? 'Cue' : 'Cues'} gelaufen</b> · ${tShort(from)}–${tShort(to)}</span>${sal}</button>`);
          } else {
            const sum = idxs.reduce((a, n) => a + rd.cues[n].durationMs, 0);
            out.push(`<button type="button" class="tl-group skip" data-toggle="${tk}" aria-expanded="${isOpen}"><span>${isOpen ? '▾' : '▸'} <b>${idxs.length} ${idxs.length === 1 ? 'Cue entfällt' : 'Cues entfallen'}</b> laut Szenario-Wahl · ${rd.cues[i].number}–${rd.cues[j].number}</span><span class="tl-g-r">${formatDuration(sum)}</span></button>`);
          }
          lastBlock = undefined;
          if (isOpen) {
            idxs.forEach((n) => {
              headFor(rd.cues[n]);
              pushRow(rd.cues[n], n);
            });
            lastBlock = undefined;
          }
          i = j + 1;
          continue;
        }
        headFor(rd.cues[i]);
        pushRow(rd.cues[i], i);
        i++;
      }
    }
    this.list.innerHTML = out.join('');
    const allFolded = this.blockNames.length > 0 && this.blockNames.every((k) => this.folded.has(k));
    this.foldAllBtn.textContent = allFolded ? 'Alle Blöcke auf' : 'Alle Blöcke zu';
    this.foldAllBtn.setAttribute('aria-pressed', String(allFolded));
    this.foldAllBtn.hidden = !this.blockNames.length;

    // Kopfzeile und Jetzt-Karte
    const curIndex = rd.cues.findIndex((c) => c.id === cur);
    const done = st.filter((s) => s === 'past').length;
    const pos = curIndex >= 0 ? `Cue ${rd.cues[curIndex].number} · ` : '';
    this.info.textContent = `${rd.title || 'Rundown'} · ${pos}${done} von ${rd.cues.length} gelaufen`;
    const curCue = curIndex >= 0 ? rd.cues[curIndex] : null;
    this.nowCard.hidden = !curCue;
    if (curCue) {
      const nextIdx = st.findIndex((s, n) => s === 'next' && n !== curIndex && (run.eta?.[rd.cues[n].id] ?? Infinity) >= 0);
      const nx = nextIdx >= 0 ? rd.cues[nextIdx] : null;
      const r = run.cues?.[curCue.id];
      this.nowCard.innerHTML = `<span class="tl-live big" data-start="${r?.startAt ?? this.getState()?.cue?.startedAt ?? ''}" data-eff="${curCue.durationMs + (r?.stretchMs ?? this.getState()?.cue?.stretchMs ?? 0)}" data-open="${curCue.kind === 'open' ? 1 : 0}"></span>
<span class="rd-now-x"><b>${esc(curCue.number)} ${curCue.emoji ? esc(curCue.emoji) + ' ' : ''}${esc(curCue.title)}${headsHtml(curCue.people, { max: 6, cls: 'sm' })}</b><span>JETZT${nx ? ` · danach ${esc(nx.number)} ${nx.emoji ? esc(nx.emoji) + ' ' : ''}${esc(nx.title)}` : ''}</span></span>`;
    }
    // Block-Köpfe kleben unter der Jetzt-Karte
    this.scroll.style.setProperty('--now-h', this.nowCard.hidden ? '0px' : `${this.nowCard.offsetHeight + 14}px`);
    this.live();
  }

  /** Laufende Zeit (Restzeit bzw. Überzug; offene Cues zählen hoch) sekündlich aktualisieren. */
  live() {
    if (!this.dialog.open) return;
    this.render();
    this.dialog.querySelectorAll('.tl-live').forEach((el) => {
      const start = Number(el.dataset.start);
      if (!el.dataset.start || !Number.isFinite(start)) {
        el.textContent = '';
        return;
      }
      const elapsed = this.now() - start;
      if (el.dataset.open === '1') {
        el.className = el.className.replace(/\bover\b/, '').trim();
        el.textContent = formatClock(elapsed, true);
        return;
      }
      const left = Number(el.dataset.eff) - elapsed;
      el.classList.toggle('over', left < 0);
      el.textContent = left < 0 ? `+${formatClock(-left, true)}` : formatClock(left);
    });
  }

  scrollToCurrent(smooth) {
    const cur = this.currentId();
    const c = cur != null ? this.getRundown()?.cues?.find((x) => x.id === cur) : null;
    if (c?.block && this.folded.has(c.block)) {
      this.folded.delete(c.block);
      this.renderedKey = '';
      this.render();
    }
    const row = this.list.querySelector('.tl-row.current');
    if (!row) return;
    const offset = this.nowCard.hidden ? 0 : this.nowCard.offsetHeight;
    const top = row.offsetTop - offset - (this.scroll.clientHeight - offset) / 3;
    this.scroll.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' });
  }
}
