/* ============================================================
   animations.js — Anime.js Animation Utilities
   ============================================================ */

const Anims = {
  _reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,

  _disabled() { return this._reducedMotion || typeof anime === 'undefined'; },

  staggerFadeIn(selector, opts) {
    if (this._disabled()) return;
    const els = typeof selector === 'string' ? document.querySelectorAll(selector) : selector;
    if (!els || !els.length) return;
    anime({
      targets: els,
      opacity: [0, 1],
      translateY: [opts?.from || 8, 0],
      duration: opts?.duration || 250,
      delay: anime.stagger(opts?.stagger || 30),
      easing: opts?.easing || 'easeOutCubic',
    });
  },

  slideStep(outEl, inEl, direction, onDone) {
    if (this._disabled()) {
      if (outEl) outEl.classList.add('d-none');
      if (inEl) inEl.classList.remove('d-none');
      if (onDone) onDone();
      return;
    }
    const xOut = direction === 'next' ? -20 : 20;
    const xIn = direction === 'next' ? 20 : -20;

    const tl = anime.timeline({ easing: 'easeOutCubic' });
    if (outEl) {
      tl.add({ targets: outEl, opacity: [1, 0], translateX: [0, xOut], duration: 180, complete: () => outEl.classList.add('d-none') });
    }
    if (inEl) {
      inEl.classList.remove('d-none');
      inEl.style.opacity = '0';
      tl.add({ targets: inEl, opacity: [0, 1], translateX: [xIn, 0], duration: 220, complete: () => { if (inEl) inEl.style.opacity = ''; if (onDone) onDone(); } }, outEl ? '-=60' : 0);
    }
  },

  pulseIcon(el) {
    if (this._disabled() || !el) return;
    anime({ targets: el, scale: [1, 1.25, 1], duration: 300, easing: 'easeOutCubic' });
  },

  shakeElement(el) {
    if (this._disabled() || !el) return;
    anime({ targets: el, translateX: [0, -6, 6, -4, 4, -2, 2, 0], duration: 400, easing: 'easeOutCubic' });
  },

  scaleClick(el) {
    if (this._disabled() || !el) return;
    anime({ targets: el, scale: [1, 0.96, 1], duration: 150, easing: 'easeOutCubic' });
  },

  progressBounce(el) {
    if (this._disabled() || !el) return;
    anime({ targets: el, scale: [1, 1.08, 1], duration: 350, easing: 'easeOutElastic(1, .6)' });
  },

  chevronRotate(el, isOpen) {
    if (this._disabled() || !el) return;
    anime({ targets: el, rotateZ: isOpen ? 180 : 0, duration: 250, easing: 'easeOutCubic' });
  },

  iconSpin(el) {
    if (this._disabled() || !el) return;
    anime({ targets: el, rotateZ: 360, duration: 400, easing: 'easeOutCubic' });
  },

  skeletonReveal(selector) {
    if (this._disabled()) return;
    const els = typeof selector === 'string' ? document.querySelectorAll(selector) : selector;
    if (!els || !els.length) return;
    anime({
      targets: els,
      opacity: [0, 1],
      translateY: [6, 0],
      duration: 200,
      delay: anime.stagger(50),
      easing: 'easeOutCubic',
    });
  },

  toastEnter(el) {
    if (this._disabled() || !el) return;
    anime({ targets: el, translateX: [40, 0], opacity: [0, 1], duration: 250, easing: 'easeOutCubic' });
  },
};

window.Anims = Anims;
