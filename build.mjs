import { build } from 'esbuild';
import { cpSync, readdirSync, mkdirSync, rmSync } from 'node:fs';

// Optional local artwork is kept outside the repository. Release packaging always runs the standard build.
const artworkDir = process.argv.includes('--personal-art') ? process.argv[process.argv.indexOf('--personal-art') + 1] : null;
const personalArt = artworkDir ? readdirSync(artworkDir).filter(f => /^[a-z][a-z0-9-]*\.(?:jpe?g|png|webp)$/.test(f)).sort().map(file => {
  const id = file.split('.')[0];
  const name = id.split('-').map(word => word[0].toUpperCase() + word.slice(1)).join(' ');
  return { id, name, file: 'personal-art/' + file, tone: '#414764' };
}) : [];
if (artworkDir && !personalArt.length) throw Error('No named image backgrounds in the personal artwork folder.');
rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });
await build({
  define: personalArt.length ? { PERSONAL_ARTWORK: JSON.stringify(personalArt) } : {},
  entryPoints: {
    background: 'src/background.ts',
    launcher: 'src/ui/launcher.ts',
    receipt: 'src/ui/receiptPage.ts',
    report: 'src/ui/report.ts',
    dashboard: 'src/ui/dashboard.ts',
    analytics: 'src/ui/analytics.ts',
    collector: 'src/content/collector.ts',
    followback: 'src/followback/content.ts',
    screenshot: 'src/screenshot/editor.ts',
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
if (personalArt.length) {
  mkdirSync('dist/personal-art', {recursive: true});
  for (const art of personalArt) cpSync(artworkDir + '/' + art.file.split('/')[1], 'dist/' + art.file);
}
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
