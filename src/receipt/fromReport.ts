// Maps the captured report (X Analytics + Creator Studio rewards) onto receipt data.
// Every figure comes from a stored reading; anything not captured shows as "—", never zero.
import type { Report } from '../analytics/report';
import type { DailyRow } from '../analytics/series';
import type { Observation } from '../model/types';
import { dailyCheckpoints } from '../calc/rewards';
import { METRICS, type MetricKey, type ReceiptData } from './data';

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const fmt = (v: number) => Math.round(v).toLocaleString('en-US');
const signed = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${fmt(Math.abs(v))}`;

export function receiptFromReport(r: Report, opts: { day: number; metrics: MetricKey[]; history: DailyRow[]; observations?: readonly Observation[] }): ReceiptData {
  const ymd = r.reportingDate;
  const [y, m, d] = ymd.split('-');
  const today = r.range.cells.at(-1);
  const row = today?.isToday ? today.row : null;
  const metric = (k: string) => (row && k in row.metrics ? row.metrics[k]! : null);
  const rw = r.rewards;
  const rewardDays = dailyCheckpoints((opts.observations ?? []).filter((o) => o.metric === 'rewards_vht_90d' && o.provenance !== 'scenario'));

  const value = (k: MetricKey): string => {
    switch (k) {
      case 'followers': { const v = metric('Follows'); return v == null ? '—' : signed(v); }
      case 'posts': { const v = metric('CreateTweet'); return v == null ? '—' : fmt(v); }
      case 'replies': { const v = metric('CreateReply'); return v == null ? '—' : fmt(v); }
      case 'impressions': { const v = metric('Impressions'); return v == null ? '—' : fmt(v); }
      case 'likes': { const v = metric('Likes'); return v == null ? '—' : fmt(v); }
      case 'profileVisits': { const v = metric('ProfileVisits'); return v == null ? '—' : fmt(v); }
      case 'engagementRate': {
        const e = metric('Engagements'), i = metric('Impressions');
        return e == null || !i ? '—' : `${((e / i) * 100).toFixed(1)}%`;
      }
      case 'impressionsDelta': {
        const g = rw?.pace.gains.at(-1);
        if (!g || g.delta == null || g.date !== ymd) return '—';
        return `${g.approximate ? '≈' : ''}${signed(g.delta)}`;
      }
      default: return '—';
    }
  };

  const rows = opts.metrics.map((k) => ({ key: k, label: METRICS.find((x) => x.key === k)!.label, value: value(k) }));

  let total: ReceiptData['total'] = null;
  if (rw) {
    const p = rw.pace;
    total = {
      value: rw.reading.value,
      text: rw.reading.precision === 'rounded' ? rw.reading.displayText : fmt(rw.reading.value),
      target: rw.progress.targetText,
      // Never print 100% before the target is actually reached.
      pct: Math.min(100, Math.floor(rw.progress.percent)),
      eta: p.status === 'reached' ? 'REACHED' : (p.status === 'ahead' || p.status === 'behind') && p.eta && !p.eta.beyondProjection ? (p.eta.days <= 1 ? '~1 DAY' : `~${p.eta.days} DAYS`) : null,
    };
  }

  // NEW RECORD only when today's follows beat every earlier captured day (with a week of history).
  const follows = metric('Follows');
  const earlier = opts.history.filter((h) => h.date < ymd && 'Follows' in h.metrics).map((h) => h.metrics.Follows!);
  const record = follows != null && follows > 0 && earlier.length >= 7 && follows > Math.max(...earlier);

  const numericRows = rows.filter((x) => x.value !== '—');
  const hasAnalytics = numericRows.some((x) => x.key !== 'impressionsDelta');
  const hasRewards = !!total || numericRows.some((x) => x.key === 'impressionsDelta');
  const hasFollowers = !total && !!r.followerCount;
  const deltaShown = numericRows.some((x) => x.key === 'impressionsDelta');
  const priorReward = rewardDays.find((o) => o.reportingDate === new Date(Date.parse(`${ymd}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10));
  const rewardCaptured = rw?.reading.provenance === 'captured'
    && (!deltaShown || priorReward?.provenance === 'captured')
    && (!total?.eta || total.eta === 'REACHED' || (rewardDays.length > 0 && rewardDays.every((o) => o.provenance === 'captured')));
  const captured = (numericRows.length > 0 || hasRewards || hasFollowers)
    && (!hasRewards || rewardCaptured)
    && (!hasFollowers || r.followerCount?.provenance === 'captured');
  const at = hasAnalytics ? row?.capturedAt : hasRewards ? rw?.reading.lastSeenAt : r.followerCount?.lastSeenAt;
  const capturedYmd = at?.slice(0, 10) ?? ymd;
  return {
    handle: r.handle,
    no: String(opts.day).padStart(4, '0'),
    day: opts.day,
    date: `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`,
    stampDate: `${capturedYmd.slice(8)}.${capturedYmd.slice(5, 7)}.${capturedYmd.slice(2, 4)}`,
    time: at ? `${at.slice(11, 16)} UTC` : '—',
    rows,
    total,
    followersTotal: r.followerCount?.displayText ?? null,
    captured,
    record,
  };
}
