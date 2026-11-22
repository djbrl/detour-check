// With "detour-check-<team>" groups on the site, only their members sign off for that team.
// (A file of its own: the site's groups are cached for five minutes per container.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jira } from './fakes/api.mjs';

jira.reset({ groups: ['detour-check-ops', 'detour-check-drivers'], myGroups: ['detour-check-ops'], members: { 'detour-check-ops': ['ops-lead', 'ops-deputy'], 'detour-check-drivers': ['driver-lead'] } });
const { handler: R } = await import('../src/index.js');
const { setupStatus } = await import('../src/desk.js');
const call = (name, payload) => R[name]({ payload, context: { accountId: 'ops-lead' } });

test('team groups decide who signs off for which team', async () => {
  await call('saveSettings', { project: 'NET' });
  await call('answer', { id: 'works-197838', impact: 'closed' });
  await call('tick', { id: 'works-197838', role: 'ops' });
  await assert.rejects(call('tick', { id: 'works-197838', role: 'drivers' }), /cannot sign off for Drivers/);
  // A team without a group falls back to anyone who can edit the work item.
  await call('tick', { id: 'works-197838', role: 'scheduling' });
  assert.deepEqual((await setupStatus()).teamGroups, ['ops', 'drivers']);
});

test('each team with a group is mentioned and made a watcher when a plan needs it', async () => {
  const { store } = await import('./fakes/kvs.mjs');
  store.clear();
  await call('saveSettings', { project: 'NET' });
  const { changeRequest: { key } } = await call('answer', { id: 'works-197838', impact: 'closed' });
  const first = JSON.stringify(jira.site.comments[key][0].body);
  assert.match(first, /Sign-off needed/);
  for (const id of ['ops-lead', 'ops-deputy', 'driver-lead']) assert.match(first, new RegExp(`"type":"mention","attrs":\\{"id":"${id}"`));
  assert.doesNotMatch(first, /Scheduling: /, 'a team without a group has no one to mention');
  assert.deepEqual(jira.site.watchers[key].sort(), ['driver-lead', 'ops-deputy', 'ops-lead']);
  // Lowering the plan asks Operations, now that someone else must confirm.
  const panel = { extension: { issue: { key } }, accountId: 'driver-lead' };
  await R.savePlan({ payload: { impact: 'none', reason: 'Works moved onto the pavement' }, context: panel });
  const last = JSON.stringify(jira.site.comments[key].at(-1).body);
  assert.match(last, /Reason: Works moved onto the pavement/);
  assert.match(last, /"id":"ops-lead"/);
  assert.doesNotMatch(last, /"id":"driver-lead"/);
});
