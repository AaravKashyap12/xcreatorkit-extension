import { mountNavigation } from './navigation';
import type { StoreState } from '../model/types';
import { parseCount } from '../model/parse';
import { dailyCheckpoints, rewardsProgress, rewardsReadings, sourceHealth, windowChange } from '../calc/rewards';
import { addDaysYmd, buildPace, formatRate, paceSummary, type Pace } from '../calc/pace';
import { dayOneDate, formatTimestamp, pickDayOne, suggestDayNumber } from '../calc/time';
import { shortDate } from '../analytics/series';
import { compact, disposeCharts, legend, responsiveChart, valuesTable, type Category, type Series } from '../chart/xy';
import { buildCardModel } from '../card/model';
import { renderCard, type CardFormat } from '../card/render';
import {
  addObservation,
  buildObservation,
  deleteObservation,
  exportBackup,
  importBackup,
  normalizeHandle,
  observationsCsv,
} from '../store/state';
import { loadState, saveState, snapshotBeforeImport, updateState } from '../store/chromeStore';
import { disclosure, download, h, keepFocus } from './dom';

const app = document.getElementById('app')!;
let state: StoreState;
let current = '';
let cardFormat: CardFormat = 'portrait';
let dayConfirmed = false;
let dayValue: number | null = null;
/** A form's last confirmation, kept across redraws until that form is used again. */
const flash: Record<string, string> = {};
const takeFlash = (k: string) => flash[k] ?? '';

async function refresh() {
  state = await loadState();
  const handles = Object.keys(state.accounts).filter((k) => k !== '_unknown' && state.accounts[k]!.observations.length);
  if (!current || !handles.includes(current)) current = handles.includes(state.settings.expectedHandle) ? state.settings.expectedHandle : (handles[0] ?? state.settings.expectedHandle);
  render(handles);
}

function panel(title: string, ...body: (Node | string | null | false)[]) {
  return h('section', { class: 'xck-panel', 'aria-label': title }, h('h2', { class: 'xck-section-title' }, title), ...body);
}

function render(handles: string[]) {
  disposeCharts(app);
  keepFocus(app, () => draw(handles));
  app.removeAttribute('aria-busy');
}

/** A labelled field with its hint and an error slot above the input, so a problem is named where it is. */
function field(label: string, input: HTMLInputElement, hint?: string) {
  const id = `f-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  input.id = id;
  const err = h('span', { class: 'xck-field-error', id: `${id}-error`, hidden: true });
  const hintEl = hint ? h('span', { class: 'xck-field-hint', id: `${id}-hint` }, hint) : null;
  if (hint) input.setAttribute('aria-describedby', `${id}-hint`);
  return h('div', { class: 'xck-field' }, h('label', { for: id }, label), hintEl, err, input);
}

/** Show (or clear) the error for one field. The typed value stays; focus moves to the field. */
function fieldError(input: HTMLInputElement, message: string | null) {
  const err = document.getElementById(`${input.id}-error`)!;
  const hint = document.getElementById(`${input.id}-hint`);
  err.textContent = message ?? '';
  err.hidden = !message;
  if (message) input.setAttribute('aria-invalid', 'true');
  else input.removeAttribute('aria-invalid');
  input.setAttribute('aria-describedby', [hint?.id, message ? err.id : null].filter(Boolean).join(' '));
  if (message) input.focus();
  return !message;
}

function draw(handles: string[]) {
  const now = new Date();
  const s = state.settings;
  const acct = state.accounts[current] ?? { observations: [], attempts: [] };
  const readings = rewardsReadings(acct.observations);
  const health = sourceHealth(readings, acct.attempts, s, now);
  const latest = health.latest;

  // --- Header
  const known = [...new Set([current, ...handles])].filter(Boolean);
  const accountSel = known.length
    ? h('select', { 'aria-label': 'Account', 'data-key': 'account', onchange: (e) => ((current = (e.target as HTMLSelectElement).value), render(handles)) },
      ...known.map((k) => h('option', { value: k, ...(k === current ? { selected: true } : {}) }, '@' + k)))
    : h('span', { class: 'xck-muted xck-small' }, 'No account yet');
  const header = h(
    'header',
    { class: 'xck-head' },
    h('div', { class: 'xck-head-id' }, h('h1', { class: 'xck-title' }, 'Rewards pace'), accountSel,
      h('span', { class: 'xck-status' }, h('span', { class: `xck-status-dot ${health.state}`, 'aria-hidden': 'true' }), labelFor(health.state))),
    h('div', { class: 'xck-head-actions' },
      h('button', { onclick: () => chrome.tabs.create({ url: 'https://x.com/i/jf/creators/original_content_rewards' }) }, 'Open Rewards ↗'),
      h('button', { onclick: () => chrome.tabs.create({ url: 'https://x.com/i/account_analytics' }) }, 'Open X Analytics ↗'),
    ),
  );

  // --- Hero
  let hero: HTMLElement;
  if (latest) {
    const p = rewardsProgress(latest, s.rewardsTarget);
    hero = h(
      'section',
      { class: 'xck-panel xck-hero', 'aria-label': 'Measured reading' },
      h('div', { class: 'xck-hero-label' }, 'Verified Home Timeline impressions · 90-day rolling window · excludes replies'),
      h('div', { class: 'xck-hero-num' }, latest.displayText, latest.precision === 'rounded' ? h('span', { class: 'xck-approx', title: 'X displays this rounded' }, 'rounded') : null),
      h('div', { class: 'xck-meter', role: 'img', 'aria-label': `${p.percentText} of ${p.targetText}` }, h('div', { class: 'xck-meter-fill', style: `width:${Math.min(100, p.percent).toFixed(2)}%` })),
      h('div', { class: 'xck-meter-legend' }, h('span', {}, `${p.percentText} of ${p.targetText}`), h('span', {}, p.remainingText)),
      h(
        'div',
        { class: 'xck-hero-meta' },
        latest.provenance === 'captured' ? h('span', { class: 'xck-stamp' }, 'Captured from X') : null,
        ` ${latest.provenance === 'captured' ? '' : latest.provenance === 'manual' ? 'Entered by hand ' : 'Imported '}${formatTimestamp(new Date(latest.capturedAt), s.reportingTimeZone)}`,
        latest.lastSeenAt !== latest.capturedAt ? ` · re-confirmed ${formatTimestamp(new Date(latest.lastSeenAt), s.reportingTimeZone)}` : '',
        ` · ${latest.sourceLabel}`,
      ),
    );
  } else {
    hero = h(
      'section',
      { class: 'xck-panel xck-hero xck-hero-empty', 'aria-label': 'Measured reading' },
      h('div', { class: 'xck-hero-label' }, 'Verified Home Timeline impressions · 90-day rolling window'),
      h('h2', { class: 'xck-section-title', style: 'margin-top:8px' }, `No rewards reading yet${current ? ` for @${current}` : ''}`),
      h('p', { class: 'xck-lede' }, 'Your measured figure, its pace to the target and a straight-line projection appear here.'),
      h('ol', { class: 'xck-steps' }, h('li', {}, 'Open Rewards on X (Creator Studio).'), h('li', {}, 'Choose “Read current X tab” in the extension menu.')),
      h('div', { class: 'xck-row' }, h('button', { type: 'button', class: 'xck-primary', onclick: () => chrome.tabs.create({ url: 'https://x.com/i/jf/creators/original_content_rewards' }) }, 'Open Rewards on X ↗'), h('span', { class: 'xck-muted xck-small' }, 'Reading it on the X app? Add it by hand under Readings and setup.')),
    );
  }

  // --- Source health
  const healthPanel = panel(
    'Source health',
    h('p', { class: `xck-health ${health.state}` }, h('b', {}, labelFor(health.state)), ' — ', health.message),
    health.flags.length ? h('ul', { class: 'xck-flags' }, ...health.flags.map((f) => h('li', {}, f))) : null,
  );

  // --- Pace: rate, need, ETA and the two charts (measured readings only; projection is a labelled straight line).
  const daily = dailyCheckpoints(readings);
  const prev = daily.length >= 2 ? daily[daily.length - 2]! : null;
  const change = latest && prev && prev.id !== latest.id ? windowChange(prev, latest, s) : null;
  const pace = latest ? buildPace(readings, s.rewardsTarget, now.toISOString().slice(0, 10)) : null;
  const paceEls = pace ? paceSection(pace, change) : [panel('Pace to ' + compact(s.rewardsTarget), h('p', { class: 'xck-muted' }, '— · Pace appears after rewards readings on two UTC dates at least two days apart.'))];

  // --- Readings table
  const table = h(
    'table',
    { class: 'xck-table' },
    h('thead', {}, h('tr', {}, ...['Reporting day', 'Value', 'Precision', 'Provenance', 'First seen', 'Last seen', 'Window', ''].map((t) => h('th', {}, t)))),
    h(
      'tbody',
      {},
      ...[...readings].reverse().map((o) =>
        h(
          'tr',
          {},
          h('td', {}, o.reportingDate),
          h('td', { class: 'xck-num' }, o.displayText),
          h('td', {}, o.precision),
          h('td', {}, o.provenance),
          h('td', {}, formatTimestamp(new Date(o.capturedAt), s.reportingTimeZone)),
          h('td', {}, formatTimestamp(new Date(o.lastSeenAt), s.reportingTimeZone)),
          h('td', {}, o.windowType === 'rolling_90d' ? '90-day' : 'unconfirmed'),
          h('td', {}, h('button', {
            class: 'xck-link',
            onclick: async () => {
              if (!confirm(`Delete the ${o.displayText} reading from ${o.reportingDate}? This cannot be undone (export a backup first if unsure).`)) return;
              await updateState((st) => deleteObservation(st, current, o.id));
              void refresh();
            },
          }, 'Delete')),
        ),
      ),
    ),
  );
  const readingsPanel = disclosure('rw-readings', 'Readings', readings.length ? `${readings.length} ${readings.length === 1 ? 'reading' : 'readings'} · newest first` : 'none yet',
    [readings.length ? h('div', { class: 'xck-scroll xck-readings' }, table) : h('p', { class: 'xck-muted' }, 'None yet.')]);

  app.replaceChildren(header, hero, ...paceEls, cardPanel(now),
    h('section', { class: 'xck-setup', 'aria-labelledby': 'setup-title' },
      h('h2', { id: 'setup-title', class: 'xck-group-title' }, 'Readings and setup'),
      h('div', { class: 'xck-panel' }, healthPanel, readingsPanel,
      disclosure('rw-manual', 'Add a reading by hand', 'from the rewards screen on the X app', [manualPanel()], !readings.length),
      disclosure('rw-settings', 'Settings', 'handle · Day 1 · target · stale after', [settingsPanel()]),
      disclosure('rw-data', 'Backup and data', 'export · import · delete', [dataPanel()])),
    ));
}

// Cobalt for measured readings; dashed slate for the derived straight-line projection.
const C = { measured: 'var(--xck-accent)', projection: 'var(--xck-series-2)' };

function tile(label: string, value: string, sub: string, tone: '' | 'pos' | 'neg' = '') {
  return h('div', { class: 'xck-stat' }, h('div', { class: 'xck-figure-label' }, label), h('div', { class: `xck-figure${tone ? ` xck-${tone === 'pos' ? 'up' : 'down'}` : ''}` }, value), h('div', { class: 'xck-figure-sub' }, sub));
}

/** Callout, four tiles, progress-to-target chart and daily-net-change chart. */
function paceSection(p: Pace, change: ReturnType<typeof windowChange> | null): HTMLElement[] {
  const target = compact(p.target);
  const sum = paceSummary(p, shortDate);
  const callout = h('div', { class: `xck-callout ${p.status}` }, h('b', {}, sum.title), h('p', {}, sum.body));
  const r = p.rate;
  const tiles = h(
    'div',
    { class: 'xck-stat-row' },
    tile('Your rate', r ? formatRate(r.perDay, r.approximate) : '—', r ? `per day · over ${r.spanDays} days (${shortDate(r.from)} → ${shortDate(r.to)})` : (p.reasons[0] ?? ''), r ? (r.perDay >= p.need.perDay ? 'pos' : r.perDay < 0 ? 'neg' : '') : ''),
    tile('You need', formatRate(p.need.perDay), `per day, sustained · ${target} ÷ 90 days`),
    tile('Full window at this rate', p.fullWindowAtRate != null ? `≈${compact(p.fullWindowAtRate)}` : '—', p.fullWindowAtRate != null ? (p.fullWindowAtRate >= p.target ? 'above target if the pace holds' : 'below target if the pace holds') : 'needs a rate', p.fullWindowAtRate != null ? (p.fullWindowAtRate >= p.target ? 'pos' : 'neg') : ''),
    tile(
      `Hits ${target}`,
      p.status === 'reached' ? 'Reached' : p.eta ? shortDate(p.eta.date) : '—',
      p.status === 'reached' ? `hold ${formatRate(p.need.perDay)}/day to stay there` : p.eta ? `in ~${p.eta.days} days at this rate${p.status === 'behind' ? ' · only if nothing expires' : ''}` : p.status === 'falling' ? 'window shrinking' : 'needs a rate',
    ),
  );
  const basis = h('p', { class: 'xck-caption xck-pace-basis' }, r
    ? `Straight-line pace from measured readings ${shortDate(r.from)} → ${shortDate(r.to)} (${r.spanDays} UTC days). It assumes the rate holds; it is not a forecast.`
    : 'Pace uses measured readings only, as a straight line between them.');
  const pacePanel = panel('Pace to ' + target, callout, basis, tiles);

  // Progress chart: measured checkpoints + dashed projection, from the first reading to the projection end.
  const cpBy = new Map(p.checkpoints.map((c) => [c.date, c]));
  const projBy = new Map(p.projection.map((x) => [x.date, x.value]));
  const first = p.checkpoints[0]!.date;
  const latestDate = p.checkpoints.at(-1)!.date;
  const end = p.projection.at(-1)?.date ?? latestDate;
  const dates: string[] = [];
  for (let d = first; d <= end; d = addDaysYmd(d, 1)) dates.push(d);
  const cats: Category[] = dates.map((d) => ({ label: shortDate(d), title: `${shortDate(d)} ${d.slice(0, 4)}${cpBy.has(d) ? ` · ${cpBy.get(d)!.displayText}` : ''}`, ...(d > latestDate ? { note: 'projection only' } : cpBy.has(d) ? {} : { note: 'no reading' }) }));
  const measured: Series = { name: 'Measured readings', color: C.measured, type: 'line', values: dates.map((d) => cpBy.get(d)?.value ?? null) };
  const projected: Series = { name: 'Straight-line projection', color: C.projection, type: 'line', dashed: true, values: dates.map((d) => projBy.get(d) ?? null) };
  const progressSeries = p.projection.length ? [measured, projected] : [measured];
  // The values table lists the days that carry a reading, plus the projection's end.
  const rowsAt = dates.flatMap((_, i) => (measured.values[i] != null || i === dates.length - 1 ? [i] : []));
  const progressValues = valuesTable(rowsAt.map((i) => cats[i]!), progressSeries.map((x) => ({ ...x, values: rowsAt.map((i) => x.values[i]!) })));
  const progressPanel =
    p.checkpoints.length >= 2
      ? panel(
          `Progress to ${target}`,
          h('p', { class: 'xck-caption' }, `Blue line and points = measured readings (one per reporting day, UTC). ${p.projection.length ? `Dashed grey = a straight line at the measured rate${p.eta?.beyondProjection ? `, cut at ${p.projection.length - 1} days (${target} would be ${p.eta.days} days out)` : ''}; it is not a forecast of X's behaviour.` : ''}${p.checkpoints.length < dates.filter((d) => d <= latestDate).length ? ' Gaps are days with no reading.' : ''}`),
          h('div', { class: 'xck-chart-block' },
            legend(progressSeries),
            responsiveChart(cats, progressSeries, { ariaLabel: `Progress to ${target}`, width: 940, height: 300, refLine: { value: p.target, label: `${target} target` }, readoutStart: dates.indexOf(latestDate) }),
            h('div', { class: 'xck-values' }, disclosure('rw-progress-values', 'Show values', `${rowsAt.length} rows`, [h('div', { class: 'values-scroll' }, progressValues)]))),
        )
      : panel('Progress to ' + target, h('p', { class: 'xck-empty-chart' }, 'One reading so far. The chart appears once there are readings on two different reporting days.'));

  // Daily net change vs the holding pace.
  const gainCats: Category[] = p.gains.map((g) => ({ label: shortDate(g.date), partial: g.partial, title: `${shortDate(g.date)} ${g.date.slice(0, 4)}` }));
  const gainSeries: Series[] = [{ name: 'Net change in the 90-day window vs previous day', color: C.measured, type: 'bar', values: p.gains.map((g) => g.delta) }];
  const anyGain = p.gains.some((g) => g.delta != null);
  const gainsPanel = anyGain
    ? disclosure('rw-gains', 'Daily net change', change ? `${change.deltaText} ${change.label}` : 'each day against the pace you need', [panel(
        'Daily net change vs what you need',
        h(
          'p',
          { class: 'xck-caption' },
          change ? h('span', { class: change.delta < 0 ? 'xck-down' : change.delta > 0 ? 'xck-up' : '' }, h('strong', {}, change.deltaText), ` ${change.label}. `) : null,
          `Each bar is the window's net movement between two consecutive days' readings (new impressions minus expired ones, rounded by X). Dashed line = ${formatRate(p.need.perDay)}/day, the pace that keeps a full window at ${target}. Hatched = today, still in progress. Missing days are gaps, not zeros.`,
        ),
        h('div', { class: 'xck-chart-block' },
          responsiveChart(gainCats, gainSeries, { ariaLabel: 'Daily net change in the rewards window', width: 940, height: 240, refLine: { value: p.need.perDay, label: `${formatRate(p.need.perDay)}/day to hold ${target}` } }),
          h('div', { class: 'xck-values' }, disclosure('rw-gains-values', 'Show values', `${gainCats.length} rows`, [h('div', { class: 'values-scroll' }, valuesTable(gainCats, gainSeries))]))),
      )])
    : null;

  return [pacePanel, progressPanel, ...(gainsPanel ? [h('div', { class: 'xck-panel xck-panel-tight' }, gainsPanel)] : [])];
}

function labelFor(s: string) {
  return { ready: 'Ready', stale: 'Stale', source_error: 'Source error', no_data: 'No data' }[s] ?? s;
}

function cardPanel(now: Date) {
  const s = state.settings;
  const acct = state.accounts[current] ?? { observations: [], attempts: [] };
  const rDate = now.toISOString().slice(0, 10);
  const suggestion = suggestDayNumber(rDate, { dayAnchor: s.dayAnchor, dayOverrides: {} });
  if (dayValue == null) dayValue = suggestion.day;

  const canvas = h('canvas', { class: 'card-preview', 'aria-label': 'Share card preview' });
  const status = h('p', { class: 'xck-muted xck-small', role: 'status' });
  const size = h('span', { class: 'xck-size' });
  const draw = () => {
    size.textContent = cardFormat === 'portrait' ? 'PNG · 1080 × 1350' : 'PNG · 1600 × 900';
    const res = buildCardModel(current, acct.observations, acct.attempts, { ...s, dayOverrides: {} }, new Date(), dayConfirmed ? dayValue : null);
    if (!res.ok) {
      status.textContent = res.reason;
      canvas.hidden = true;
      dl.disabled = true;
      return;
    }
    canvas.hidden = false;
    renderCard(canvas, res.model, cardFormat);
    dl.disabled = !dayConfirmed;
    status.textContent = dayConfirmed ? `Card built from reading ${res.model.heroText} (${res.model.qualifiers.join(', ') || 'no qualifiers'}).` : 'Confirm the Day number to enable download.';
  };

  const dayInput = h('input', { type: 'number', min: '1', value: String(dayValue), 'aria-label': 'Day number' });
  dayInput.addEventListener('input', () => {
    dayValue = Number(dayInput.value) || null;
    dayConfirmed = false;
    confirmBox.checked = false;
    draw();
  });
  const confirmBox = h('input', { type: 'checkbox', ...(dayConfirmed ? { checked: true } : {}) });
  confirmBox.addEventListener('change', () => ((dayConfirmed = confirmBox.checked && dayValue != null), draw()));
  const formatSel = h(
    'select',
    { onchange: (e) => ((cardFormat = (e.target as HTMLSelectElement).value as CardFormat), draw()) },
    h('option', { value: 'portrait', ...(cardFormat === 'portrait' ? { selected: true } : {}) }, 'Portrait 1080×1350'),
    h('option', { value: 'landscape', ...(cardFormat === 'landscape' ? { selected: true } : {}) }, 'Landscape 1600×900'),
  );
  const dl = h('button', {
    class: 'xck-primary',
    onclick: () =>
      canvas.toBlob((b) => b && download(`${current}-day-${dayValue}-${rDate}-${cardFormat}.png`, b), 'image/png'),
  }, 'Download PNG');

  queueMicrotask(draw);
  formatSel.setAttribute('aria-label', 'Card format');
  return panel(
    'EOD share card',
    h('div', { class: 'xck-card-layout' },
      h('div', { class: 'xck-card-stage' }, canvas),
      h('div', { class: 'xck-card-controls' },
        h('label', { class: 'xck-inline-field' }, 'Day ', dayInput),
        h('label', { class: 'xck-check' }, confirmBox, ` Day ${suggestion.source === 'unset' ? '(set Day 1 in Settings below)' : '(from Day 1)'} is correct for ${rDate} UTC`),
        h('label', { class: 'xck-inline-field' }, 'Format ', formatSel),
        h('div', { class: 'xck-row' }, dl, size),
        status,
        h('p', { class: 'xck-muted xck-small' }, 'Nothing is posted automatically. Check the preview against X before sharing.'),
      ),
    ),
  );
}

function manualPanel() {
  const value = h('input', { placeholder: 'e.g. 109.2K or 109,214', autocomplete: 'off' });
  const handle = h('input', { value: current ? '@' + current : '', placeholder: '@yourhandle', autocomplete: 'off', spellcheck: 'false' });
  const when = h('input', { type: 'datetime-local', value: toUtcInput(new Date()) });
  const source = h('input', { value: 'X mobile app (manual)' });
  const msg = h('p', { role: 'status', class: 'xck-form-status' }, takeFlash('manual'));
  const form = h(
    'form',
    {
      class: 'xck-form',
      onsubmit: async (e) => {
        e.preventDefault();
        const parsed = parseCount(value.value);
        const acct = normalizeHandle(handle.value);
        const at = new Date(`${when.value}Z`);
        msg.textContent = flash.manual = '';
        // Checked bottom-up so focus ends on the first field with a problem.
        const ok = [
          fieldError(when, Number.isNaN(at.getTime()) || at.getTime() > Date.now() + 60_000 ? 'Enter the UTC date and time you read it. It cannot be in the future.' : null),
          fieldError(handle, acct ? null : 'Enter the X handle the reading belongs to, for example @yourhandle.'),
          fieldError(value, parsed ? null : 'Enter the number exactly as X shows it, for example 109.2K or 109,214.'),
        ];
        if (ok.includes(false)) return void (msg.textContent = 'Nothing was saved. Correct the highlighted field.');
        if (!parsed || !acct) return;
        const { result } = await updateState((st) =>
          addObservation(
            st,
            buildObservation(
              {
                account: acct,
                accountSource: 'user_confirmed',
                metric: 'rewards_vht_90d',
                parsed,
                provenance: 'manual',
                sourceUrl: null,
                sourceLabel: source.value.trim() || 'Manual entry',
                at,
                windowType: 'rolling_90d',
                verifiedOnly: true,
                excludesReplies: true,
                note: 'User-reported from X rewards screen',
              },
              { ...st.settings, reportingTimeZone: 'UTC', cycleCutoffHour: 0 },
            ),
          ),
        );
        flash.manual = result.kind === 'appended' ? `Saved ${parsed.displayText} (user-reported).` : 'Same value already recorded for that day; re-confirmed.';
        current = acct;
        void refresh();
      },
    },
    field('Rewards reading as shown by X', value, 'Verified Home Timeline impressions, 90 days'),
    field('Account', handle),
    field('Read at (UTC)', when),
    field('Source', source),
    h('button', { type: 'submit', 'data-key': 'save-manual' }, 'Save manual reading'),
  );
  form.noValidate = true;
  return h('div', { class: 'xck-form-block' }, h('p', { class: 'xck-muted' }, 'Only enter the Verified Home Timeline impressions figure from the rewards screen, not account impressions.'), form, msg);
}

function settingsPanel() {
  const s = state.settings;
  const f = {
    handle: h('input', { value: s.expectedHandle ? '@' + s.expectedHandle : '', placeholder: '@yourhandle', autocomplete: 'off', spellcheck: 'false' }),
    dayOne: h('input', { type: 'date', value: dayOneDate(s) ?? '' }),
    target: h('input', { type: 'number', min: '1', step: '1', value: String(s.rewardsTarget) }),
    stale: h('input', { type: 'number', min: '1', step: '1', value: String(s.staleAfterHours) }),
  };
  const msg = h('p', { role: 'status', class: 'xck-form-status' }, takeFlash('settings'));
  const form = h(
    'form',
    {
      class: 'xck-form',
      onsubmit: async (e) => {
        e.preventDefault();
        // The handle is optional here: an empty field keeps no account until one is read or typed.
        const handle = f.handle.value.trim() ? normalizeHandle(f.handle.value) : '';
        const target = Number(f.target.value);
        const stale = Number(f.stale.value);
        let picked: ReturnType<typeof pickDayOne> | null = null;
        let dayProblem: string | null = null;
        if (f.dayOne.value !== (dayOneDate(s) ?? '')) {
          if (!f.dayOne.value) dayProblem = 'Pick a Day 1 UTC date.';
          else try { picked = pickDayOne(f.dayOne.value, new Date().toISOString().slice(0, 10)); }
          catch (error) { dayProblem = (error as Error).message; }
        }
        msg.textContent = flash.settings = '';
        // Checked bottom-up so focus ends on the first field with a problem.
        const ok = [
          fieldError(f.stale, Number.isInteger(stale) && stale > 0 ? null : 'Enter a whole number of hours above 0, for example 24.'),
          fieldError(f.target, Number.isInteger(target) && target > 0 ? null : 'Enter a whole-number target above 0, for example 500000.'),
          fieldError(f.dayOne, dayProblem),
          fieldError(f.handle, handle == null ? 'Use letters, numbers or _ (up to 15), for example @yourhandle. Leave it empty to set it later.' : null),
        ];
        if (ok.includes(false) || handle == null) return void (msg.textContent = 'Nothing was saved. Correct the highlighted field.');
        await updateState((st) => {
          st.settings = {
            ...st.settings,
            expectedHandle: handle,
            reportingTimeZone: 'UTC',
            cycleCutoffHour: 0,
            utcOnly: true,
            ...(picked ?? {}),
            rewardsTarget: target,
            staleAfterHours: stale,
          };
        });
        dayValue = null;
        dayConfirmed = false;
        flash.settings = 'Settings saved.';
        void refresh();
      },
    },
    field('Your handle', f.handle),
    field('Day 1 (UTC date)', f.dayOne, 'Reporting days use UTC. Existing readings stay in your history.'),
    field('Rewards target', f.target),
    field('Mark stale after (hours)', f.stale),
    h('button', { type: 'submit', 'data-key': 'save-settings' }, 'Save settings'),
  );
  form.noValidate = true;
  // Optional avatar for the share card: resized to 160px and stored locally as PNG (no upload anywhere).
  const avatarMsg = h('span', { class: 'xck-muted xck-small', role: 'status' });
  const avatarInput = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp' });
  avatarInput.addEventListener('change', async () => {
    const file = avatarInput.files?.[0];
    if (!file) return;
    try {
      const bmp = await createImageBitmap(file);
      const size = 160;
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const side = Math.min(bmp.width, bmp.height);
      c.getContext('2d')!.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, size, size);
      const url = c.toDataURL('image/png');
      await updateState((st) => void (st.settings.avatarDataUrl = url));
      avatarMsg.textContent = 'Saved. It appears on the share card.';
    } catch {
      avatarMsg.textContent = 'Could not read that image.';
    }
  });
  const avatarRow = h(
    'div',
    { class: 'xck-row' },
    s.avatarDataUrl ? h('img', { src: s.avatarDataUrl, alt: '', style: 'width:40px;height:40px;border-radius:50%' }) : null,
    h('label', { class: 'xck-inline-field' }, 'Share-card avatar ', avatarInput),
    s.avatarDataUrl ? h('button', { class: 'xck-link', onclick: async () => (await updateState((st) => void delete st.settings.avatarDataUrl), void refresh()) }, 'Remove') : null,
    avatarMsg,
  );
  return h('div', { class: 'xck-form-block' }, form, msg, avatarRow);
}

function dataPanel() {
  const msg = h('p', { role: 'status', class: 'xck-form-status' }, takeFlash('data'));
  const file = h('input', { type: 'file', accept: 'application/json' });
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    if (!f) return;
    flash.data = '';
    try {
      const text = await f.text();
      const st = await loadState();
      await snapshotBeforeImport(st);
      const rep = importBackup(st, text);
      await saveState(st);
      flash.data = `Imported ${rep.added} new, ${rep.duplicates} duplicates skipped, ${rep.rejected} rejected (accounts: ${rep.accounts.map((a) => '@' + a).join(', ') || 'none'}). A pre-import copy was kept.`;
      void refresh();
    } catch (e) {
      msg.textContent = `Import failed: ${(e as Error).message}`;
    }
  });
  const stamp = () => new Date().toISOString().slice(0, 10);
  return h(
    'div',
    { class: 'xck-form-block' },
    h('p', { class: 'xck-muted' }, 'Data lives only in this browser’s extension storage. Uninstalling the extension deletes it — export a backup regularly.'),
    h(
      'div',
      { class: 'xck-row' },
      h('button', { onclick: () => download(`xgd-backup-${stamp()}.json`, exportBackup(state, new Date()), 'application/json') }, 'Export JSON backup'),
      current ? h('button', { onclick: () => download(`xgd-${current}-${stamp()}.csv`, observationsCsv(state.accounts[current]?.observations ?? []), 'text/csv') }, `Export CSV (@${current})`) : null,
      h('label', { class: 'xck-inline-field' }, 'Import backup ', file),
      current ? h('button', {
        class: 'xck-danger',
        onclick: async () => {
          const typed = prompt(`Type ${current} to permanently delete all stored data for @${current}.`);
          if (typed?.trim().toLowerCase() !== current) return;
          await updateState((st) => void delete st.accounts[current]);
          flash.data = `Deleted data for @${current}.`;
          void refresh();
        },
      }, `Delete @${current} data…`) : null,
    ),
    msg,
  );
}

function toUtcInput(d: Date) {
  return d.toISOString().slice(0, 16);
}

chrome.storage.onChanged.addListener((_c, area) => area === 'local' && void refresh());
void refresh();

mountNavigation();
