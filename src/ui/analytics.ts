import { mountNavigation } from './navigation';
import type { StoreState } from '../model/types';
import {
  METRIC_NAMES,
  bucketCells,
  calendarRange,
  changeOver,
  dayValue,
  fieldsFor,
  figureOver,
  runningTotal,
  shortDate,
  sortedRows,
  topDaysBy,
  utcDate,
  weekdayAverages,
  type CalendarRange,
  type CellBucket,
  type FigureKey,
  type Granularity,
  type SeriesKind,
} from '../analytics/series';
import {
  C,
  METRICS,
  audienceName,
  categories,
  customRange,
  followCells,
  followersCard,
  groupsFor,
  interactions,
  interactionsCard,
  metricCard,
  num,
  overlayPrev,
  pct,
  perName,
  plural,
  publishingCard,
  publishingSeries,
  seriesFor,
  signed,
  span,
  summaries,
  visitRate,
  visitRateSeries,
  visitsCard,
  shareFileName,
  type Metric,
  type ShareCard,
  type View,
} from '../analytics/view';
import { compact, disposeCharts, legend, responsiveChart, sparkline, valuesTable, type Category, type Series } from '../chart/xy';
import { loadState } from '../store/chromeStore';
import { formatReportingDate, formatTimestamp } from '../calc/time';
import { disclosure, h, keepFocus } from './dom';
import { openShare, setShareSources, type ShareSource } from './analyticsShare';

const X_ANALYTICS = 'https://x.com/i/account_analytics';

type Range = 7 | 14 | 28 | 90 | 365 | 'all' | 'custom';
type Tab = 'history' | 'any' | 'days';

const app = document.getElementById('app')!;
let state: StoreState;
let handle = '';
let kind: SeriesKind = 'all';
let win: Range = 28;
let custom = { from: '', to: '' };
let customError = '';
let gran: Granularity = 'daily';
let includeToday = false;
let compare = true;
let metric: Metric = 'Impressions';
let tab: Tab = 'history';
let explorerMetric = 'Impressions';
let explorerType: 'bar' | 'line' = 'bar';
let daysSort: FigureKey = 'Impressions';

/** Accounts with any captured daily analytics, read from state on every draw so redraws keep the full list. */
const accountsWithDaily = () => Object.keys(state.accounts).filter((k) => (['all', 'verified'] as const).some((s) => sortedRows(state.accounts[k]!.daily?.[s]).length));

async function refresh() {
  try {
    state = await loadState();
  } catch (e) {
    showError((e as Error).message);
    return;
  }
  const withDaily = accountsWithDaily();
  if (!handle || !withDaily.includes(handle)) handle = withDaily.includes(state.settings.expectedHandle) ? state.settings.expectedHandle : (withDaily[0] ?? state.settings.expectedHandle);
  render();
}

function showError(message: string) {
  app.removeAttribute('aria-busy');
  app.replaceChildren(
    h('header', { class: 'xck-head' }, h('div', { class: 'xck-head-id' }, h('h1', { class: 'xck-title' }, 'Analytics'))),
    h('section', { class: 'xck-panel', 'aria-label': 'Could not read saved analytics', role: 'alert' },
      h('h2', { class: 'xck-section-title' }, 'Could not read your saved analytics'),
      h('p', { class: 'xck-lede' }, `This browser did not return the stored days (${message || 'unknown error'}). Nothing was changed or deleted.`),
      h('div', { class: 'xck-row', style: 'margin-top:12px' }, h('button', { type: 'button', class: 'xck-primary', 'data-key': 'retry', onclick: () => void refresh() }, 'Try again'))));
}

/** How a capture works, said the same way wherever the page asks for one. */
const READ_STEPS = (verified: boolean) => [
  verified ? 'Open X Analytics (Overview) and choose its Verified only filter.' : 'Open X Analytics (Overview) and wait for it to load.',
  'Choose the date range you want there. The extension reads only the range that page has loaded.',
  'Open the extension menu and choose Read current X tab.',
];

/** A labelled exclusive choice: native buttons with aria-pressed; `name` labels the group and keys focus. */
function seg<T extends string | number>(name: string, opts: { v: T; label: string; disabled?: boolean; describedBy?: string }[], cur: T, set: (v: T) => void) {
  return h('div', { class: 'xck-seg', role: 'group', 'aria-label': name }, ...opts.map((o) => h('button', {
    type: 'button', 'aria-pressed': String(o.v === cur), 'data-key': `${name}:${o.v}`,
    ...(o.disabled ? { disabled: true } : {}), ...(o.describedBy ? { 'aria-describedby': o.describedBy } : {}),
    onclick: () => (set(o.v), render()),
  }, o.label)));
}
const control = (label: string, ...children: (Node | null)[]) => h('div', { class: 'xck-control' }, h('span', { class: 'xck-control-label', 'aria-hidden': 'true' }, label), ...children);
const panel = (title: string, ...body: (Node | null | false)[]) => h('section', { class: 'xck-panel', 'aria-label': title }, ...body.filter((b): b is Node => !!b));

/** A section's Share image button. Disabled with its reason when the section has nothing honest to show. */
function shareButton(id: string, title: string, reason: string | null) {
  const key = `share:${id}`;
  const why = reason ? `share-why-${id}` : null;
  return h('span', { class: 'xck-share-open' },
    h('button', { type: 'button', class: 'xck-share-btn', 'data-key': key, 'aria-label': `Share image: ${title}`, ...(reason ? { disabled: true, 'aria-describedby': why! } : {}), onclick: () => openShare(id, key) },
      'Share image'),
    reason ? h('span', { class: 'xck-sr', id: why! }, reason) : null);
}

/** Legend, the chart at its container's width with its readout, and its exact values one click away. */
function chartBlock(id: string, cats: Category[], series: Series[], aria: string, opts: Partial<Parameters<typeof responsiveChart>[2]> = {}) {
  return h('div', { class: 'xck-chart-block' },
    series.length > 1 ? legend(series) : null,
    responsiveChart(cats, series, { ariaLabel: aria, width: 1100, height: 280, ...opts }),
    h('div', { class: 'xck-values' }, disclosure(`${id}-values`, 'Show values', plural(cats.length, 'row'), [h('div', { class: 'values-scroll' }, valuesTable(cats, series))])),
  );
}

function render() {
  disposeCharts(app);
  keepFocus(app, draw);
  app.removeAttribute('aria-busy');
}

function draw() {
  const today = utcDate(new Date());
  const acct = state.accounts[handle];
  const allRows = { all: sortedRows(acct?.daily?.all), verified: sortedRows(acct?.daily?.verified) };
  const series = acct?.daily?.[kind];
  const all = allRows[kind];
  const known = [...new Set([handle, ...accountsWithDaily()])].filter(Boolean);
  const header = h('header', { class: 'xck-head' },
    h('div', { class: 'xck-head-id' }, h('h1', { class: 'xck-title' }, 'Analytics'),
      known.length > 1 ? h('select', { 'aria-label': 'Account', 'data-key': 'account', onchange: (e) => ((handle = (e.target as HTMLSelectElement).value), render()) },
        ...known.map((k) => h('option', { value: k, ...(k === handle ? { selected: true } : {}) }, '@' + k))) : known.length ? h('span', { class: 'xck-muted' }, '@' + known[0]) : null),
    h('div', { class: 'xck-head-actions' }, h('button', { type: 'button', onclick: () => chrome.tabs.create({ url: X_ANALYTICS }) }, 'Open X Analytics ↗')),
  );

  const otherKind: SeriesKind = kind === 'all' ? 'verified' : 'all';
  const verifiedMissing = !allRows.verified.length;
  const audience = control('Audience',
    seg<SeriesKind>('Audience', [
      { v: 'all', label: 'All viewers', disabled: !allRows.all.length && kind !== 'all' },
      { v: 'verified', label: 'Verified only', disabled: verifiedMissing && kind !== 'verified', ...(verifiedMissing ? { describedBy: 'verified-availability' } : {}) },
    ], kind, (v) => (kind = v)),
    verifiedMissing && kind === 'all' ? h('p', { id: 'verified-availability', class: 'xck-reason' }, 'Verified only: not captured yet. On X Analytics choose Verified only, then use Read current X tab.') : null,
  );

  if (!all.length) {
    setShareSources({});
    const neither = !allRows[otherKind].length;
    const title = neither ? 'No X Analytics captured yet' : kind === 'verified' ? 'No Verified-only analytics captured yet' : 'No All-viewers analytics captured yet';
    app.replaceChildren(...[header,
      neither ? null : h('div', { class: 'xck-bar-controls' }, audience),
      panel(title,
        h('h2', { class: 'xck-section-title' }, title),
        h('p', { class: 'xck-lede' }, neither
          ? 'Read your X Analytics page once and this page shows impressions, engagement rate, profile visits and net follows for each UTC day.'
          : `Each audience comes from its own read of X Analytics. ${kind === 'verified' ? 'All viewers' : 'Verified only'} has captured days you can switch back to.`),
        h('ol', { class: 'xck-steps' }, ...READ_STEPS(kind === 'verified').map((t) => h('li', {}, t))),
        h('div', { class: 'xck-row' }, h('button', { type: 'button', class: 'xck-primary', onclick: () => chrome.tabs.create({ url: X_ANALYTICS }) }, 'Open X Analytics ↗'))),
    ].filter((n): n is HTMLElement => !!n));
    return;
  }

  // ---------- Range ----------
  const first = all[0]!.date;
  if (win === 'custom' && (!custom.from || !custom.to)) win = 28;
  const range: CalendarRange = win === 'custom' ? customRange(all, custom.from, custom.to, today) : calendarRange(all, { days: win, includeToday, today });
  const cells = range.cells;
  const rows = range.rows;
  const groups = win === 'all' ? groupsFor(Infinity) : groupsFor(cells.length);
  if (!groups.includes(gran)) gran = 'daily';
  const buckets: CellBucket[] = bucketCells(cells, gran);
  const canCompare = !!range.prev;
  const view: View = { handle, kind, range, buckets, gran, today, compare: compare && canCompare };
  const catsFor = (fields: string[], independent = false) => categories(buckets, gran, today, fields, independent);
  /** "· 26 of 28 captured days" when a total covers fewer days than were captured; nothing when it covers all. */
  const covNote = (days: number) => (days < rows.length ? ` · ${days} of ${plural(rows.length, 'captured day')}` : '');

  // ---------- Filters ----------
  const rangeSelect = h('select', { 'aria-label': 'Range', 'data-key': 'range', onchange: (e) => {
    const v = (e.target as HTMLSelectElement).value;
    if (v === 'custom') { custom = { from: range.start ?? first, to: range.end ?? addDay(today, -1) }; customError = ''; win = 'custom'; }
    else win = v === 'all' ? 'all' : (Number(v) as Range);
    render();
  } },
  ...([[7, 'Last 7 days'], [14, 'Last 14 days'], [28, 'Last 28 days'], [90, 'Last 90 days'], [365, 'Last 365 days'], ['all', 'All captured days'], ['custom', 'Custom dates']] as [Range, string][])
    .map(([v, t]) => h('option', { value: String(v), ...(v === win ? { selected: true } : {}) }, t)));
  const dateInput = (which: 'from' | 'to', label: string) => h('label', { class: 'xck-date' }, h('span', { class: 'xck-control-label' }, label),
    h('input', { type: 'date', 'data-key': `custom-${which}`, value: custom[which], min: first, max: today,
      ...(customError ? { 'aria-invalid': 'true', 'aria-describedby': 'custom-error' } : {}),
      onchange: (e) => {
        const value = (e.target as HTMLInputElement).value;
        const next = { ...custom, [which]: value };
        if (!/^\d{4}-\d{2}-\d{2}$/.test(next.from) || !/^\d{4}-\d{2}-\d{2}$/.test(next.to)) customError = 'Enter both dates.';
        else if (next.from > next.to) customError = 'The start date is after the end date.';
        else { customError = ''; custom = next; }
        render();
      } }));
  const rangeControl = control('Range', rangeSelect,
    win === 'custom' ? dateInput('from', 'From (UTC)') : null,
    win === 'custom' ? dateInput('to', 'To (UTC)') : null,
    win === 'custom' && customError ? h('p', { id: 'custom-error', class: 'xck-field-error', role: 'alert' }, `${customError} Showing ${range.start ? span(range.start, range.end!) : 'the last valid dates'}.`) : null,
    win !== 'custom' ? h('label', { class: 'xck-check' }, h('input', { type: 'checkbox', 'data-key': 'today', ...(includeToday ? { checked: true } : {}), onchange: (e) => ((includeToday = (e.target as HTMLInputElement).checked), render()) }), 'Show today (in progress)') : null);
  const groupControl = groups.length > 1 ? control('Group', seg<Granularity>('Group', groups.map((g) => ({ v: g, label: g === 'daily' ? 'Day' : g === 'weekly' ? 'Week' : 'Month' })), gran, (v) => (gran = v))) : null;
  const compareControl = control('Compare',
    seg<'prev' | 'off'>('Compare', [
      { v: 'prev', label: 'Previous period', disabled: !canCompare, ...(canCompare ? {} : { describedBy: 'compare-availability' }) },
      { v: 'off', label: 'Off' },
    ], view.compare ? 'prev' : 'off', (v) => (compare = v === 'prev')),
    canCompare ? null : h('p', { id: 'compare-availability', class: 'xck-reason' }, 'All captured days has no earlier period to compare with.'));
  const controls = h('div', { class: 'xck-bar-controls xck-filters', role: 'group', 'aria-label': 'Filters' }, rangeControl, audience, groupControl, compareControl);

  // ---------- Context ----------
  const read = series?.lastCaptureAt ? formatTimestamp(new Date(series.lastCaptureAt), 'UTC') : '—';
  const context = h('p', { id: 'analytics-source', class: 'xck-context' },
    `${audienceName(kind)} · `,
    h('b', {}, range.start && range.end ? span(range.start, range.end) : '—'),
    ` · UTC · ${rows.length} of ${plural(cells.length, 'day')} captured · last read ${read}`);
  const compareBlocked = view.compare && rows.length && changeOver(cells, range.prev, 'Impressions').kind === 'none' && range.prev?.length
    ? `No changes shown: comparing needs every day of ${span(range.start!, range.end!)} and of ${span(range.prev[0]!.date, range.prev.at(-1)!.date)} captured and complete.` : null;
  const noteItems = [
    range.missing.length && rows.length ? `${plural(range.missing.length, 'day')} in this range ${range.missing.length === 1 ? 'was' : 'were'} not captured and ${range.missing.length === 1 ? 'shows' : 'show'} as ${range.missing.length === 1 ? 'a gap' : 'gaps'}.` : null,
    range.incomplete.length ? `${range.incomplete.map(shortDate).join(', ')} ${range.incomplete.length === 1 ? 'was' : 'were'} read while still in progress, so ${range.incomplete.length === 1 ? 'its total is' : 'their totals are'} incomplete until X Analytics is read again.` : null,
    range.excludedToday ? `Today (${shortDate(range.excludedToday.date)}) is in progress and not included.` : null,
    range.includesToday && win === 'custom' ? `Today (${shortDate(today)}) is in progress; its total is incomplete.` : null,
    compareBlocked,
    range.start && range.start < first ? `Captured days start on ${shortDate(first)} ${first.slice(0, 4)}. For earlier days, choose a longer range on X Analytics and read that tab again.` : null,
  ].filter((x): x is string => !!x);
  const notes = noteItems.length ? h('ul', { id: 'analytics-notes', class: 'xck-notes' }, ...noteItems.map((t) => h('li', {}, t))) : null;
  // Coverage: one mark per UTC day of the range, so a day that was not read is a visible gap and never a zero.
  // It repeats what the context line and the notes say in words, so it is hidden from assistive technology.
  const coverage = cells.length ? h('div', { id: 'analytics-coverage', class: `xck-cover${cells.length > 400 ? ' densest' : cells.length > 120 ? ' dense' : ''}`, 'aria-hidden': 'true' },
    ...cells.map((c) => h('i', { class: !c.row ? 'gap' : c.row.partial ? 'part' : 'read', title: `${shortDate(c.date)} ${c.date.slice(0, 4)} (UTC) · ${!c.row ? 'not captured' : c.row.partial ? 'read while in progress' : 'captured'}` }))) : null;

  // ---------- Metric tiles ----------
  const sums = summaries(view);
  if (!sums[metric].ok) metric = 'Impressions';
  /** The tile's own series over the same periods as the chart, as a trend line; none for a figure that shows "—". */
  const spark = (m: Metric) => {
    if (!sums[m].ok || !rows.length) return null;
    const own = seriesFor(m, view).find((x) => (m === 'NetFollows' ? x.type === 'line' : true))!;
    return sparkline(own.values, catsFor(fieldsFor(m)).map((c) => !!c.partial), C.main);
  };
  const tile = (d: (typeof METRICS)[number]) => {
    const s = sums[d.key];
    return h('label', { class: 'xck-tile' },
      h('input', { type: 'radio', name: 'metric', value: d.key, 'data-key': `metric:${d.key}`, ...(metric === d.key ? { checked: true } : {}), ...(s.ok ? {} : { disabled: true }),
        onchange: () => ((metric = d.key), render()) }),
      h('span', { class: 'xck-figure-label' }, d.label),
      h('span', { class: `xck-figure${s.tone === 'up' ? ' xck-up' : s.tone === 'down' ? ' xck-down' : ''}`, style: 'display:block' }, s.value),
      ...s.subs.map((t) => h('span', { class: `xck-figure-sub${s.change && t === s.change.text ? ` xck-change xck-change-${s.change.tone}` : ''}`, style: 'display:block' }, t)),
      spark(d.key));
  };
  const tiles = h('fieldset', { class: 'xck-tiles', 'aria-describedby': 'analytics-source' }, h('legend', { class: 'xck-sr' }, 'Chart metric'), ...METRICS.map(tile));

  // ---------- Main chart ----------
  const def = METRICS.find((d) => d.key === metric)!;
  const per = perName(gran);
  const chartTitle = `${kind === 'verified' ? 'Verified viewers: ' : ''}${def.chart} per ${per}`;
  const chartHead = h('div', { class: 'xck-section-head' },
    h('h2', { class: 'xck-section-title', id: 'main-chart-title' }, chartTitle),
    shareButton('main', def.label, rows.length ? null : 'No captured days in this range.'));
  const mainSeries = seriesFor(metric, view);
  const prevNote = view.compare && metric !== 'NetFollows'
    ? (overlayPrev(view, metric) ? `The thin grey line is the previous ${plural(cells.length, 'day')} (${span(range.prev![0]!.date, range.prev!.at(-1)!.date)}), day for day.` : gran !== 'daily' ? 'The previous-period line shows when grouped by day.' : 'The previous-period line needs a complete value for every prior day. Missing or in-progress values are not used as a comparison line.')
    : null;
  const main = rows.length
    ? h('section', { class: 'xck-main-chart', 'aria-labelledby': 'main-chart-title' }, chartHead,
      chartBlock('an-main', catsFor(fieldsFor(metric)), mainSeries, `${def.chart} per ${per}, ${range.start ? span(range.start, range.end!) : ''}, UTC`, metric === 'EngagementRate' ? { yFormat: (v) => `${compact(v * 100)}%` } : {}),
      h('p', { id: 'analytics-metric-note', class: 'xck-caption' }, def.caption, prevNote ? ` ${prevNote}` : ''))
    : h('section', { class: 'xck-main-chart', 'aria-labelledby': 'main-chart-title' }, chartHead,
      h('div', { class: 'xck-empty-chart' },
        h('p', { style: 'margin:0 0 12px' }, range.start ? `No days captured between ${shortDate(range.start)} and ${shortDate(range.end!)} ${range.end!.slice(0, 4)}.` : 'No captured days in this range.'),
        h('div', { class: 'xck-row' },
          h('button', { type: 'button', class: 'xck-primary', onclick: () => chrome.tabs.create({ url: X_ANALYTICS }) }, 'Open X Analytics ↗'),
          h('button', { type: 'button', 'data-key': 'show-all', onclick: () => ((win = 'all'), render()) }, 'Show all captured days'))));

  // ---------- Breakdowns ----------
  const small = { width: 560, height: 200 };
  const it = interactions(cells);
  const maxType = Math.max(1, ...it.rows.map((t) => t.commonTotal ?? 0));
  const sectionHead = (id: string, title: string, reason: string | null, extra?: Node | null) =>
    h('div', { class: 'xck-section-head' }, h('h3', { class: 'xck-section-title' }, title), h('div', { class: 'xck-row' }, extra ?? null, shareButton(id, title, reason)));
  const interactionsPanel = panel('Interactions',
    sectionHead('interactions', 'Interactions', it.commonDays && it.rows.length ? null : 'No days report every listed interaction type.',
      it.total != null ? h('span', { class: 'xck-muted xck-small' }, `${num(it.total)} in all${it.commonDays < rows.length ? ` · ${it.commonDays} of ${plural(rows.length, 'captured day')}` : ''}`) : null),
    it.rows.length
      ? h('ul', { class: 'xck-barlist', id: 'an-interactions' }, ...it.rows.map((t) => h('li', {},
        h('span', {}, t.label, it.commonDays < rows.length ? h('span', { class: 'xck-muted xck-small' }, covNote(it.commonDays)) : null),
        h('span', { class: 'xck-barlist-figs' }, h('span', { class: 'xck-num' }, num(t.commonTotal)), h('span', { class: 'xck-share-pct', title: 'Share of listed interactions' }, t.share == null ? '—' : `${(t.share * 100).toFixed(1)}%`)),
        h('span', { class: 'xck-bar', 'aria-hidden': 'true' }, h('i', { style: `width:${(((t.commonTotal ?? 0) / maxType) * 100).toFixed(1)}%` })))))
      : h('p', { class: 'xck-muted' }, 'Interaction types are not in this capture.'),
    it.rows.length ? h('p', { class: 'xck-caption' }, `Percent = each type ÷ all listed interactions. Counts and percentages use the same ${plural(it.commonDays, 'day')} that reported every type. By day keeps each type’s available observations. X also counts clicks and expands as engagements; they are not listed here.`) : null,
    it.rows.length ? disclosure('an-mix', 'By day', `per ${per}`, [chartBlock('an-mix-chart', catsFor(it.rows.slice(0, 5).map((t) => t.key), true),
      it.rows.slice(0, 5).map((t, i) => ({ name: t.label, color: [C.main, 'color-mix(in srgb, var(--xck-an-line) 65%, var(--xck-text))', 'color-mix(in srgb, var(--xck-an-line) 40%, var(--xck-series-2))', C.ref, 'var(--xck-text-2)'][i]!, fill: [C.fill, 'color-mix(in srgb, var(--xck-an-line) 62%, var(--xck-surface))', 'color-mix(in srgb, var(--xck-an-line) 32%, var(--xck-surface))', C.refFill, 'color-mix(in srgb, var(--xck-series-2) 45%, var(--xck-surface))'][i]!, type: 'bar' as const, stack: 'e', values: buckets.map((b) => figureOver(b.cells, t.key).value) })),
      'Interactions by type', small)]) : null);
  const followDays = figureOver(cells, 'NetFollows').days;
  const followers = metric === 'NetFollows' ? null : panel('Followers',
    sectionHead('followers', 'Followers', sums.NetFollows.ok ? null : 'Needs follows and unfollows on every captured day.',
      followDays ? h('span', { class: 'xck-muted xck-small' }, `${num(figureOver(followCells(cells), 'Follows').value)} follows · ${num(figureOver(followCells(cells), 'Unfollows').value)} unfollows${covNote(followDays)}`) : null),
    followDays ? chartBlock('an-follows', catsFor(['Follows', 'Unfollows']), seriesFor('NetFollows', view), 'Follows and unfollows', small) : h('p', { class: 'xck-muted' }, 'Follow and unfollow events are not in this capture.'));
  const posts = figureOver(cells, 'CreateTweet');
  const replies = figureOver(cells, 'CreateReply');
  const publishing = panel('Publishing',
    sectionHead('publishing', 'Publishing', posts.days || replies.days ? null : 'Publishing counts are not in this capture.',
      h('span', { class: 'xck-muted xck-small' }, `${num(posts.value)} posts${covNote(posts.days)} · ${num(replies.value)} replies published${covNote(replies.days)}`)),
    posts.days || replies.days
      ? chartBlock('an-publish', catsFor(['CreateTweet', 'CreateReply'], true), publishingSeries(view), 'Posts and replies published', small)
      : h('p', { class: 'xck-muted' }, 'Publishing counts are not in this capture.'));
  const vr = visitRate(view);
  const visits = panel('Profile visits per 1K impressions',
    sectionHead('visits', 'Profile visits per 1K impressions', vr.value == null ? 'Needs profile visits and impressions on the same days.' : null,
      h('span', { class: 'xck-muted xck-small' }, vr.value == null ? '—' : `${vr.value.toFixed(2)} ${vr.days < rows.length ? `over ${vr.days} of ${plural(rows.length, 'captured day')}` : 'over the range'}${vr.change ? ` · ${vr.change.text}` : ''}`)),
    vr.days ? chartBlock('an-visit-rate', catsFor(['ProfileVisits', 'Impressions']), visitRateSeries(view), 'Profile visits per 1K impressions', { ...small, yFormat: compact }) : h('p', { class: 'xck-muted' }, 'Needs profile visits and impressions on the same days.'),
    h('p', { class: 'xck-caption' }, 'A ratio of daily totals: visits ÷ impressions × 1,000. It does not show which impressions led to a visit.'));
  const breakdowns = h('section', { class: 'xck-breakdowns', 'aria-labelledby': 'breakdowns-title' },
    h('h2', { class: 'xck-group-title', id: 'breakdowns-title' }, 'Breakdowns'),
    h('p', { class: 'xck-lede', style: 'margin:2px 0 12px' }, 'What sits behind the four figures, for the same days. Each section can be saved as an image.'),
    h('div', { class: 'xck-grid2' }, interactionsPanel, ...(followers ? [followers] : []), publishing, visits));

  // ---------- Share sources: the same view the page shows ----------
  const src = (card: (show: boolean) => ShareCard): ShareSource => ({ card, fileName: (c) => shareFileName(c, view) });
  setShareSources({
    main: src((show) => metricCard(view, metric, sums[metric], show)),
    interactions: src((show) => interactionsCard(view, show)),
    followers: src((show) => followersCard(view, sums.NetFollows, show)),
    publishing: src((show) => publishingCard(view, show)),
    visits: src((show) => visitsCard(view, show)),
  });

  const explore = exploreSection(all, range, buckets, gran, today);
  const footer = h('p', { class: 'xck-context xck-totals' },
    `Captured history: ${plural(all.length, 'day')}, ${span(all[0]!.date, all.at(-1)!.date)} (UTC). Stored in this browser. Read current X tab adds the range loaded on the X Analytics tab you have open.`);

  app.replaceChildren(header, controls, h('div', { class: 'xck-context-block' }, coverage, context, notes), h('section', { class: 'xck-panel xck-overview', 'aria-label': 'Overview' }, tiles, main), breakdowns, explore, footer);
}

const addDay = (ymd: string, n: number) => utcDate(Date.parse(ymd + 'T00:00:00Z') + n * 86_400_000);

function exploreSection(all: ReturnType<typeof sortedRows>, range: CalendarRange, buckets: CellBucket[], g: Granularity, today: string): HTMLElement {
  const tabs: { v: Tab; label: string }[] = [{ v: 'history', label: 'History' }, { v: 'any', label: 'Any metric' }, { v: 'days', label: 'Days to look at' }];
  const tabEls = tabs.map((t) => h('button', {
    type: 'button', role: 'tab', id: `tab-${t.v}`, 'aria-controls': 'explore-panel', 'aria-selected': String(t.v === tab), tabindex: t.v === tab ? '0' : '-1', 'data-key': `tab:${t.v}`,
    onclick: () => ((tab = t.v), render()),
    onkeydown: (e) => {
      const k = (e as KeyboardEvent).key;
      const i = tabs.findIndex((x) => x.v === tab);
      const next = ({ ArrowRight: (i + 1) % tabs.length, ArrowLeft: (i + tabs.length - 1) % tabs.length, Home: 0, End: tabs.length - 1 } as Record<string, number>)[k];
      if (next == null) return;
      e.preventDefault();
      tab = tabs[next]!.v;
      render();
      document.getElementById(`tab-${tab}`)?.focus();
    },
  }, t.label));
  const per = perName(g);
  let body: Node[];
  if (tab === 'history') {
    const history = calendarRange(all, { days: 'all', includeToday: false, today });
    const months = bucketCells(history.cells, 'monthly');
    const daily = range.cells.map((c) => dayValue(c.row, 'Impressions'));
    const dailyCats = categories(bucketCells(range.cells, 'daily'), 'daily', today, ['Impressions', 'NetFollows'], true);
    const netDaily = range.cells.map((c) => dayValue(c.row, 'NetFollows'));
    const wd = weekdayAverages(range.rows, 'Impressions');
    const wdReady = wd.every((d) => d.n >= 4);
    body = [
      h('h3', { class: 'xck-section-title' }, 'Monthly impressions, every captured month'),
      months.length ? chartBlock('an-monthly', categories(months, 'monthly', today, ['Impressions']), [{ name: 'Impressions', color: C.main, fill: C.fill, type: 'bar', values: months.map((b) => figureOver(b.cells, 'Impressions').value) }], 'Monthly impressions', { height: 240 }) : h('p', { class: 'xck-muted' }, 'No complete days captured yet.'),
      h('p', { class: 'xck-caption' }, 'Hatched months were not captured on every day; the readout says how many were.'),
      h('div', { class: 'xck-grid2', style: 'margin-top:20px' },
        h('div', {},
          h('h3', { class: 'xck-section-title' }, 'Running totals for this range'),
          chartBlock('an-running', dailyCats, [
            { name: 'Impressions so far', color: C.main, type: 'line', values: runningTotal(daily) },
            ...(netDaily.some((v) => v != null) ? [{ name: 'Net follows so far', color: C.ref, type: 'line' as const, axis: 'right' as const, values: runningTotal(netDaily), format: signed }] : []),
          ], 'Running totals of captured days', { width: 560, height: 220 }),
          h('p', { class: 'xck-caption' }, 'Totals of captured days only. A day that was not captured is a gap and adds nothing.')),
        h('div', {},
          h('h3', { class: 'xck-section-title' }, 'Average impressions by UTC weekday'),
          wdReady
            ? chartBlock('an-weekday', wd.map((d) => ({ label: d.label, title: `${d.label} (${d.n} days)` })), [{ name: 'Average impressions', color: C.main, fill: C.fill, type: 'bar', values: wd.map((d) => (d.avg == null ? null : Math.round(d.avg))) }], 'Average impressions by UTC weekday', { width: 560, height: 220 })
            : h('p', { class: 'xck-muted' }, 'Appears when every weekday has at least 4 complete days in this range. Choose a longer range.'),
          wdReady ? h('p', { class: 'xck-caption' }, 'Averages of complete days in this range. They describe past days only.') : null)),
    ];
  } else if (tab === 'any') {
    const keys = Object.keys(METRIC_NAMES).filter((k) => all.some((r) => k in r.metrics));
    if (!keys.includes(explorerMetric)) explorerMetric = keys[0] ?? 'Impressions';
    const rate = explorerMetric === 'EngagementRate';
    body = [
      h('div', { class: 'xck-row', style: 'margin-bottom:12px' },
        control('Metric', h('select', { 'aria-label': 'Metric', 'data-key': 'explorer-metric', onchange: (e) => ((explorerMetric = (e.target as HTMLSelectElement).value), render()) },
          ...keys.map((k) => h('option', { value: k, ...(k === explorerMetric ? { selected: true } : {}) }, METRIC_NAMES[k]!)))),
        control('Chart', seg<'bar' | 'line'>('Chart type', [{ v: 'bar', label: 'Bar' }, { v: 'line', label: 'Line' }], explorerType, (v) => (explorerType = v)))),
      chartBlock('an-explorer', categories(buckets, g, today, fieldsFor(explorerMetric)), [{ name: METRIC_NAMES[explorerMetric] ?? explorerMetric, color: C.main, type: explorerType, ...(explorerType === 'bar' ? { fill: C.fill } : { area: true }), values: buckets.map((b) => figureOver(b.cells, explorerMetric).value), ...(rate ? { format: pct } : {}) }],
        `${METRIC_NAMES[explorerMetric] ?? explorerMetric} per ${per}`, { height: 260, ...(rate ? { yFormat: (v: number) => `${compact(v * 100)}%` } : {}) }),
    ];
  } else {
    const sorts: [FigureKey, string][] = [['Impressions', 'Impressions'], ['ProfileVisits', 'Profile visits'], ['NetFollows', 'Net follows'], ['Engagements', 'Engagements']];
    const best = topDaysBy(range.rows, daysSort, 10);
    const cell = (v: number | null, f: (x: number) => string = num) => h('td', { class: 'xck-num' }, v == null ? '—' : f(v));
    body = [
      h('div', { class: 'xck-row', style: 'margin-bottom:12px' }, control('Sort by', h('select', { 'aria-label': 'Sort by', 'data-key': 'days-sort', onchange: (e) => ((daysSort = (e.target as HTMLSelectElement).value), render()) },
        ...sorts.map(([k, t]) => h('option', { value: k, ...(k === daysSort ? { selected: true } : {}) }, t))))),
      best.length
        ? h('div', { class: 'xck-scroll' }, h('table', { class: 'xck-table', id: 'an-days' },
          h('thead', {}, h('tr', {}, ...['Day (UTC)', 'Impressions', 'Engagements', 'Engagement rate', 'Profile visits', 'Net follows', 'Posts', 'Replies published'].map((t, i) => h('th', i ? { class: 'xck-num' } : {}, t)))),
          h('tbody', {}, ...best.map((r) => h('tr', {}, h('td', {}, formatReportingDate(r.date)),
            cell(dayValue(r, 'Impressions')), cell(dayValue(r, 'Engagements')), cell(dayValue(r, 'EngagementRate'), pct), cell(dayValue(r, 'ProfileVisits')), cell(dayValue(r, 'NetFollows'), signed), cell(dayValue(r, 'CreateTweet')), cell(dayValue(r, 'CreateReply')))))))
        : h('p', { class: 'xck-muted' }, 'No complete days with this figure in the range.'),
      h('p', { class: 'xck-caption' }, 'The ten highest complete days in this range. Daily totals cannot tell which post drove a day; open X Analytics for post-level detail.'),
    ];
  }
  return h('section', { class: 'xck-panel xck-explore', 'aria-label': 'Explore' },
    disclosure('an-explore', 'Explore', 'Monthly history, running totals, any captured field, and the days to look at', [
      h('div', { class: 'xck-tabs', role: 'tablist', 'aria-label': 'Explore' }, ...tabEls),
      h('div', { id: 'explore-panel', role: 'tabpanel', 'aria-labelledby': `tab-${tab}` }, ...body)]));
}

chrome.storage.onChanged.addListener((_c, area) => area === 'local' && void refresh());
void refresh();

mountNavigation();
