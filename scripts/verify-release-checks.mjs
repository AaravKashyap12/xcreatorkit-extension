// Negative tests for the release package rules: each mutation of a copy of dist/ must be rejected.
//   npm run build && node scripts/verify-release-checks.mjs
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPackage } from './release-lib.mjs';

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => { (ok ? passed++ : failed++); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` ${detail}`}`); };
const fresh = () => { const d = mkdtempSync(join(tmpdir(), 'xck-neg-')); cpSync('dist', d, { recursive: true }); return d; };
const editManifest = (d, fn) => { const p = join(d, 'manifest.json'); const m = JSON.parse(readFileSync(p, 'utf8')); fn(m); writeFileSync(p, JSON.stringify(m)); };
const cases = [
  ['missing editor artwork rejected', d => rmSync(join(d, 'backgrounds/rose-hour.webp')), true],
  ['retired side panel bundle rejected', d => writeFileSync(join(d, 'reply.js'), ''), true],
  ['clean dist passes', () => {}, false],
  ['extra permission rejected', (d) => editManifest(d, (m) => m.permissions.push('tabs')), true],
  ['host_permissions rejected', (d) => editManifest(d, (m) => (m.host_permissions = ['https://*/*'])), true],
  ['static content script rejected', (d) => editManifest(d, (m) => (m.content_scripts = [{ matches: ['https://x.com/*'], js: ['followback.js'] }])), true],
  ['CSP without restricted connect-src rejected', (d) => editManifest(d, (m) => (m.content_security_policy.extension_pages = "script-src 'self'; object-src 'self'")), true],
  ['remote CSP source rejected', (d) => editManifest(d, (m) => (m.content_security_policy.extension_pages += ' https://cdn.example.com')), true],
  ['additional connect destination rejected', d => editManifest(d, m => { m.content_security_policy.extension_pages = m.content_security_policy.extension_pages.replace("connect-src 'none';", 'connect-src https://example.com;'); }), true],
  ['editor bundle third-party destination rejected', d => appendFileSync(join(d, 'screenshot.js'), '\nfetch("https://example.com/");'), true],
  ['source map rejected', (d) => writeFileSync(join(d, 'background.js.map'), '{}'), true],
  ['unlisted JavaScript rejected', (d) => writeFileSync(join(d, 'extra.js'), 'const unused = 1;'), true],
  ['symlink rejected before contents are read', (d) => { rmSync(join(d, 'analytics.js')); symlinkSync('report.js', join(d, 'analytics.js')); }, true],
  ['stray env file rejected', (d) => writeFileSync(join(d, '.env'), 'X=1'), true],
  ['fetch() in service worker rejected', (d) => appendFileSync(join(d, 'background.js'), '\nfetch("https://x.com/");'), true],
  ['eval in a bundle rejected', (d) => appendFileSync(join(d, 'launcher.js'), '\neval("1");'), true],
  ['third-party URL rejected', (d) => appendFileSync(join(d, 'report.js'), '\nvar u="https://example.com/p";'), true],
  ['inline script rejected', (d) => appendFileSync(join(d, 'launcher.html'), '<script>1</script>'), true],
  ['external script src rejected', (d) => appendFileSync(join(d, 'launcher.html'), '<script src="https://example.com/a.js"></script>'), true],
  ['missing injected script rejected', (d) => rmSync(join(d, 'collector.js')), true],
];
for (const [name, mutate, shouldFail] of cases) {
  const d = fresh();
  try { mutate(d); const { errors } = checkPackage(d); check(name, shouldFail ? errors.length > 0 : errors.length === 0, errors.join('; ')); }
  finally { rmSync(d, { recursive: true, force: true }); }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
