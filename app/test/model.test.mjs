// The go-live checks on the frozen demo day: what the desk and the video show.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { currentDesk, readiness } = await import('../src/desk.js');
const { outlook, defaultPlan, runChecks } = await import('../src/model.js');
const { desk } = await currentDesk();
const plan = (item, more = {}) => ({ ...defaultPlan(item), impact: 'closed', signoffs: {}, ...more });
const lights = desk.items.map((i) => [i, outlook(i, desk)]);

test('the demo day has problems, items to check and a covered case', () => {
  const n = (l) => lights.filter(([, o]) => o.light === l).length;
  assert.ok(n('red') >= 1 && n('amber') >= 1 && n('green') >= 1);
  assert.equal(lights.find(([i]) => i.id === 'works-197100')[1].light, 'red', 'the real case in the video is a problem');
});

test('the real case: the detour ends 7 days before the works, so the dates check fails', () => {
  const item = desk.byId.get('works-197100');
  const r = runChecks(plan(item), item, desk);
  assert.deepEqual(r.checks.map((c) => [c.id, c.state]), [['diversion', 'pass'], ['directions', 'pass'], ['dates', 'fail']]);
  assert.equal(r.checks.find((c) => c.id === 'dates').data.gapDays, 7);
  assert.equal(outlook(item, desk).problem, 'The detour ends 27 Nov: 7 days of works with no detour.');
  // A plan cannot be narrowed below the permit to make the check pass; it can only be widened.
  const narrowed = runChecks(plan(item, { ends: '2026-11-27' }), item, desk).checks.find((c) => c.id === 'dates');
  assert.equal(narrowed.state, 'fail');
  const widened = runChecks(plan(item, { ends: '2026-12-20' }), item, desk).checks.find((c) => c.id === 'dates');
  assert.ok(widened.data.gapDays > 7);
});

test('works in force on a bus route with no published detour fail the detour check', () => {
  const found = desk.items.find((i) => !outlook(i, desk).timeline?.detour && i.starts <= desk.today && i.lines.some((id) => !/^T/.test(id)));
  assert.ok(found, 'the demo day has works in force with no detour');
  const check = runChecks(plan(found), found, desk).checks.find((c) => c.id === 'diversion');
  assert.equal(check?.state, 'fail');
});

test('works under way with no detour today are to check, labelled so; only a detour that falls short is a problem', () => {
  const noDetour = lights.filter(([i, o]) => !o.timeline?.detour && i.lines.some((id) => !/^T/.test(id)));
  const now = noDetour.filter(([i]) => i.starts <= desk.today && (!i.ends || i.ends >= desk.today));
  const later = noDetour.filter(([i]) => i.starts > desk.today);
  assert.ok(now.length && later.length, 'the demo day has both');
  for (const [i, o] of now) assert.deepEqual([i.id, o.light, o.label, o.underway], [i.id, 'amber', 'Under way, no detour', true]);
  for (const [i, o] of later) assert.deepEqual([i.id, o.light, o.underway], [i.id, 'amber', undefined]);
  assert.ok(lights.filter(([, o]) => o.light === 'red').every(([, o]) => o.label === 'Falls short'));
});

test('"no effect on buses" needs a reason and Operations from someone else', () => {
  const item = desk.byId.get('works-197100');
  const lowered = { reason: 'Pavement only', by: 'alice' };
  assert.equal(readiness(plan(item, { impact: 'none', lowered }), item, desk).ready, false);
  assert.equal(readiness(plan(item, { impact: 'none', signoffs: { ops: { at: 'x', by: 'bob' } } }), item, desk).ready, false, 'no reason given');
  assert.equal(readiness(plan(item, { impact: 'none', lowered, signoffs: { ops: { at: 'x', by: 'alice' } } }), item, desk).ready, false, 'same person');
  assert.equal(readiness(plan(item, { impact: 'none', lowered, signoffs: { ops: { at: 'x', by: 'bob' } } }), item, desk).ready, true);
});

test('a covered item is ready only once every team has signed off', () => {
  const item = desk.byId.get('works-197838');
  const all = Object.fromEntries(['ops', 'scheduling', 'passengers'].map((r) => [r, { at: 'x' }]));
  assert.equal(readiness(plan(item, { signoffs: all }), item, desk).ready, false);
  assert.equal(readiness(plan(item, { signoffs: { ...all, drivers: { at: 'x' } } }), item, desk).ready, true);
});

test('a date range across two years names both years', () => {
  const item = desk.byId.get('works-169572');
  assert.match(outlook(item, desk).story, /from 1 Jul 2026 to 1 Jul 2027,/);
});
