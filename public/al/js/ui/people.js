// Schematische Köpfe für die Personen eines Cues (aus der GFX-Spalte):
// Moderation farbig, Gäste hellgrau. Name(n) im Tooltip und für VoiceOver.

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const HEAD = '<circle cx="10" cy="6.3" r="4.6"/><path d="M1.4 22c0-5.4 3.9-8.9 8.6-8.9s8.6 3.5 8.6 8.9z"/>';

/** „Moderation: Anna, Ben · Gäste: Carla“ */
export function peopleLabel(people) {
  if (!people?.length) return '';
  const hosts = people.filter((p) => p.role === 'host').map((p) => p.name);
  const guests = people.filter((p) => p.role !== 'host').map((p) => p.name);
  return [hosts.length ? `Moderation: ${hosts.join(', ')}` : '', guests.length ? `${guests.length === 1 ? 'Gast' : 'Gäste'}: ${guests.join(', ')}` : '']
    .filter(Boolean)
    .join(' · ');
}

/**
 * Köpfe als HTML.
 * @param {Array<{name:string, role:string}>} people
 * @param {{max?: number, cls?: string}} [o]
 */
export function headsHtml(people, o = {}) {
  if (!people?.length) return '';
  const max = o.max ?? 6;
  const shown = people.slice(0, max);
  const more = people.length - shown.length;
  const label = peopleLabel(people);
  return `<span class="heads${o.cls ? ' ' + o.cls : ''}" role="img" title="${esc(label)}" aria-label="${esc(`${people.length} ${people.length === 1 ? 'Person' : 'Personen'} – ${label}`)}">${shown
    .map((p) => `<svg class="head ${p.role === 'host' ? 'host' : 'guest'}" viewBox="0 0 20 22" aria-hidden="true">${HEAD}</svg>`)
    .join('')}${more > 0 ? `<span class="heads-more">+${more}</span>` : ''}</span>`;
}

/** Namensliste mit Farbpunkt (für Details). */
export function peopleNamesHtml(people) {
  if (!people?.length) return '';
  return people.map((p) => `<span class="pp ${p.role === 'host' ? 'host' : 'guest'}">${esc(p.name)}</span>`).join('');
}
