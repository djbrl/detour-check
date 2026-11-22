// One plan from start to finish against a fake Jira site: the page's resolvers, the issue panel and
// Rovo's actions, the way a judge on a fresh site would use them.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { store } from './fakes/kvs.mjs';
import { jira } from './fakes/api.mjs';

const { handler: R, listDisruptions, getDisruption, createChangeRequestAction, checkChangeRequest, recordAssessment, hourly, issueDeleted, goLive } = await import('../src/index.js');
const { setupStatus } = await import('../src/desk.js');

const COVERED = 'works-197838'; // has a published detour that covers it on the demo day
const PROBLEM = 'works-197100'; // the real case: the detour ends 7 days before the works
const ROLES = ['ops', 'scheduling', 'passengers', 'drivers'];
const as = (accountId = 'judge') => ({ accountId });
const call = (name, payload = {}, context = as()) => R[name]({ payload, context });

beforeEach(() => { store.clear(); jira.reset(); });

test('a fresh install shows the demo day and asks for a space before any plan', async () => {
  const desk = await call('getDesk');
  assert.equal(desk.mode, 'demo');
  assert.ok(desk.items.length > 50);
  assert.equal(desk.items[0].outlook.light, 'red', 'problems come first');
  assert.equal(desk.settings.project, null);
  const setup = await setupStatus();
  assert.deepEqual({ admin: setup.admin, project: setup.project, space: setup.space }, { admin: true, project: null, space: null });
  await assert.rejects(call('answer', { id: PROBLEM, impact: 'closed' }), /Choose a Jira space/);
});

test('only an admin chooses the space, and only one they can create work items in', async () => {
  jira.site.admin = false;
  await assert.rejects(call('saveSettings', { project: 'NET' }), /Only a Jira administrator/);
  jira.site.admin = true;
  await assert.rejects(call('saveSettings', { project: 'NOPE' }), /cannot create work items in NOPE/);
  await assert.rejects(call('saveSettings', { project: 'net; drop' }), /Unknown project key/);
  await assert.rejects(call('saveSettings', { mode: 'prod' }), /demo or live/);
  assert.equal((await call('saveSettings', { project: 'NET' })).project, 'NET');
});

test('a plan goes from first answer to ready, with one Jira change request and its history', async () => {
  await call('saveSettings', { project: 'NET' });
  const first = await call('answer', { id: COVERED, impact: 'closed' });
  const key = first.changeRequest.key;
  assert.equal(key, 'NET-1');
  const issue = jira.site.issues[key];
  assert.equal(issue.issuetype.id, '10', 'uses the service space\'s Change type');
  assert.deepEqual(issue.labels, ['detour-check']);
  assert.ok(Object.keys(issue).some((k) => k.startsWith('customfield_')), 'fills the change fields');
  const prop = () => jira.site.properties[`${key}/detour-check`];
  assert.equal(prop().plan, true, 'marks the work item so its panel shows');
  assert.equal(prop().status, 'waiting');
  assert.equal(first.changeRequest.readiness.ready, false);

  // Answering again changes the answer; it never opens a second change request.
  await call('answer', { id: COVERED, impact: 'stops' });
  assert.equal(Object.keys(jira.site.issues).length, 1);

  let view;
  for (const role of ROLES) view = await call('tick', { id: COVERED, role });
  assert.equal(view.changeRequest.readiness.ready, true);
  assert.equal(jira.site.comments[key].length, 6, 'the teams are asked, then the changed answer and each sign-off are written on the work item');
  assert.deepEqual({ status: prop().status, ready: prop().ready, signed: prop().signed }, { status: 'ready', ready: true, signed: 4 }, 'JQL and the workflow validator see it is ready');

  const row = (await call('getDesk')).items.find((i) => i.id === COVERED);
  assert.equal(row.changeRequest.key, key);
  assert.equal(row.changeRequest.ready, true);

  // A withdrawn sign-off takes readiness away again.
  view = await call('tick', { id: COVERED, role: 'drivers', undo: true });
  assert.equal(view.changeRequest.readiness.ready, false);
  assert.equal(prop().ready, false);
});

test('changing what a plan is checked against clears its sign-offs and says so on the work item', async () => {
  await call('saveSettings', { project: 'NET' });
  const { changeRequest: { key } } = await call('answer', { id: PROBLEM, impact: 'closed' });
  for (const role of ROLES) await call('tick', { id: PROBLEM, role });
  const panel = { extension: { issue: { key } }, accountId: 'judge' };
  const before = jira.site.comments[key].length;
  const view = await R.savePlan({ payload: { ends: '2027-01-15' }, context: panel });
  assert.equal(view.readiness.signed, 0);
  const last = jira.site.comments[key].at(-1).body.content;
  assert.equal(jira.site.comments[key].length, before + 1);
  assert.match(JSON.stringify(last), /sign-offs cleared/);
  assert.match(JSON.stringify(last), /Plan end: .* → 2027-01-15/);
});

test('someone who cannot edit the work item cannot change its plan or sign it off', async () => {
  await call('saveSettings', { project: 'NET' });
  const { changeRequest: { key } } = await call('answer', { id: PROBLEM, impact: 'closed' });
  jira.site.canEdit = false;
  const panel = { extension: { issue: { key } }, accountId: 'viewer' };
  await assert.rejects(R.savePlan({ payload: { directions: 'one', reason: 'Southbound only' }, context: panel }), /cannot edit/);
  await assert.rejects(call('answer', { id: PROBLEM, impact: 'none' }), /cannot edit/);
  await assert.rejects(call('tick', { id: PROBLEM, role: 'ops' }), /cannot sign off/);
  await assert.rejects(recordAssessment({ changeRequest: key, impact: 'stops' }), /cannot edit/);
});

test('deleting the work item frees the roadworks to be planned again', async () => {
  await call('saveSettings', { project: 'NET' });
  const { changeRequest: { key } } = await call('answer', { id: PROBLEM, impact: 'closed' });
  await issueDeleted({ issue: { key } });
  await issueDeleted({ issue: { key: 'NOT A KEY' } });
  const again = await call('answer', { id: PROBLEM, impact: 'closed' });
  assert.notEqual(again.changeRequest.key, key);
});

test('two answers at the same moment open one change request', async () => {
  await call('saveSettings', { project: 'NET' });
  const [a, b] = await Promise.allSettled([call('answer', { id: PROBLEM, impact: 'closed' }), call('answer', { id: PROBLEM, impact: 'closed' })]);
  assert.equal(Object.keys(jira.site.issues).length, 1);
  assert.ok([a, b].some((r) => r.status === 'fulfilled'));
});

test('Rovo lists problems, opens a plan and records its assessment on that plan only', async () => {
  await call('saveSettings', { project: 'NET' });
  const list = await listDisruptions({ status: 'problem' });
  assert.ok(list.count > 0);
  assert.ok(list.disruptions.every((d) => d.light === list.disruptions[0].light));
  assert.match(list.data, /demo day/);

  const one = await getDisruption({ disruption: PROBLEM });
  assert.equal(one.geo, undefined, 'no map geometry goes to the model');

  const made = await createChangeRequestAction({ disruption: PROBLEM }, { principal: { accountId: 'rovo-user' } });
  assert.equal(made.created, true);
  assert.equal((await createChangeRequestAction({ disruption: PROBLEM }, {})).created, false);

  const rec = await recordAssessment({ changeRequest: made.key, impact: 'closed', assessment: 'Line 9 cannot pass.', passengerNotice: 'Stop Victoire is not served.' });
  assert.deepEqual(rec.recorded, { impact: 'Road closed: buses divert', assessment: true, passengerNotice: true });
  assert.equal(jira.site.comments[made.key].length, 3, 'the teams were asked when the plan was answered');

  const check = await checkChangeRequest({ changeRequest: made.key });
  assert.equal(check.readyToGoLive, false);
  assert.ok(check.checks.length > 0);

  // A model cannot use the app to comment on work items Detour Check did not open.
  jira.site.issues['HR-7'] = {};
  await assert.rejects(recordAssessment({ changeRequest: 'HR-7', assessment: 'x' }), /not a plan from Detour Check/);
  await assert.rejects(recordAssessment({ changeRequest: made.key }), /Nothing to record/);
});

test('agent and page input that is not an id is refused before any Jira call', async () => {
  await call('saveSettings', { project: 'NET' });
  const before = jira.calls.length;
  await assert.rejects(call('answer', { id: '../../rest/api/3/issue', impact: 'closed' }), /Unknown disruption/);
  await assert.rejects(call('answer', { id: PROBLEM, impact: 'everything' }), /Unknown answer/);
  await assert.rejects(getDisruption({ disruption: 'NET-1/comment' }), /Give a disruption id/);
  await assert.rejects(checkChangeRequest({ changeRequest: 'net-1' }), /change request key/);
  await assert.rejects(call('tick', { id: PROBLEM, role: 'ops' }), /Answer whether buses can get through first/);
  assert.equal(jira.calls.length, before);
});

test('a space without the Change type gets Tasks, and the setup check says so', async () => {
  jira.reset({ projects: { OPS: { name: 'Operations', projectTypeKey: 'software', types: [{ id: '20', name: 'Task' }, { id: '21', name: 'Bug' }] } } });
  await call('saveSettings', { project: 'OPS' });
  const setup = await setupStatus();
  const { gate, ...space } = setup.space;
  assert.deepEqual(space, { found: true, name: 'Operations', serviceSpace: false, canCreate: true, issueType: 'Task', changeFields: [], allFields: 9 });
  assert.deepEqual(gate.missing, ['Start', 'Done', 'Done'], 'the gate is not there until setup adds it (Task and Bug)');
  const made = await call('answer', { id: PROBLEM, impact: 'closed' });
  assert.equal(jira.site.issues[made.changeRequest.key].issuetype.id, '20');
});

test('a site in another language still finds the Change type', async () => {
  jira.reset({ projects: { NET: { name: 'Changements', projectTypeKey: 'service_desk', types: [{ id: '30', name: 'Tâche', untranslatedName: 'Task' }, { id: '31', name: 'Changement', untranslatedName: '[System] Change' }] } } });
  await call('saveSettings', { project: 'NET' });
  const made = await call('answer', { id: PROBLEM, impact: 'closed' });
  assert.equal(jira.site.issues[made.changeRequest.key].issuetype.id, '31');
  assert.equal((await setupStatus()).space.issueType, 'Changement');
});

test('change fields the space will not take on create are dropped, not fatal', async () => {
  jira.reset({ failOnChangeFields: true });
  await call('saveSettings', { project: 'NET' });
  const made = await call('answer', { id: PROBLEM, impact: 'closed' });
  assert.equal(made.changeRequest.key, 'NET-1');
});

test('the setup check reports a space that was deleted or locked after it was chosen', async () => {
  await call('saveSettings', { project: 'NET' });
  jira.site.projects = {};
  const setup = await setupStatus();
  assert.equal(setup.space.found, false);
  assert.equal(setup.space.canCreate, false);
});

test('the hourly check runs as the app and comments only on plans', async () => {
  await call('saveSettings', { project: 'NET' });
  await call('answer', { id: COVERED, impact: 'closed' });
  await hourly();
  assert.ok(jira.calls.every((c) => !c.path.includes('/comment') || /NET-1/.test(c.path)));
});

test('teams signing off at the same moment all count', async () => {
  await call('saveSettings', { project: 'NET' });
  const { changeRequest: { key } } = await call('answer', { id: COVERED, impact: 'closed' });
  await Promise.all(ROLES.map((role) => call('tick', { id: COVERED, role })));
  const view = await call('getItem', { id: COVERED });
  assert.equal(view.changeRequest.readiness.signed, 4);
  assert.equal(view.changeRequest.readiness.ready, true);
  await hourly();
  assert.equal(jira.site.properties[`${key}/detour-check`].signed, 4, 'the hourly check settles the status on what is stored');
});

test('an edit made while the hourly check runs is never undone', async () => {
  await call('saveSettings', { project: 'NET' });
  const { changeRequest: { key } } = await call('answer', { id: COVERED, impact: 'closed' });
  for (const role of ROLES) await call('tick', { id: COVERED, role });
  const panel = { extension: { issue: { key } }, accountId: 'judge' };
  await Promise.all([hourly(), R.savePlan({ payload: { ends: '2026-11-30' }, context: panel })]);
  const view = await call('getItem', { id: COVERED });
  assert.equal(view.changeRequest.readiness.signed, 0);
  assert.equal(store.get(`plan:${key}`).ends, '2026-11-30');
  await hourly();
  assert.equal(jira.site.properties[`${key}/detour-check`].ready, false);
});

test('the go-live gate reads storage and the published data, never the work item', async () => {
  await call('saveSettings', { project: 'NET' });
  const { changeRequest: { key } } = await call('answer', { id: PROBLEM, impact: 'closed' });
  // Someone who can edit the work item sets its property to ready, or deletes it.
  jira.site.properties[`${key}/detour-check`] = { ready: true };
  let gate = await goLive({ issue: { key } });
  assert.equal(gate.result, false);
  assert.match(gate.errorMessage, /Detour covers the whole works/);
  assert.match(gate.errorMessage, /Operations sign-off/);
  delete jira.site.properties[`${key}/detour-check`];
  assert.equal((await goLive({ issue: { key } })).result, false);
  // A work item Detour Check did not open goes through, and so does nonsense.
  assert.equal((await goLive({ issue: { key: 'HR-7' } })).result, true);
  assert.equal((await goLive({})).result, true);
  // A covered plan with every sign-off goes through.
  const ok = await call('answer', { id: COVERED, impact: 'closed' });
  for (const role of ROLES) await call('tick', { id: COVERED, role });
  assert.deepEqual(await goLive({ issue: { key: ok.changeRequest.key } }), { result: true });
});

test('plan dates must be real days, and the works cannot end before they start', async () => {
  await call('saveSettings', { project: 'NET' });
  const { changeRequest: { key } } = await call('answer', { id: PROBLEM, impact: 'closed' });
  const panel = { extension: { issue: { key } }, accountId: 'judge' };
  await assert.rejects(R.savePlan({ payload: { ends: '2026-02-30' }, context: panel }), /real day/);
  await assert.rejects(R.savePlan({ payload: { ends: '0202-11-01' }, context: panel }), /real day/);
  await assert.rejects(R.savePlan({ payload: { ends: '2026-01-01' }, context: panel }), /cannot end before they start/);
});

test('plans saved before per-team sign-offs keep their sign-offs and move over on the next one', async () => {
  await call('saveSettings', { project: 'NET' });
  const { changeRequest: { key } } = await call('answer', { id: COVERED, impact: 'closed' });
  const old = { ...store.get(`plan:${key}`), signoffs: { ops: { at: 'x' }, scheduling: { at: 'y' } } };
  delete old.version;
  store.set(`plan:${key}`, old);
  assert.equal((await call('getItem', { id: COVERED })).changeRequest.readiness.signed, 2);
  await call('tick', { id: COVERED, role: 'passengers' });
  await call('tick', { id: COVERED, role: 'ops', undo: true });
  const view = await call('getItem', { id: COVERED });
  assert.deepEqual(view.changeRequest.signoffs.filter((x) => x.at).map((x) => x.role), ['scheduling', 'passengers']);
  assert.equal(store.get(`plan:${key}`).signoffs, undefined);
});

test('app comments are internal notes, and a stale sign-off button changes nothing', async () => {
  await call('saveSettings', { project: 'NET' });
  const { changeRequest: { key } } = await call('answer', { id: COVERED, impact: 'closed' });
  await call('tick', { id: COVERED, role: 'ops', signed: true });
  const sent = jira.calls.filter((c) => c.path.endsWith('/comment'));
  assert.ok(sent.length && sent.every((c) => c.body.properties?.some((p) => p.key === 'sd.public.comment' && p.value.internal === true)));
  const before = jira.site.comments[key].length;
  // A second tab still showing "Sign off" signs again, and one showing the old tick withdraws twice.
  await call('tick', { id: COVERED, role: 'ops', signed: true });
  await call('tick', { id: COVERED, role: 'scheduling', signed: false });
  assert.equal(jira.site.comments[key].length, before);
});

test('the change fields follow the plan when it changes', async () => {
  await call('saveSettings', { project: 'NET' });
  const { changeRequest: { key } } = await call('answer', { id: PROBLEM, impact: 'closed' });
  const panel = { extension: { issue: { key } }, accountId: 'judge' };
  assert.deepEqual(jira.site.issues[key].priority, { id: '2' }, 'five lines closed: High');
  await R.savePlan({ payload: { impact: 'none', reason: 'Works are on the pavement only' }, context: panel });
  const issue = jira.site.issues[key];
  const text = (id) => JSON.stringify(issue[id]);
  const plan = Object.keys(issue).find((k) => /Operations: /.test(text(k)));
  assert.match(text(plan), /confirm buses are not affected/);
  assert.doesNotMatch(text(plan), /bulletList/);
  // The fake site's Change risk is customfield_103 (Low is option 30) and Impact customfield_104 (Minor is 40).
  assert.deepEqual(issue.customfield_103, { id: '30' });
  assert.deepEqual(issue.customfield_104, { id: '40' });
  assert.deepEqual(issue.priority, { id: '4' }, 'priority follows the risk: Low, not the space default');
  assert.match(text('description'), /Impact: No service impact/);
  assert.match(text('description'), /Why: Works are on the pavement only/);
  assert.match(text('customfield_107'), /change the impact in Detour Check/, 'the backout plan follows the impact');
});

test('a plan cannot say the works end sooner than the permit, and fields edited in Jira are kept', async () => {
  await call('saveSettings', { project: 'NET' });
  const { changeRequest: { key } } = await call('answer', { id: PROBLEM, impact: 'closed' });
  const panel = { extension: { issue: { key } }, accountId: 'judge' };
  await assert.rejects(R.savePlan({ payload: { ends: '2026-11-25' }, context: panel }), /permit runs until 2026-12-04/);
  // The team rewrites the backout plan (customfield_107) in Jira; the next plan change leaves it.
  const own = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Our own backout plan' }] }] };
  jira.site.issues[key].customfield_107 = own;
  await R.savePlan({ payload: { impact: 'stops' }, context: panel });
  assert.deepEqual(jira.site.issues[key].customfield_107, own);
  assert.match(JSON.stringify(jira.site.comments[key].at(-1)), /left as they are[^]*Backout plan/);
  assert.match(JSON.stringify(jira.site.issues[key].description), /Stops not served/, 'untouched fields still follow the plan');
});

test('a first answer that lowers the plan says why on the work item, and an old lowered plan can be given a reason', async () => {
  await call('saveSettings', { project: 'NET' });
  const { changeRequest: { key } } = await call('answer', { id: PROBLEM, impact: 'none', reason: 'Pavement works only' });
  assert.match(JSON.stringify(jira.site.comments[key]), /Reason: Pavement works only/);
  // A plan lowered before reasons were asked for.
  const raw = store.get(`plan:${key}`);
  delete raw.lowered;
  const panel = (accountId) => ({ extension: { issue: { key } }, accountId });
  assert.equal((await R.getPanel({ context: panel('alice') })).changeRequest.readiness.blocker, 'A reason for the lower impact');
  await R.savePlan({ payload: { reason: 'Pavement works only, checked on site' }, context: panel('alice') });
  await R.signOff({ payload: { role: 'ops', signed: true }, context: panel('bob') });
  assert.deepEqual(await goLive({ issue: { key } }), { result: true });
});

test('lowering a plan takes a reason and a second person, and agents cannot lower one', async () => {
  await call('saveSettings', { project: 'NET' });
  await assert.rejects(call('answer', { id: PROBLEM, impact: 'none' }), /Say why/);
  assert.equal(Object.keys(jira.site.issues).length, 0, 'no work item opened without the reason');
  const { changeRequest: { key } } = await call('answer', { id: PROBLEM, impact: 'closed' });
  await assert.rejects(recordAssessment({ changeRequest: key, impact: 'narrowed' }), /An agent cannot set/);
  const panel = (accountId) => ({ extension: { issue: { key } }, accountId });
  await assert.rejects(R.savePlan({ payload: { directions: 'one' }, context: panel('alice') }), /Say why/);
  await R.savePlan({ payload: { impact: 'none', reason: 'Works are on the pavement only' }, context: panel('alice') });
  assert.match(JSON.stringify(jira.site.comments[key].at(-1)), /Reason: Works are on the pavement only/);
  await assert.rejects(R.signOff({ payload: { role: 'ops', signed: true }, context: panel('alice') }), /someone else signs off/);
  assert.match((await goLive({ issue: { key } })).errorMessage, /someone other than the person who lowered/);
  await R.signOff({ payload: { role: 'ops', signed: true }, context: panel('bob') });
  assert.deepEqual(await goLive({ issue: { key } }), { result: true });
  // Back to a closed road: the reason goes, and the full checks apply again.
  await R.savePlan({ payload: { impact: 'closed' }, context: panel('alice') });
  assert.equal((await goLive({ issue: { key } })).result, false);
  assert.equal((await R.getPanel({ context: panel('alice') })).changeRequest.lowered, null);
});

test('a change already live whose checks fail is flagged on the desk, the panel and the work item, never moved', async () => {
  await call('saveSettings', { project: 'NET' });
  const { changeRequest: { key } } = await call('answer', { id: PROBLEM, impact: 'closed' });
  await hourly();
  const heading = (c) => c.body.content[0].content[0].text;
  const before = jira.site.comments[key].length;
  assert.equal(heading(jira.site.comments[key].at(-1)), 'Go-live check: published information does not match this change');

  // Someone moves it live anyway (an admin, or before the gate was added).
  jira.site.issues[key].status = { name: 'Implementing', statusCategory: { key: 'indeterminate' } };
  await hourly();
  const note = jira.site.comments[key].at(-1);
  assert.equal(jira.site.comments[key].length, before + 1);
  assert.equal(heading(note), 'Live, but the checks no longer pass');
  await hourly();
  assert.equal(jira.site.comments[key].length, before + 1, 'said once');
  assert.equal(jira.site.issues[key].status.name, 'Implementing', 'the work item is not moved');

  const row = (await call('getDesk')).items.find((i) => i.id === PROBLEM);
  assert.deepEqual([row.outlook.light, row.outlook.label, row.changeRequest.liveFailing], ['red', 'Live, failing', true]);
  const panel = await R.getPanel({ context: { extension: { issue: { key } }, accountId: 'judge' } });
  assert.equal(panel.changeRequest.liveFailing, true);
  assert.equal((await call('getItem', { id: PROBLEM })).changeRequest.liveFailing, true);
  assert.equal((await checkChangeRequest({ changeRequest: key })).warning, 'Live in Jira, but the checks no longer pass');
});

test('Rovo gets places, lines and plain words, and asks when a place matches several sites', async () => {
  await call('saveSettings', { project: 'NET' });
  const several = await getDisruption({ disruption: 'Rue Pasteur' });
  assert.ok(several.several && several.matches.length === 3, 'three sites on Rue Pasteur');
  assert.ok(several.matches.every((m) => m.place && m.dates && m.lines.every((l) => /^(Bus|Tram) /.test(l))));

  await call('answer', { id: PROBLEM, impact: 'closed' });
  await call('tick', { id: PROBLEM, role: 'ops' });
  const one = await getDisruption({ disruption: '177 Cours de la Marne' });
  assert.equal(one.ref, PROBLEM);
  assert.equal(one.light, 'Problem');
  assert.ok(one.detourByLine.length > 0 && one.detourByLine.every((l) => l.endsBeforeTheWorks === true && /27 Nov/.test(l.until)));
  assert.match(one.worksUntil, /4 Dec/);
  const text = JSON.stringify([one, await listDisruptions({}), await checkChangeRequest({ changeRequest: one.changeRequest.key })]);
  assert.ok(!text.includes('judge'), 'no account ids');
  assert.ok(!/"(impact|state|result|status)":"(closed|stops|failing|fail|pass|in-force)"/.test(text), 'no raw values');
  assert.ok(!text.includes('"geo"'), 'no map geometry');
});
