type Child = Node | string | null | undefined | false;

/** Tiny element builder. Strings always become text nodes, never HTML. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | ((e: Event) => void)> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === 'function') e.addEventListener(k.replace(/^on/, ''), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false) e.setAttribute(k, v);
  }
  for (const c of children) if (c) e.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return e;
}

export function download(filename: string, data: Blob | string, type = 'application/octet-stream') {
  const blob = typeof data === 'string' ? new Blob([data], { type }) : data;
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const disclosures = new Map<string, boolean>();

/**
 * A native disclosure whose open state survives the page re-rendering itself. `summary` is the
 * visible name; `note` is a short mono line beside it saying what is inside.
 */
export function disclosure(id: string, summary: string, note: string | null, children: Child[], openByDefault = false) {
  const open = disclosures.get(id) ?? openByDefault;
  const d = h('details', { id, class: 'disclosure', ...(open ? { open: true } : {}) },
    h('summary', { 'data-key': `summary:${id}` }, h('span', { class: 'disclosure-text' }, h('span', { class: 'disclosure-name' }, summary), note ? h('span', { class: 'disclosure-note' }, note) : null)),
    h('div', { class: 'disclosure-body' }, ...children));
  d.addEventListener('toggle', () => disclosures.set(id, d.open));
  return d;
}

/** Re-render without losing keyboard focus or open disclosures: the control with the same data-key gets focus back. */
export function keepFocus(root: HTMLElement, rerender: () => void) {
  const key = (document.activeElement as HTMLElement | null)?.dataset?.key;
  // The toggle event is async, so read the live state too before the old elements go.
  root.querySelectorAll<HTMLDetailsElement>('details.disclosure[id]').forEach((d) => disclosures.set(d.id, d.open));
  rerender();
  if (key) root.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
}
