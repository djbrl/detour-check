// Detour Check's state: which feeds to read, which disruptions have a change request, and what
// each change request approved. The page, the issue panel, Rovo and the hourly check all go through
// here, so they always agree.
import api, { route, fetch } from '@forge/api';
import { kvs, WhereConditions } from '@forge/kvs';
import { API, FEEDS, useNetwork, buildDesk, reviveDesk, runChecks, defaultPlan, summary, detail, outlook, timelineOf, lineInfo, IMPACTS, dayLabel } from './model.js';
// The demo day is precomputed at build time (scripts/precompute.mjs); live data needs the full network.
import demoDesk from './demo-desk.json';

// ---------- input checks (everything here can come from a page, Rovo or another agent) ----------

export const ITEM = /^works-\d{1,12}$/;
export const ISSUE_KEY = /^[A-Z][A-Z0-9_]{0,19}-\d{1,9}$/;
const PROJECT = /^[A-Z][A-Z0-9_]{0,19}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const ROLES = {
  ops: 'Operations',
  scheduling: 'Scheduling',
  passengers: 'Passenger information',
  drivers: 'Drivers',
};

export function need(ok, message) {
  if (!ok) throw new Error(message);
}

// ---------- settings ----------

export async function getSettings() {
  return { mode: 'demo', project: null, ...((await kvs.get('settings')) || {}) };
}

// Only a Jira administrator changes where plans go and which data the desk reads.
export async function saveSettings({ mode, project }) {
  const perms = await jira(route`/rest/api/3/mypermissions?permissions=ADMINISTER`);
  need(perms?.permissions?.ADMINISTER?.havePermission, 'Only a Jira administrator can change these settings');
  const current = await getSettings();
  if (mode !== undefined) { need(mode === 'demo' || mode === 'live', 'Mode is demo or live'); current.mode = mode; }
  if (project !== undefined) { need(project === null || PROJECT.test(project), 'Unknown project key'); current.project = project; }
  await kvs.set('settings', current);
  return current;
}

// ---------- feeds and the computed desk, cached per container ----------

const cache = { live: null, demo: null };
const LIVE_TTL = 5 * 60 * 1000;

async function fetchFeed(name) {
  const res = await fetch(`${API}/${name}/exports/json`);
  if (!res.ok) throw new Error(`Bordeaux open data (${name}) answered HTTP ${res.status}`);
  return res.json();
}

export async function loadDesk(mode) {
  if (mode === 'live') {
    if (cache.live && Date.now() - cache.live.at < LIVE_TTL) return cache.live.desk;
    const feeds = Object.fromEntries(await Promise.all(FEEDS.map(async (n) => [n, await fetchFeed(n)])));
    // The full network is only loaded for live data; the demo day ships its own slice.
    const network = (await import('./network.json')).default;
    useNetwork(network);
    const desk = { ...buildDesk(feeds, new Date()), mode, takenAt: new Date().toISOString(), network };
    cache.live = { at: Date.now(), desk };
    return desk;
  }
  cache.demo ||= { ...reviveDesk(demoDesk), mode: 'demo', takenAt: demoDesk.takenAt, network: demoDesk.network };
  return cache.demo;
}

// The demo desk carries only the slice of the network it needs, so each desk brings its own network
// back into use; otherwise a warm container that served one mode would answer the other with it.
export async function currentDesk() {
  const settings = await getSettings();
  const desk = await loadDesk(settings.mode);
  useNetwork(desk.network);
  return { settings, desk };
}

// ---------- change requests and their plans ----------
// "cr:<itemId>" -> { key, at, by }; "plan:<ISSUE-KEY>" -> the approved plan, sign-offs and last check.

async function allWithPrefix(prefix) {
  const found = [];
  let cursor;
  do {
    let query = kvs.query().where('key', WhereConditions.beginsWith(prefix)).limit(100);
    if (cursor) query = query.cursor(cursor);
    const page = await query.getMany();
    found.push(...page.results);
    cursor = page.nextCursor;
  } while (cursor);
  return found;
}

export async function changeRequests() {
  return Object.fromEntries((await allWithPrefix('cr:')).map(({ key, value }) => [key.slice(3), value]));
}

export async function getPlan(key) {
  need(ISSUE_KEY.test(key), 'Unknown work item key');
  return kvs.get(`plan:${key}`);
}

export function readiness(plan, item, desk) {
  const result = item ? runChecks(plan, item, desk) : { state: 'not-found', checks: [], failing: 0 };
  const signed = Object.keys(ROLES).filter((r) => plan.signoffs?.[r]);
  // "No effect" still needs Operations to confirm it; otherwise every check and every team.
  const ready = result.state === 'no-impact' ? !!plan.signoffs?.ops : result.state === 'ready' && signed.length === Object.keys(ROLES).length;
  return { ...result, signed: signed.length, roles: Object.keys(ROLES).length, ready };
}

// What one change request looks like to the page and to Rovo.
export async function changeRequestView(key, desk) {
  const plan = await getPlan(key);
  if (!plan) return null;
  const item = desk.byId.get(plan.item);
  const r = readiness(plan, item, desk);
  return {
    key, item: plan.item, impact: plan.impact, impactLabel: plan.impact ? IMPACTS[plan.impact] : 'Not assessed yet',
    lines: plan.lines.map(lineInfo).filter(Boolean), starts: plan.starts, ends: plan.ends,
    startsLabel: dayLabel(plan.starts, desk.now), endsLabel: dayLabel(plan.ends, desk.now),
    directions: plan.directions, stops: plan.stops, notice: !!plan.notice,
    signoffs: Object.entries(ROLES).map(([role, label]) => ({ role, label, ...(plan.signoffs?.[role] || {}) })),
    readiness: r,
    outlook: item ? outlook(item, desk, plan, r) : null,
    disruption: item ? detail(item, desk) : null,
  };
}

const IMPACT_KEYS = Object.keys(IMPACTS);

export async function savePlan(key, changes) {
  const plan = await getPlan(key);
  need(plan, 'That work item is not a change request from the desk');
  if (changes.impact !== undefined) {
    need(IMPACT_KEYS.includes(changes.impact), `Impact is one of ${IMPACT_KEYS.join(', ')}`);
    // Sign-offs approved the old answer, so a new answer needs them again.
    if (plan.impact !== changes.impact) plan.signoffs = {};
    plan.impact = changes.impact;
  }
  if (changes.notice) plan.notice = { at: new Date().toISOString() };
  if (changes.directions !== undefined) { need(['both', 'one'].includes(changes.directions), 'Directions is both or one'); plan.directions = changes.directions; }
  if (changes.ends !== undefined) { need(DATE.test(changes.ends), 'End date is YYYY-MM-DD'); plan.ends = changes.ends; }
  if (changes.starts !== undefined) { need(DATE.test(changes.starts), 'Start date is YYYY-MM-DD'); plan.starts = changes.starts; }
  await kvs.set(`plan:${key}`, plan);
  const update = {};
  if (changes.starts !== undefined && plan.fields?.plannedStart) update[plan.fields.plannedStart] = parisDateTime(plan.starts, '05:00');
  if (changes.ends !== undefined && plan.fields?.plannedEnd) update[plan.fields.plannedEnd] = parisDateTime(plan.ends, '23:59');
  if (Object.keys(update).length) {
    try { await jira(route`/rest/api/3/issue/${key}`, { method: 'PUT', body: JSON.stringify({ fields: update }) }); } catch (e) { console.warn(`Planned dates on ${key} not updated: ${e.message}`); }
  }
  return plan;
}

// Who may sign off for a team: members of the site group "detour-check-<team>" when the site has
// one, otherwise anyone who can edit the change request.
const roleGroup = (role) => `detour-check-${role}`;
async function maySignOff(key, role) {
  let groups = [];
  try { groups = (await jira(route`/rest/api/3/groups/picker?query=detour-check&maxResults=20`, {}, 'app'))?.groups?.map((g) => g.name) || []; } catch { /* no group lookup: fall back */ }
  if (groups.includes(roleGroup(role))) {
    const me = await jira(route`/rest/api/3/myself?expand=groups`);
    return (me?.groups?.items || []).some((g) => g.name === roleGroup(role));
  }
  const perms = await jira(route`/rest/api/3/mypermissions?issueKey=${key}&permissions=EDIT_ISSUES`);
  return !!perms?.permissions?.EDIT_ISSUES?.havePermission;
}

export async function signOff(key, role, accountId, undo = false, desk = null) {
  need(ROLES[role], 'Unknown sign-off');
  const plan = await getPlan(key);
  need(plan, 'That work item is not a change request from the desk');
  need(plan.impact, 'Answer whether buses can get through first');
  need(await maySignOff(key, role), `You cannot sign off for ${ROLES[role]} on ${key}`);
  if (!undo && desk) {
    const item = desk.byId.get(plan.item);
    need(!item || !runChecks(plan, item, desk).failing, 'Fix the failing checks before signing off');
  }
  plan.signoffs ||= {};
  if (undo) delete plan.signoffs[role];
  else plan.signoffs[role] = { by: accountId || null, at: new Date().toISOString() };
  await kvs.set(`plan:${key}`, plan);
  // The work item's own history shows who signed off for which team.
  try { await addComment(key, undo ? `${ROLES[role]} sign-off withdrawn` : `${ROLES[role]} signed off`, `Impact: ${IMPACTS[plan.impact]}.`); } catch (e) { console.warn(`Sign-off comment on ${key} failed: ${e.message}`); }
  return plan.signoffs;
}

// ---------- Jira ----------

// Requests run as the person using the app, so Jira's own permissions apply and the history shows
// who did what. Only the hourly check, which has no person, runs as the app.
async function jira(path, init = {}, as = 'user') {
  const res = await (as === 'app' ? api.asApp() : api.asUser()).requestJira(path, { headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, ...init });
  const text = await res.text();
  if (!res.ok) throw new Error(`Jira answered ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

// Plain text to Atlassian Document Format. Text from agents is never parsed as markup.
const para = (text, marks) => ({ type: 'paragraph', content: text ? [{ type: 'text', text: String(text).slice(0, 4000), ...(marks ? { marks } : {}) }] : [] });
const doc = (paragraphs) => ({ type: 'doc', version: 1, content: paragraphs });
const bullets = (items) => ({ type: 'bulletList', content: items.map((t) => ({ type: 'listItem', content: [para(t)] })) });
// "Bus 1, 31, G · Tram B": how a rider would name the lines.
const linesText = (lines) => [['BUS', 'Bus'], ['TRAM', 'Tram']].map(([m, word]) => { const ls = lines.filter((l) => (l.mode === 'TRAM') === (m === 'TRAM')); return ls.length ? `${word} ${ls.map((l) => l.short).join(', ')}` : ''; }).filter(Boolean).join(' · ');
const shortDay = (iso, now) => (iso ? new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: iso.slice(0, 4) !== new Date(now).toISOString().slice(0, 4) ? 'numeric' : undefined, timeZone: 'Europe/Paris' }) : 'further notice');

async function issueTypeFor(project) {
  const meta = await jira(route`/rest/api/3/issue/createmeta/${project}/issuetypes`);
  const types = (meta.issueTypes || meta.values || []).filter((t) => !t.subtask);
  return (types.find((t) => /^(\[system\] )?change$/i.test(t.name)) || types.find((t) => /^task$/i.test(t.name)) || types[0])?.id;
}

// Paris wall-clock time as Jira's datetime format, with the right winter or summer offset.
function parisDateTime(date, time) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Paris', timeZoneName: 'longOffset' })
    .formatToParts(new Date(`${date}T12:00:00Z`)).find((p) => p.type === 'timeZoneName')?.value || 'GMT+01:00';
  const m = name.match(/([+-])(\d{2}):?(\d{2})/);
  return `${date}T${time}:00.000${m ? `${m[1]}${m[2]}${m[3]}` : '+0100'}`;
}

// Jira Service Management's own change fields, found by name because their ids differ per site.
// Anything the space does not have is skipped.
async function changeFields(project, issuetype, item, s, desk) {
  let fields = [];
  try {
    const meta = await jira(route`/rest/api/3/issue/createmeta/${project}/issuetypes/${issuetype}?maxResults=200`);
    fields = meta.fields || meta.values || [];
  } catch { return { values: {}, ids: {} }; }
  const byName = (n) => fields.find((f) => String(f.name).toLowerCase() === n);
  const values = {};
  const ids = {};
  const set = (name, key, value) => { const f = byName(name); if (f) { values[f.fieldId] = value; if (key) ids[key] = f.fieldId; } };
  const option = (name, test) => { const f = byName(name); const v = f?.allowedValues?.find((o) => test.test(o.value || '')); if (v) values[f.fieldId] = { id: v.id }; };
  const n = item.lines.length;
  const lines = linesText(s.lines);
  const until = shortDay(item.ends, desk.now);
  // "MÉCA", "MÉCA (Paludate)" and "MECA (Paludate)" are one stop to a reader.
  const base = (name) => name.replace(/\s*\(.*\)\s*$/, '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const stopNames = [...new Map(item.stops.map((x) => [base(x.name), x.name.replace(/\s*\(.*\)\s*$/, '')])).values()].slice(0, 3);
  set('planned start', 'plannedStart', parisDateTime(item.starts, '05:00'));
  if (item.ends) set('planned end', 'plannedEnd', parisDateTime(item.ends, '23:59'));
  option('change type', /^normal$/i);
  option('change risk', n >= 4 ? /^high$/i : n >= 2 ? /^medium$/i : /^low$/i);
  option('impact', n >= 4 ? /^significant/i : n >= 2 ? /^moderate/i : /^minor/i);
  option('change reason', /^maintenance$/i);
  set('implementation plan', null, doc([bullets([
    `Operations: publish the detour, both ways, until ${until}`,
    'Scheduling: update timetables and the journey planner',
    `Passenger information: post the notice${stopNames.length ? ` at ${stopNames.join(', ')}` : ''}`,
    `Drivers: brief ${lines}`,
  ])]));
  set('backout plan', null, doc([para('If the works end early: withdraw the detour and notices, restore timetables, tell drivers.')]));
  set('test plan', null, doc([para(`Detour Check shows all checks green before ${shortDay(item.starts, desk.now)}.`)]));
  return { values, ids };
}

export async function createChangeRequest(itemId, accountId, initial = {}) {
  need(ITEM.test(itemId), 'Unknown disruption');
  const { settings, desk } = await currentDesk();
  need(settings.project, 'Choose a Jira space for change requests first, on the Detour Check page');
  const existing = await kvs.get(`cr:${itemId}`);
  if (existing) return { ...existing, created: false };
  const item = desk.byId.get(itemId);
  need(item, 'That disruption is not on the desk');
  // One plan per disruption, even when two people (or a person and Rovo) ask at the same moment.
  try {
    await kvs.set(`claim:${itemId}`, { at: new Date().toISOString() }, { keyPolicy: 'FAIL_IF_EXISTS', ttl: { value: 2, unit: 'MINUTES' } });
  } catch {
    const now = await kvs.get(`cr:${itemId}`);
    if (now) return { ...now, created: false };
    need(false, 'The plan for this is being opened. Try again in a moment.');
  }
  try {
    return await openChangeRequest(itemId, item, settings, desk, accountId, initial);
  } finally {
    await kvs.delete(`claim:${itemId}`);
  }
}

async function openChangeRequest(itemId, item, settings, desk, accountId, initial) {
  const s = summary(item, desk);
  const lineList = linesText(s.lines);
  const issuetype = await issueTypeFor(settings.project);
  need(issuetype, `No issue type found in ${settings.project}`);
  const extra = await changeFields(settings.project, issuetype, item, s, desk);
  const t = timelineOf(item, desk);
  const post = (more) => jira(route`/rest/api/3/issue`, {
    method: 'POST',
    body: JSON.stringify({
      fields: {
        ...more,
        project: { key: settings.project },
        issuetype: { id: issuetype },
        summary: `Roadworks · ${item.title.split(',')[0]} · ${lineList}`.slice(0, 250),
        labels: ['detour-check'],
        description: doc([bullets([
          `Where: ${item.title}`,
          `When: ${shortDay(item.starts, desk.now)} → ${shortDay(item.ends, desk.now)}`,
          `Lines: ${lineList}`,
          `Published detour: ${t.detour ? `${shortDay(t.detour.from, desk.now)} → ${shortDay(t.detour.to, desk.now)}` : 'none'}`,
        ]), para(`${item.what} · ${s.source} ${s.ref}`, [{ type: 'em' }])]),
      },
    }),
  });
  // A space can make a change field read-only on create; the change request matters more than the field.
  let created;
  let ids = extra.ids;
  try { created = await post(extra.values); } catch (e) { console.warn(`Create with change fields failed, retrying without: ${e.message}`); created = await post({}); ids = {}; }
  await markIssue(created.key);
  const cr = { key: created.key, at: new Date().toISOString(), by: accountId || null, marked: 'detour-check' };
  await kvs.set(`plan:${created.key}`, { ...defaultPlan(item), ...initial, signoffs: {}, fields: ids });
  await kvs.set(`cr:${itemId}`, cr);
  return { ...cr, created: true };
}

// The issue panel shows only on work items carrying this property (see the manifest's display condition).
export async function markIssue(key) {
  need(ISSUE_KEY.test(key), 'Unknown work item key');
  try { await jira(route`/rest/api/3/issue/${key}/properties/detour-check`, { method: 'PUT', body: JSON.stringify({ plan: true }) }, 'app'); return true; } catch (e) { console.warn(`Marking ${key} failed: ${e.message}`); return false; }
}

export async function addComment(key, heading, text, as = 'user') {
  need(ISSUE_KEY.test(key), 'Unknown work item key');
  const body = doc([para(heading, [{ type: 'strong' }]), ...String(text || '').split(/\n{1,}/).filter(Boolean).slice(0, 40).map((t) => para(t))]);
  return jira(route`/rest/api/3/issue/${key}/comment`, { method: 'POST', body: JSON.stringify({ body }) }, as);
}

// ---------- the hourly go-live check ----------
// Comments on a change request when its published information starts or stops matching the plan,
// so the change's own history shows when it went wrong and when it was fixed.
export async function checkAll() {
  const { desk } = await currentDesk();
  const results = [];
  for (const { key: kvKey, value: plan } of await allWithPrefix('plan:')) {
    const key = kvKey.slice(5);
    const item = desk.byId.get(plan.item);
    if (!item) continue;
    const r = readiness(plan, item, desk);
    const failing = r.checks.filter((c) => c.state === 'fail').map((c) => c.id).sort().join(',');
    if (failing !== (plan.lastFailing || '')) {
      const text = failing
        ? r.checks.filter((c) => c.state === 'fail').map((c) => `${c.label}: ${c.evidence}`).join('\n')
        : 'Every published check now matches the plan.';
      try { await addComment(key, failing ? 'Go-live check: published information does not match this change' : 'Go-live check passed', text, 'app'); } catch (e) { console.warn(`Comment on ${key} failed: ${e.message}`); continue; }
      plan.lastFailing = failing;
      await kvs.set(kvKey, plan);
    }
    results.push({ key, state: r.state });
  }
  return results;
}
