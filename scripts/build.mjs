import { build } from 'esbuild';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const outdir = path.join(repoRoot, 'dist');
const htmlEntries = [
  { source: 'src/html/popup.html', output: 'popup.html' },
  { source: 'src/html/search.html', output: 'search.html' },
  { source: 'src/html/options.html', output: 'options.html' },
  { source: 'src/html/cli.html', output: 'cli.html' },
  {
    source: 'src/html/timerFeatureModule/timer.html',
    output: 'timerFeatureModule/timer.html',
  },
];

await rm(outdir, { recursive: true, force: true });

await build({
  absWorkingDir: repoRoot,
  entryPoints: {
    popup: 'src/ts/popup.ts',
    search: 'src/ts/search.ts',
    options: 'src/ts/options.ts',
    cli: 'src/ts/cli.ts',
    'jira-issue-detection': 'src/ts/jira-issue-detection.ts',
    'floating-timer-widget': 'src/ts/floating-timer-widget.ts',
    'timerFeatureModule/timer': 'src/ts/timerFeatureModule/timer.ts',
    'timerFeatureModule/background': 'src/ts/timerFeatureModule/background.ts',
  },
  outdir: 'dist',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome120'],
  charset: 'utf8',
  legalComments: 'none',
  sourcemap: false,
  logLevel: 'info',
});

for (const entry of htmlEntries) {
  const sourcePath = path.join(repoRoot, entry.source);
  const destinationPath = path.join(outdir, entry.output);
  await mkdir(path.dirname(destinationPath), { recursive: true });

  let html = await readFile(sourcePath, 'utf8');

  if (entry.output === 'timerFeatureModule/timer.html') {
    html = html
      .replace('../dist/timerFeatureModule/timer.js', 'timer.js')
      .replaceAll('../src/icons/', '../../src/icons/');
  } else {
    html = html
      .replace(/dist\//g, '')
      .replaceAll('src/icons/', '../src/icons/')
      .replace('dynamically by dist/popup.js', 'dynamically by popup.js');
  }

  await writeFile(destinationPath, html);
}
