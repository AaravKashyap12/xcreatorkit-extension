import { mountNavigation } from './navigation';
// The receipt page: pick a scene, colourway and up to four metrics on the left; the receipt prints on the
// right while the capture runs; then copy it straight into X, download it, or open X's composer.
import pageCss from './receiptPage.css';
import { injectReceiptCss, receiptFontsReady } from '../receipt/assets';
import { BRAND, DEFAULT_METRICS, MAX_ROWS, METRICS, RECAP_METRICS, SCENES, sampleFor, sceneById, type MetricKey, type ReceiptData } from '../receipt/data';
import { renderScene } from '../receipt/scenes';
import { playReceipt, rollTo, type Playback } from '../receipt/animate';
import { receiptPng } from '../receipt/export';
import { receiptFromReport } from '../receipt/fromReport';
import { recapFromReport, type RecapKind } from '../receipt/recap';
import { RANGES, buildReport } from '../analytics/report';
import { sortedRows } from '../analytics/series';
import { RUN_KEY, type RunStatus } from '../capture/run';
import { loadState, updateState } from '../store/chromeStore';
import { dayOneDate, pickDayOne, suggestDayNumber } from '../calc/time';
import { download, h, keepFocus } from './dom';
import { normalizeHandle } from '../store/state';

injectReceiptCss();
document.head.append(h('style', {}, pageCss));

const KEY = 'xgd:receipt';
const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as { scene?: number; colourway?: number; metrics?: MetricKey[]; period?: 'day' | RecapKind };
let period: 'day' | RecapKind = saved.period === 'week' || saved.period === 'month' ? saved.period : 'day';
let scene = SCENES.some((s) => s.id === saved.scene) ? saved.scene! : 1;
let colourway = Math.min(5, Math.max(0, saved.colourway ?? 0));
let metrics: MetricKey[] = (saved.metrics ?? DEFAULT_METRICS).filter((k) => METRICS.some((m) => m.key === k)).slice(0, MAX_ROWS);
if (period === 'day') metrics = metrics.filter((key) => !['bestDay', 'daysPosted', 'streak'].includes(key));
if (!metrics.length) metrics = [...DEFAULT_METRICS];
/** The creator's Day 1 (UTC date), or null until they pick one. Saved in settings, so every receipt counts from it. */
let dayOne: string | null = null;
let dayError: string | null = null;
const todayUtc = () => new Date().toISOString().slice(0, 10);
let data: ReceiptData | null = null;
let run: RunStatus | null = null;
let playback: Playback | null = null;
let shownKey = '';
let expectedHandle = '';

const save = () => localStorage.setItem(KEY, JSON.stringify({ scene, colourway, metrics, period }));
const app = document.getElementById('app')!;

// ---------- data ----------
async function loadData(): Promise<{ data: ReceiptData; demo: boolean }> {
  const state = await loadState();
  expectedHandle = state.settings.expectedHandle;
  dayOne = dayOneDate(state.settings);
  const handle = state.settings.expectedHandle;
  const acct = state.accounts[handle];
  if (period === 'day' && (!acct || (!acct.observations.length && !acct.daily?.all))) // The sample is never stamped.
    return { data: sampleWithDay(suggestDayNumber(todayUtc(), state.settings).day), demo: true };
  const today = RANGES.find((r) => r.key === 'today')!;
  const series = acct?.daily?.all;
  const history = sortedRows(series);
  const observations = acct?.observations ?? [];
  const report = buildReport({ handle, settings: state.settings, observations, attempts: acct?.attempts ?? [], daily: history, analyticsCapturedAt: series?.lastCaptureAt ?? null, intraday: acct?.intraday, days: today.days, anchor: today.anchor, now: new Date() });
  return { data: period === 'day'
    ? receiptFromReport(report, { day: report.daySuggested, metrics, history, observations })
    : recapFromReport(report, { kind: period, metrics, history, dayOne }), demo: !acct || (!observations.length && !series) };
}

/** The sample (never stamped: the stamp means the numbers were read from X), numbered with the creator's own day. */
function sampleWithDay(day: number): ReceiptData {
  // The sample wears the creator's own handle once known, and a placeholder before that.
  return { ...sampleFor(metrics), captured: false, day, no: String(day).padStart(4, '0'), handle: normalizeHandle(expectedHandle) ?? 'yourhandle' };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const prettyDate = (ymd: string) => `${Number(ymd.slice(8))} ${MONTHS[Number(ymd.slice(5, 7)) - 1]} ${ymd.slice(0, 4)}`;

async function setDayOne(ymd: string) {
  try {
    const picked = pickDayOne(ymd, todayUtc());
    dayError = null;
    await updateState((st) => Object.assign(st.settings, picked));
    say(`Day 1 is now ${prettyDate(ymd)}.`);
    await refresh(true); // new day number: print it fresh
  } catch (e) {
    dayError = (e as Error).message;
    await refresh(false); // nothing changed: just show the message
  }
}

// ---------- receipt stage ----------
const stage = h('div', { class: 'stage-frame' });
function fitStage() {
  const art = stage.firstElementChild as HTMLElement | null;
  if (!art) return;
  const box = stage.getBoundingClientRect();
  const k = Math.min(box.width / 1080, box.height / 1350);
  art.style.transform = `scale(${k})`;
  art.style.transformOrigin = 'top left';
  art.style.marginLeft = `${(box.width - 1080 * k) / 2}px`;
}
new ResizeObserver(fitStage).observe(stage);

/** Re-render and replay when the layout changes; roll the numbers when only the values changed. */
function showReceipt(d: ReceiptData, replay: boolean) {
  const layoutKey = `${scene}:${colourway}:${d.rows.map((r) => r.key).join(',')}:${d.total ? 1 : 0}:${d.captured}:${d.record}:${d.day}:${d.handle}:${d.date}:${d.stampDate}:${d.time}:${d.period?.title}:${d.period?.dates}:${d.period?.coverage}:${d.period?.dayRange}`;
  if (!replay && layoutKey === shownKey && stage.firstElementChild) {
    playback?.cancel();
    playback = null;
    rollTo(stage.firstElementChild as HTMLElement, d.rows.map((r) => r.value), d.total?.text ?? d.followersTotal ?? '—');
    return;
  }
  shownKey = layoutKey;
  playback?.cancel();
  stage.innerHTML = renderScene(scene, colourway, d);
  fitStage();
  const art = stage.firstElementChild as HTMLElement;
  // Animate once the receipt fonts are in (rolling digits are sized from real metrics); a newer render wins.
  void receiptFontsReady().then(() => {
    if (stage.firstElementChild === art) playback = playReceipt(art);
  });
}

// ---------- controls ----------
function thumb(id: number) {
  const s = sceneById(id);
  const c = s.colourways[0]!;
  return h(
    'button',
    { type: 'button', class: `xck-scene${id === scene ? ' on' : ''}`, 'aria-pressed': String(id === scene), title: s.name, 'data-key': `scene:${id}`, onclick: () => ((scene = id), (colourway = 0), save(), void refresh(true)) },
    h('span', { class: 'xck-swatch', style: `background:${c.field}` }, h('span', { class: 'xck-mini', style: `background:${c.paper ?? '#f6f3ec'}` }, h('i', { style: `background:${c.accent}` }), h('i', {}), h('i', {}), h('i', {}))),
    h('span', { class: 'xck-scene-name' }, s.name),
  );
}

function controls(demo: boolean) {
  const s = sceneById(scene);
  const metricList = h(
    'div',
    { class: 'xck-lines' },
    ...(period === 'day' ? METRICS.filter((m) => !['bestDay', 'daysPosted', 'streak'].includes(m.key)) : RECAP_METRICS).map((m) => {
      const on = metrics.includes(m.key);
      const full = !on && metrics.length >= MAX_ROWS;
      const box = h('input', { type: 'checkbox', 'data-key': `line:${m.key}`, ...(on ? { checked: true } : {}), ...(full ? { disabled: true } : {}), ...(full ? { 'aria-describedby': 'lines-hint' } : {}) });
      box.addEventListener('change', () => {
        metrics = box.checked ? [...metrics, m.key] : metrics.filter((k) => k !== m.key);
        if (!metrics.length) metrics = [m.key];
        save();
        void refresh(true);
      });
      return h('label', { class: `xck-line${full ? ' full' : ''}` }, box, h('span', {}, period !== 'day' && m.key === 'impressions' ? 'Impressions' : m.short));
    }),
  );
  const dayOneInput = h('input', { type: 'date', max: todayUtc(), value: dayOne ?? '', id: 'day-one', 'data-key': 'day-one', 'aria-describedby': dayError ? 'day-one-hint day-one-error' : 'day-one-hint', ...(dayError ? { 'aria-invalid': 'true' } : {}) });
  dayOneInput.addEventListener('change', () => void setDayOne(dayOneInput.value));
  return h(
    'aside',
    { class: 'xck-controls', 'aria-label': 'Receipt options' },
    h('section', {}, h('h2', {}, 'Period'), h('div', { class: 'xck-seg xck-period', role: 'group', 'aria-label': 'Receipt period' }, ...(['day', 'week', 'month'] as const).map((kind) => h('button', {
      type: 'button', class: `xck-period-button${period === kind ? ' on' : ''}`, 'aria-pressed': String(period === kind), 'data-key': `period:${kind}`,
      onclick: () => {
        period = kind;
        metrics = kind === 'day' ? metrics.filter((key) => !['bestDay', 'daysPosted', 'streak'].includes(key))
          : metrics.map((key) => key === 'impressionsDelta' ? 'impressions' : key).filter((key, i, all) => all.indexOf(key) === i);
        if (!metrics.length) metrics = kind === 'day' ? [...DEFAULT_METRICS] : ['followers', 'posts', 'impressions', 'engagementRate'];
        save(); void refresh(true);
      },
    }, kind[0]!.toUpperCase() + kind.slice(1))))),
    h('section', {}, h('h2', {}, 'Scene'), h('div', { class: 'xck-scenes' }, ...SCENES.map((x) => thumb(x.id)))),
    h(
      'section',
      {},
      h('h2', {}, 'Colourway', h('span', { class: 'xck-hint' }, s.colourways[colourway]!.name)),
      h(
        'div',
        { class: 'xck-colourways' },
        ...s.colourways.map((c, i) =>
          h('button', { type: 'button', class: `xck-swatch-dot${i === colourway ? ' on' : ''}`, title: c.name, 'aria-label': c.name, 'aria-pressed': String(i === colourway), 'data-key': `colourway:${i}`, style: `--a:${c.field};--b:${c.accent}`, onclick: () => ((colourway = i), save(), void refresh(true)) }),
        ),
      ),
    ),
    h('section', {}, h('h2', {}, 'Lines', h('span', { class: 'xck-hint' }, `${metrics.length} of ${MAX_ROWS}`)), metricList,
      metrics.length >= MAX_ROWS ? h('p', { class: 'xck-hint xck-lines-hint', id: 'lines-hint' }, `A receipt holds ${MAX_ROWS} lines. Untick one to choose another.`) : null),
    h(
      'section',
      { class: `xck-dayone${dayOne ? '' : ' ask'}${dayError ? ' invalid' : ''}` },
      h('div', { class: 'xck-dayone-row' }, h('label', { for: 'day-one' }, h('h2', {}, 'Day 1')), dayOneInput),
      h('p', { class: 'xck-hint', id: 'day-one-hint' }, dayOne ? `Today is Day ${data?.day ?? 1}, counted in UTC days from ${prettyDate(dayOne)}.` : 'When did your journey start? Pick the day you count as Day 1. Until you do, today is Day 1.'),
      dayError ? h('p', { class: 'xck-error', id: 'day-one-error', role: 'alert' }, dayError) : null,
    ),
    demo ? h('p', { class: 'xck-note' }, period === 'day' ? 'Showing a sample receipt. Choose Read current X tab in the extension menu to print yours.' : 'No captured recap days yet. Open X Analytics, select a range, then choose Read current X tab in the extension menu.') : null,
  );
}

function statusLine() {
  const steps = run?.steps;
  const busy = run && !run.finishedAt;
  const item = (name: string, s?: { state: string; message: string }) => (s ? h('li', { class: s.state }, h('b', {}, name), ` ${s.message}`) : null);
  return h(
    'div',
    { class: 'xck-status-line', role: 'status', 'aria-live': 'polite' },
    busy ? h('span', { class: 'xck-pulse' }, 'Printing from X…') : data?.captured ? h('span', { class: 'xck-stamp' }, '✓ Captured from X') : h('span', {}, data?.period ? 'Recap has gaps or unavailable lines' : 'Not captured yet'),
    steps ? h('ul', {}, item('Analytics', steps.analytics), item('Rewards', steps.rewards), item('Followers', steps.profile)) : null,
  );
}

const toast = h('div', { class: 'xck-toast', role: 'status', 'aria-live': 'polite' });
function say(msg: string) {
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2200);
}

async function copyImage() {
  if (!data) return;
  try {
    const blob = receiptPng(scene, colourway, data);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    say('Copied. Paste it into your post on X.');
  } catch (e) {
    say(`Couldn't copy (${(e as Error).message}). Use Download instead.`);
  }
}
async function downloadImage() {
  if (!data) return;
  const blob = await receiptPng(scene, colourway, data);
  download(`${data.handle}-${data.period?.kind ?? `day${data.day}`}-${sceneById(scene).key}-${colourway + 1}.png`, blob);
}
function shareOnX() {
  if (!data) return;
  const text = `${data.period?.title ?? `Day ${data.day}`} receipt 🧾`;
  void chrome.tabs.create({ url: `https://x.com/intent/post?text=${encodeURIComponent(text)}` });
  void copyImage();
}

let refreshSeq = 0;
let replayPending = false;
async function refresh(replay = false) {
  // Quick changes can start several refreshes; only the latest one paints, and a requested replay is kept.
  const seq = ++refreshSeq;
  replayPending ||= replay;
  const { data: d, demo } = await loadData();
  if (seq !== refreshSeq) return;
  replay = replayPending;
  replayPending = false;
  data = d;
  const actions = h(
    'div',
    { class: 'xck-actions' },
    h('button', { type: 'button', class: 'xck-primary', onclick: () => void copyImage() }, 'Copy image'),
    h('button', { type: 'button', onclick: () => void downloadImage() }, 'Download PNG'),
    h('span', { class: 'xck-size' }, 'PNG · 2160 × 2700'),
    h('button', { type: 'button', onclick: shareOnX }, 'Share on X ↗'),
    h('button', { type: 'button', class: 'xck-ghost', onclick: () => data && showReceipt(data, true), 'aria-label': 'Replay animation' }, 'Replay'),
  );
  const top = h(
    'header',
    { class: 'xck-head xck-receipt-head' },
    h('div', { class: 'xck-head-id' }, h('h1', { class: 'xck-title' }, 'Receipts'), h('span', { class: 'xck-muted' }, `Growth receipts by ${BRAND}`)),
    h('div', { class: 'xck-head-actions' },
      h('button', { type: 'button', onclick: () => void recapture() }, 'Open X Analytics ↗'),
    ),
  );
  const grant = h('p', { class: 'xck-grant' }, 'Choose a range on X, then use Read current X tab in the extension toolbar.');
  keepFocus(app, () => app.replaceChildren(top, h('main', { class: 'xck-layout' }, controls(demo), h('section', { class: 'xck-preview', 'aria-label': 'Receipt preview' }, statusLine(), grant, stage, actions)), toast));
  showReceipt(d, replay || !shownKey);
}

async function recapture() {
  await chrome.tabs.create({ url: 'https://x.com/i/account_analytics', active: true });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes[RUN_KEY]) run = changes[RUN_KEY].newValue as RunStatus;
  void refresh(false);
});
void chrome.storage.session.get(RUN_KEY).then((v) => {
  run = (v[RUN_KEY] as RunStatus) ?? null;
  void refresh(true);
});

mountNavigation();
