import { mountNavigation } from './navigation';
import css from './report.css';
import geistUrl from '../../static/fonts/geist.woff2';
import monoUrl from '../../static/fonts/geist-mono-latin.woff2';
import { RANGES, buildReport, compactNum, dayLabel, type RangeKey, type Report } from '../analytics/report';
import { shortDate, sortedRows } from '../analytics/series';
import { formatRate, type Pace } from '../calc/pace';
import { RUN_KEY, type RunStatus } from '../capture/run';
import { loadState } from '../store/chromeStore';
import { download, h, keepFocus } from './dom';

// Self-hosted, OFL-licensed faces (licence files sit beside them in static/fonts). Inlined as data
// URLs so the PNG export (SVG foreignObject) renders them without a network fetch.
const FONT_FACE = [
  `@font-face{font-family:'Geist';src:url(${geistUrl}) format('woff2');font-weight:200 800;font-style:normal;}`,
  `@font-face{font-family:'Geist Mono';src:url(${monoUrl}) format('woff2');font-weight:100 900;font-style:normal;}`,
].join('');
document.head.append(h('style', {}, FONT_FACE + css));

const NS = 'http://www.w3.org/2000/svg';

const storedRange = localStorage.getItem('xgd:report:range') as RangeKey | null;
let rangeKey: RangeKey = RANGES.some((r) => r.key === storedRange) ? storedRange! : 'today';
let format: 'landscape' | 'portrait' = localStorage.getItem('xgd:report:format') === 'portrait' ? 'portrait' : 'landscape';
let theme: 'light' | 'dark' = localStorage.getItem('xgd:report:theme') === 'dark' ? 'dark' : 'light';
let compare = localStorage.getItem('xgd:report:compare') === '1';
let dayValue: number | null = null;
let current: Report | null = null;
let run: RunStatus | null = null;
/** On narrow screens the fitted artboard is too small to read; zoom keeps its size and scrolls instead. */
let zoom = false;

const root = document.getElementById('app')!;

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, text?: string) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text != null) e.textContent = text;
  return e;
}

const hhmm = (iso: string) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

const fmtN = (v: number) => v.toLocaleString('en-US');
const pct1 = (v: number) => `${(v * 100).toFixed(1)}%`;
const signed = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmtN(Math.abs(v))}`;
const range = (a: string, b: string) => (a === b ? shortDate(a) : `${shortDate(a)} – ${shortDate(b)}`);

/** "2 Oct, 18:08 UTC": X's timestamps are UTC, so the report never shows local clock times. */
function timeBoth(iso: string, withDate = true): string {
  const utc = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', ...(withDate ? { day: 'numeric', month: 'short' } : {}), hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  return `${utc} UTC`;
}

function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const k of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (k * p >= v) return k * p;
  return 10 * p;
}

/**
 * Daily impressions per UTC day. Complete days: ink. Today (in progress): accent, lighter.
 * Missing days: no bar, a short rule at the baseline. With comparison on, the previous
 * complete-day period is a thin grey line (never bars, never against today's partial value).
 */
function trendChart(r: Report, width: number, height: number): SVGSVGElement {
  const M = { l: 46, r: 10, t: 58, b: 26 };
  const pw = width - M.l - M.r;
  const ph = height - M.t - M.b;
  const n = r.trend.length;
  const showPrev = compare && r.comparison.available;
  const max = niceMax(Math.max(1, ...r.trend.map((d) => Math.max(d.cur ?? 0, showPrev ? (d.prev ?? 0) : 0))));
  const y = (v: number) => M.t + ph - (v / max) * ph;
  const band = pw / Math.max(1, n);
  const cx = (i: number) => M.l + band * i + band / 2;
  const s = svg('svg', { viewBox: `0 0 ${width} ${height}`, class: 'r-svg', role: 'img', 'aria-label': 'Impressions per UTC day' });
  for (const g of [0, 0.5, 1]) {
    s.append(svg('line', { x1: M.l, x2: width - M.r, y1: y(max * g), y2: y(max * g), class: g === 0 ? 'base' : 'grid' }));
    s.append(svg('text', { x: M.l - 8, y: y(max * g) + 4, 'text-anchor': 'end', class: 'axis' }, compactNum(max * g)));
  }
  const bw = Math.min(n === 1 ? 120 : 56, Math.max(2, band * 0.62));
  r.trend.forEach((d, i) => {
    if (d.cur == null) {
      s.append(svg('line', { x1: cx(i) - bw / 2, x2: cx(i) + bw / 2, y1: M.t + ph - 1, y2: M.t + ph - 1, class: 'gap' }));
      return;
    }
    const hh = Math.max(d.cur > 0 ? 1.5 : 0, M.t + ph - y(d.cur));
    const bar = svg('rect', { x: cx(i) - bw / 2, y: M.t + ph - hh, width: bw, height: hh, class: d.partial ? 'bar partial' : 'bar' });
    bar.append(svg('title', {}, `${dayLabel(d.date)} (UTC): ${fmtN(d.cur)} impressions${d.partial ? ' (in progress)' : ''}`));
    s.append(bar);
  });
  if (showPrev) {
    const pts = r.trend.map((d, i) => (d.prev == null ? null : `${cx(i).toFixed(1)},${y(d.prev).toFixed(1)}`)).filter(Boolean).join(' ');
    s.append(svg('polyline', { points: pts, class: 'line prev' }));
  }
  // Labels: the peak complete day, and today's in-progress bar. Each has a leader line to its own bar
  // and is placed above every bar its text spans, so it can never read as a neighbour's label.
  const textW = (t: string, cls: string) => t.length * (cls === 'lbl' ? 11 : 8);
  type Box = { x0: number; x1: number; y: number };
  const placeLabel = (i: number, value: number, text: string, cls: string, anchor: 'start' | 'middle' | 'end', avoid: Box | null): Box => {
    const x = cx(i);
    const ax = anchor === 'end' ? x + bw / 2 : anchor === 'start' ? x - bw / 2 : x;
    const w = textW(text, cls);
    const x0 = anchor === 'end' ? ax - w : anchor === 'start' ? ax : ax - w / 2;
    const x1 = x0 + w;
    let tallest = value;
    r.trend.forEach((d, j) => {
      if (cx(j) + bw / 2 >= x0 && cx(j) - bw / 2 <= x1) tallest = Math.max(tallest, d.cur ?? 0, showPrev ? (d.prev ?? 0) : 0);
    });
    let ly = Math.max(avoid ? 16 : 44, y(tallest) - 12);
    if (avoid && x0 < avoid.x1 + 6 && x1 > avoid.x0 - 6 && Math.abs(ly - avoid.y) < 30) ly = Math.max(16, avoid.y - 30);
    s.append(svg('line', { x1: x, x2: x, y1: ly + 4, y2: y(value) - 2, class: cls === 'lbl' ? 'leader' : 'leader focus' }));
    s.append(svg('text', { x: ax, y: ly, 'text-anchor': anchor, class: cls }, text));
    return { x0, x1, y: ly };
  };
  const ti = r.trend.findIndex((d) => d.isToday);
  const today = r.trend[ti];
  const peakI = r.peak ? r.trend.findIndex((d) => d.date === r.peak!.date) : -1;
  let peakBox: Box | null = null;
  if (peakI >= 0) {
    const anchor = peakI < n * 0.25 ? 'start' : peakI > n * 0.75 ? 'end' : 'middle';
    peakBox = placeLabel(peakI, r.peak!.value, `Peak ${dayLabel(r.peak!.date)} · ${compactNum(r.peak!.value)}`, 'lbl', anchor, null);
  }
  if (today?.cur != null) {
    placeLabel(ti, today.cur, n === 1 ? fmtN(today.cur) : `Today so far · ${compactNum(today.cur)}`, n === 1 ? 'lbl' : 'lbl-soft', n === 1 ? 'middle' : 'end', peakBox);
  }
  const idx = n === 1 ? [0] : n > 2 ? [0, Math.floor((n - 1) / 2), n - 1] : [...Array(n).keys()];
  for (const i of idx) {
    const anchor = n === 1 ? 'middle' : i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle';
    const x = n === 1 ? cx(0) : i === 0 ? M.l : i === n - 1 ? width - M.r : cx(i);
    s.append(svg('text', { x, y: height - 5, 'text-anchor': anchor, class: 'axis' }, r.trend[i]!.isToday ? `${shortDate(r.trend[i]!.date)} (today)` : shortDate(r.trend[i]!.date)));
  }
  return s;
}

/**
 * Single-day context: X's daily impressions for the 7 UTC days ending on the focus day (today
 * or yesterday). Earlier days are soft ink; the focus day is the accent bar and the only label.
 */
function contextChart(pts: { date: string; v: number | null; focus: boolean }[], width: number, height: number, focusName: string, focusIsToday: boolean): SVGSVGElement {
  const M = { l: 46, r: 10, t: 36, b: 28 };
  const pw = width - M.l - M.r;
  const ph = height - M.t - M.b;
  const n = pts.length;
  const max = niceMax(Math.max(1, ...pts.map((p) => p.v ?? 0)));
  const y = (v: number) => M.t + ph - (v / max) * ph;
  const band = pw / n;
  const cx = (i: number) => M.l + band * i + band / 2;
  const bw = Math.min(width > 700 ? 84 : 48, band * 0.58);
  const s = svg('svg', { viewBox: `0 0 ${width} ${height}`, class: 'r-svg', role: 'img', 'aria-label': `Daily impressions, last 7 UTC days, ${focusName} highlighted` });
  for (const g of [0, 0.5, 1]) {
    s.append(svg('line', { x1: M.l, x2: width - M.r, y1: y(max * g), y2: y(max * g), class: g === 0 ? 'base' : 'grid' }));
    s.append(svg('text', { x: M.l - 8, y: y(max * g) + 4, 'text-anchor': 'end', class: 'axis' }, compactNum(max * g)));
  }
  pts.forEach((p, i) => {
    if (p.v == null) {
      s.append(svg('line', { x1: cx(i) - bw / 2, x2: cx(i) + bw / 2, y1: M.t + ph - 1, y2: M.t + ph - 1, class: 'gap' }));
      return;
    }
    const hh = Math.max(p.v > 0 ? 2 : 0, M.t + ph - y(p.v));
    const bar = svg('rect', { x: cx(i) - bw / 2, y: M.t + ph - hh, width: bw, height: hh, class: p.focus ? 'bar focus' : 'bar soft' });
    bar.append(svg('title', {}, `${dayLabel(p.date)} (UTC): ${fmtN(p.v)} impressions`));
    s.append(bar);
  });
  const ti = pts.findIndex((p) => p.focus);
  const t = pts[ti];
  if (t?.v != null) {
    const top = y(t.v);
    const text = `${focusName} · ${fmtN(t.v)}`;
    const w = text.length * 12;
    let tallest = t.v;
    pts.forEach((p, j) => { if (cx(j) + bw / 2 >= cx(ti) + bw / 2 - w) tallest = Math.max(tallest, p.v ?? 0); });
    const ly = Math.max(20, y(tallest) - 12);
    s.append(svg('line', { x1: cx(ti), x2: cx(ti), y1: ly + 5, y2: top - 3, class: 'leader focus' }));
    s.append(svg('text', { x: cx(ti) + bw / 2, y: ly, 'text-anchor': 'end', class: 'lbl-today' }, text));
  }
  s.append(svg('text', { x: cx(0) - bw / 2, y: height - 5, 'text-anchor': 'start', class: 'axis' }, shortDate(pts[0]!.date)));
  s.append(svg('text', { x: cx(n - 1) + bw / 2, y: height - 5, 'text-anchor': 'end', class: 'axis' }, `${shortDate(pts[n - 1]!.date)}${focusIsToday ? ' (today)' : ''}`));
  return s;
}

/**
 * Conversation activity: likes and replies received as hairline rows with a 2px measure (actual
 * counts, scaled to the larger of the two), plus replies per 1K impressions. Not a total.
 */
function conversationPanel(c: NonNullable<Report['conversation']>): HTMLElement {
  const max = Math.max(1, c.likes, c.replies, c.repliesWritten ?? 0);
  const bar = (label: string, v: number, cls = '') =>
    h('div', { class: `eb-row ${cls}` }, h('div', { class: 'eb-top' }, h('span', { class: 'eb-label' }, label), h('span', { class: 'eb-val' }, fmtN(v))), h('div', { class: 'eb-track' }, h('div', { class: 'eb-fill', style: `width:${v > 0 ? Math.max(1.5, (v / max) * 100).toFixed(1) : 0}%` })));
  return h(
    'div',
    { class: 'card cv' },
    h('div', { class: 'tr-title' }, 'Conversation'),
    h(
      'div',
      { class: 'eb' },
      h('div', { class: 'cv-cap' }, 'On your posts'),
      bar('Likes', c.likes),
      bar('Replies received', c.replies),
      c.repliesWritten != null ? h('div', { class: 'cv-cap mine' }, 'By you') : null,
      c.repliesWritten != null ? bar('Replies you wrote', c.repliesWritten, 'mine') : null,
    ),
    c.repliesPer1k != null ? h('div', { class: 'cv-metric' }, h('b', {}, c.repliesPer1k.toFixed(1)), h('span', {}, 'replies received per 1K impressions')) : null,
  );
}

/** Follows (ink), unfollows (outlined), net (accent). Values labelled on their own bars. */
function waterfall(f: NonNullable<Report['followers']>, width: number, height: number): SVGSVGElement {
  const M = { l: 6, r: 6, t: 28, b: 24 };
  const ph = height - M.t - M.b;
  const lo = Math.min(0, f.net, f.follows - f.unfollows);
  const hi = Math.max(f.follows, 1);
  const y = (v: number) => M.t + (1 - (v - lo) / (hi - lo)) * ph;
  const col = (width - M.l - M.r) / 3;
  const bw = col * 0.5;
  const s = svg('svg', { viewBox: `0 0 ${width} ${height}`, class: 'r-svg', role: 'img', 'aria-label': `Follows ${f.follows}, unfollows ${f.unfollows}, net ${f.net}` });
  s.append(svg('line', { x1: M.l, x2: width - M.r, y1: y(0), y2: y(0), class: 'base' }));
  const steps = [
    { label: 'Follows', from: 0, to: f.follows, cls: 'wf-in', text: signed(f.follows) },
    { label: 'Unfollows', from: f.follows, to: f.follows - f.unfollows, cls: 'wf-out', text: signed(-f.unfollows) },
    { label: 'Net', from: 0, to: f.net, cls: 'wf-net', text: signed(f.net) },
  ];
  steps.forEach((st, i) => {
    const x = M.l + col * i + (col - bw) / 2;
    const top = Math.min(y(st.from), y(st.to));
    const hgt = Math.max(2, Math.abs(y(st.from) - y(st.to)));
    s.append(svg('rect', { x, y: top, width: bw, height: hgt, class: st.cls }));
    s.append(svg('text', { x: x + bw / 2, y: top - 8, 'text-anchor': 'middle', class: 'lbl' }, st.text));
    s.append(svg('text', { x: x + bw / 2, y: height - 5, 'text-anchor': 'middle', class: 'axis' }, st.label));
    if (i < 2) {
      const level = i === 0 ? f.follows : f.follows - f.unfollows;
      s.append(svg('line', { x1: x + bw, x2: x + col, y1: y(level), y2: y(level), class: 'wf-link' }));
    }
  });
  return s;
}

/** Cumulative line from a zero baseline; straight segments; single endpoint label. */
function momentumChart(pts: { date: string | null; v: number }[], width: number, height: number, endValue: string, endLabel: string): SVGSVGElement {
  const M = { l: 10, r: 8, t: 40, b: 24 };
  const pw = width - M.l - M.r;
  const ph = height - M.t - M.b;
  const lo = Math.min(0, ...pts.map((p) => p.v));
  const hi = Math.max(0, ...pts.map((p) => p.v));
  const span = hi - lo || 1;
  const x = (i: number) => M.l + (i / Math.max(1, pts.length - 1)) * pw;
  const y = (v: number) => M.t + (1 - (v - lo) / span) * ph;
  // Scales down inside a squeezed row instead of spilling over the text above it.
  const s = svg('svg', { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'xMinYMax meet', class: 'r-svg', role: 'img', 'aria-label': `${endLabel}: ${endValue}` });
  s.append(svg('line', { x1: M.l, x2: width - M.r, y1: y(0), y2: y(0), class: 'base' }));
  const line = pts.map((p, i) => `${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  s.append(svg('polyline', { points: line, class: 'line' }));
  const ex = x(pts.length - 1);
  const ey = y(pts.at(-1)!.v);
  s.append(svg('circle', { cx: ex, cy: ey, r: 5, class: 'end-dot' }));
  const t = svg('text', { x: ex, y: Math.max(30, ey - 16), 'text-anchor': 'end' });
  t.append(svg('tspan', { class: 'end-val' }, endValue), svg('tspan', { class: 'end-unit', dx: 6 }, endLabel));
  s.append(t);
  const dated = pts.map((p, i) => ({ i, d: p.date })).filter((p) => p.d);
  if (dated.length) {
    const first = dated[0]!;
    const mid = dated[Math.floor((dated.length - 1) / 2)]!;
    const last = dated.at(-1)!;
    s.append(svg('text', { x: M.l, y: height - 5, 'text-anchor': 'start', class: 'axis' }, shortDate(first.d!)));
    if (dated.length > 2) s.append(svg('text', { x: x(mid.i), y: height - 5, 'text-anchor': 'middle', class: 'axis' }, shortDate(mid.d!)));
    s.append(svg('text', { x: width - M.r, y: height - 5, 'text-anchor': 'end', class: 'axis' }, shortDate(last.d!)));
  }
  s.append(svg('text', { x: M.l + 2, y: y(0) - 6, class: 'axis' }, '0'));
  return s;
}

/**
 * The ruler: 0 → target with 25K ticks and 100K labels, the measured span drawn thick in ink,
 * an ink needle at the current reading, and (only when the pace is ahead of the holding rate)
 * a dashed accent needle at the target with the projected date. The one decorative object.
 */
function ruler(p: Pace, target: number, readingText: string, percentText: string, width: number, height: number): SVGSVGElement {
  const M = { l: 12, r: 26 };
  const x = (v: number) => M.l + (Math.min(v, target) / target) * (width - M.l - M.r);
  const base = 50;
  const s = svg('svg', { viewBox: `0 0 ${width} ${height}`, class: 'ruler', role: 'img', 'aria-label': `${readingText} of ${compactNum(target)}` });
  s.append(svg('line', { x1: x(0), x2: x(target), y1: base, y2: base, class: 'track' }));
  for (let v = 0; v <= target; v += 25_000) {
    const major = v % 100_000 === 0;
    s.append(svg('line', { x1: x(v), x2: x(v), y1: major ? base - 12 : base - 6, y2: major ? base + 12 : base + 6, class: major ? 'major' : 'tick' }));
    if (major) s.append(svg('text', { x: x(v), y: base + 30, 'text-anchor': v === 0 ? 'start' : v === target ? 'end' : 'middle', class: 'scale' }, v === 0 ? '0' : compactNum(v)));
  }
  const cur = x(p.reading.value);
  if (p.reading.value > 0) s.append(svg('line', { x1: x(0), x2: cur, y1: base, y2: base, class: 'done' }));
  s.append(svg('line', { x1: cur, x2: cur, y1: base - 26, y2: base + 16, class: 'needle' }));
  const anchor = cur < width * 0.22 ? 'start' : cur > width * 0.78 ? 'end' : 'middle';
  const lab = svg('text', { x: cur, y: base - 34, 'text-anchor': anchor });
  lab.append(svg('tspan', { class: 'now' }, readingText), svg('tspan', { class: 'now-sub', dx: 6 }, percentText));
  s.append(lab);
  if (p.status === 'ahead' && p.eta) {
    const tx = x(target);
    s.append(svg('line', { x1: tx, x2: tx, y1: base - 26, y2: base + 16, class: 'eta' }));
    const etaLab = svg('text', { x: tx, y: base - 34, 'text-anchor': 'end', class: 'eta-lbl' }, `${compactNum(target)} on ${shortDate(p.eta.date)}`);
    // Keep the two labels apart when the reading sits near the target.
    if (cur > width * 0.6) etaLab.setAttribute('y', String(base - 54));
    s.append(etaLab);
  }
  return s;
}

function logoMark() {
  const s = svg('svg', { width: 20, height: 20, viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  s.append(svg('path', { d: 'M4 17 L10 11 L14 14 L20 7 M15 7 H20 V12', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.75, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  return s;
}

type Format = 'landscape' | 'portrait';
type Theme = 'light' | 'dark';
const DIMS: Record<Format, { w: number; h: number }> = { landscape: { w: 1200, h: 750 }, portrait: { w: 1080, h: 1350 } };

function avatarOrMark(avatar: string | undefined): HTMLElement {
  return avatar ? h('img', { class: 'r-avatar', src: avatar, alt: '' }) : h('div', { class: 'r-mark' }, logoMark());
}

function stage(r: Report, opts: { format: Format; theme: Theme; avatar?: string }): HTMLElement {
  const R = r.range;
  const P = opts.format === 'portrait';
  const single = R.days === 1;
  const entry = RANGES.find((x) => x.days === R.days && x.anchor === R.anchor)!;
  const label = entry.label;

  // ---- Header: @handle + one reporting line; follower count + Day N on the right.
  const asOf = R.todayAsOf ? `${hhmm(R.todayAsOf)} UTC` : null;
  const reportLine = (
    R.anchor === 'yesterday'
      ? [shortDate(R.today), 'Yesterday', R.endStatus === 'final' ? 'Final' : R.endStatus === 'partial' ? `captured ${asOf}` : 'Data unavailable']
      : single
        ? [shortDate(R.today), 'Today', ...(R.endStatus === 'in_progress' ? [asOf!, 'In progress'] : ["Today's data unavailable"])]
        : [range(R.start, R.end), label, ...(R.endStatus === 'in_progress' ? [asOf!, 'Today in progress'] : ['Today not captured'])]
  ).join(' · ');
  const lineOk = R.endStatus === 'in_progress' || R.endStatus === 'final';
  const day = dayValue ?? r.daySuggested;
  const fc = r.followerCount;
  const head = h(
    'div',
    { class: 'r-head' },
    h('div', { class: 'r-id' }, avatarOrMark(opts.avatar), h('div', {}, h('div', { class: 'r-handle' }, r.handle ? '@' + r.handle : 'Your account'), h('div', { class: `r-line${lineOk ? '' : ' stale'}` }, h('i', { class: 'dot' }), reportLine))),
    h(
      'div',
      { class: 'r-hgroup' },
      fc ? h('div', { class: 'r-followers' }, h('b', {}, fc.displayText), h('span', {}, 'followers')) : null,
      h('div', { class: 'r-day' }, h('span', {}, 'Day'), h('b', {}, String(day))),
    ),
  );

  // ---- Hero band: X's rolling 90-day metric (independent of the selected range) and the ruler.
  let rw: HTMLElement;
  if (r.rewards) {
    const { reading, progress, history, target, pace: pc } = r.rewards;
    const prev = history.length >= 2 ? history[history.length - 2]! : null;
    const vf = r.rewards.verifiedFollowers;
    // One pace line when a rate exists (readings ≥ 2 days apart); otherwise the net change since the previous reading.
    const paceLine = pc.rate
      ? h(
          'div',
          { class: 'rw-delta' },
          h('b', {}, `${formatRate(pc.rate.perDay, pc.rate.approximate)}`),
          ' a day',
          pc.status === 'reached'
            ? ' · target reached'
            : pc.status === 'ahead' && pc.eta
              ? ` · ${progress.targetText} on ${shortDate(pc.eta.date)} at this pace`
              : pc.status === 'behind'
                ? ` · ${formatRate(pc.need.perDay)} a day holds ${progress.targetText}`
                : ` over ${pc.rate.spanDays} days`,
        )
      : r.rewards.change && prev
        ? h('div', { class: 'rw-delta' }, h('b', {}, r.rewards.change.deltaText), ` since ${shortDate(prev.date)}`)
        : null;
    rw = h(
      'div',
      { class: 'rw' },
      h(
        'div',
        { class: 'rw-l' },
        h('div', { class: 'rw-hero' }, reading.displayText),
        h('div', { class: 'rw-def' }, `of ${progress.targetText} verified Home Timeline impressions, `, h('i', {}, 'rolling 90 days · replies excluded')),
        paceLine,
      ),
      h(
        'div',
        { class: 'rw-r' },
        ruler(pc, target, reading.displayText, progress.percentText, P ? 500 : 520, P ? 96 : 86),
        h(
          'div',
          { class: 'rw-checks' },
          vf ? h('div', { class: 'rw-check' }, h('span', { class: `rw-dot ${vf.value >= 500 ? 'ok' : 'todo'}` }, vf.value >= 500 ? '✓' : '·'), `${vf.displayText} verified followers`, h('span', { class: 'mono' }, 'need 500')) : null,
          h('div', { class: 'rw-check' }, h('span', { class: `rw-dot ${progress.percent >= 100 ? 'ok' : 'todo'}` }, progress.percent >= 100 ? '✓' : '·'), `${progress.remainingText}`, h('span', { class: 'mono' }, progress.percentText)),
          r.rewards.health !== 'ready' ? h('div', { class: 'rw-check' }, h('span', { class: 'rw-dot' }, '·'), h('span', { class: 'rw-stale' }, `Reading is ${r.rewards.ageText} old`)) : null,
        ),
      ),
    );
  } else {
    rw = h('div', { class: 'rw' }, h('div', { class: 'rw-l' }, h('div', { class: 'rw-empty' }, 'No rewards reading yet.')));
  }

  // ---- Follower growth: waterfall, or a compact stat when nothing changed yet.
  let fw: HTMLElement | null = null;
  if (r.followers) {
    const f = r.followers;
    const vfText = f.verified ? `${f.verified.displayText} verified followers` : null;
    const body =
      f.follows === 0 && f.unfollows === 0
        ? h('div', { class: 'fw-zero' }, h('b', {}, '±0'), h('span', {}, 'net followers so far'))
        : h('div', { class: 'fw-chart' }, waterfall(f, P ? 440 : 250, P ? 220 : 180));
    fw = h('div', { class: 'card fw' }, h('div', { class: 'fw-title' }, `Followers · ${label}`), body, vfText ? h('div', { class: 'fw-foot' }, vfText) : null);
  }

  // ---- KPI row (+ visits per 1K as a 5th tile in single-day views and in portrait)
  const cmp = r.comparison;
  const kpis = r.kpis.length
    ? r.kpis
    : (['Impressions', 'Engagements', 'EngagementRate', 'ProfileVisits'] as const).map((k) => ({ key: k, label: { Impressions: 'Impressions', Engagements: 'Engagements', EngagementRate: 'Engagement rate', ProfileVisits: 'Profile visits' }[k], value: null, change: null, basisCur: null, basisPrev: null, upIsGood: true }));
  const chip = (ch: number | null, isRate: boolean, cur: number | null, prev: number | null) => {
    if (!cmp.available || ch == null) return null;
    const cls = Math.abs(ch) < 0.005 ? 'flat' : ch > 0 ? 'pos' : 'neg';
    const text = isRate ? `${ch >= 0 ? '▲' : '▼'} ${Math.abs(((cur ?? 0) - (prev ?? 0)) * 100).toFixed(1)} pts` : ch >= 1 ? `▲ ${(1 + ch).toFixed(1)}×` : `${ch >= 0 ? '▲' : '▼'} ${Math.abs(ch * 100).toFixed(0)}%`;
    return h('div', { class: 'tile-row' }, h('span', { class: `tile-delta ${cls}` }, text), h('span', { class: 'tile-prev' }, cmp.days === 1 ? 'vs day before' : `${cmp.days} full days vs prior ${cmp.days}`));
  };
  const e = r.efficiency;
  // Landscape single-day: visits per 1K rides inside the Profile visits tile (no extra tile or panel).
  const inlinePer1k = !P && single && e && e.visitsPer1k.cur != null ? `${e.visitsPer1k.cur.toFixed(1)} per 1K impr.` : null;
  const tiles: HTMLElement[] = kpis.map((k) => {
    const isRate = k.key === 'EngagementRate';
    const f = isRate ? pct1 : (v: number) => (v >= 10_000 ? compactNum(v) : fmtN(v));
    const row = chip(k.change, isRate, k.basisCur, k.basisPrev);
    const aside = k.key === 'ProfileVisits' && inlinePer1k ? h('span', { class: 'tile-aside' }, inlinePer1k) : null;
    return h('div', { class: `card tile${row ? '' : ' solo'}` }, h('div', { class: 'tile-label' }, h('span', {}, k.label)), h('div', { class: 'tile-val' }, k.value == null ? '—' : f(k.value), aside), row);
  });
  const effTile = P && e && e.visitsPer1k.cur != null;
  if (effTile) {
    const ch = e!.visitsPer1k.prev ? e!.visitsPer1k.cur! / e!.visitsPer1k.prev - 1 : null;
    const row = e!.basis === 'complete_days' ? chip(ch, false, null, null) : null;
    tiles.push(h('div', { class: `card tile${row ? '' : ' solo'}` }, h('div', { class: 'tile-label' }, h('span', {}, 'Visits / 1K impr.')), h('div', { class: 'tile-val' }, e!.visitsPer1k.cur!.toFixed(1)), row));
  }

  // ---- Second panel: single-day → conversation activity; ranges → follower momentum.
  let second: HTMLElement | null = null;
  const mo = r.momentum;
  if (single) {
    if (r.conversation) second = conversationPanel(r.conversation);
  } else if (mo && mo.kind !== 'unavailable') {
    const isF = mo.kind === 'followers';
    second = h(
      'div',
      { class: 'card mo' },
      h('div', {}, h('div', { class: 'tr-title' }, isF ? 'Follower momentum' : 'Cumulative impressions'), h('div', { class: 'ef-sub' }, isF ? (!P && r.followers ? `${signed(r.followers.follows)} follows · ${signed(-r.followers.unfollows)} unfollows${mo.endsPartial && !mo.endsToday ? ` · ends ${shortDate(mo.through)}, captured mid-day` : ''}` : `From 0 · ${mo.endsPartial && !mo.endsToday ? `ends ${shortDate(mo.through)}, captured mid-day · ` : ''}not follower count`) : 'All surfaces · not rewards-qualified')),
      momentumChart(mo.points, P ? 440 : 300, P ? 200 : 70, isF ? signed(mo.final) : compactNum(mo.final), isF ? 'net followers' : 'account impressions'),
    );
  }

  // ---- Reach efficiency (landscape ranges only; elsewhere it is the 5th tile)
  let eff: HTMLElement | null = null;
  if (!P && !single && e && e.basis === 'complete_days' && cmp.available) {
    const row = (lbl: string, prev: number | null, cur: number | null, fmt: (v: number) => string) =>
      h('div', { class: 'ef-line' }, h('span', { class: 'ef-label' }, lbl), h('span', { class: 'ef-vals' }, h('span', { class: 'ef-prev' }, prev == null ? '—' : fmt(prev)), h('span', { class: 'ef-arrow' }, '→'), h('b', { class: 'ef-val' }, cur == null ? '—' : fmt(cur))));
    eff = h(
      'div',
      { class: 'card ef' },
      h('div', { class: 'tr-title' }, 'Reach efficiency'),
      row('Profile visits per 1K impressions', e.visitsPer1k.prev, e.visitsPer1k.cur, (v) => v.toFixed(1)),
      e.netFollows ? row('Net follower growth', e.netFollows.prev, e.netFollows.cur, signed) : null,
    );
  }

  // ---- Trend
  const stack = P ? [] : ([second, single ? null : eff].filter(Boolean) as HTMLElement[]);
  // Landscape ranges carry follower momentum (its endpoint is the net), so the waterfall stays single-day there.
  const fwL = !P && single ? fw : null;
  const cols = P ? 1 : 1 + (fwL ? 1 : 0) + (stack.length ? 1 : 0);
  // Widths match the CSS column tracks so SVG text renders at its nominal size.
  const TREND_W = P ? 984 : cols === 3 ? 476 : cols === 2 ? 732 : 1112;
  // Landscape rows shrink when tiles carry comparison lines; portrait keeps a fixed chart height.
  const TREND_H = P ? 250 : cmp.available ? 176 : 198;
  const facts = r.trendFacts;
  const focusLabel = R.anchor === 'yesterday' ? 'yesterday' : 'today';
  const trend = h(
    'div',
    { class: 'card tr' },
    h(
      'div',
      { class: 'tr-head' },
      h('div', { class: 'tr-title' }, single ? 'Impressions' : 'Daily impressions'),
      single && r.context ? h('div', { class: 'tr-meta' }, `7-day context · ${focusLabel} highlighted`) : null,
      // Landscape ranges: the two facts ride on the title line instead of a row under the chart.
      !P && !single && facts && facts.avgPerCompleteDay != null ? h('div', { class: 'tr-meta' }, `${compactNum(facts.avgPerCompleteDay)} avg per full day · ${facts.daysOver10k} of ${facts.completeDays} full days over 10K`) : null,
      h(
        'div',
        { class: 'tr-legend' },
        !single && r.trend.some((d) => d.partial) ? h('span', {}, h('i', { class: 'sw-bar today' }), r.trend.every((d) => !d.partial || d.isToday) ? 'Today, in progress' : 'Partial day (captured before it ended)') : null,
        compare && cmp.available && !single ? h('span', {}, h('i', { class: 'sw-line' }), `Prior ${cmp.days} days`) : null,
      ),
    ),
    single && r.context
      ? contextChart(r.context, TREND_W, TREND_H, R.anchor === 'yesterday' ? shortDate(R.today) : 'Today', R.anchor === 'today')
      : r.trend.some((d) => d.cur != null)
        ? trendChart(r, TREND_W, TREND_H)
        : h('div', { class: 'empty dash' }, '—'),
    P && !single && facts && facts.avgPerCompleteDay != null
      ? h('div', { class: 'tr-facts' }, h('div', {}, h('b', {}, compactNum(facts.avgPerCompleteDay)), h('span', {}, 'avg per full day')), h('div', {}, h('b', {}, `${facts.daysOver10k}`), h('span', {}, `of ${facts.completeDays} full days over 10K`)))
      : null,
  );

  // ---- Footer: one compact source line.
  const aAt = r.analytics.capturedAt;
  const rAt = r.rewards?.reading.lastSeenAt ?? null;
  const apart = aAt && rAt && Math.abs(Date.parse(aAt) - Date.parse(rAt)) > 30 * 60_000;
  const manualRewards = r.rewards?.reading.provenance === 'manual';
  const foot = h(
    'div',
    { class: 'r-foot' },
    [
      `Sources: X Analytics (UTC); ${manualRewards ? 'hand-entered Rewards' : 'Creator Studio Rewards'} (rolling 90 days, replies excluded).`,
      r.rewards?.reading.precision === 'rounded' ? manualRewards ? 'Rewards entered at rounded precision.' : 'Rewards rounded by X.' : null,
      fc && fc.precision === 'rounded' ? 'Follower total rounded by X.' : null,
      apart ? manualRewards ? `Analytics captured ${timeBoth(aAt!)}; rewards entered ${timeBoth(rAt!)}.` : `Captured: analytics ${timeBoth(aAt!)}, rewards ${timeBoth(rAt!)}.` : null,
      r.analytics.stale && aAt ? `Analytics last captured ${timeBoth(aAt)}.` : null,
      r.rewards && r.rewards.health !== 'ready' ? `Rewards reading ${r.rewards.ageText} old.` : null,
      R.missingDays.length ? `${R.missingDays.length} day(s) not captured.` : null,
    ]
      .filter(Boolean)
      .join(' '),
  );

  const cls = `stage ${opts.format}${opts.theme === 'dark' ? ' dark' : ''}`;
  const kpiRow = h('div', { class: `kpis4${tiles.length === 5 ? ' five' : ''}` }, ...tiles);
  if (P) {
    const bottom = [fw, second].filter(Boolean) as HTMLElement[];
    return h('div', { class: cls, id: 'stage' }, head, rw, kpiRow, trend, bottom.length ? h('div', { class: `p-bottom${bottom.length === 1 ? ' one' : ''}` }, ...bottom) : null, foot);
  }
  const lower = h(
    'div',
    { class: `r-lower${cols === 1 ? ' solo' : cols === 3 ? ' three' : ''}` },
    trend,
    fwL,
    stack.length ? h('div', { class: `r-stack${stack.length === 1 ? ' one' : ''}${single ? ' today' : ''}${cmp.available ? ' chips' : ''}` }, ...stack) : null,
  );
  return h('div', { class: cls, id: 'stage' }, head, rw, kpiRow, lower, foot);
}

// ---------- Toolbar, status, layout ----------

function sourcePill(name: string, s: { state: string; message: string; at?: string } | null | undefined, lastGood: string | null) {
  const state = s?.state ?? 'none';
  const icon = ({ pending: '○', running: '◌', done: '✓', skipped: '!', failed: '✕', none: '·' } as Record<string, string>)[state];
  const when = s?.at ? ` · ${timeBoth(s.at, false)}` : '';
  const fallback = state !== 'done' && state !== 'running' && lastGood ? ` · showing capture from ${timeBoth(lastGood)}` : '';
  return h('div', { class: `xck-src ${state}` }, h('b', {}, `${icon} ${name}`), ` ${s ? s.message : 'no capture this session'}${when}${fallback}`);
}

async function render() {
  const state = await loadState();
  const handles = Object.keys(state.accounts).filter((k) => k !== '_unknown');
  const handle = run?.account && handles.includes(run.account) ? run.account : handles.includes(state.settings.expectedHandle) ? state.settings.expectedHandle : (handles[0] ?? state.settings.expectedHandle);
  const acct = state.accounts[handle] ?? { observations: [], attempts: [] };
  const series = acct.daily?.all;
  const entry = RANGES.find((x) => x.key === rangeKey)!;
  current = buildReport({ handle, settings: state.settings, observations: acct.observations, attempts: acct.attempts, daily: sortedRows(series), analyticsCapturedAt: series?.lastCaptureAt ?? null, intraday: acct.intraday, days: entry.days, anchor: entry.anchor, now: new Date() });
  if (dayValue == null) dayValue = current.daySuggested;

  const busy = run && !run.finishedAt;
  const dayInput = h('input', { type: 'number', min: '1', value: String(dayValue), 'aria-label': 'Day number', 'data-key': 'day' });
  dayInput.addEventListener('change', () => ((dayValue = Number(dayInput.value) || null), void render()));
  const select = <T extends string>(label: string, value: T, options: [T, string][], set: (v: T) => void, visible = label) =>
    h('label', { class: 'xck-dock-group' }, h('span', { class: 'xck-control-label' }, visible), h('select', { 'aria-label': label, 'data-key': `select:${label}`, onchange: (ev) => (set((ev.target as HTMLSelectElement).value as T), void render()) }, ...options.map(([v, t]) => h('option', { value: v, ...(v === value ? { selected: true } : {}) }, t))));
  dayInput.setAttribute('style', 'width:84px');

  // The card first, then its options and the export right under it, then the private source notes.
  const head = h('header', { class: 'xck-head' },
    h('div', { class: 'xck-head-id' }, h('h1', { class: 'xck-title' }, 'Ledger'), handle ? h('span', { class: 'xck-muted' }, '@' + handle) : null),
    h('div', { class: 'xck-head-actions' }, h('button', { type: 'button', 'data-key': 'refresh', disabled: !!busy, 'aria-busy': String(!!busy), onclick: () => void refresh() }, 'Open X Analytics ↗')));
  const { w: outW, h: outH } = DIMS[format];
  const zoomButton = h('button', { type: 'button', class: 'zoom', 'data-key': 'zoom', 'aria-pressed': String(zoom), onclick: () => ((zoom = !zoom), fit()) }, zoom ? 'Fit to screen' : 'Zoom to read');
  const exportRow = h('div', { class: 'xck-export export-row' },
    h('button', { type: 'button', class: 'xck-primary primary', 'data-key': 'download', onclick: () => void exportPng() }, 'Download PNG'),
    zoomButton,
    h('span', { class: 'xck-size' }, `PNG · ${outW * 2} × ${outH * 2}`));
  const bar = h('section', { class: 'xck-panel', 'aria-label': 'Card options' }, h('div', { class: 'xck-dock' },
    h('div', { class: 'xck-dock-group' }, h('span', { class: 'xck-control-label', 'aria-hidden': 'true' }, 'Period'), h(
      'div',
      { class: 'xck-seg', role: 'group', 'aria-label': 'Period' },
      ...RANGES.map((x) =>
        h('button', { type: 'button', 'aria-pressed': String(x.key === rangeKey), 'data-key': `range:${x.key}`, onclick: () => ((rangeKey = x.key), (dayValue = null), localStorage.setItem('xgd:report:range', x.key), void render()) }, x.button),
      ),
    )),
    select<Format>('Format', format, [['landscape', 'Landscape 16:10'], ['portrait', 'Portrait 4:5']], (v) => ((format = v), localStorage.setItem('xgd:report:format', v))),
    select<Theme>('Theme', theme, [['light', 'Light'], ['dark', 'Dark']], (v) => ((theme = v), localStorage.setItem('xgd:report:theme', v)), 'Card theme'),
    h('label', { class: 'xck-dock-group' }, h('span', { class: 'xck-control-label' }, 'Day'), dayInput),
    h('label', { class: 'xck-check' }, h('input', { type: 'checkbox', 'data-key': 'compare', ...(compare ? { checked: true } : {}), onchange: (ev) => ((compare = (ev.target as HTMLInputElement).checked), localStorage.setItem('xgd:report:compare', compare ? '1' : '0'), void render()) }), 'Compare'),
  ));
  const rewardsObs = acct.observations.filter((o) => o.metric === 'rewards_vht_90d').sort((a, b) => a.lastSeenAt.localeCompare(b.lastSeenAt)).at(-1);
  const profileObs = acct.observations.filter((o) => o.metric === 'followers_total' && o.precision === 'exact').sort((a, b) => a.lastSeenAt.localeCompare(b.lastSeenAt)).at(-1);
  const status = h(
    'section',
    { class: 'xck-panel xck-sources', 'aria-labelledby': 'sources-title' },
    h('h2', { id: 'sources-title', class: 'xck-section-title' }, 'Sources and notes ', h('span', { class: 'xck-muted xck-small', style: 'font-weight:400' }, '· private, not in the PNG')),
    sourcePill('Analytics', run?.steps.analytics, series?.lastCaptureAt ?? null),
    sourcePill('Rewards', run?.steps.rewards, rewardsObs?.lastSeenAt ?? null),
    sourcePill('Followers', run?.steps.profile, profileObs?.lastSeenAt ?? null),
    current.engagementTypes
      ? h('div', { class: 'xck-private' }, h('b', {}, 'Engagement types (private, not in PNG): '), `Likes ${fmtN(current.engagementTypes.likes)} · Replies received ${fmtN(current.engagementTypes.replies)} · Reposts ${fmtN(current.engagementTypes.reposts)} · Bookmarks ${fmtN(current.engagementTypes.bookmarks)}${current.engagementTypes.shares != null ? ` · Shares ${fmtN(current.engagementTypes.shares)}` : ''}`)
      : null,
    h(
      'div',
      { class: 'xck-private' },
      h('b', {}, 'Sources (private): '),
      [
        current.analytics.capturedAt ? `X Analytics captured ${timeBoth(current.analytics.capturedAt)}${current.analytics.stale ? ` (${current.analytics.ageText} ago)` : ''}` : 'X Analytics not captured',
        current.rewards ? `Creator Studio rewards ${current.rewards.reading.provenance === 'manual' ? 'entered' : 'captured'} ${timeBoth(current.rewards.reading.lastSeenAt)}` : 'Rewards not captured',
        current.followerCount ? `followers ${current.followerCount.displayText} from ${current.followerCount.sourceLabel}, ${timeBoth(current.followerCount.lastSeenAt)}` : null,
        current.comparison.available ? `changes compare ${range(current.comparison.cur.start, current.comparison.cur.end)} with ${range(current.comparison.prev.start, current.comparison.prev.end)}` : null,
      ]
        .filter(Boolean)
        .join(' · '),
    ),
    current.diagnostics.length ? h('details', { class: 'xck-diag' }, h('summary', {}, `Data notes (${current.diagnostics.length}) · not shown in the PNG`), h('ul', {}, ...current.diagnostics.map((d) => h('li', {}, d)))) : null,
    h('p', { class: 'xck-grant' }, 'Choose a range on X, then use Read current X tab in the extension toolbar.'),
  );
  root.removeAttribute('aria-busy');
  keepFocus(root, () => root.replaceChildren(head, h('section', { class: 'xck-stage', 'aria-label': 'Preview and export' }, h('div', { class: 'frame-scroll' }, h('div', { class: 'frame' }, stage(current!, { format, theme, avatar: state.settings.avatarDataUrl }))), exportRow), bar, status));
  fit();
}

/** Scale the artboard to fit the window so a plain screenshot also works. */
function fit() {
  const st = document.getElementById('stage');
  const frame = st?.parentElement;
  if (!st || !frame) return;
  const { w, h: hh } = DIMS[format];
  const box = frame.parentElement;
  const pad = box ? parseFloat(getComputedStyle(box).paddingLeft) + parseFloat(getComputedStyle(box).paddingRight) : 0;
  const room = (box?.clientWidth ?? window.innerWidth - 48) - pad;
  // Leave room under the card for its options and export so they stay in view with it.
  const fitK = Math.min(1.25, room / w, Math.max(300, window.innerHeight - 300) / hh);
  // Zoom is offered only when the fitted card is too small to read; it scrolls sideways inside its own box.
  const small = fitK < 0.55;
  const k = small && zoom ? Math.max(fitK, 0.62) : fitK;
  const button = root.querySelector<HTMLButtonElement>('.export-row .zoom');
  if (button) { button.hidden = !small; button.textContent = zoom ? 'Fit to screen' : 'Zoom to read'; button.setAttribute('aria-pressed', String(zoom)); }
  st.style.transform = `scale(${k})`;
  st.style.transformOrigin = 'top left';
  frame.style.width = `${w * k}px`;
  frame.style.height = `${hh * k}px`;
}
window.addEventListener('resize', fit);

/** Open the source visibly; the toolbar reader is a separate explicit gesture. */
async function refresh() {
  await chrome.tabs.create({ url: 'https://x.com/i/account_analytics', active: true });
}

/**
 * Render the artboard straight to a 2x PNG. The SVG's intrinsic size is already 2x (viewBox
 * stays at the logical size), so text and charts are rasterised at final resolution; nothing
 * is upscaled and there is no JPEG step. Waits for fonts (and the avatar image) before drawing.
 */
async function renderStagePng(scale = 2): Promise<Blob | null> {
  const st = document.getElementById('stage');
  if (!st) return null;
  await document.fonts.ready;
  await Promise.all([...st.querySelectorAll('img')].map((i) => (i as HTMLImageElement).decode().catch(() => undefined)));
  const { w, h: hh } = DIMS[format];
  const clone = st.cloneNode(true) as HTMLElement;
  clone.style.transform = 'none';
  const xml = new XMLSerializer().serializeToString(clone);
  const doc = `<svg xmlns="http://www.w3.org/2000/svg" width="${w * scale}" height="${hh * scale}" viewBox="0 0 ${w} ${hh}"><foreignObject x="0" y="0" width="${w}" height="${hh}"><div xmlns="http://www.w3.org/1999/xhtml"><style>${(FONT_FACE + css).replace(/</g, '\\3c ')}</style>${xml}</div></foreignObject></svg>`;
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(doc);
  await img.decode();
  await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
  const c = document.createElement('canvas');
  c.width = w * scale;
  c.height = hh * scale;
  c.getContext('2d')!.drawImage(img, 0, 0);
  return new Promise((res) => c.toBlob(res, 'image/png'));
}

async function exportPng() {
  if (!current) return;
  const blob = await renderStagePng(2);
  if (blob) download(`${current.handle || 'ledger'}-day${dayValue ?? current.daySuggested}-${rangeKey}-${format}${theme === 'dark' ? '-dark' : ''}-utc.png`, blob);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes[RUN_KEY]) run = changes[RUN_KEY].newValue as RunStatus;
  void render();
});
void chrome.storage.session.get(RUN_KEY).then((v) => {
  run = (v[RUN_KEY] as RunStatus) ?? null;
  void render();
});

mountNavigation();
