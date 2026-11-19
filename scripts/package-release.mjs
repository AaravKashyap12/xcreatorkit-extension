// Rebuilds dist/ and makes a local release CANDIDATE archive from this checkout.
//   node scripts/package-release.mjs [--out <dir>] [--allow-dirty]
// It only copies an allow-listed set of built files, adds third-party licence notices, checks the
// result (scripts/release-lib.mjs) and zips it with fixed timestamps. It never uploads, signs or
// publishes anything. The output is a candidate, not a cleared release: see
// docs/v1/evidence/26-release-readiness.md for the open blockers.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkPackage, sha256 } from './release-lib.mjs';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const out = resolve(opt('--out', join(tmpdir(), 'xck-release')));
const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();

const dirty = git('status', '--porcelain', '--', '.', ':(exclude)node_modules').length > 0;
if (dirty && !flag('--allow-dirty')) throw new Error('Working tree has uncommitted changes. Commit them, or pass --allow-dirty (the candidate is then marked dirty).');
const commit = git('rev-parse', 'HEAD');
const commitTime = Number(git('show', '-s', '--format=%ct', 'HEAD'));
const tree = git('rev-parse', 'HEAD^{tree}');
// Never label a stale dist/ with the current source commit.
execFileSync(process.execPath, ['build.mjs'], { stdio: 'inherit' });

// Licence notices for code and fonts that the bundles inline (the bundles carry no licence files).
const BUNDLED = [
  ['gsap', 'GSAP, used under the GreenSock Standard "no charge" licence: https://gsap.com/standard-license (the licence banner is kept inside the bundled code)'],
  ['number-flow'], ['esm-env'],
  ['@fontsource/ibm-plex-mono'], ['@fontsource/instrument-serif'], ['@fontsource/zilla-slab'], ['@fontsource/courier-prime'], ['@fontsource/yellowtail'],
  ['@fontsource-variable/archivo'], ['@fontsource-variable/bricolage-grotesque'], ['@fontsource-variable/martian-mono'],
];
function notices() {
  const parts = ['X Creator Kit: third-party notices', '', 'These packages are bundled into the extension. Geist, Geist Mono, Archivo, Martian Mono and Doto also ship as separate files under fonts/, each with its own licence text (OFL-*.txt).', ''];
  for (const [name, note] of BUNDLED) {
    const dir = join('node_modules', name);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    parts.push('='.repeat(72), `${name}@${pkg.version} (${typeof pkg.license === 'string' ? pkg.license : JSON.stringify(pkg.license)})`, '');
    const licence = ['LICENSE', 'LICENSE.md', 'LICENSE.txt'].map((f) => join(dir, f)).find(existsSync);
    if (licence) parts.push(readFileSync(licence, 'utf8').trim());
    else if (note) parts.push(note);
    else throw new Error(`No licence text found for bundled package ${name}`);
    parts.push('');
  }
  return parts.join('\n');
}

const stage = mkdtempSync(join(tmpdir(), 'xck-stage-'));
try {
  cpSync('dist', stage, { recursive: true });
  writeFileSync(join(stage, 'THIRD_PARTY_NOTICES.txt'), notices());
  const { errors, notes, files, manifest } = checkPackage(stage);
  if (errors.length) throw new Error(errors.map((e) => `FAIL ${e}`).join('\n'));

  for (const f of files) utimesSync(join(stage, f.path), commitTime, commitTime);
  mkdirSync(out, { recursive: true });
  const base = `x-creator-kit-${manifest.version}-candidate-${commit.slice(0, 7)}${dirty ? '-dirty' : ''}`;
  const zip = join(out, `${base}.zip`);
  rmSync(zip, { force: true });
  const names = files.map((f) => f.path).sort();
  execFileSync('zip', ['-X', '-D', '-q', zip, '-@'], { cwd: stage, input: names.join('\n') + '\n', env: { ...process.env, TZ: 'UTC' } });

  const zipBuf = readFileSync(zip);
  const record = {
    label: 'CANDIDATE. Not cleared for Chrome Web Store submission or launch. See docs/v1/evidence/26-release-readiness.md.',
    name: manifest.name, version: manifest.version,
    gitCommit: commit, gitTree: tree, workingTreeDirty: dirty,
    zip: `${base}.zip`, zipBytes: zipBuf.length, zipSha256: sha256(zipBuf),
    permissions: manifest.permissions, optionalHostPermissions: manifest.optional_host_permissions,
    checks: { staticPackageChecks: 'pass', notes },
    files: files.map((f) => ({ path: f.path, bytes: f.bytes, sha256: sha256(readFileSync(join(stage, f.path))) })),
  };
  writeFileSync(join(out, `${base}.manifest.json`), JSON.stringify(record, null, 2) + '\n');
  console.log(`candidate: ${zip}\nsha256:    ${record.zipSha256}\nbytes:     ${record.zipBytes}\nfiles:     ${files.length}\nmanifest:  ${join(out, `${base}.manifest.json`)}`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
