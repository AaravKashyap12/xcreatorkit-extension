// Checks a candidate archive made by scripts/package-release.mjs, using the archive itself.
//   node scripts/verify-release-package.mjs <candidate.zip>
// 1. Archive hash, entry list and per-file hashes match the sidecar manifest.
// 2. Static package rules (scripts/release-lib.mjs).
// 3. The extracted archive loads as an unpacked extension in a throwaway Chromium profile
//    (never the user's Chrome): the service worker starts, every extension page renders
//    without console errors or page errors, and no page makes a network request.
// Synthetic data only. This does not exercise X pages and is not Store approval.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkPackage, sha256 } from './release-lib.mjs';

const zip = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('usage: node scripts/verify-release-package.mjs <candidate.zip>');
let passed = 0, failed = 0;
const check = (name, ok, detail = '') => { (ok ? passed++ : failed++); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` ${detail}`}`); };

const sidecar = JSON.parse(readFileSync(zip.replace(/\.zip$/, '.manifest.json'), 'utf8'));
check('zip sha256 matches sidecar', sha256(readFileSync(zip)) === sidecar.zipSha256);

const listing = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).split('\n').filter(Boolean);
check('zip has no directory entries or absolute/parent paths', listing.every((n) => !n.endsWith('/') && !n.startsWith('/') && !n.includes('..')));
check('zip entries equal sidecar file list', JSON.stringify([...listing].sort()) === JSON.stringify(sidecar.files.map((f) => f.path).sort()));
const metadata = execFileSync('unzip', ['-Z', '-l', zip], { encoding: 'utf8' });
check('zip contains no symlinks or duplicate names', !/^l[rwx-]{9}\s/m.test(metadata) && new Set(listing).size === listing.length);
if (failed) throw new Error('Unsafe or mismatched archive: refusing extraction.');

const dir = mkdtempSync(join(tmpdir(), 'xck-verify-pkg-'));
const profile = mkdtempSync(join(tmpdir(), 'xck-verify-profile-'));
try {
  execFileSync('unzip', ['-q', zip, '-d', dir]);
  check('extracted file hashes match sidecar', sidecar.files.every((f) => sha256(readFileSync(join(dir, f.path))) === f.sha256));
  const { errors, manifest } = checkPackage(dir);
  check('static package rules', errors.length === 0, errors.join('; '));
  check('candidate is labelled, not cleared', /^CANDIDATE/.test(sidecar.label));
  if (failed) throw new Error('Candidate failed validation: refusing to load extension code.');

  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath: chromium.executablePath(), headless: true, viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce',
    args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`],
  });
  const problems = [], requests = [];
  try {
    let [worker] = ctx.serviceWorkers();
    worker ??= await ctx.waitForEvent('serviceworker', { timeout: 15000 });
    check('service worker starts from the archive', /\/background\.js$/.test(worker.url()));
    const base = worker.url().replace(/\/background\.js$/, '');
    const regs = await worker.evaluate(() => chrome.scripting.getRegisteredContentScripts().then((r) => r.length));
    check('no content script is registered before the user grants x.com access', regs === 0, String(regs));
    const granted = await worker.evaluate(() => chrome.permissions.getAll());
    check('install-time API permissions are a subset of the manifest list', granted.permissions.every((p) => manifest.permissions.includes(p)), JSON.stringify(granted));
    check('no host access granted at install', (granted.origins ?? []).length === 0, JSON.stringify(granted.origins));
    for (const page of ['launcher', 'receipt', 'report', 'dashboard', 'analytics', 'postcard', 'screenshot']) {
      const p = await ctx.newPage();
      p.on('console', (m) => { if (m.type() === 'error') problems.push(`${page}: console ${m.text()}`); });
      p.on('pageerror', (e) => problems.push(`${page}: pageerror ${e.message}`));
      p.on('request', (r) => { if (!/^(chrome-extension|data|blob):/.test(r.url())) requests.push(`${page}: ${r.url()}`); });
      await p.goto(`${base}/${page}.html`);
      await p.waitForLoadState('load');
      await p.waitForTimeout(700);
      const body = (await p.locator('body').innerText()).trim();
      check(`${page}.html renders`, body.length > 20, `body length ${body.length}`);
      await p.close();
    }
    check('no console or page errors across extension pages', problems.length === 0, problems.join(' | '));
    check('no network requests from extension pages', requests.length === 0, requests.join(' | '));
  } finally { await ctx.close(); }
} finally {
  rmSync(dir, { recursive: true, force: true });
  rmSync(profile, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
