// The reader: the kit's mark in the popup strip and the bar on every tool page. Styles live in static/tokens.css
// (.xck-rd, .xck-utc), which every extension page loads.
const SVG = 'http://www.w3.org/2000/svg';
const ARM = 'M34 0H11Q0 0 0 11V95Q0 106 11 106H34V91H15V15H34Z';

function arm(right: boolean) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', right ? 'xck-arm xck-arm-r' : 'xck-arm');
  svg.setAttribute('viewBox', '0 0 34 106');
  svg.setAttribute('preserveAspectRatio', 'none');
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', ARM);
  svg.append(path);
  return svg;
}

/** Two bracket arms and two square eyes. Decorative, so it is hidden from assistive technology. */
export function reader() {
  const mark = document.createElement('span');
  mark.className = 'xck-rd';
  mark.setAttribute('aria-hidden', 'true');
  const eye = () => { const e = document.createElement('i'); e.className = 'xck-eye'; return e; };
  mark.append(arm(false), eye(), eye(), arm(true));
  return mark;
}

const two = (n: number) => String(n).padStart(2, '0');
/** "UTC 02:38" from the clock of this browser. Every time the kit shows is UTC (product rule 4). */
export const utcNow = (now = new Date()) => `UTC ${two(now.getUTCHours())}:${two(now.getUTCMinutes())}`;

/**
 * A UTC clock for the bar. It reads only the local clock, repaints when the minute changes, and stops
 * ticking while the page is hidden.
 */
export function utcReadout() {
  const text = document.createElement('span');
  const clock = document.createElement('p');
  clock.className = 'xck-utc';
  clock.title = 'Current time in UTC. X counts analytics by UTC day.';
  const led = document.createElement('i');
  led.setAttribute('aria-hidden', 'true');
  clock.append(led, text);
  const paint = () => { const next = utcNow(); if (text.textContent !== next) text.textContent = next; };
  let timer = 0;
  const run = () => {
    clearInterval(timer);
    paint();
    if (!document.hidden) timer = window.setInterval(paint, 1000);
  };
  document.addEventListener('visibilitychange', run);
  run();
  return clock;
}
