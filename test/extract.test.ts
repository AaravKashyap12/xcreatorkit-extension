import { describe, expect, it } from 'vitest';
import { cleanSourceUrl, extractRewards } from '../src/extract/rewards';
import * as F from './fixtures/rewards';

function doc(html: string): Document {
  const d = document.implementation.createHTMLDocument('t');
  d.documentElement.innerHTML = html;
  return d;
}

describe('rewards extractor (SYNTHETIC fixtures)', () => {
  it('reads the value next to the requirement row, with window, replies and account', () => {
    const r = extractRewards(doc(F.rewardsRequirementRow('109.2K')), F.REWARDS_URL);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.parsed.displayText).toBe('109.2K');
    expect(r.parsed.precision).toBe('rounded');
    expect(r.windowType).toBe('rolling_90d');
    expect(r.excludesReplies).toBe(true);
    expect(r.account).toBe('byaarav');
    expect(r.method).toBe('label_proximity');
  });
  it('does not confuse the 500K threshold or 500 followers with the reading', () => {
    const r = extractRewards(doc(F.rewardsPairText), F.REWARDS_URL);
    expect(r.ok && r.parsed.displayText).toBe('109.2K');
  });
  it('prefers an exact ARIA progressbar value when the max equals the target', () => {
    const r = extractRewards(doc(F.rewardsProgressbar), F.REWARDS_URL);
    expect(r.ok && r.method).toBe('aria_progressbar');
    expect(r.ok && r.parsed).toMatchObject({ value: 109_214, precision: 'exact' });
  });
  it('refuses to guess between several nearby numbers', () => {
    const r = extractRewards(doc(F.rewardsAmbiguous), F.REWARDS_URL);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('ambiguous');
    expect(r.candidates).toEqual(['109.2K', '3.2K']);
  });
  it('a valid zero reading is captured as 0, not missing', () => {
    const r = extractRewards(doc(F.rewardsRequirementRow('0')), F.REWARDS_URL);
    expect(r.ok && r.parsed.value).toBe(0);
  });
  it('a missing value is reported as not found, never zero', () => {
    const r = extractRewards(doc(F.rewardsRequirementRow('—')), F.REWARDS_URL);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBe('value_not_found');
  });
  it('regression: a missing rewards value never borrows the verified-followers number from a sibling row (div layout)', () => {
    const html = `<body><main><div>
      <div><span>At least 500 verified followers</span><span>750</span></div>
      <div><div><span>At least 500K Verified Home Timeline impressions in the last 90 days</span></div><div><span>—</span></div></div>
    </div></main></body>`;
    const r = extractRewards(doc(html), F.REWARDS_URL);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBe('value_not_found');
  });
  it('X error page → source_error', () => {
    const r = extractRewards(doc(F.rewardsErrorPage), F.REWARDS_URL);
    expect(!r.ok && r.code).toBe('source_error');
  });
  it('never reads account impressions as rewards (wrong page is unsupported)', () => {
    const r = extractRewards(doc(F.accountOverviewOnly), 'https://x.com/i/account_analytics');
    expect(!r.ok && r.code).toBe('unsupported_page');
  });
  it('account-overview content on the rewards URL still yields no reading', () => {
    const r = extractRewards(doc(F.accountOverviewOnly), F.REWARDS_URL);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBe('label_not_found');
  });
  it('detects the sign-in redirect', () => {
    const r = extractRewards(doc('<body></body>'), 'https://x.com/i/jf/onboarding/web?redirect_after_login=%2Fi');
    expect(!r.ok && r.code).toBe('not_signed_in');
  });
  it('unknown account is reported as null (popup then asks the user)', () => {
    const r = extractRewards(doc(F.rewardsRequirementRow('109.2K', null)), F.REWARDS_URL);
    expect(r.ok && r.account).toBeNull();
  });
  it('strips query strings from stored source URLs', () => {
    expect(cleanSourceUrl('https://x.com/i/jf/creators/original_content_rewards?token=abc#x')).toBe(
      'https://x.com/i/jf/creators/original_content_rewards',
    );
  });
});
