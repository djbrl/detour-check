// Points the Forge packages at the fakes in test/fakes, and loads JSON the way Forge's bundler does.
import { readFileSync } from 'node:fs';
const fakes = new URL('./fakes/', import.meta.url).href;
const map = { '@forge/kvs': 'kvs.mjs', '@forge/events': 'events.mjs', '@forge/api': 'api.mjs', '@forge/resolver': 'resolver.mjs' };
export async function resolve(spec, ctx, next) {
  if (map[spec]) return { url: fakes + map[spec], shortCircuit: true };
  return next(spec, ctx);
}
export async function load(url, ctx, next) {
  if (url.endsWith('.json') && url.startsWith('file:')) return { format: 'json', source: readFileSync(new URL(url)), shortCircuit: true };
  return next(url, ctx);
}
