// Live data is built in the background, and nothing about it can stop the page or mislead a plan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { store } from './fakes/kvs.mjs';
import { pushed } from './fakes/events.mjs';
import { feeds } from './fakes/feeds.mjs';
import { jira } from './fakes/api.mjs';

const { handler: R, hourly, goLive } = await import('../src/index.js');
const live = await import('../src/live.js');
const call = (name, payload = {}) => R[name]({ payload, context: { accountId: 'judge' } });

test('a failed live build falls back to the demo day, says why, and never runs the go-live check', async () => {
  await call('saveSettings', { project: 'NET' });
  await call('answer', { id: 'works-197100', impact: 'closed' });
  await call('saveSettings', { mode: 'live' });
  const waiting = await call('getDesk');
  assert.equal(waiting.liveLoading, true);
  assert.equal(waiting.mode, 'demo', 'the demo day stands in');
  assert.equal(pushed.length, 1, 'one background build is asked for');
  await call('getDesk');
  assert.equal(pushed.length, 1, 'and not again while it runs');

  feeds.fail = true;
  await live.handler();
  const meta = store.get('live:meta');
  assert.ok(meta.failedAt);
  // The page re-reads after a minute; a new container reads at once.
  const failed = await reloaded();
  assert.match(failed.liveError, /HTTP 503/);
  const before = jira.calls.length;
  await hourly();
  assert.equal(jira.calls.filter((c, i) => i >= before && c.path.includes('/comment')).length, 0, 'no go-live comment from stand-in data');
  const key = Object.keys(jira.site.issues)[0];
  assert.equal(jira.site.properties[`${key}/detour-check`].status, 'unknown', 'the status says the desk cannot vouch for it');
  assert.equal(jira.site.properties[`${key}/detour-check`].ready, false);
  const gate = await goLive({ issue: { key } });
  assert.equal(gate.result, false);
  assert.match(gate.errorMessage, /cannot confirm/);
});

test('a live build stores the desk in pieces and pages read it back', async () => {
  feeds.fail = false;
  await live.handler();
  const desk = await reloaded();
  assert.equal(desk.mode, 'live');
  assert.equal(desk.liveError ?? null, null);
  assert.ok(desk.items.length > 50);
  assert.ok(store.get('live:meta').n >= 1);
});

// A fresh import of the back end, as a new Forge container would start, sharing the same storage.
async function reloaded() {
  const fresh = await import(`../src/index.js?${Math.random()}`);
  return fresh.handler.getDesk({ payload: {}, context: { accountId: 'judge' } });
}
