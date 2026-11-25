/** Line icons drawn for this editor on a 20px grid, stroked in the current colour. */
const PATHS = {
  grid: 'M3 3h14v14H3zM8 3v14M12 3v14M3 8h14M3 12h14',
  select: 'M5 3.5l10 6.2-4.4 1.1 2.6 4.6-1.9 1.1-2.6-4.6L5 14.6z',
  crop: 'M6 2.5V14h11.5M2.5 6H14v11.5',
  arrow: 'M4 16L15.5 4.5M8.5 4.5h7v7',
  box: 'M3.5 5.5a2 2 0 012-2h9a2 2 0 012 2v9a2 2 0 01-2 2h-9a2 2 0 01-2-2z',
  text: 'M4 5V3.5h12V5M10 3.5v13M7.5 16.5h5',
  step: 'M10 17a7 7 0 100-14 7 7 0 000 14zM8.6 7.2l1.9-1.1v8',
  redact: 'M3 6.5h14v7H3z M5.5 9h2M5.5 11h5',
  undo: 'M7.5 4.5L4 8l3.5 3.5M4.5 8h7a4.5 4.5 0 010 9H9',
  redo: 'M12.5 4.5L16 8l-3.5 3.5M15.5 8h-7a4.5 4.5 0 000 9H11',
  open: 'M3 15.5v-11h5l1.5 2H17v9z',
  copy: 'M7 7h9.5v9.5H7zM13 7V3.5H3.5V13H7',
  export: 'M10 3v9.5M6 8.5l4 4 4-4M3.5 13.5v3h13v-3',
  minus: 'M5 10h10',
  plus: 'M5 10h10M10 5v10',
  up: 'M10 15.5v-11M5.5 9L10 4.5 14.5 9',
  down: 'M10 4.5v11M5.5 11l4.5 4.5 4.5-4.5',
  duplicate: 'M7 7h9.5v9.5H7zM13 7V3.5H3.5V13H7',
  trash: 'M3.5 5.5h13M8 5.5V3.5h4v2M5.5 5.5l.8 11h7.4l.8-11',
  image: 'M3 4.5h14v11H3zM3 13l4-4 3.5 3.5L13 10l4 3.5M13.2 7.4h.01',
  swap: 'M4 7h11M12 4l3 3-3 3M16 13H5M8 10l-3 3 3 3',
  save: 'M5 3.5h10v13l-5-3.6-5 3.6z',
  close: 'M5 5l10 10M15 5L5 15',
} as const;
export type IconName = keyof typeof PATHS;

export function icon(name: IconName, size = 20): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'ss-icon');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', PATHS[name]);
  svg.append(path);
  return svg;
}
