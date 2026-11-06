// Halten zum Bestätigen (SwiftUI: onLongPressGesture(minimumDuration:)).
// Ein Ring füllt sich um den Finger; früher loslassen bricht ab.

function ringEl() {
  return document.getElementById('hold-ring');
}

export function bindHold(el, onConfirm, ms = 600) {
  let timer = null;
  const finish = () => {
    ringEl()?.classList.remove('on');
    el.classList.remove('is-pressed');
  };
  const cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    finish();
  };
  const start = (x, y) => {
    if (el.disabled || timer) return;
    const ring = ringEl();
    if (ring) {
      ring.style.left = `${x}px`;
      ring.style.top = `${y}px`;
      ring.style.setProperty('--hold-ms', `${ms}ms`);
      ring.classList.remove('on');
      void ring.getBoundingClientRect();
      ring.classList.add('on');
    }
    el.classList.add('is-pressed');
    timer = setTimeout(() => {
      timer = null;
      finish();
      el.classList.add('confirmed');
      setTimeout(() => el.classList.remove('confirmed'), 450);
      onConfirm();
    }, ms);
  };
  el.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    e.preventDefault();
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* egal */
    }
    start(e.clientX, e.clientY);
  });
  el.addEventListener('pointerup', cancel);
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('lostpointercapture', cancel);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  el.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      start(r.left + r.width / 2, r.top + r.height / 2);
    }
  });
  el.addEventListener('keyup', (e) => {
    if (e.key === 'Enter' || e.key === ' ') cancel();
  });
  el.addEventListener('click', (e) => e.preventDefault());
}

/** Tippen mit Schutz gegen Doppelauslösung. */
export function bindTap(el, fn) {
  let last = 0;
  el.addEventListener('click', (e) => {
    const t = performance.now();
    if (t - last < 350) return;
    last = t;
    fn(e);
  });
}
