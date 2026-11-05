// Display wach halten (Screen Wake Lock API).
// In Safari ab iPadOS 16.4, als Homescreen-App ab iPadOS 18.4. Braucht HTTPS.

export function initWakeLock(onStatus = () => {}) {
  let sentinel = null;
  let status = 'unbekannt';
  const set = (s) => {
    status = s;
    onStatus(s);
  };
  async function request() {
    if (!('wakeLock' in navigator)) return set(window.isSecureContext ? 'nicht unterstützt' : 'braucht HTTPS');
    if (document.visibilityState !== 'visible') return;
    if (sentinel && !sentinel.released) return;
    try {
      sentinel = await navigator.wakeLock.request('screen');
      set('aktiv');
      sentinel.addEventListener('release', () => set('freigegeben'));
    } catch {
      set('blockiert – Automatische Sperre „Nie“');
    }
  }
  document.addEventListener('visibilitychange', request);
  document.addEventListener('pointerdown', request, { passive: true });
  request();
  return { get status() { return status; } };
}
