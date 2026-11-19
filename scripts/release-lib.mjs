// Shared checks for the local release-candidate archive. No dependencies beyond Node.
// A pass here means the package matches the code-level rules below. It is not Chrome Web Store
// approval, and it says nothing about whether X permits reading its pages.
import { readdirSync, readFileSync, lstatSync } from 'node:fs';
import { join, relative, extname, posix } from 'node:path';
import { createHash } from 'node:crypto';

export const EXPECTED_PERMISSIONS = ['activeTab', 'contextMenus', 'scripting', 'sidePanel', 'storage'];
export const EXPECTED_OPTIONAL_HOSTS = ['https://x.com/*', 'https://generativelanguage.googleapis.com/*'];
/** Scripts injected by the service worker with chrome.scripting; no manifest entry references them. */
export const INJECTED_SCRIPTS = ['collector.js', 'followback.js', 'postcard-target.js', 'reply-target.js'];
/** URL hosts that may appear as text in shipped code. Navigation targets and comments only. */
export const ALLOWED_URL_HOSTS = new Set(['x.com', 'www.w3.org', 'gsap.com', 'github.com']);
const FORBIDDEN_JS = [
  [/\beval\s*\(/, 'eval()'],
  [/\bnew\s+Function\s*\(/, 'new Function()'],
  [/\bfetch\s*\(/, 'fetch()'],
  [/XMLHttpRequest/, 'XMLHttpRequest'],
  [/sendBeacon/, 'sendBeacon'],
  [/\bWebSocket\b/, 'WebSocket'],
  [/\bEventSource\b/, 'EventSource'],
  [/importScripts/, 'importScripts'],
  [/document\.cookie/, 'document.cookie'],
  [/chrome\.(cookies|webRequest|history|downloads|identity|management|declarativeNetRequest)\b/, 'unrequested chrome API'],
  [/sourceMappingURL/, 'source map reference'],
  [/\bimport\s*\(\s*["'`]https?:/, 'remote dynamic import'],
];
const FILE_RULES = [
  [/^manifest\.json$/, 'manifest'],
  [/^(analytics|dashboard|launcher|postcard|reply|receipt|report)\.(html|js)$/, 'tool page or bundle'],
  [/^(background|collector|followback|postcard-target|reply-target)\.js$/, 'worker or injected bundle'],
  [/^(dashboard|launcher|tokens|ui)\.css$/, 'style'],
  [/^icons\/icon-(16|32|48|128)\.png$/, 'icon'],
  [/^fonts\/[A-Za-z0-9._-]+\.woff2$/, 'font'],
  [/^fonts\/OFL-[A-Za-z0-9._-]+\.txt$/, 'font licence'],
  [/^THIRD_PARTY_NOTICES\.txt$/, 'third-party notices'],
];

export function walk(dir) {
  const out = [];
  const go = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const s = lstatSync(p);
      if (s.isDirectory()) go(p);
      else out.push({ path: relative(dir, p).split('\\').join('/'), bytes: s.size, regular: s.isFile() });
    }
  };
  go(dir);
  return out;
}

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Returns { errors: string[], notes: string[] } for an unpacked package directory. */
export function checkPackage(dir, { expectVersion } = {}) {
  const errors = [];
  const notes = [];
  const fail = (m) => errors.push(m);
  const files = walk(dir);
  const names = new Set(files.map((f) => f.path));

  for (const f of files) {
    if (!f.regular) fail(`non-regular file in package: ${f.path}`);
    if (!FILE_RULES.some(([re]) => re.test(f.path))) fail(`unexpected file in package: ${f.path}`);
  }
  if (files.some(f => !f.regular)) return { errors, notes, files };

  if (!names.has('manifest.json')) { fail('manifest.json missing'); return { errors, notes, files }; }
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  if (manifest.manifest_version !== 3) fail('manifest_version must be 3');
  if (!/^\d+(\.\d+){0,3}$/.test(manifest.version ?? '')) fail(`version "${manifest.version}" is not a Chrome version string`);
  if (expectVersion && manifest.version !== expectVersion) fail(`version ${manifest.version} != expected ${expectVersion}`);
  if (JSON.stringify([...(manifest.permissions ?? [])].sort()) !== JSON.stringify(EXPECTED_PERMISSIONS)) fail(`permissions changed: ${JSON.stringify(manifest.permissions)}`);
  if (JSON.stringify(manifest.optional_host_permissions) !== JSON.stringify(EXPECTED_OPTIONAL_HOSTS)) fail(`optional_host_permissions changed: ${JSON.stringify(manifest.optional_host_permissions)}`);
  for (const key of ['host_permissions', 'optional_permissions', 'content_scripts', 'web_accessible_resources', 'externally_connectable', 'update_url', 'key', 'commands', 'declarative_net_request', 'devtools_page', 'chrome_url_overrides', 'sandbox', 'omnibox', 'oauth2']) {
    if (key in manifest) fail(`manifest has unexpected "${key}"`);
  }
  if (manifest.side_panel?.default_path !== 'reply.html?panel') fail('reply side panel path changed');
  const csp = manifest.content_security_policy?.extension_pages ?? '';
  for (const need of ["script-src 'self'", "connect-src https://generativelanguage.googleapis.com", "object-src 'self'"]) if (!csp.includes(need)) fail(`CSP lacks ${need}`);
  if (/unsafe-|https?:|\*/.test(csp.replace('connect-src https://generativelanguage.googleapis.com;', ''))) fail(`CSP allows unsafe or remote sources: ${csp}`);
  if (!manifest.name || !manifest.description || manifest.description.length > 132) fail('name missing, or description empty/over 132 characters');

  const referenced = [
    manifest.background?.service_worker, manifest.action?.default_popup,
    ...Object.values(manifest.icons ?? {}), ...Object.values(manifest.action?.default_icon ?? {}),
    ...INJECTED_SCRIPTS,
  ].filter(Boolean);
  for (const r of referenced) if (!names.has(r)) fail(`referenced file missing: ${r}`);
  if (manifest.background?.type === 'module') notes.push('service worker is a module');

  for (const f of files) {
    const ext = extname(f.path);
    const text = ['.js', '.html', '.css'].includes(ext) ? readFileSync(join(dir, f.path), 'utf8') : null;
    if (text === null) continue;
    for (const url of text.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)) {
      if (!ALLOWED_URL_HOSTS.has(url[1].toLowerCase()) && !(f.path === 'reply.js' && ['generativelanguage.googleapis.com', 'aistudio.google.com'].includes(url[1].toLowerCase()))) fail(`${f.path}: URL host not allowed: ${url[1]}`);
    }
    if (ext === '.js') for (const [re, label] of FORBIDDEN_JS) if (re.test(text) && !(f.path === 'reply.js' && label === 'fetch()')) fail(`${f.path}: ${label}`);
    if (ext === '.html') {
      if (/<script(?![^>]*\ssrc=)/i.test(text)) fail(`${f.path}: inline script`);
      if (/\son[a-z]+\s*=/i.test(text)) fail(`${f.path}: inline event handler`);
      if (/(?:src|href)\s*=\s*["']?(?:https?:)?\/\//i.test(text)) fail(`${f.path}: external src/href`);
      for (const m of text.matchAll(/(?:src|href)\s*=\s*"([^"#?]+)"/g)) {
        const target = posix.normalize(m[1]);
        if (!/^(https?:|data:|chrome-extension:)/.test(target) && !names.has(target)) fail(`${f.path}: references missing file ${m[1]}`);
      }
    }
  }
  return { errors, notes, files, manifest };
}
