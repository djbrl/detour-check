// With "detour-check-<team>" groups on the site, only their members sign off for that team.
// (A file of its own: the site's groups are cached for five minutes per container.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jira } from './fakes/api.mjs';

jira.reset({ groups: ['detour-check-ops', 'detour-check-drivers'], myGroups: ['detour-check-ops'] });
const { handler: R } = await import('../src/index.js');
const { setupStatus } = await import('../src/desk.js');
const call = (name, payload) => R[name]({ payload, context: { accountId: 'ops-lead' } });

test('team groups decide who signs off for which team', async () => {
  await call('saveSettings', { project: 'NET' });
  await call('answer', { id: 'works-197100', impact: 'closed' });
  await call('tick', { id: 'works-197100', role: 'ops' });
  await assert.rejects(call('tick', { id: 'works-197100', role: 'drivers' }), /cannot sign off for Drivers/);
  // A team without a group falls back to anyone who can edit the work item.
  await call('tick', { id: 'works-197100', role: 'scheduling' });
  assert.deepEqual((await setupStatus()).teamGroups, ['ops', 'drivers']);
});
