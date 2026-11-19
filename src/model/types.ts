import type { DailySeries, SeriesKind } from '../analytics/series';

// Normalized observation model. Every stored number carries its provenance.

/**
 * Metric types are deliberately separate. A rewards reading can never be
 * substituted by any account-impression type (see calc/rewards.ts).
 */
export type MetricType =
  | 'rewards_vht_90d' // Verified Home Timeline impressions, rolling 90 days, excludes replies (OCR)
  | 'account_impressions' // Account analytics impressions, all viewers
  | 'account_impressions_verified_only' // Account analytics impressions with verified-only filter
  | 'post_impressions' // Per-post views
  | 'followers_total'
  | 'followers_verified';

export type Provenance = 'captured' | 'imported' | 'manual' | 'derived' | 'scenario';

/** exact: the source showed every digit. rounded: the source abbreviated (e.g. 109.2K). */
export type Precision = 'exact' | 'rounded';

export type WindowType = 'rolling_90d' | 'fixed_range' | 'all_time' | 'unknown';

export interface ParsedNumber {
  displayText: string;
  value: number;
  precision: Precision;
  /** Half-width of the uncertainty implied by rounding (0 when exact). */
  roundingHalfStep: number;
  isPercent: boolean;
}

export interface Observation {
  id: string;
  account: string; // normalized lowercase handle without '@'
  /** How the account was established: read from the page, or confirmed by the user. */
  accountSource: 'page' | 'user_confirmed';
  metric: MetricType;
  displayText: string;
  value: number;
  precision: Precision;
  roundingHalfStep: number;
  provenance: Provenance;
  sourceUrl: string | null;
  sourceLabel: string; // e.g. "X Creator Studio · Original Content Rewards", "X mobile app (manual)"
  capturedAt: string; // ISO timestamp of first observation of this value
  lastSeenAt: string; // ISO timestamp of the latest capture that re-confirmed the same value
  reportingTimeZone: string;
  reportingDate: string; // YYYY-MM-DD in reportingTimeZone (after cycle cutoff)
  periodStart: string | null;
  periodEnd: string | null;
  windowType: WindowType;
  verifiedOnly: boolean | null; // null = unknown
  excludesReplies: boolean | null; // null = unknown
  note?: string;
}

export type CaptureFailureCode =
  | 'unsupported_page'
  | 'not_signed_in'
  | 'source_error'
  | 'label_not_found'
  | 'value_not_found'
  | 'ambiguous'
  | 'unstable'
  | 'account_unknown';

export interface CaptureAttempt {
  at: string;
  account: string | null;
  metric: MetricType;
  ok: boolean;
  code?: CaptureFailureCode;
  message?: string;
  sourceUrl: string | null;
}

export interface Settings {
  expectedHandle: string;
  /** Tint non-follow-back rows on the creator's own Following page when x.com access is granted. */
  followBackEnabled?: boolean;
  /** Set only by the Following switch; old defaults are not an opt-in. */
  followBackOptIn?: boolean;
  reportingTimeZone: string;
  /** Hours after local midnight that still belong to the previous reporting day. */
  cycleCutoffHour: number;
  dayAnchor: { date: string; day: number };
  dayOverrides: Record<string, number>;
  rewardsTarget: number;
  staleAfterHours: number;
  /** Set once the store has been migrated to UTC-only reporting (X's timezone). */
  utcOnly?: boolean;
  /** Optional profile photo for the share card, stored locally as a small PNG data URL. */
  avatarDataUrl?: string;
}

export interface AccountData {
  observations: Observation[];
  attempts: CaptureAttempt[];
  /** Daily account analytics from X web analytics, by filter. Optional for older stores. */
  daily?: Partial<Record<SeriesKind, DailySeries>>;
  /**
   * Timestamped snapshots of each UTC day's running totals, one per capture.
   * X has no hourly data; this is what was observed at capture times, nothing more.
   */
  intraday?: Record<string, IntradayObs[]>;
}

export interface IntradayObs {
  at: string; // capture time (ISO)
  metrics: Record<string, number>; // X's running totals for that UTC day at `at`
}

export interface StoreState {
  schemaVersion: 1;
  settings: Settings;
  accounts: Record<string, AccountData>;
}

export const SCHEMA_VERSION = 1 as const;

export function defaultSettings(): Settings {
  return {
    // Empty until the creator's own account is read from X or typed; never someone else's handle.
    expectedHandle: '',
    followBackEnabled: false,
    followBackOptIn: false,
    // X timestamps and daily buckets are UTC; local clocks are not used for reporting.
    reportingTimeZone: 'UTC',
    cycleCutoffHour: 0,
    // Each creator picks their own Day 1 on the receipt page; until then today counts as Day 1.
    dayAnchor: { date: '', day: 1 },
    dayOverrides: {},
    rewardsTarget: 500_000,
    staleAfterHours: 24,
    utcOnly: true,
  };
}

export const METRIC_LABELS: Record<MetricType, string> = {
  rewards_vht_90d: 'Verified Home Timeline impressions · 90-day rolling window · excludes replies',
  account_impressions: 'Account impressions',
  account_impressions_verified_only: 'Account impressions (verified-only filter)',
  post_impressions: 'Post impressions',
  followers_total: 'Followers',
  followers_verified: 'Verified followers',
};
