// Bordeaux open data, offline: the frozen demo day's feeds, or a failure when a test asks for one.
import { readFileSync } from 'node:fs';
export const feeds = { fail: false };
const day = JSON.parse(readFileSync(new URL('../../src/demo-day.json', import.meta.url)));
export async function fetchFeed(url) {
  if (feeds.fail) return { ok: false, status: 503, json: async () => ({}) };
  const name = url.match(/datasets\/([^/]+)\//)?.[1];
  const data = day.feeds?.[name] ?? day[name];
  if (!data) return { ok: false, status: 404, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => structuredClone(data) };
}
