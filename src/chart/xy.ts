// Small dependency-free SVG chart renderer. All text goes through textContent.

const NS = 'http://www.w3.org/2000/svg';

export interface Category {
  label: string;
  partial?: boolean; // drawn lighter / hatched and noted in the tooltip
  title?: string; // tooltip and readout heading (defaults to label)
  missing?: boolean; // the period was not captured: a dashed mark on the baseline, never a zero bar
  note?: string; // readout qualifier, e.g. "in progress" or "5 of 7 days captured"
  missingText?: string; // readout wording for a missing period (default "not captured")
}

export interface Series {
  name: string;
  /** Any CSS colour, including var(--xck-…); applied as a style so custom properties resolve. */
  color: string;
  type: 'bar' | 'line';
  values: (number | null)[]; // null = no data (gap), 0 = real zero
  stack?: string; // bars sharing a stack id are stacked
  axis?: 'left' | 'right';
  dashed?: boolean; // only for derived reference lines (e.g. rolling average), labelled in legend
  format?: (v: number) => string;
  /** Opt-in light look. Bars: this pale body with `color` as the outline. Lines with `area`: the shading colour (default `color`). */
  fill?: string;
  /** Opt-in for line series: pale shading down to zero under each settled run. In-progress points join with a dashed
   *  segment and no shading; gaps stay gaps. Per-point markers appear only for lone and in-progress readings, and for
   *  the period the readout is on. */
  area?: boolean;
  /** false: a plain line keeps markers only for lone readings (for a quiet reference line). Default true. */
  markers?: boolean;
}

export interface ChartOpts {
  width?: number;
  height?: number;
  yFormat?: (v: number) => string;
  y2Format?: (v: number) => string;
  ariaLabel: string;
  refLine?: { value: number; label: string }; // horizontal reference on left axis
  zeroBaseline?: boolean; // include 0 even for line charts (default true)
  readoutStart?: number; // index the readout starts on (default: the latest complete period with a value)
}

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, text?: string) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  // Presentation attributes cannot read CSS custom properties; mirror colours into style so tokens apply.
  const paint = ['fill', 'stroke', 'stop-color'].filter((k) => typeof attrs[k] === 'string' && /var\(|color-mix\(/.test(String(attrs[k]))).map((k) => `${k}:${attrs[k]}`);
  if (paint.length) e.setAttribute('style', paint.join(';'));
  if (text != null) e.textContent = text;
  return e;
}

export function compact(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e6) return (v / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (a >= 1e3) return (v / 1e3).toFixed(a >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'K';
  if (a > 0 && a < 1) return String(Number(v.toPrecision(2)));
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function extent(series: Series[], axis: 'left' | 'right', ref?: number): [number, number] {
  let lo = 0;
  let hi = ref ?? 0;
  const stacks = new Map<string, { pos: number[]; neg: number[] }>();
  for (const s of series.filter((x) => (x.axis ?? 'left') === axis)) {
    if (s.type === 'bar' && s.stack) {
      const st = stacks.get(s.stack) ?? stacks.set(s.stack, { pos: [], neg: [] }).get(s.stack)!;
      s.values.forEach((v, i) => {
        if (v == null) return;
        if (v >= 0) st.pos[i] = (st.pos[i] ?? 0) + v;
        else st.neg[i] = (st.neg[i] ?? 0) + v;
      });
    } else
      for (const v of s.values) {
        if (v == null) continue;
        hi = Math.max(hi, v);
        lo = Math.min(lo, v);
      }
  }
  for (const st of stacks.values()) {
    for (const v of st.pos) if (v != null) hi = Math.max(hi, v);
    for (const v of st.neg) if (v != null) lo = Math.min(lo, v);
  }
  return [lo < 0 ? -niceMax(-lo) : 0, niceMax(hi)];
}

/** Keep mixed-sign axes on readable steps with a labelled zero. Positive-only plots keep their scale. */
function axisTicks(lo: number, hi: number): number[] {
  if (lo >= 0) return Array.from({ length: 5 }, (_, i) => lo + (hi - lo) * i / 4);
  const raw = (hi - lo) / 5;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].find(m => m * power >= raw)! * power;
  const first = Math.floor(lo / step), last = Math.ceil(hi / step);
  return Array.from({ length: last - first + 1 }, (_, i) => Number(((first + i) * step).toPrecision(12)));
}

export function xyChart(categories: Category[], series: Series[], opts: ChartOpts): SVGSVGElement {
  const W = opts.width ?? 720;
  const H = opts.height ?? 260;
  const hasRight = series.some((s) => s.axis === 'right');
  const M = { l: 48, r: hasRight ? 48 : 16, t: 12, b: 28 };
  const pw = W - M.l - M.r;
  const ph = H - M.t - M.b;
  const n = Math.max(1, categories.length);
  const band = pw / n;
  const ticks = axisTicks(...extent(series, 'left', opts.refLine?.value));
  const ticks2 = axisTicks(...extent(series, 'right'));
  const [lo, hi] = [ticks[0]!, ticks.at(-1)!];
  const [lo2, hi2] = [ticks2[0]!, ticks2.at(-1)!];
  const sy = (v: number) => M.t + ph - ((v - lo) / (hi - lo || 1)) * ph;
  const sy2 = (v: number) => M.t + ph - ((v - lo2) / (hi2 - lo2 || 1)) * ph;
  const cx = (i: number) => M.l + band * i + band / 2;
  const fmt = opts.yFormat ?? compact;
  const fmt2 = opts.y2Format ?? compact;

  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': opts.ariaLabel, 'data-plot': `${M.l} ${M.t} ${pw} ${ph} ${n}` });
  const defs = el('defs', {});
  const pat = el('pattern', { id: 'partial-hatch', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
  pat.append(el('rect', { width: 6, height: 6, fill: 'var(--xck-surface, #fff)', opacity: 0.55 }), el('line', { x1: 0, y1: 0, x2: 0, y2: 6, stroke: 'var(--xck-surface, #fff)', 'stroke-width': 3 }));
  defs.append(pat);
  svg.append(defs);

  for (const v of ticks) {
    svg.append(el('line', { x1: M.l, x2: W - M.r, y1: sy(v), y2: sy(v), class: v === 0 ? 'zero' : 'grid' }));
    svg.append(el('text', { x: M.l - 6, y: sy(v) + 4, 'text-anchor': 'end', class: 'axis' }, fmt(v)));
  }
  if (hasRight) {
    for (const v2 of ticks2) {
      svg.append(el('text', { x: W - M.r + 6, y: sy2(v2) + 4, class: 'axis' }, fmt2(v2)));
    }
  }
  if (opts.refLine) {
    svg.append(el('line', { x1: M.l, x2: W - M.r, y1: sy(opts.refLine.value), y2: sy(opts.refLine.value), class: 'ref' }));
  }

  // X labels: thin out to ~10, fewer when the plot is narrow (about one label per 64px).
  const step = Math.max(1, Math.ceil(n / Math.max(2, Math.min(10, Math.floor(pw / 64)))));
  categories.forEach((c, i) => {
    if (i % step === 0 || i === n - 1) {
      // Labels near the right edge end there instead of being cut off.
      const edge = cx(i) > W - 30;
      if (i === n - 1 || n - 1 - i >= step / 2) svg.append(el('text', { x: edge ? W - 2 : cx(i), y: H - 8, 'text-anchor': edge ? 'end' : 'middle', class: 'axis' }, c.label));
    }
  });

  // The readout's highlighted column sits behind the marks.
  svg.append(el('g', { class: 'band-layer' }));
  // A period that was not captured: a short dashed mark on the baseline, so the gap reads as a gap.
  categories.forEach((c, i) => {
    if (c.missing) svg.append(el('line', { x1: cx(i) - Math.min(8, band * 0.32), x2: cx(i) + Math.min(8, band * 0.32), y1: sy(Math.max(0, lo)) - 2, y2: sy(Math.max(0, lo)) - 2, class: 'missing-mark' }));
  });

  // Bars: group by stack id (unstacked bars get their own slot).
  const bars = series.filter((s) => s.type === 'bar');
  const slots = [...new Set(bars.map((s, i) => s.stack ?? `__${i}`))];
  const slotW = Math.max(1, (band * 0.72) / Math.max(1, slots.length));
  const pos = new Map<string, number[]>();
  const neg = new Map<string, number[]>();
  bars.forEach((s, si) => {
    const slot = s.stack ?? `__${si}`;
    const k = slots.indexOf(slot);
    const ys = s.axis === 'right' ? sy2 : sy;
    s.values.forEach((v, i) => {
      if (v == null) return;
      const p = pos.get(slot) ?? pos.set(slot, []).get(slot)!;
      const q = neg.get(slot) ?? neg.set(slot, []).get(slot)!;
      const base = v >= 0 ? (p[i] ?? 0) : (q[i] ?? 0);
      const top = base + v;
      if (v >= 0) p[i] = top;
      else q[i] = top;
      const x = M.l + band * i + band * 0.14 + slotW * k;
      const y = Math.min(ys(base), ys(top));
      const h = Math.max(v === 0 ? 0 : 1, Math.abs(ys(base) - ys(top)));
      // A pale bar keeps its outline inside its own box; an in-progress one gets a dashed outline, since a hatch barely
      // shows on a pale body. Bars too narrow for an outline to leave a visible body are drawn solid in the series colour.
      const outlined = !!s.fill && slotW >= 8 && h >= 2;
      const box = outlined ? { x: x + 0.5, y: y + 0.5, width: slotW - 2, height: h - 1 } : { x, y, width: Math.max(1, slotW - 1), height: h };
      const r = el('rect', { ...box, fill: outlined ? s.fill! : s.color, rx: Math.min(2, slotW / 4), ...(outlined ? { stroke: s.color, 'stroke-width': 1, ...(categories[i]!.partial ? { 'stroke-dasharray': '3 2' } : {}) } : {}) });
      r.append(el('title', {}, tip(categories[i]!, s, v)));
      svg.append(r);
      if (categories[i]!.partial) svg.append(el('rect', { ...box, fill: 'url(#partial-hatch)', 'pointer-events': 'none' }));
    });
  });

  // Shaded lines: settled runs get a pale area down to zero; in-progress points join with a dashed segment.
  const zeroY = sy(Math.min(hi, Math.max(lo, 0)));
  series.forEach((s, si) => {
    if (s.type !== 'line' || !s.area) return;
    const ys = s.axis === 'right' ? sy2 : sy;
    const zy = s.axis === 'right' ? sy2(Math.min(hi2, Math.max(lo2, 0))) : zeroY;
    const id = `xck-area-${++areaIds}-${si}`;
    const grad = el('linearGradient', { id, x1: 0, x2: 0, y1: M.t, y2: zy, gradientUnits: 'userSpaceOnUse' });
    grad.append(el('stop', { offset: 0, 'stop-color': s.fill ?? s.color, 'stop-opacity': 0.2 }), el('stop', { offset: 1, 'stop-color': s.fill ?? s.color, 'stop-opacity': 0.03 }));
    defs.append(grad);
    const at = (i: number) => `${cx(i).toFixed(1)},${ys(s.values[i]!).toFixed(1)}`;
    const settled = (i: number) => s.values[i] != null && !categories[i]?.partial;
    const runs: number[][] = [];
    s.values.forEach((_, i) => { if (settled(i)) (settled(i - 1) ? runs.at(-1)! : (runs.push([]), runs.at(-1)!)).push(i); });
    for (const run of runs) {
      if (run.length < 2) continue;
      svg.append(el('polygon', { points: [`${cx(run[0]!).toFixed(1)},${zy.toFixed(1)}`, ...run.map(at), `${cx(run.at(-1)!).toFixed(1)},${zy.toFixed(1)}`].join(' '), fill: `url(#${id})`, class: 'area', 'pointer-events': 'none' }));
      svg.append(el('polyline', { points: run.map(at).join(' '), fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', class: 'series-line' }));
    }
    s.values.forEach((v, i) => {
      if (v == null) return;
      const next = s.values[i + 1];
      if (next != null && (categories[i]!.partial || categories[i + 1]?.partial)) svg.append(el('polyline', { points: `${at(i)} ${at(i + 1)}`, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-dasharray': '4 3', class: 'partial-link' }));
      const partial = !!categories[i]!.partial;
      const lone = !partial && !settled(i - 1) && !settled(i + 1);
      const c = el('circle', { cx: cx(i), cy: ys(v), r: partial ? 3.5 : lone ? 3 : 4, fill: partial ? 'var(--xck-surface, #fff)' : s.color, stroke: partial ? s.color : 'var(--xck-surface, #fff)', 'stroke-width': partial ? 1.5 : 2,
        ...(partial || lone ? { class: partial ? 'pt-partial' : 'pt-lone' } : { class: 'pt', 'data-i': i, visibility: 'hidden' }) });
      c.append(el('title', {}, tip(categories[i]!, s, v)));
      svg.append(c);
    });
  });

  // Lines: break at nulls.
  for (const s of series.filter((x) => x.type === 'line' && !x.area)) {
    const ys = s.axis === 'right' ? sy2 : sy;
    let seg: string[] = [];
    const flush = () => {
      // The classes carry no look of their own: a page may draw a quiet reference line (markers: false) thinner than the rest.
      if (seg.length > 1) svg.append(el('polyline', { points: seg.join(' '), fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-dasharray': s.dashed ? '5 4' : 'none', 'stroke-linejoin': 'round', class: s.markers === false ? 'series-line quiet' : 'series-line' }));
      seg = [];
    };
    s.values.forEach((v, i) => {
      if (v == null) return flush();
      seg.push(`${cx(i).toFixed(1)},${ys(v).toFixed(1)}`);
      // A reading with no neighbour has no segment to show it, so it always gets its point.
      const isolated = s.values[i - 1] == null && s.values[i + 1] == null;
      if (isolated || (!s.dashed && s.markers !== false && n <= 60)) {
        const c = el('circle', { cx: cx(i), cy: ys(v), r: categories[i]!.partial ? 3.5 : 2.5, fill: s.dashed || categories[i]!.partial ? 'var(--xck-surface, #fff)' : s.color, stroke: s.color, 'stroke-width': 1.5 });
        c.append(el('title', {}, tip(categories[i]!, s, v)));
        svg.append(c);
      }
    });
    flush();
  }
  // Reference label last so it sits above bars and lines at the right edge.
  // Below the line when it sits at the top of the plot, so the label is not cut off.
  if (opts.refLine) { const y = sy(opts.refLine.value); svg.append(el('text', { x: W - M.r, y: y < M.t + 14 ? y + 15 : y - 5, 'text-anchor': 'end', class: 'axis ref-label' }, opts.refLine.label)); }
  return svg;
}

const exact = (s: Series, v: number) => (s.format ?? ((x: number) => x.toLocaleString('en-US', { maximumFractionDigits: 2 })))(v);
const heading = (c: Category) => `${c.title ?? c.label}${c.partial ? ' (partial)' : ''}`;

function tip(c: Category, s: Series, v: number): string {
  return `${heading(c)}\n${s.name}: ${exact(s, v)}`;
}

let areaIds = 0;
const chartObservers = new WeakMap<Element, ResizeObserver>();

/** Release responsive charts before their owning page replaces them. */
export function disposeCharts(root: HTMLElement): void {
  root.querySelectorAll('.chart-box').forEach(box => {
    chartObservers.get(box)?.disconnect();
    chartObservers.delete(box);
  });
}

let readoutIds = 0;

/** The readout sentence for one period: its heading, then every series value (a dash where there is none). */
export function readoutText(c: Category, series: Series[], i: number): string {
  const head = `${c.title ?? c.label} (UTC${c.note ? `, ${c.note}` : ''})`;
  if (series.every((s) => s.values[i] == null)) return `${head} · ${c.missing ? (c.missingText ?? 'not captured') : 'no value'}`;
  return [head, ...(c.missing ? [c.missingText ?? 'current period not captured'] : []), ...series.map((s) => `${s.name} ${s.values[i] == null ? '—' : exact(s, s.values[i]!)}`)].join(' · ');
}

/**
 * A chart drawn at its container's width, so axis text stays at its real size on narrow screens, with a
 * readout line above it. The readout starts on the latest complete period; pointer hover or the arrow keys
 * (Home/End too) on the focused plot move it, and the plot's column is highlighted. Draws once at the
 * default width straight away, then redraws whenever the container's width changes.
 */
export function responsiveChart(categories: Category[], series: Series[], opts: ChartOpts): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'xck-chart';
  const readout = document.createElement('p');
  readout.className = 'xck-readout';
  readout.id = `xck-readout-${++readoutIds}`;
  const box = document.createElement('div');
  box.className = 'chart-box';
  box.tabIndex = 0;
  box.setAttribute('role', 'group');
  box.setAttribute('aria-roledescription', 'chart');
  box.setAttribute('aria-label', `${opts.ariaLabel}. Use the left and right arrow keys to read each period.`);
  box.setAttribute('aria-describedby', readout.id);
  wrap.append(readout, box);
  const n = categories.length;
  const settled = categories.map((c, i) => !c.partial && !c.missing && series.some((s) => s.values[i] != null));
  const home = opts.readoutStart ?? (settled.lastIndexOf(true) >= 0 ? settled.lastIndexOf(true) : n - 1);
  let at = home;
  let drawn = opts.width ?? 720;
  const show = (i: number) => {
    at = Math.max(0, Math.min(n - 1, i));
    readout.textContent = n ? readoutText(categories[at]!, series, at) : '';
    const svg = box.querySelector('svg');
    const plot = svg?.dataset.plot?.split(' ').map(Number);
    const layer = svg?.querySelector('.band-layer');
    if (!plot || !layer) return;
    const [l, t, pw, ph, count] = plot as [number, number, number, number, number];
    const bw = pw / count;
    layer.replaceChildren(el('rect', { x: l + bw * at, y: t, width: bw, height: ph, class: 'focus-band' }));
    svg!.querySelectorAll('circle.pt').forEach((c) => c.setAttribute('visibility', c.getAttribute('data-i') === String(at) ? 'visible' : 'hidden'));
  };
  const draw = (width: number) => { box.replaceChildren(xyChart(categories, series, { ...opts, width })); show(at); };
  draw(drawn);
  box.addEventListener('keydown', (e) => {
    const next = ({ ArrowLeft: at - 1, ArrowRight: at + 1, Home: 0, End: n - 1 } as Record<string, number>)[e.key];
    if (next == null) return;
    e.preventDefault();
    readout.setAttribute('aria-live', 'polite');
    show(next);
  });
  box.addEventListener('blur', () => readout.removeAttribute('aria-live'));
  box.addEventListener('pointermove', (e) => {
    const svg = box.querySelector('svg');
    const plot = svg?.dataset.plot?.split(' ').map(Number);
    if (!svg || !plot) return;
    const r = svg.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * svg.viewBox.baseVal.width;
    const i = Math.floor((x - plot[0]!) / (plot[2]! / plot[4]!));
    if (i >= 0 && i < n && i !== at) show(i);
  });
  box.addEventListener('pointerleave', () => { if (document.activeElement !== box) show(home); });
  const observer = new ResizeObserver(() => {
    const w = Math.round(box.clientWidth);
    if (w < 200 || Math.abs(w - drawn) < 8) return;
    drawn = w;
    draw(w);
  });
  observer.observe(box);
  chartObservers.set(box, observer);
  return wrap;
}

/** The chart's exact values as a table: the text alternative to the picture and its tooltips. */
export function valuesTable(categories: Category[], series: Series[]): HTMLTableElement {
  const cell = (tag: 'th' | 'td', text: string, cls = '') => {
    const c = document.createElement(tag);
    if (cls) c.className = cls;
    c.textContent = text;
    return c;
  };
  const table = document.createElement('table');
  table.className = 'values';
  const head = document.createElement('tr');
  head.append(cell('th', 'Period (UTC)'), ...series.map((s) => cell('th', s.name, 'num')));
  const body = document.createElement('tbody');
  categories.forEach((c, i) => {
    const tr = document.createElement('tr');
    tr.append(cell('td', heading(c)), ...series.map((s) => cell('td', s.values[i] == null ? '—' : exact(s, s.values[i]!), 'num')));
    body.append(tr);
  });
  const thead = document.createElement('thead');
  thead.append(head);
  table.append(thead, body);
  return table;
}

export function legend(series: Series[]): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'legend';
  for (const s of series) {
    const item = document.createElement('span');
    const sw = document.createElement('i');
    sw.className = s.type === 'line' ? (s.dashed ? 'sw line dashed' : 'sw line') : s.fill ? 'sw outlined' : 'sw';
    sw.style.setProperty('--c', s.color);
    if (s.fill && s.type === 'bar') sw.style.setProperty('--f', s.fill);
    item.append(sw, document.createTextNode(s.name));
    wrap.append(item);
  }
  return wrap;
}

/**
 * A small trend line of real values for a figure tile, scaled to its own range (it carries no axis, so no area is
 * drawn to imply a baseline). Gaps stay gaps, an in-progress value joins with a dashed segment, a lone reading is a
 * dot, and a zero line shows when the values cross zero. Decorative to assistive tech: the tile states the figure
 * and the main chart's readout and table give every value. Null when fewer than two values exist.
 */
export function sparkline(values: (number | null)[], partial: boolean[], color: string): SVGSVGElement | null {
  const known = values.filter((v): v is number => v != null);
  if (known.length < 2) return null;
  const W = 120, H = 32, pad = 3;
  let lo = Math.min(...known), hi = Math.max(...known);
  if (hi === lo) { lo -= 1; hi += 1; }
  const x = (i: number) => ((i / (values.length - 1)) * W).toFixed(2);
  const y = (v: number) => (pad + (1 - (v - lo) / (hi - lo)) * (H - pad * 2)).toFixed(2);
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', class: 'xck-spark', 'aria-hidden': 'true', focusable: 'false' });
  const line = (pts: string[], dashed = false, width = 1.75) => svg.appendChild(el('polyline', { points: pts.join(' '), fill: 'none', stroke: color, 'stroke-width': width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke', ...(dashed ? { 'stroke-dasharray': '3 3' } : {}) }));
  if (lo < 0 && hi > 0) svg.append(el('line', { x1: 0, x2: W, y1: y(0), y2: y(0), class: 'spark-zero', 'vector-effect': 'non-scaling-stroke' }));
  const settled = (i: number) => values[i] != null && !partial[i];
  let run: string[] = [];
  values.forEach((v, i) => {
    if (settled(i)) run.push(`${x(i)},${y(v!)}`);
    // A round-capped zero-length line stays a circle when the box stretches.
    if (!settled(i + 1) && run.length) { line(run.length > 1 ? run : [run[0]!, run[0]!], false, run.length > 1 ? 1.75 : 4); run = []; }
    if (v != null && values[i + 1] != null && (partial[i] || partial[i + 1])) line([`${x(i)},${y(v)}`, `${x(i + 1)},${y(values[i + 1]!)}`], true);
    // A lone in-progress value: a fainter dot, so it is shown without reading as settled.
    if (v != null && partial[i] && values[i - 1] == null && values[i + 1] == null) line([`${x(i)},${y(v)}`, `${x(i)},${y(v)}`], false, 4).setAttribute('stroke-opacity', '0.45');
  });
  return svg;
}
