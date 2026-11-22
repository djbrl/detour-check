// Bundles the page into build/: one script, one stylesheet and index.html. Forge serves the folder
// as a Custom UI resource, whose policy only allows scripts and styles served from the app itself.
import * as esbuild from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'build');
await fs.rm(out, { recursive: true, force: true });
const result = await esbuild.build({
  entryPoints: [path.join(root, 'src', 'main.js')],
  bundle: true,
  minify: true,
  format: 'esm',
  splitting: true,
  target: 'es2022',
  outdir: out,
  loader: { '.png': 'dataurl', '.svg': 'dataurl' },
  logLevel: 'info',
  metafile: true,
});
// Version the entry files so browsers and the Forge CDN never serve a stale page after a deploy.
const v = Date.now().toString(36);
const html = await fs.readFile(path.join(root, 'public', 'index.html'), 'utf8');
// Inside Jira the page loads the Forge bridge as a separate chunk, which used to download only once
// main.js had run. Preloading every chunk Jira uses lets them download together. The in-page
// stand-in for working outside Jira (local-*.js) is large and never needed there, so it is left out.
const chunks = Object.keys(result.metafile.outputs)
  .map((f) => path.basename(f))
  .filter((f) => f.endsWith('.js') && f !== 'main.js' && !f.startsWith('local-'));
const preload = chunks.map((f) => `<link rel="modulepreload" href="${f}">`).join('\n');
await fs.writeFile(path.join(out, 'index.html'), html
  .replace('main.css', `main.css?v=${v}`)
  .replace('main.js', `main.js?v=${v}`)
  .replace('</head>', `${preload}\n</head>`));
await fs.copyFile(path.join(root, 'public', 'icon.svg'), path.join(out, 'icon.svg'));
