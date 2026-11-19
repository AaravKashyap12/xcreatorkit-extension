// Synthetic X React fixture only: all requests are fulfilled locally. Exercise
// the serialized MAIN-world function in actual browser timezone contexts.
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const bundle = await build({ entryPoints: ['src/x/analyticsPage.ts'], bundle: true, write: false, format: 'iife', globalName: 'CaptureFixture', target: 'chrome120' });
const runner = await build({ entryPoints: ['src/capture/run.ts'], bundle: true, write: false, format: 'iife', globalName: 'RunnerFixture', target: 'chrome120' });
const browser = await chromium.launch({ headless: true });
const results = [];
const check = (name, ok) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
};

try {
  for (const timezoneId of ['UTC', 'Asia/Kolkata', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
    const context = await browser.newContext({ timezoneId });
    await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<main data-testid="primaryColumn"><button>Range</button></main><a data-testid="AppTabBar_Profile_Link" href="/samplecreator">Profile</a>' }));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('https://x.com/i/account_analytics');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    for (const now of ['2026-03-09T00:30:00.000Z', '2026-11-02T23:30:00.000Z']) {
      await page.clock.setFixedTime(new Date(now));
      for (const days of [1, 7, 365]) {
        const midnight = Date.parse(now.slice(0, 10) + 'T00:00:00.000Z');
        const expected = { from: new Date(midnight - (days - 1) * 864e5).toISOString(), to: new Date(midnight + 864e5 - 1).toISOString() };
        await page.evaluate(({ midnight, expected }) => {
          const props = {
            timeRange: { from: new Date(expected.from), to: new Date(expected.to) },
            currentMetricData: { [midnight]: { Impressions: 123, Engagements: 0 } },
            verifiedOnly: true,
            isPending: false,
            onTimeRangeChange(range) { props.timeRange = range; window.rangeCalls++; },
          };
          window.rangeCalls = 0;
          document.querySelector('button').__reactFiber$fixture = { memoizedProps: props };
          // chrome.scripting serializes the function, without module scope.
          window.captureFunction = (0, eval)('(' + CaptureFixture.xAnalyticsInPage.toString() + ')');
        }, { midnight, expected });
        const result = await page.evaluate(days => window.captureFunction(), days);
        const label = `${timezoneId} ${now} ${days}D`;
        check(`${label}: exact UTC boundaries`, result.ok && result.range.from === expected.from && result.range.to === expected.to);
        check(`${label}: preserves source timestamp, zeros and audience`, result.ok && result.account === 'samplecreator' && result.verifiedOnly === true && result.points[0]?.t === midnight && result.points[0]?.m.Engagements === 0 && result.capturedAt === now);
        const repeat = await page.evaluate(days => window.captureFunction(), days);
        check(`${label}: selected range is never changed`, repeat.ok && !repeat.appliedRange && await page.evaluate(() => window.rangeCalls === 0));
      }
    }
    await page.evaluate(() => { document.querySelector('button').__reactFiber$fixture.memoizedProps.isPending = true; });
    const pending = await page.evaluate(() => window.captureFunction());
    check(`${timezoneId}: pending source fails without changing range`, !pending.ok && pending.code === 'not_ready' && await page.evaluate(() => window.rangeCalls === 0));
    await page.evaluate(() => { const p = document.querySelector('button').__reactFiber$fixture.memoizedProps; p.isPending = false; p.timeRange = { from: '2026-10-01', to: '2026-10-02' }; });
    const ambiguous = await page.evaluate(() => window.captureFunction());
    check(`${timezoneId}: timezone-less range is rejected`, !ambiguous.ok && await page.evaluate(() => window.rangeCalls === 0));
    await page.evaluate(() => {
      const owner = { memoizedProps: { verifiedOnly: true, onTimeRangeChange() { window.rangeCalls++; } } };
      const child = { memoizedProps: { currentMetricData: { [Date.parse('2026-11-01T00:00:00Z')]: { Impressions: 12 } }, timeRange: { from: new Date('2026-11-01T00:00:00Z'), to: new Date('2026-11-01T23:59:59.999Z') } }, return: owner };
      owner.child = child;
      document.querySelector('button').__reactFiber$fixture = child;
    });
    const nested = await page.evaluate(() => window.captureFunction());
    check(`${timezoneId}: audience above the data host remains attached without invoking its handler`, nested.ok && nested.verifiedOnly === true && await page.evaluate(() => window.rangeCalls === 0));
    check(`${timezoneId}: no page errors`, errors.length === 0);
    await page.addScriptTag({ content: runner.outputFiles[0].text });
    const passive = await page.evaluate(async () => {
      let creates = 0, reads = 0;
      window.chrome = {
        permissions: { contains: async () => true },
        storage: { session: { set: async () => {} }, local: { get: async () => ({ 'xgd:v1': { settings: { expectedHandle: 'samplecreator' } } }) } },
        tabs: { create: async () => { creates++; throw Error('Unexpected background tab'); } },
        scripting: { executeScript: async () => { reads++; return [{ result: { ok: false, message: 'Synthetic unavailable' } }]; } },
      };
      const idle = await RunnerFixture.runCapture(undefined);
      const idleReads = reads;
      const one = await RunnerFixture.runCapture({ id: 9, url: 'https://x.com/i/account_analytics' });
      return { creates, reads, idleReads, idle, one };
    });
    check(`${timezoneId}: even granted access cannot open background source tabs`, passive.creates === 0 && passive.idleReads === 0);
    check(`${timezoneId}: Analytics gesture reads only Analytics and skips other sources`, passive.reads === 1 && passive.one.steps.rewards.state === 'skipped' && passive.one.steps.profile.state === 'skipped');
    await context.close();
  }
} finally {
  await browser.close();
}

mkdirSync('verification', { recursive: true });
writeFileSync('verification/capture-utc.json', JSON.stringify(results, null, 2));
const passed = results.filter(result => result.ok).length;
console.log(`${passed}/${results.length} passed`);
if (passed !== results.length) process.exitCode = 1;
