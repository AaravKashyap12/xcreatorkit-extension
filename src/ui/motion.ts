import { gsap } from 'gsap';

/** Transient feedback only. The DOM always holds the current, interactive state. */
export function feedbackMotion() {
  const active = new Map<HTMLElement, gsap.core.Tween>();
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  function stop(target: HTMLElement) {
    const tween = active.get(target);
    if (!tween) return;
    active.delete(target);
    tween.revert();
  }
  const clear = () => active.forEach((_tween, target) => stop(target));
  const visibility = () => {
    document.documentElement.toggleAttribute('data-motion-hidden', document.hidden);
    if (document.hidden) clear();
  };
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('pagehide', clear);
  visibility();
  gsap.matchMedia().add('(prefers-reduced-motion: no-preference)', () => clear);

  function play(target: HTMLElement, from: gsap.TweenVars, to: gsap.TweenVars, duration = .18, ease = 'power2.out') {
    stop(target);
    if (reduced.matches || document.hidden || !target.getClientRects().length) return;
    const tween = gsap.fromTo(target, from, {
      ...to, duration, ease, onComplete: () => {
        if (active.get(target) === tween) stop(target);
      },
    });
    active.set(target, tween);
  }
  const lift = (target: HTMLElement, y = 4) => play(target, { y, opacity: .83 }, { y: 0, opacity: 1 });
  return { play, lift, stop, clear };
}
