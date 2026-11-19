import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });
await build({
  entryPoints: {
    background: 'src/background.ts',
    launcher: 'src/ui/launcher.ts',
    receipt: 'src/ui/receiptPage.ts',
    report: 'src/ui/report.ts',
    dashboard: 'src/ui/dashboard.ts',
    analytics: 'src/ui/analytics.ts',
    collector: 'src/content/collector.ts',
    followback: 'src/followback/content.ts',
    reply: 'src/reply/editor.ts',
    'reply-target': 'src/reply/target.ts',
    postcard: 'src/postcard/editor.ts',
    'postcard-target': 'src/postcard/target.ts',
  },
  outdir: 'dist',
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  minify: false,
  sourcemap: false,
  logLevel: 'info',
  loader: { '.css': 'text', '.woff2': 'dataurl', '.jpg': 'dataurl' },
});
cpSync('static', 'dist', { recursive: true });
// UI type for the reader system (docs/v1/EXTENSION-READER.md). All SIL OFL, self-hosted, each with its licence text.
// Archivo and Martian Mono come from their fontsource packages; Doto has no package here and ships in static/fonts/.
const fonts = [
  ['node_modules/@fontsource-variable/archivo/files/archivo-latin-wdth-normal.woff2', 'archivo-latin-wdth.woff2'],
  ['node_modules/@fontsource-variable/archivo/LICENSE', 'OFL-archivo.txt'],
  ['node_modules/@fontsource-variable/martian-mono/files/martian-mono-latin-wdth-normal.woff2', 'martian-mono-latin-wdth.woff2'],
  ['node_modules/@fontsource-variable/martian-mono/LICENSE', 'OFL-martian-mono.txt'],
];
for (const [from, to] of fonts) cpSync(from, `dist/fonts/${to}`);
console.log('Built unpacked extension in dist/');
