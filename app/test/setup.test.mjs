// One-click setup: the space for plans and the go-live gate in its workflows, added by the app so a
// judge on a fresh site never edits a workflow by hand.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { store } from './fakes/kvs.mjs';
import { jira, workflowOf } from './fakes/api.mjs';

const { handler: R, goLive } = await import('../src/index.js');
const { setupStatus } = await import('../src/desk.js');
const call = (name, payload = {}, accountId = 'judge') => R[name]({ payload, context: { accountId } });
const GATE = 'ari:cloud:ecosystem::extension/app-1/env-1/static/detour-check-ready';
const guarded = (key, type) => Object.fromEntries(workflowOf(key, type).workflow.transitions.map((t) => [t.name, t.validators.some((v) => v.parameters.key === GATE)]));
const PROBLEM = 'works-197100';

beforeEach(() => { store.clear(); jira.reset({ projects: {} }); });

test('on a fresh site, setup creates a service space and guards every way into implementation', async () => {
  const out = await call('setUp');
  assert.deepEqual(out, { project: 'ROAD', created: true, gate: null, next: 'gate' }, 'the space first, in a call of its own');
  await call('setUp', { project: 'ROAD' });
  assert.equal(jira.site.created[0].projectTypeKey, 'service_desk');
  assert.deepEqual(guarded('ROAD', '10'), { 'Normal change': false, 'Standard change': true, 'Emergency override': true, Approve: true, Implement: true, Complete: true, Cancel: false });
  const setup = await setupStatus();
  assert.equal(setup.project, 'ROAD');
  assert.equal(setup.space.issueType, 'Change');
  assert.deepEqual(setup.space.gate.missing, []);
  assert.equal(setup.space.gate.guarded.length, 5);
});

test('every other workflow in the space guards finishing, so changing the type skips nothing', async () => {
  jira.reset({ projects: { NET: { name: 'Network Changes', projectTypeKey: 'service_desk', types: [{ id: '10', name: '[System] Change' }, { id: '11', name: 'Task' }] } } });
  await call('setUp', { project: 'NET' });
  assert.deepEqual(guarded('NET', '11'), { Start: false, Done: true, "Won't do": false });
});

test('setup twice changes nothing the second time', async () => {
  await call('setUp');
  await call('setUp');
  const before = jira.site.updates;
  const out = await call('setUp');
  assert.equal(out.created, false);
  assert.equal(jira.site.updates, before);
  assert.equal(jira.site.created.length, 1);
});

test('a taken key moves to the next one, and a site without service spaces gets a task space', async () => {
  jira.reset({ projects: { ROAD: { name: 'Roads', projectTypeKey: 'software', types: [{ id: '11', name: 'Task' }] } }, templates: ['business'] });
  const out = await call('setUp');
  await call('setUp');
  assert.equal(out.project, 'ROADS');
  assert.equal(jira.site.created[0].projectTypeKey, 'business');
  assert.deepEqual(guarded('ROADS', '11'), { Start: true, Done: true, "Won't do": false });
});

test('a workflow shared with another space is left alone', async () => {
  jira.reset({ projects: {
    NET: { name: 'Network Changes', projectTypeKey: 'service_desk', types: [{ id: '10', name: '[System] Change' }] },
    IT: { name: 'IT', projectTypeKey: 'service_desk', types: [{ id: '10', name: '[System] Change' }] },
  } });
  workflowOf('IT', '10');
  jira.site.schemes['NET:10'] = jira.site.schemes['IT:10'];
  const out = await call('setUp', { project: 'NET' });
  assert.match(out.gate.error, /shared with other spaces/);
  assert.equal(jira.site.updates, undefined);
});

test('setup can use a space the admin already has', async () => {
  jira.reset();
  const out = await call('setUp', { project: 'NET' });
  assert.deepEqual([out.project, out.created], ['NET', false]);
  assert.equal(jira.site.created.length, 0);
  assert.equal(out.gate.missing.length, 0);
});

test('only an admin sets up', async () => {
  jira.site.admin = false;
  await assert.rejects(call('setUp'), /Only a Jira administrator/);
  assert.equal(jira.site.created.length, 0);
});

test('an admin with a space already can still ask for a new one', async () => {
  jira.reset();
  await call('setUp', { project: 'NET' });
  const out = await call('setUp', { create: true });
  assert.deepEqual([out.project, out.created], ['ROAD', true]);
  assert.equal((await setupStatus()).project, 'ROAD');
});

test('a space left by an earlier setup is used, not doubled', async () => {
  jira.reset({ projects: { ROAD: { name: 'Roadworks Changes', projectTypeKey: 'service_desk', types: [{ id: '10', name: '[System] Change' }] } } });
  const out = await call('setUp', { create: true });
  assert.deepEqual([out.project, out.created], ['ROAD', false]);
  assert.equal(jira.site.created.length, 0);
});

test('a work item moved to another space keeps its check', async () => {
  jira.reset();
  await call('saveSettings', { project: 'NET' });
  const { changeRequest: { key } } = await call('answer', { id: PROBLEM, impact: 'closed' });
  const id = jira.site.ids[key];
  assert.equal((await goLive({ issue: { key, id } })).result, false);
  // Moved: a new key, the same id.
  assert.equal((await goLive({ issue: { key: 'OTHER-9', id } })).result, false);
  assert.deepEqual(await goLive({ issue: { key: 'OTHER-10', id: '99999' } }), { result: true }, 'not a plan');
});
