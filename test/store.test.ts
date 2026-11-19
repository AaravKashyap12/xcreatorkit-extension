import { afterEach, describe, expect, it, vi } from 'vitest';
import { addObservation, emptyState, exportBackup, importBackup, normalizeHandle, observationsCsv, recordAttempt, recordIntraday } from '../src/store/state';
import { loadState } from '../src/store/chromeStore';
import { obs } from './helpers';

afterEach(() => vi.unstubAllGlobals());

describe('state loading', () => {
  it('uses UTC settings when a stored utcOnly flag coexists with a custom timezone, without rewriting storage', async () => {
    const stored = emptyState();
    Object.assign(stored.settings, { utcOnly: true, reportingTimeZone: 'Asia/Kolkata', cycleCutoffHour: 4 });
    const set = vi.fn();
    vi.stubGlobal('chrome', { storage: { local: { get: async () => ({ 'xgd:v1': stored }), set } } });
    expect((await loadState()).settings).toMatchObject({ utcOnly: true, reportingTimeZone: 'UTC', cycleCutoffHour: 0 });
    expect(stored.settings).toMatchObject({ reportingTimeZone: 'Asia/Kolkata', cycleCutoffHour: 4 });
    expect(set).not.toHaveBeenCalled();
  });
});

describe('store', () => {
  it('same value on the same reporting day re-confirms instead of adding history', () => {
    const s = emptyState();
    expect(addObservation(s, obs('109.2K', '2026-10-02T15:00:00Z')).kind).toBe('appended');
    expect(addObservation(s, obs('109.2K', '2026-10-02T19:00:00Z')).kind).toBe('reconfirmed');
    const list = s.accounts.byaarav!.observations;
    expect(list).toHaveLength(1);
    expect(list[0]!.lastSeenAt).toBe('2026-10-02T19:00:00.000Z');
    expect(list[0]!.capturedAt).toBe('2026-10-02T15:00:00.000Z');
  });
  it('a changed value on the same day is a new observation', () => {
    const s = emptyState();
    addObservation(s, obs('109.2K', '2026-10-02T15:00:00Z'));
    expect(addObservation(s, obs('109.4K', '2026-10-02T19:00:00Z')).kind).toBe('appended');
  });
  it('exact duplicates (same id) are not duplicated', () => {
    const s = emptyState();
    const o = obs('109.2K', '2026-10-02T15:00:00Z');
    addObservation(s, o);
    addObservation(s, obs('100K', '2026-10-03T15:00:00Z'));
    expect(addObservation(s, { ...o }).kind).toBe('reconfirmed');
    expect(s.accounts.byaarav!.observations).toHaveLength(2);
  });
  it('accounts are isolated', () => {
    const s = emptyState();
    addObservation(s, obs('109.2K', '2026-10-02T15:00:00Z'));
    addObservation(s, obs('400K', '2026-10-02T15:00:00Z', { account: 'someoneelse' }));
    expect(s.accounts.byaarav!.observations.map((o) => o.displayText)).toEqual(['109.2K']);
    expect(s.accounts.someoneelse!.observations.map((o) => o.displayText)).toEqual(['400K']);
  });
  it('failed attempts with unknown account never touch a creator bucket', () => {
    const s = emptyState();
    recordAttempt(s, { at: 'x', account: null, metric: 'rewards_vht_90d', ok: false, sourceUrl: null });
    expect(Object.keys(s.accounts)).toEqual(['_unknown']);
  });
  it('normalizes handles', () => {
    expect(normalizeHandle('@ByAarav')).toBe('byaarav');
    expect(normalizeHandle('bad handle!')).toBeNull();
  });
});

describe('backup', () => {
  it('round-trips and deduplicates', () => {
    const a = emptyState();
    addObservation(a, obs('109.2K', '2026-10-02T15:00:00Z'));
    const json = exportBackup(a, new Date('2026-10-02T20:00:00Z'));
    const b = emptyState();
    expect(importBackup(b, json)).toMatchObject({ added: 1, duplicates: 0, rejected: 0 });
    expect(importBackup(b, json)).toMatchObject({ added: 0, duplicates: 1 });
  });
  it('rejects observations filed under the wrong account and malformed records', () => {
    const bad = {
      kind: 'xgd-backup',
      schemaVersion: 1,
      accounts: {
        byaarav: { observations: [obs('400K', '2026-10-02T15:00:00Z', { account: 'someoneelse' }), { id: 'x', value: 'NaN' }] },
      },
    };
    const s = emptyState();
    expect(importBackup(s, JSON.stringify(bad))).toMatchObject({ added: 0, rejected: 2 });
    expect(s.accounts.byaarav!.observations).toHaveLength(0);
  });
  it('rejects non-backup files', () => {
    expect(() => importBackup(emptyState(), '{"hello":1}')).toThrow(/backup/);
    expect(() => importBackup(emptyState(), 'not json')).toThrow(/JSON/);
  });
  it('CSV neutralises formula injection', () => {
    const csv = observationsCsv([obs('109.2K', '2026-10-02T15:00:00Z', { sourceLabel: '=HYPERLINK("x")' })]);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
  });
});

describe('intraday observations', () => {
  it('stores one point per capture time, sorted, deduplicated, per account and UTC day', () => {
    const s = emptyState();
    recordIntraday(s, 'byaarav', '2026-10-02', new Date('2026-10-02T18:00:29Z'), { Impressions: 6009 });
    recordIntraday(s, 'byaarav', '2026-10-02', new Date('2026-10-02T16:48:49Z'), { Impressions: 5169 });
    recordIntraday(s, 'byaarav', '2026-10-02', new Date('2026-10-02T18:00:29Z'), { Impressions: 6009 });
    recordIntraday(s, 'other', '2026-10-02', new Date('2026-10-02T17:00:00Z'), { Impressions: 1 });
    expect(s.accounts.byaarav!.intraday!['2026-10-02']!.map((o) => o.metrics.Impressions)).toEqual([5169, 6009]);
    expect(s.accounts.other!.intraday!['2026-10-02']).toHaveLength(1);
  });
  it('keeps only the most recent 14 days', () => {
    const s = emptyState();
    for (let d = 1; d <= 20; d++) recordIntraday(s, 'byaarav', `2026-09-${String(d).padStart(2, '0')}`, new Date(`2026-09-${String(d).padStart(2, '0')}T12:00:00Z`), { Impressions: d });
    expect(Object.keys(s.accounts.byaarav!.intraday!).sort()[0]).toBe('2026-09-07');
  });
});
