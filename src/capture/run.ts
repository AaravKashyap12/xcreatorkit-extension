// One-click capture, run by the background service worker.
// Uses only the tab selected by the toolbar gesture; other sources are skipped.
import { isRewardsUrl, type RewardsExtract } from '../extract/rewards';
import { xAnalyticsInPage, type XAnalyticsResult } from '../x/analyticsPage';
import { xProfileFollowersInPage, type ProfileResult } from '../x/profilePage';
import { rowsFromCapture } from '../analytics/series';
import { parseCount } from '../model/parse';
import { addObservation, buildObservation, recordAttempt, recordIntraday, saveDailyCapture } from '../store/state';
import { updateState } from '../store/chromeStore';

export const ANALYTICS_URL = 'https://x.com/i/account_analytics';
export const REWARDS_URL = 'https://x.com/i/jf/creators/original_content_rewards';
export const X_ORIGINS = ['https://x.com/*'];
export const RUN_KEY = 'xgd:run';

export type StepState = 'pending' | 'running' | 'done' | 'skipped' | 'failed';
export interface RunStatus {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  /** Each source is reported on its own: refreshing one never implies the other refreshed. */
  steps: {
    analytics: { state: StepState; message: string; at?: string };
    rewards: { state: StepState; message: string; at?: string };
    profile?: { state: StepState; message: string; at?: string };
  };
  account: string | null;
}

export function isAnalyticsUrl(u?: string): boolean {
  try {
    const x = new URL(u ?? '');
    return (x.hostname === 'x.com' || x.hostname === 'twitter.com') && /^\/i\/account_analytics\/?$/.test(x.pathname);
  } catch {
    return false;
  }
}

async function setStatus(s: RunStatus) {
  await chrome.storage.session.set({ [RUN_KEY]: s });
}

/** Read only the matching tab supplied by the toolbar gesture. Never open a source page. */
async function withSourceTab<T>(
  matches: (u?: string) => boolean,
  active: chrome.tabs.Tab | undefined,
  fn: (tabId: number) => Promise<T>,
): Promise<T | 'no_access'> {
  if (active?.id != null && matches(active.url)) return fn(active.id);
  return 'no_access';
}

async function captureAnalytics(tabId: number): Promise<XAnalyticsResult> {
  const [inj] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: xAnalyticsInPage, args: [] });
  return inj!.result as XAnalyticsResult;
}

async function captureRewards(tabId: number): Promise<RewardsExtract> {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['collector.js'] });
  const [inj] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => (globalThis as unknown as { __xgdCollect: () => Promise<unknown> }).__xgdCollect(),
  });
  return inj!.result as RewardsExtract;
}

export async function runCapture(active: chrome.tabs.Tab | undefined): Promise<RunStatus> {
  const status: RunStatus = {
    id: crypto.randomUUID(),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    steps: { analytics: { state: 'running', message: 'Reading X Analytics…' }, rewards: { state: 'pending', message: 'Waiting…' }, profile: { state: 'pending', message: 'Waiting…' } },
    account: null,
  };
  await setStatus(status);

  // ---- Analytics (daily series + follower card)
  try {
    const res = await withSourceTab(isAnalyticsUrl, active, captureAnalytics);
    if (res === 'no_access') {
      status.steps.analytics = { state: 'skipped', message: 'not refreshed: open X Analytics and use Read current X tab', at: new Date().toISOString() };
    } else if (!res.ok) {
      status.steps.analytics = { state: 'failed', message: `failed: ${res.message}`, at: new Date().toISOString() };
    } else if (!res.account) {
      status.steps.analytics = { state: 'failed', message: 'failed: could not tell which account is signed in; nothing saved', at: new Date().toISOString() };
    } else if (typeof res.verifiedOnly !== 'boolean') {
      status.steps.analytics = { state: 'failed', message: 'failed: could not identify the audience filter on X Analytics; analytics were not saved. Check the selected filter on X, then read the tab again.', at: new Date().toISOString() };
    } else {
      const capturedAt = new Date(res.capturedAt);
      const rows = rowsFromCapture(res.points, capturedAt);
      const acct = res.account;
      status.account = acct;
      await updateState((s) => {
        saveDailyCapture(s, acct, res.verifiedOnly ? 'verified' : 'all', rows, res.range, capturedAt);
        // Observed intraday point: the in-progress UTC day's running totals at this capture time.
        const live = rows.find((r) => r.partial && r.date === capturedAt.toISOString().slice(0, 10));
        if (live && !res.verifiedOnly) recordIntraday(s, acct, live.date, capturedAt, live.metrics);
        const src = { sourceUrl: ANALYTICS_URL, sourceLabel: 'X Analytics · follower card', at: capturedAt, windowType: 'unknown' as const, verifiedOnly: null, excludesReplies: null };
        for (const [metric, text] of [['followers_verified', res.followers.verified], ['followers_total', res.followers.total]] as const) {
          const parsed = parseCount(text);
          if (parsed) addObservation(s, buildObservation({ account: acct, accountSource: 'page', metric, parsed, provenance: 'captured', ...src }, s.settings));
        }
      });
      const today = rows.find((r) => r.partial);
      status.steps.analytics = { state: 'done', message: `refreshed: ${rows.length} days${today ? `, today so far ${today.metrics.Impressions ?? '—'} impressions` : ', no row for today'}${res.verifiedOnly ? ' (verified-only filter)' : ''}`, at: res.capturedAt };
    }
  } catch (e) {
    status.steps.analytics = { state: 'failed', message: `failed: ${(e as Error).message}`, at: new Date().toISOString() };
  }
  status.steps.rewards = { state: 'running', message: 'Reading Original Content Rewards…' };
  await setStatus(status);

  // ---- Rewards (90-day Verified Home Timeline impressions)
  try {
    const res = await withSourceTab((u) => isRewardsUrl(u ?? ''), active, captureRewards);
    const now = new Date();
    if (res === 'no_access') {
      status.steps.rewards = { state: 'skipped', message: 'not refreshed: open Rewards and use Read current X tab', at: now.toISOString() };
    } else if (!res.ok) {
      await updateState((s) => recordAttempt(s, { at: now.toISOString(), account: res.account, metric: 'rewards_vht_90d', ok: false, code: res.code, message: res.message, sourceUrl: res.sourceUrl }));
      status.steps.rewards = { state: 'failed', message: `failed: ${res.message}`, at: now.toISOString() };
    } else if (!res.account || (status.account && res.account !== status.account)) {
      status.steps.rewards = { state: 'failed', message: res.account ? `failed: rewards page shows @${res.account}, analytics showed @${status.account}; not saved` : 'failed: account not detected; not saved', at: now.toISOString() };
    } else {
      const acct = res.account;
      status.account ??= acct;
      const { result } = await updateState((s) => {
        recordAttempt(s, { at: now.toISOString(), account: acct, metric: 'rewards_vht_90d', ok: true, sourceUrl: res.sourceUrl });
        return addObservation(
          s,
          buildObservation(
            { account: acct, accountSource: 'page', metric: 'rewards_vht_90d', parsed: res.parsed, provenance: 'captured', sourceUrl: res.sourceUrl, sourceLabel: 'X Creator Studio · Original Content Rewards', at: now, windowType: res.windowType, verifiedOnly: true, excludesReplies: res.excludesReplies, note: `method: ${res.method}` },
            s.settings,
          ),
        );
      });
      status.steps.rewards = { state: 'done', message: `${result.kind === 'appended' ? 'refreshed' : 're-confirmed'}: ${res.parsed.displayText}`, at: now.toISOString() };
    }
  } catch (e) {
    status.steps.rewards = { state: 'failed', message: `failed: ${(e as Error).message}`, at: new Date().toISOString() };
  }
  // ---- Profile: exact follower count (X Analytics only shows a rounded "1K")
  status.steps.profile = { state: 'running', message: 'Reading follower count…' };
  await setStatus(status);
  try {
    const settingsHandle = (await chrome.storage.local.get('xgd:v1'))['xgd:v1']?.settings?.expectedHandle as string | undefined;
    const handle = (status.account ?? settingsHandle ?? '').toLowerCase();
    const url = `https://x.com/${handle}`;
    const isProfile = (u?: string) => {
      try {
        const x = new URL(u ?? '');
        return (x.hostname === 'x.com' || x.hostname === 'twitter.com') && x.pathname.replace(/\/+$/, '').toLowerCase() === `/${handle}`;
      } catch {
        return false;
      }
    };
    const now = new Date();
    if (!handle) {
      status.steps.profile = { state: 'skipped', message: 'not refreshed: account unknown', at: now.toISOString() };
    } else {
      const res = await withSourceTab(isProfile, active, async (tabId) => {
        const [inj] = await chrome.scripting.executeScript({ target: { tabId }, func: xProfileFollowersInPage, args: [handle] });
        return inj!.result as ProfileResult;
      });
      const parsed = res !== 'no_access' && res.ok ? parseCount(res.followersText) : null;
      if (res === 'no_access') {
        status.steps.profile = { state: 'skipped', message: 'not refreshed: open your profile and use Read current X tab', at: now.toISOString() };
      } else if (!res.ok) {
        status.steps.profile = { state: 'failed', message: `failed: ${res.message}`, at: now.toISOString() };
      } else if (!parsed) {
        status.steps.profile = { state: 'failed', message: `failed: could not read "${res.followersText}"`, at: now.toISOString() };
      } else {
        await updateState((s) =>
          addObservation(
            s,
            buildObservation({ account: res.account, accountSource: 'page', metric: 'followers_total', parsed, provenance: 'captured', sourceUrl: url, sourceLabel: 'X profile', at: now, windowType: 'unknown', verifiedOnly: null, excludesReplies: null }, s.settings),
          ),
        );
        status.steps.profile = { state: 'done', message: `refreshed: ${parsed.displayText} followers`, at: now.toISOString() };
      }
    }
  } catch (e) {
    status.steps.profile = { state: 'failed', message: `failed: ${(e as Error).message}`, at: new Date().toISOString() };
  }
  status.finishedAt = new Date().toISOString();
  await setStatus(status);
  return status;
}
