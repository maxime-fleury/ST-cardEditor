/* ============================================================
   animations.js — Anime.js Animation Utilities
   ============================================================ */

const Anims = {
  // Read live so a runtime change to the OS reduced-motion preference is
  // honored without a reload.
  get _reducedMotion() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  },

  _disabled() { return this._reducedMotion || typeof anime === 'undefined'; },

  staggerFadeIn(selector, opts) {
    if (this._disabled()) return;
    // Accept a single Element OR a collection — a bare <div> has no .length,
    // which made the old guard silently pass and drop the whole animation (#62).
    let els = typeof selector === 'string' ? document.querySelectorAll(selector) : selector;
    if (els && typeof els.length !== 'number') els = [els];
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

  _slideToken: 0,
  _activeTimeline: null,

  slideStep(outEl, inEl, direction, onDone) {
    // Stop any in-flight transition so rapid calls can't race on the same
    // elements, leaving them stuck at an intermediate opacity/transform.
    if (this._activeTimeline) {
      this._activeTimeline.pause();
      this._activeTimeline = null;
    }
    // A paused timeline never fires its `complete` callbacks, which means the
    // previous step's outgoing element was never hidden (#70). Do it here so a
    // rapid Next→Next doesn't leave step 1 and step 3 on screen together.
    if (this._pendingOutEl && this._pendingOutEl !== inEl && !this._pendingOutEl.classList.contains('d-none')) {
      this._pendingOutEl.classList.add('d-none');
      this._pendingOutEl.style.opacity = '';
      this._pendingOutEl.style.transform = '';
    }
    this._pendingOutEl = outEl;
    const token = ++this._slideToken;
    // Reset lingering inline styles from a previous interrupted run so the new
    // animation walks from a clean state.
    if (outEl) { outEl.style.opacity = ''; outEl.style.transform = ''; }
    if (inEl) { inEl.style.opacity = ''; inEl.style.transform = ''; }

    if (this._disabled()) {
      if (outEl) outEl.classList.add('d-none');
      if (inEl) inEl.classList.remove('d-none');
      this._pendingOutEl = null;
      if (onDone) onDone();
      return;
    }
    const xOut = direction === 'next' ? -20 : 20;
    const xIn = direction === 'next' ? 20 : -20;

    const tl = anime.timeline({ easing: 'easeOutCubic' });
    this._activeTimeline = tl;
    const finish = () => {
      // A superseded animation must not run the new step's completion logic:
      // only the owner of the latest token finalizes (#96).
      if (token !== this._slideToken) return;
      if (this._activeTimeline === tl) this._activeTimeline = null;
      if (onDone) onDone();
    };
    if (outEl) {
      tl.add({ targets: outEl, opacity: [1, 0], translateX: [0, xOut], duration: 180, complete: () => {
        if (token === this._slideToken) outEl.classList.add('d-none');
        // If there is no incoming element, this animation is the last step and
        // must finalize bookkeeping and notify the caller.
        if (!inEl) { finish(); }
      } });
    }
    if (inEl) {
      inEl.classList.remove('d-none');
      inEl.style.opacity = '0';
      tl.add({ targets: inEl, opacity: [0, 1], translateX: [xIn, 0], duration: 220, complete: () => {
        if (inEl) inEl.style.opacity = '';
        if (this._pendingOutEl === outEl) this._pendingOutEl = null;
        finish();
      } }, outEl ? '-=60' : 0);
    } else if (!outEl) {
      // Nothing to animate; finalize immediately so callers and bookkeeping
      // complete even when both elements are missing.
      finish();
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
    let els = typeof selector === 'string' ? document.querySelectorAll(selector) : selector;
    if (els && typeof els.length !== 'number') els = [els];
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

export { Anims };
if (typeof window !== 'undefined') window.Anims = Anims;
