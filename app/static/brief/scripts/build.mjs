// Bundles the page into build/: one script, one stylesheet and index.html. Forge serves the folder
// as a Custom UI resource, whose policy only allows scripts and styles served from the app itself.
import * as esbuild from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'build');
await fs.rm(out, { recursive: true, force: true });
await esbuild.build({
  entryPoints: [path.join(root, 'src', 'main.js')],
  bundle: true,
  minify: true,
  format: 'esm',
  splitting: true,
  target: 'es2022',
  outdir: out,
  loader: { '.png': 'dataurl', '.svg': 'dataurl' },
  logLevel: 'info',
});
// Version the entry files so browsers and the Forge CDN never serve a stale page after a deploy.
const v = Date.now().toString(36);
const html = await fs.readFile(path.join(root, 'public', 'index.html'), 'utf8');
await fs.writeFile(path.join(out, 'index.html'), html.replace('main.css', `main.css?v=${v}`).replace('main.js', `main.js?v=${v}`));
await fs.copyFile(path.join(root, 'public', 'icon.svg'), path.join(out, 'icon.svg'));
