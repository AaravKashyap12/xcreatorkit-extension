import { h } from './dom';
import type { feedbackMotion } from './motion';

export const TOUR_KEY = 'xck:quick-tour-pending';

/** One inline card follows the controls it describes. It never clicks them or takes focus on install. */
export function mountWalkthrough(tools: HTMLElement, replay: HTMLButtonElement, motion: ReturnType<typeof feedbackMotion>) {
  const steps = [
    { anchor: '#capture', after: '#capture-status', title: 'Save your X numbers', tip: 'Open X Analytics, Rewards or your profile, then choose Read current X tab.' },
    { anchor: 'a[href="analytics.html"]', title: 'See your growth', tip: 'Open Analytics for trends or Receipts for a shareable image.' },
    { anchor: 'a[href="reply.html"]', title: 'Draft beside X', tip: 'Paste a post in Reply drafter. Edit and copy your reply from the side panel.' },
  ];
  const count = h('p', { id: 'tour-count' });
  const title = h('h2', { id: 'tour-title', tabindex: '-1', 'aria-describedby': 'tour-count tour-tip' });
  const tip = h('p', { id: 'tour-tip' });
  const skip = h('button', { type: 'button' }, 'Skip tour');
  const back = h('button', { type: 'button' }, 'Back');
  const next = h('button', { type: 'button', class: 'tour-next' }, 'Next');
  const card = h('section', { id: 'quick-tour', 'aria-labelledby': 'tour-title', hidden: true }, count, title, tip,
    h('div', { class: 'tour-actions' }, skip, back, next));
  tools.append(card);
  let index = 0;
  let anchor: HTMLElement | null = null;
  let mode: 'install' | 'replay' | null = null;
  let pending = false;
  let storageChanged = false;

  function render(focus: boolean) {
    motion.stop(card);
    anchor?.removeAttribute('data-tour-anchor');
    const step = steps[index]!;
    anchor = tools.querySelector<HTMLElement>(step.anchor)!;
    anchor.setAttribute('data-tour-anchor', '');
    const after = step.after ? tools.querySelector(step.after)! : anchor;
    after.after(card);
    count.textContent = `Quick tour · ${index + 1} of ${steps.length}`;
    title.textContent = step.title;
    tip.textContent = step.tip;
    back.hidden = index === 0;
    next.textContent = index === steps.length - 1 ? 'Done' : 'Next';
    card.hidden = false;
    replay.setAttribute('aria-expanded', 'true');
    if (focus) {
      card.scrollIntoView({ block: 'nearest' });
      title.focus({ preventScroll: true });
    }
    motion.lift(card, 3);
  }
  function close(focus: boolean) {
    mode = null;
    motion.stop(card);
    card.hidden = true;
    anchor?.removeAttribute('data-tour-anchor');
    replay.setAttribute('aria-expanded', 'false');
    if (focus) replay.focus();
  }
  function finish() {
    close(true);
    if (pending) {
      pending = false;
      void chrome.storage.local.remove(TOUR_KEY).catch(() => {});
    }
  }
  function setPending(value: unknown) {
    pending = value === 1;
    if (pending && !mode) { mode = 'install'; index = 0; render(false); }
    if (!pending && mode === 'install') close(card.contains(document.activeElement));
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[TOUR_KEY]) return;
    storageChanged = true;
    setPending(changes[TOUR_KEY].newValue);
  });
  const initial = chrome.storage.local.get(TOUR_KEY).then(saved => {
    if (!storageChanged) setPending(saved[TOUR_KEY]);
  }).catch(() => {}).finally(() => { replay.hidden = false; });
  replay.addEventListener('click', () => {
    if (mode) { title.focus(); return; }
    mode = 'replay';
    index = 0;
    render(true);
  });
  next.addEventListener('click', () => { if (index === steps.length - 1) finish(); else { ++index; render(true); } });
  back.addEventListener('click', () => { --index; render(true); });
  skip.addEventListener('click', finish);
  tools.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !mode) return;
    event.preventDefault();
    finish();
  });
  return initial;
}
