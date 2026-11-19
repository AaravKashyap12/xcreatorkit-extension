import type { Observation, Settings } from '../src/model/types';
import { defaultSettings } from '../src/model/types';
import { parseCount } from '../src/model/parse';
import { buildObservation } from '../src/store/state';

// Fixture: the original account's count (30 Sep 2026 = Day 30, with a confirming override for 1 Oct).
export const settings = (over: Partial<Settings> = {}): Settings => ({
  ...defaultSettings(),
  reportingTimeZone: 'Europe/London',
  dayAnchor: { date: '2026-09-30', day: 30 },
  dayOverrides: { '2026-10-01': 31 },
  ...over,
});

export function obs(display: string, at: string, over: Partial<Observation> & { s?: Settings } = {}): Observation {
  const { s = settings(), ...rest } = over;
  const o = buildObservation(
    {
      account: 'byaarav',
      accountSource: 'page',
      metric: 'rewards_vht_90d',
      parsed: parseCount(display)!,
      provenance: 'captured',
      sourceUrl: 'https://x.com/i/jf/creators/original_content_rewards',
      sourceLabel: 'test',
      at: new Date(at),
      windowType: 'rolling_90d',
      verifiedOnly: true,
      excludesReplies: true,
    },
    s,
  );
  return { ...o, ...rest };
}
