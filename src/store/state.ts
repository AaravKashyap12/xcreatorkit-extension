import {
  SCHEMA_VERSION,
  defaultSettings,
  type AccountData,
  type CaptureAttempt,
  type MetricType,
  type Observation,
  type ParsedNumber,
  type Provenance,
  type Settings,
  type StoreState,
  type WindowType,
} from '../model/types';
import { reportingDate } from '../calc/time';
import { emptySeries, mergeRows, type DailyRow, type MergeReport, type SeriesKind } from '../analytics/series';

export function emptyState(): StoreState {
  return { schemaVersion: SCHEMA_VERSION, settings: defaultSettings(), accounts: {} };
}

export function normalizeHandle(raw: string): string | null {
  const h = raw.trim().replace(/^@/, '').toLowerCase();
  return /^[a-z0-9_]{1,15}$/.test(h) ? h : null;
}

function account(state: StoreState, handle: string): AccountData {
  return (state.accounts[handle] ??= { observations: [], attempts: [] });
}

export interface NewObservationInput {
  account: string;
  accountSource: Observation['accountSource'];
  metric: MetricType;
  parsed: ParsedNumber;
  provenance: Provenance;
  sourceUrl: string | null;
  sourceLabel: string;
  at: Date;
  windowType: WindowType;
  verifiedOnly: boolean | null;
  excludesReplies: boolean | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  note?: string;
}

export function buildObservation(input: NewObservationInput, settings: Settings): Observation {
  const iso = input.at.toISOString();
  return {
    id: `${input.account}:${input.metric}:${input.provenance}:${iso}`,
    account: input.account,
    accountSource: input.accountSource,
    metric: input.metric,
    displayText: input.parsed.displayText,
    value: input.parsed.value,
    precision: input.parsed.precision,
    roundingHalfStep: input.parsed.roundingHalfStep,
    provenance: input.provenance,
    sourceUrl: input.sourceUrl,
    sourceLabel: input.sourceLabel,
    capturedAt: iso,
    lastSeenAt: iso,
    reportingTimeZone: settings.reportingTimeZone,
    reportingDate: reportingDate(input.at, settings),
    periodStart: input.periodStart ?? null,
    periodEnd: input.periodEnd ?? null,
    windowType: input.windowType,
    verifiedOnly: input.verifiedOnly,
    excludesReplies: input.excludesReplies,
    ...(input.note ? { note: input.note } : {}),
  };
}

export type AddResult = { kind: 'appended'; observation: Observation } | { kind: 'reconfirmed'; observation: Observation };

/**
 * Add an observation. A capture that shows the same value as the latest reading
 * for the same account/metric on the same reporting day only refreshes
 * lastSeenAt; repeated captures do not create fake history points.
 */
export function addObservation(state: StoreState, obs: Observation): AddResult {
  const acct = account(state, obs.account);
  const latest = acct.observations
    .filter((o) => o.metric === obs.metric)
    .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))
    .at(-1);
  if (
    latest &&
    latest.displayText === obs.displayText &&
    latest.reportingDate === obs.reportingDate &&
    latest.provenance === obs.provenance &&
    latest.windowType === obs.windowType
  ) {
    if (obs.lastSeenAt > latest.lastSeenAt) latest.lastSeenAt = obs.lastSeenAt;
    return { kind: 'reconfirmed', observation: latest };
  }
  if (acct.observations.some((o) => o.id === obs.id)) {
    return { kind: 'reconfirmed', observation: acct.observations.find((o) => o.id === obs.id)! };
  }
  acct.observations.push(obs);
  return { kind: 'appended', observation: obs };
}

const MAX_ATTEMPTS = 50;

export function recordAttempt(state: StoreState, attempt: CaptureAttempt): void {
  // Failed attempts without a known account go to a separate bucket so they never touch a creator's data.
  const key = attempt.account ?? '_unknown';
  const acct = account(state, key);
  acct.attempts.push(attempt);
  if (acct.attempts.length > MAX_ATTEMPTS) acct.attempts.splice(0, acct.attempts.length - MAX_ATTEMPTS);
}

export function deleteObservation(state: StoreState, handle: string, id: string): boolean {
  const acct = state.accounts[handle];
  if (!acct) return false;
  const before = acct.observations.length;
  acct.observations = acct.observations.filter((o) => o.id !== id);
  return acct.observations.length < before;
}

/** Merge a daily analytics capture into one account's series for one filter (all / verified-only). */
export function saveDailyCapture(
  state: StoreState,
  handle: string,
  kind: SeriesKind,
  rows: DailyRow[],
  range: { from: string; to: string },
  capturedAt: Date,
): MergeReport {
  const acct = account(state, handle);
  const daily = (acct.daily ??= {});
  const series = (daily[kind] ??= emptySeries());
  return mergeRows(series, rows, range, capturedAt);
}

const INTRADAY_KEEP_DAYS = 14;

/** Record the in-progress day's running totals at this capture time (no interpolation, no backfill). */
export function recordIntraday(state: StoreState, handle: string, date: string, at: Date, metrics: Record<string, number>): void {
  const acct = account(state, handle);
  const map = (acct.intraday ??= {});
  const list = (map[date] ??= []);
  const iso = at.toISOString();
  if (!list.some((o) => o.at === iso)) list.push({ at: iso, metrics: { ...metrics } });
  list.sort((a, b) => a.at.localeCompare(b.at));
  for (const d of Object.keys(map).sort().slice(0, -INTRADAY_KEEP_DAYS)) delete map[d];
}

function isDailyRow(r: unknown, date: string): r is DailyRow {
  if (!r || typeof r !== 'object') return false;
  const x = r as Record<string, unknown>;
  return (
    x.date === date &&
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    typeof x.capturedAt === 'string' &&
    !Number.isNaN(Date.parse(x.capturedAt)) &&
    typeof x.partial === 'boolean' &&
    !!x.metrics &&
    typeof x.metrics === 'object' &&
    Object.values(x.metrics as object).every((v) => typeof v === 'number' && Number.isFinite(v))
  );
}

// ---------- Backup / restore ----------

export function exportBackup(state: StoreState, now: Date): string {
  return JSON.stringify({ kind: 'xgd-backup', exportedAt: now.toISOString(), ...state }, null, 2);
}

const METRICS: readonly MetricType[] = [
  'rewards_vht_90d',
  'account_impressions',
  'account_impressions_verified_only',
  'post_impressions',
  'followers_total',
  'followers_verified',
];
const PROVENANCE: readonly Provenance[] = ['captured', 'imported', 'manual', 'derived', 'scenario'];
const WINDOWS: readonly WindowType[] = ['rolling_90d', 'fixed_range', 'all_time', 'unknown'];

function isObservation(o: unknown, handle: string): o is Observation {
  if (!o || typeof o !== 'object') return false;
  const x = o as Record<string, unknown>;
  return (
    typeof x.id === 'string' &&
    x.account === handle &&
    (x.accountSource === 'page' || x.accountSource === 'user_confirmed') &&
    METRICS.includes(x.metric as MetricType) &&
    typeof x.displayText === 'string' &&
    typeof x.value === 'number' &&
    Number.isFinite(x.value) &&
    (x.precision === 'exact' || x.precision === 'rounded') &&
    typeof x.roundingHalfStep === 'number' &&
    PROVENANCE.includes(x.provenance as Provenance) &&
    (x.sourceUrl === null || typeof x.sourceUrl === 'string') &&
    typeof x.sourceLabel === 'string' &&
    typeof x.capturedAt === 'string' &&
    !Number.isNaN(Date.parse(x.capturedAt)) &&
    typeof x.lastSeenAt === 'string' &&
    typeof x.reportingTimeZone === 'string' &&
    typeof x.reportingDate === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(x.reportingDate) &&
    WINDOWS.includes(x.windowType as WindowType)
  );
}

export interface ImportReport {
  added: number;
  duplicates: number;
  rejected: number;
  accounts: string[];
  dailyRows: number;
}

/**
 * Merge a backup into the current state. Observations are validated, kept in
 * their own account bucket (an observation whose `account` field disagrees
 * with its bucket is rejected), and deduplicated by id. Settings are not
 * overwritten.
 */
export function importBackup(state: StoreState, json: string): ImportReport {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error('Backup is not valid JSON.');
  }
  const d = data as { kind?: unknown; schemaVersion?: unknown; accounts?: unknown };
  if (d?.kind !== 'xgd-backup' || d.schemaVersion !== SCHEMA_VERSION || !d.accounts || typeof d.accounts !== 'object') {
    throw new Error('Not a recognised backup file (wrong kind or schema version).');
  }
  const report: ImportReport = { added: 0, duplicates: 0, rejected: 0, accounts: [], dailyRows: 0 };
  for (const [rawHandle, acctData] of Object.entries(d.accounts as Record<string, unknown>)) {
    const handle = normalizeHandle(rawHandle);
    const obsList = (acctData as { observations?: unknown })?.observations;
    if (!handle || !Array.isArray(obsList)) {
      report.rejected += Array.isArray(obsList) ? obsList.length : 0;
      continue;
    }
    report.accounts.push(handle);
    const acct = account(state, handle);
    for (const o of obsList) {
      if (!isObservation(o, handle)) {
        report.rejected++;
        continue;
      }
      if (acct.observations.some((e) => e.id === o.id)) {
        report.duplicates++;
        continue;
      }
      acct.observations.push({ ...o });
      report.added++;
    }
    const daily = (acctData as { daily?: Record<string, unknown> })?.daily;
    for (const kind of ['all', 'verified'] as const) {
      const ser = daily?.[kind] as { rows?: Record<string, unknown>; lastCaptureAt?: string; lastRange?: { from: string; to: string } } | undefined;
      if (!ser?.rows || typeof ser.rows !== 'object') continue;
      const rows = Object.entries(ser.rows).filter(([date, r]) => {
        const ok = isDailyRow(r, date);
        if (!ok) report.rejected++;
        return ok;
      }).map(([, r]) => r as DailyRow);
      if (!rows.length) continue;
      const latest = rows.reduce((a, r) => (r.capturedAt > a ? r.capturedAt : a), rows[0]!.capturedAt);
      const target = ((acct.daily ??= {})[kind] ??= emptySeries());
      const keepRange = target.lastRange;
      const keepAt = target.lastCaptureAt;
      const rep = mergeRows(target, rows, ser.lastRange ?? { from: rows[0]!.date, to: rows.at(-1)!.date }, new Date(latest));
      // Importing never makes the series look freshly captured.
      if (keepAt && keepAt > latest) {
        target.lastCaptureAt = keepAt;
        target.lastRange = keepRange;
      }
      report.dailyRows += rep.added + rep.updated;
    }
  }
  return report;
}

export function observationsCsv(observations: readonly Observation[]): string {
  const cols: (keyof Observation)[] = [
    'account',
    'metric',
    'displayText',
    'value',
    'precision',
    'provenance',
    'capturedAt',
    'lastSeenAt',
    'reportingDate',
    'reportingTimeZone',
    'windowType',
    'verifiedOnly',
    'excludesReplies',
    'periodStart',
    'periodEnd',
    'sourceLabel',
    'sourceUrl',
  ];
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v);
    // Neutralise spreadsheet formula injection as well as quoting.
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return [cols.join(','), ...observations.map((o) => cols.map((c) => esc(o[c])).join(','))].join('\n');
}
