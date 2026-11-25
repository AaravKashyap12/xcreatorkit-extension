import { h } from './dom';
import css from './navigation.css';
import { reader, utcReadout } from './reader';

/** Every destination, in three groups: what the kit keeps, what it makes, and what it does on X itself. */
export const TOOLS = [
  { name: 'Analytics', href: 'analytics.html', description: 'Growth over time', group: 'Numbers' },
  { name: 'Ledger', href: 'report.html', description: 'Numbers in one report', group: 'Numbers' },
  { name: 'Rewards pace', href: 'dashboard.html', description: 'Verified impressions', group: 'Numbers' },
  { name: 'Receipts', href: 'receipt.html', description: 'Day, week or month', group: 'Make' },
  { name: 'Post to image', href: 'postcard.html', description: 'A post as an image', group: 'Make' },
  { name: 'Screenshot editor', href: 'screenshot.html', description: 'Frame a screenshot', group: 'Make' },
  { name: 'Following settings', href: 'launcher.html#following', description: 'Follow-back highlighting', group: 'On X' },
] as const;

/** Must match the `@media (max-width:860px)` block in navigation.css. */
const NARROW = '(max-width: 860px)';

/** The file a route points at. `launcher.html#following` and `launcher.html` are the same page. */
export const pageOf = (href: string) => href.split(/[?#]/)[0]!.split('/').pop() ?? '';

/**
 * One ink bar for every full-page tool. Wide: the routes sit in the bar in their three groups and
 * the current one is a paper chip. Narrow (860px and under): a button naming the current tool opens the same links in
 * flow below the bar, so nothing is covered and nothing scrolls sideways.
 */
export function mountNavigation() {
  document.head.append(h('style', {}, css));
  const page = pageOf(location.pathname);
  const current = TOOLS.find(tool => pageOf(tool.href) === page);
  const links = h('nav', { class: 'xck-nav', id: 'xck-nav', 'aria-label': 'Kit tools' },
    h('ul', { class: 'xck-links' }, ...TOOLS.map((tool, i) => h('li', {
      ...(tool === current ? { class: 'xck-current' } : {}),
      // The first route of each group names it: a hairline in the bar, a label in the compact menu.
      ...(tool.group !== TOOLS[i - 1]?.group ? { 'data-group': tool.group } : {}),
    }, h('a', {
      href: tool.href, ...(tool === current ? { 'aria-current': 'page' } : {}),
      ...(tool.href.includes('#') ? { class: 'xck-settings' } : {}),
    }, tool.name)))));
  // The name starts with the visible text (the current tool), then says what the button opens.
  const toggle = h('button', { type: 'button', class: 'xck-menu-toggle', 'aria-expanded': 'false', 'aria-controls': 'xck-nav', 'aria-label': `${current?.name ?? 'Tools'}, tools menu` },
    h('span', {}, current?.name ?? 'Tools'), h('span', { class: 'xck-chevron', 'aria-hidden': 'true' }));
  const shell = h('header', { class: 'xck-shell' },
    h('span', { class: 'xck-wordmark' }, reader(), 'X Creator Kit'),
    toggle, links,
    h('div', { class: 'xck-shell-end' }, h('p', { class: 'xck-trust' }, 'Stored in this browser · Dates in UTC'), utcReadout()),
  );
  const setOpen = (open: boolean) => {
    toggle.setAttribute('aria-expanded', String(open));
    shell.classList.toggle('xck-open', open);
  };
  toggle.addEventListener('click', () => setOpen(toggle.getAttribute('aria-expanded') !== 'true'));
  shell.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || toggle.getAttribute('aria-expanded') !== 'true') return;
    setOpen(false);
    toggle.focus();
  });
  document.addEventListener('click', (event) => {
    if (!shell.contains(event.target as Node)) setOpen(false);
  });
  // Crossing the breakpoint (keep in step with navigation.css) always starts closed. If that hides
  // the link that had focus, focus moves to the menu button instead of an invisible element.
  // Chrome may already have dropped focus to <body> by the time the media query reports, so remember
  // where focus last was.
  let lastFocus: EventTarget | null = null;
  document.addEventListener('focusin', (event) => { lastFocus = event.target; });
  const narrow = matchMedia(NARROW);
  narrow.addEventListener('change', () => {
    setOpen(false);
    const active = document.activeElement;
    const lost = !active || active === document.body;
    if (narrow.matches && (links.contains(active) || (lost && links.contains(lastFocus as Node | null)))) toggle.focus();
  });
  document.body.prepend(shell);
}
