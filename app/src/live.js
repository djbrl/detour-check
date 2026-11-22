// Builds the desk from live Bordeaux open data in the background. A page call has 25 seconds and
// this takes longer on a cold container, so the page only ever reads what this stores (src/desk.js).
import { fetch } from '@forge/api';
import { API, FEEDS, useNetwork, buildDesk, serializeDesk } from './model.js';
import network from './network.json';
import { storeLive, noteLiveFailure } from './desk.js';

async function fetchFeed(name) {
  const res = await fetch(`${API}/${name}/exports/json`);
  if (!res.ok) throw new Error(`Bordeaux open data (${name}) answered HTTP ${res.status}`);
  return res.json();
}

export async function buildLive() {
  const t0 = Date.now();
  const feeds = Object.fromEntries(await Promise.all(FEEDS.map(async (n) => [n, await fetchFeed(n)])));
  const t1 = Date.now();
  useNetwork(network);
  const now = new Date();
  const desk = buildDesk(feeds, now);
  const stored = await storeLive(serializeDesk(desk, now.toISOString()));
  console.log(`Live desk: ${desk.items.length} roadworks, feeds ${t1 - t0} ms, build ${Date.now() - t1} ms, ${stored.n} pieces`);
}

// The queue consumer behind the page's "live data" setting and the hourly refresh.
// A failure is recorded rather than thrown: pages then show the demo day and say live data is
// unavailable, and the next page load after three minutes asks for another try.
export async function handler() {
  try {
    await buildLive();
  } catch (e) {
    console.error(`Live desk failed: ${e.message}`);
    await noteLiveFailure(e.message);
  }
}
