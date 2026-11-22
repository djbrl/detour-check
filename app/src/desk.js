// Detour Check's state: which feeds to read, which disruptions have a change request, and what
// each change request approved. The page, the issue panel, Rovo and the hourly check all go through
// here, so they always agree.
import api, { route, getAppContext } from '@forge/api';
import { kvs, WhereConditions } from '@forge/kvs';
import { Queue } from '@forge/events';
import { gzipSync, gunzipSync } from 'node:zlib';
import { useNetwork, reviveDesk, runChecks, defaultPlan, planDates, summary, detail, outlook, timelineOf, lineInfo, IMPACTS, dayLabel } from './model.js';
// The demo day is precomputed at build time (scripts/precompute.mjs). Live data is built in the
// background by src/live.js, which alone loads the full network.
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

// "Operations, Scheduling and Drivers".
const andList = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

// ---------- settings ----------

export async function getSettings() {
  return { mode: 'demo', project: null, ...((await kvs.get('settings')) || {}) };
}

// Only a Jira administrator changes where plans go and which data the desk reads.
async function isAdmin() {
  const perms = await jira(route`/rest/api/3/mypermissions?permissions=ADMINISTER`);
  return !!perms?.permissions?.ADMINISTER?.havePermission;
}

export async function saveSettings({ mode, project }) {
  need(await isAdmin(), 'Only a Jira administrator can change these settings');
  const current = await getSettings();
  if (mode !== undefined) { need(mode === 'demo' || mode === 'live', 'Mode is demo or live'); current.mode = mode; }
  if (project !== undefined) {
    need(project === null || PROJECT.test(project), 'Unknown project key');
    // A space nobody can open plans in would only fail later, on the first plan.
    if (project) need(await mayCreateIn(project), `You cannot create work items in ${project}. Choose another space or check its permissions.`);
    current.project = project;
  }
  await kvs.set('settings', current);
  return current;
}

async function mayCreateIn(project) {
  try {
    const p = await jira(route`/rest/api/3/mypermissions?projectKey=${project}&permissions=CREATE_ISSUES`);
    return !!p?.permissions?.CREATE_ISSUES?.havePermission;
  } catch { return false; }
}

// What this site has for Detour Check, so a new install says what is missing instead of failing
// on the first plan. Each part is checked on its own: one failure never hides the others.
// Reading the gate means reading every workflow in the space, which takes seconds. With
// `cachedGate` the last reading is returned (or none), and the page asks gateStatus() for a fresh
// one after it has drawn the rest.
export async function setupStatus({ cachedGate = false } = {}) {
  const settings = await getSettings();
  const p = settings.project;
  const [admin, groups, info, canCreate, meta, lastGate] = await Promise.all([
    isAdmin().catch(() => false),
    siteGroups(),
    p ? jira(route`/rest/api/3/project/${p}`).catch(() => null) : null,
    p ? mayCreateIn(p) : false,
    p ? spaceMeta(p).catch((e) => ({ error: e.message })) : null,
    p && cachedGate ? kvs.get(`gate:${p}`) : null,
  ]);
  const out = { admin, project: p, teamGroups: Object.keys(ROLES).filter((r) => groups.includes(roleGroup(r))), space: null };
  if (!p) return out;
  out.space = {
    found: !!info,
    name: info?.name || p,
    serviceSpace: info?.projectTypeKey === 'service_desk',
    canCreate,
    issueType: meta.name || null,
    changeFields: meta.fields?.filter((f) => f.fieldId !== 'priority').map((f) => f.name) || [],
    allFields: FIELD_NAMES.length,
  };
  // Only an admin can read workflows; anyone else sees the space without the gate's state.
  if (admin && info && meta.issuetype) {
    if (cachedGate) out.space.gate = lastGate || null;
    else out.space.gate = await keptGate(p, gateState(p, info.id, meta.issuetype));
  }
  return out;
}

// The gate's state as read now, kept for the next page load.
async function keptGate(project, reading) {
  const gate = await reading.catch((e) => ({ error: e.message }));
  if (!gate.error) await kvs.set(`gate:${project}`, gate, { ttl: { value: 10, unit: 'MINUTES' } }).catch(() => null);
  return gate;
}

export async function gateStatus() {
  const settings = await getSettings();
  const p = settings.project;
  if (!p) return null;
  const [admin, info, meta] = await Promise.all([isAdmin().catch(() => false), jira(route`/rest/api/3/project/${p}`).catch(() => null), spaceMeta(p).catch(() => null)]);
  if (!admin || !info || !meta?.issuetype) return null;
  return keptGate(p, gateState(p, info.id, meta.issuetype));
}

// ---------- one-click setup: a space for plans and the go-live gate in its workflow ----------

// The validator as Jira stores it on a transition. Built from the running app, so it names the
// environment (development, staging or production) that is actually installed.
function validatorKey() {
  const env = String(getAppContext().environmentAri).split('/');
  return `ari:cloud:ecosystem::extension/${env.at(-2)}/${env.at(-1)}/static/detour-check-ready`;
}

// Which statuses the check guards. In the plans' own workflow: going live, which is Awaiting
// implementation or Implementing in Jira Service Management's change workflow, and work starting
// in any other. In every workflow of the space: finishing, so neither "Mark as done" nor moving the
// work item to another type skips the check. Cancelling, declining or failing is never held back.
const LIVE = /^(awaiting implementation|implementing|en attente de (la )?mise en (œ|oe)uvre|mise en (œ|oe)uvre)$/i;
const LETGO = /cancel|declin|reject|fail|won.?t|annul|refus|rejet|échec|echec|abandon/i;
function gatedStatuses(statuses, refs, plans) {
  const used = statuses.filter((s) => refs.has(s.statusReference));
  const named = used.filter((s) => LIVE.test(s.name));
  const live = !plans ? [] : named.length ? named : used.filter((s) => s.statusCategory === 'IN_PROGRESS');
  const done = used.filter((s) => s.statusCategory === 'DONE' && !LETGO.test(s.name));
  return new Set([...live, ...done].map((s) => s.statusReference));
}

// Every workflow in the space, the plans' own first. A workflow that other spaces share is left
// alone: changing it would put the check on their work too.
async function spaceWorkflows(project, projectId, planType) {
  const meta = await jira(route`/rest/api/3/issue/createmeta/${project}/issuetypes`);
  const types = (meta.issueTypes || meta.values || []).filter((t) => !t.subtask).map((t) => String(t.id));
  const read = (ids) => jira(route`/rest/api/3/workflows`, { method: 'POST', body: JSON.stringify({ projectAndIssueTypes: ids.map((issueTypeId) => ({ projectId: String(projectId), issueTypeId })) }) });
  const [own, rest] = await Promise.all([read([String(planType)]), read(types.filter((t) => t !== String(planType)))]);
  const plansWf = own?.workflows?.[0];
  need(plansWf, 'No workflow found for plans in this space');
  const statuses = [...(own.statuses || []), ...(rest?.statuses || [])];
  const all = [plansWf, ...(rest?.workflows || []).filter((w) => w.id !== plansWf.id)];
  // Each workflow's usage is one call, so they are asked at once.
  const out = await Promise.all(all.map(async (w) => {
    const used = await jira(route`/rest/api/3/workflow/${w.id}/projectUsages`).catch(() => null);
    const shared = (used?.projects?.values || []).some((x) => String(x.id) !== String(projectId));
    const refs = new Set(w.statuses.map((x) => x.statusReference));
    return { w, shared, plans: w === plansWf, gated: gatedStatuses(statuses, refs, w === plansWf) };
  }));
  return { statuses, workflows: out };
}

const hasGate = (t, key) => (t.validators || []).some((v) => v.parameters?.key === key);
const intoGated = (w, gated) => w.transitions.filter((t) => gated.has(t.toStatusReference));

function describeGate({ workflows }) {
  const key = validatorKey();
  const mine = workflows.filter((x) => !x.shared);
  const into = mine.flatMap((x) => intoGated(x.w, x.gated));
  const plans = workflows.find((x) => x.plans);
  return {
    workflow: plans.w.name,
    guarded: into.filter((t) => hasGate(t, key)).map((t) => t.name),
    missing: into.filter((t) => !hasGate(t, key)).map((t) => t.name),
    shared: workflows.filter((x) => x.shared).map((x) => x.w.name),
  };
}

async function gateState(project, projectId, planType) {
  return describeGate(await spaceWorkflows(project, projectId, planType));
}

// Adds "Detour Check is ready" to every guarded transition, in one update. Transitions that already
// have it are left alone, so running setup twice changes nothing.
async function installGate(project, projectId, planType) {
  const found = await spaceWorkflows(project, projectId, planType);
  const key = validatorKey();
  const plans = found.workflows.find((x) => x.plans);
  need(!plans.shared, `${plans.w.name} is shared with other spaces, so Detour Check leaves it alone. Choose a space with its own workflow, or create one with Set up.`);
  const todo = found.workflows.filter((x) => !x.shared && intoGated(x.w, x.gated).some((t) => !hasGate(t, key)));
  if (todo.length) {
    await jira(route`/rest/api/3/workflows/update`, {
      method: 'POST',
      body: JSON.stringify({
        statuses: found.statuses.filter((st, i, a) => a.findIndex((x) => x.statusReference === st.statusReference) === i),
        workflows: todo.map(({ w, gated }) => ({
          id: w.id, version: w.version, description: w.description, statuses: w.statuses, startPointLayout: w.startPointLayout,
          transitions: w.transitions.map((t) => (gated.has(t.toStatusReference) && !hasGate(t, key)
            ? { ...t, validators: [...(t.validators || []), { ruleKey: 'forge:expression-validator', parameters: { key, config: '' } }] }
            : t)),
        })),
      }),
    });
  }
  return gateState(project, projectId, planType);
}

const SPACE_NAME = 'Roadworks Changes';
const SPACE_KEYS = ['ROAD', 'ROADS', 'RWC', 'DETOUR', 'ROADWORKS'];
// A Jira Service Management IT space carries the Change type, its fields and its workflow. On a
// site without Jira Service Management, a plain business space with tasks stands in.
const TEMPLATES = [
  ['service_desk', 'com.atlassian.servicedesk:simplified-it-service-management'],
  ['business', 'com.atlassian.jira-core-project-templates:jira-core-simplified-task-tracking'],
];

async function createSpace() {
  // A space made by an earlier setup (one that timed out, say) is used rather than doubled.
  // It is looked up by name among all spaces, since create permission on a new space comes late.
  const earlier = async () => (await jira(route`/rest/api/3/project/search?query=${SPACE_NAME}`).catch(() => null))?.values?.find((p) => p.name === SPACE_NAME);
  const before = await earlier();
  if (before) return { key: before.key, made: false };
  const me = await jira(route`/rest/api/3/myself`);
  let lastError = '';
  for (const [projectTypeKey, projectTemplateKey] of TEMPLATES) {
    for (const key of SPACE_KEYS) {
      const taken = await jira(route`/rest/api/3/project/${key}`).then(() => true, () => false);
      if (taken) continue;
      try {
        await jira(route`/rest/api/3/project`, { method: 'POST', body: JSON.stringify({ key, name: SPACE_NAME, projectTypeKey, projectTemplateKey, leadAccountId: me.accountId }) });
        return { key, made: true };
      } catch (e) {
        lastError = e.message;
        // The name taken means an earlier setup got there first; a key held by a space in the trash
        // is worth the next key; anything else (a template this site cannot make) the next template.
        if (/projectName/.test(e.message)) { const now = await earlier(); if (now) return { key: now.key, made: false }; break; }
        if (!/projectKey/.test(e.message)) break;
      }
    }
  }
  need(false, `Could not create a space: ${lastError.slice(0, 200) || 'every key is taken'}`);
}

// Sets the site up: the space (new, or one the admin chose) and the gate in its workflow.
// Creating a Jira Service Management space takes about 20 seconds, close to the 25 a call is
// allowed, so a new space is one call and its gate the next (the page makes both).
export async function setUp({ project, create = false } = {}) {
  need(await isAdmin(), 'Only a Jira administrator can set up Detour Check');
  need(project === undefined || project === null || PROJECT.test(project), 'Unknown project key');
  const chosen = project || (create ? null : (await getSettings()).project);
  if (!chosen) {
    const { key, made } = await createSpace();
    // Jira takes a moment to grant create permission on a space this new, and the admin who just
    // made it leads it, so it is saved without asking.
    await kvs.set('settings', { ...(await getSettings()), project: key });
    return { project: key, created: made, gate: null, next: 'gate' };
  }
  const key = chosen;
  if (key !== (await getSettings()).project) await saveSettings({ project: key });
  await kvs.delete(`meta2:${key}`);
  let gate;
  try {
    const [info, meta] = await Promise.all([jira(route`/rest/api/3/project/${key}`), spaceMeta(key)]);
    gate = await keptGate(key, installGate(key, info.id, meta.issuetype));
  } catch (e) { gate = { error: e.message }; }
  return { project: key, created: false, gate };
}

// ---------- feeds and the computed desk, cached per container ----------

const cache = { live: null, demo: null, liveCheckedAt: 0 };

// Building the live desk fetches three feeds and matches every permit against the bus network,
// which can take longer than the 25 seconds a page call is allowed. So it is built in the
// background (src/live.js), stored gzipped in pieces under a key per build, and only read here.
const LIVE_FRESH = 15 * 60 * 1000;
const CHUNK = 200000; // characters per stored piece, under the storage's value limit
const liveQueue = new Queue({ key: 'live-desk' });

export async function storeLive(packed) {
  const data = gzipSync(JSON.stringify(packed)).toString('base64');
  const n = Math.ceil(data.length / CHUNK);
  const id = packed.takenAt;
  await Promise.all(Array.from({ length: n }, (_, i) => kvs.set(`live:${id}:${i}`, data.slice(i * CHUNK, (i + 1) * CHUNK), { ttl: { value: 1, unit: 'DAYS' } })));
  // The pieces are written before the pointer to them, so a reader never sees half a build.
  await kvs.set('live:meta', { takenAt: id, n });
  return { n, bytes: data.length };
}

// A build that fails is written down, so pages stop waiting for it and say why.
export async function noteLiveFailure(message) {
  const meta = (await kvs.get('live:meta')) || {};
  await kvs.set('live:meta', { ...meta, failedAt: new Date().toISOString(), error: String(message).slice(0, 200) });
}

async function readLive() {
  const meta = (await kvs.get('live:meta')) || {};
  cache.liveCheckedAt = Date.now();
  if (meta.n && cache.live?.takenAt !== meta.takenAt) {
    const parts = await Promise.all(Array.from({ length: meta.n }, (_, i) => kvs.get(`live:${meta.takenAt}:${i}`)));
    if (parts.every(Boolean)) {
      const pre = JSON.parse(gunzipSync(Buffer.from(parts.join(''), 'base64')).toString('utf8'));
      cache.live = { takenAt: meta.takenAt, desk: { ...reviveDesk(pre), mode: 'live', takenAt: pre.takenAt, network: pre.network } };
    }
  }
  return meta;
}

// Asks for a fresh build at most every three minutes, however many pages are open.
async function requestLive(meta) {
  if (meta.queuedAt && Date.now() - Date.parse(meta.queuedAt) < 3 * 60 * 1000) return;
  await kvs.set('live:meta', { ...meta, queuedAt: new Date().toISOString() });
  await liveQueue.push({ body: { at: new Date().toISOString() } });
}

const demo = () => (cache.demo ||= { ...reviveDesk(demoDesk), mode: 'demo', takenAt: demoDesk.takenAt, network: demoDesk.network });

export async function loadDesk(mode) {
  if (mode !== 'live') return demo();
  // A warm container trusts what it read in the last minute.
  if (cache.live && Date.now() - cache.liveCheckedAt < 60 * 1000) return cache.live.desk;
  // Nothing about live data may stop the page from loading: any failure here falls back to the
  // demo day, with a reason the page can show.
  let meta = {};
  try { meta = await readLive(); } catch (e) { console.warn(`Live data unreadable: ${e.message}`); meta = { error: 'The stored live data could not be read' }; }
  const failed = meta.failedAt && (!meta.queuedAt || meta.failedAt > meta.queuedAt);
  if (!cache.live || Date.now() - Date.parse(cache.live.takenAt) > LIVE_FRESH) {
    try { await requestLive(meta); } catch (e) { console.warn(`Live data build not queued: ${e.message}`); }
  }
  if (cache.live) return cache.live.desk;
  if (failed || (meta.error && !meta.queuedAt)) return { ...demo(), liveError: meta.error || 'Bordeaux open data did not answer' };
  // Until the first build lands, the demo day stands in and the page says so.
  return { ...demo(), liveLoading: true };
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

// Each sign-off is stored under its own key, so two teams signing at once never overwrite each
// other. A sign-off counts only for the plan version it approved: changing the plan bumps the
// version, which retires every earlier sign-off at once, even one being written at that moment.
// Plans from before versions (no "version") keep their sign-offs inside the plan.
const signoffPrefix = (key) => `signoff:${key}:`;
export async function getPlan(key) {
  need(ISSUE_KEY.test(key), 'Unknown work item key');
  const [plan, signed] = await Promise.all([kvs.get(`plan:${key}`), allWithPrefix(signoffPrefix(key))]);
  if (!plan) return null;
  const version = plan.version || 0;
  const signoffs = version ? {} : { ...(plan.signoffs || {}) };
  for (const { key: k, value } of signed) if ((value?.version || 0) === version && version) signoffs[k.slice(signoffPrefix(key).length)] = value;
  return { ...plan, signoffs };
}

// Moves a plan from before versions onto per-team keys, once.
async function versioned(key, raw) {
  if (raw.version) return raw;
  const next = { ...raw, version: 1 };
  delete next.signoffs;
  await Promise.all(Object.entries(raw.signoffs || {}).filter(([r]) => ROLES[r]).map(([r, s]) => kvs.set(`${signoffPrefix(key)}${r}`, { ...s, version: 1 })));
  await kvs.set(`plan:${key}`, next);
  return next;
}

// Answers that ask less of the published detour: no effect, delays only, or a detour needed one way.
// They are the easy way to make a failing plan pass, so each needs a written reason, and Operations
// must sign off as someone other than the person who gave it.
export const lowered = (plan) => plan.impact === 'none' || plan.impact === 'narrowed' || ((plan.impact === 'closed' || plan.impact === 'stops') && plan.directions === 'one');
const REASON_MIN = 10;

// The reason that goes with a lowered plan, from the person lowering it. Agents cannot lower a plan.
export function lowering(next, reason, accountId) {
  if (!lowered(next)) return null;
  const text = String(reason ?? '').trim().slice(0, 500);
  need(text.length >= REASON_MIN, `Say why (${IMPACTS[next.impact] || 'one way only'}): a reason of at least ${REASON_MIN} characters is needed, and someone else must then sign off for Operations`);
  need(accountId, 'Only a person can lower a plan');
  return { reason: text, by: accountId, at: new Date().toISOString() };
}

// Everyone who had a hand in lowering a plan: who lowered it and, when the reason came later, who
// gave it. None of them confirms it for Operations.
const lowerers = (plan) => [plan.lowered?.by, plan.lowered?.reasonBy].filter(Boolean);

// What still stands between a plan and going live, beyond its checks.
function secondPerson(plan) {
  if (!lowered(plan)) return null;
  if (!plan.lowered?.reason) return 'A reason for the lower impact';
  const ops = plan.signoffs?.ops;
  return ops && ops.by && !lowerers(plan).includes(ops.by) ? null : 'Operations sign-off from someone other than the person who lowered the impact';
}

// The checks each team's own work answers to. A team cannot say its part is done while one of them
// fails: Operations publishes the detour, Passenger information tells riders at the stops.
const OWNS = { ops: ['diversion', 'directions', 'dates'], passengers: ['notice'] };

// A live change whose checks fail is a problem whatever else is true, and its label says why.
export const liveOutlook = (o, liveFailing) => (liveFailing ? { ...o, light: 'red', label: 'Live, failing' } : o);

export function readiness(plan, item, desk) {
  const result = item ? runChecks(plan, item, desk) : { state: 'not-found', checks: [], failing: 0 };
  const signed = Object.keys(ROLES).filter((r) => plan.signoffs?.[r]);
  // "No effect" still needs Operations to confirm it; otherwise every check and every team.
  const teams = result.state === 'no-impact' ? !!plan.signoffs?.ops : result.state === 'ready' && signed.length === Object.keys(ROLES).length;
  const blocker = secondPerson(plan);
  return { ...result, signed: signed.length, roles: Object.keys(ROLES).length, ready: teams && !blocker, blocker };
}

// What one change request looks like to the page and to Rovo.
// `plan` can be passed in when the caller has just read or saved it.
// `live` says the work item is in a live status now (liveNow, liveKeys).
export async function changeRequestView(key, desk, { full = true, plan = null, live = false } = {}) {
  plan ||= await getPlan(key);
  if (!plan) return null;
  const item = desk.byId.get(plan.item);
  const r = readiness(plan, item, desk);
  const liveFailing = !!live && r.failing > 0;
  return {
    live: !!live, liveFailing,
    key, item: plan.item, impact: plan.impact, impactLabel: plan.impact ? IMPACTS[plan.impact] : 'Not assessed yet',
    lines: plan.lines.map(lineInfo).filter(Boolean), starts: plan.starts, ends: plan.ends,
    startsLabel: dayLabel(plan.starts, desk.now), endsLabel: dayLabel(plan.ends, desk.now),
    directions: plan.directions, stops: plan.stops, notice: !!plan.notice,
    lowered: plan.lowered ? { reason: plan.lowered.reason, by: plan.lowered.by, reasonBy: plan.lowered.reasonBy, at: plan.lowered.at } : null,
    signoffs: Object.entries(ROLES).map(([role, label]) => ({ role, label, ...(plan.signoffs?.[role] || {}) })),
    readiness: r,
    outlook: item ? liveOutlook(outlook(item, desk, plan, r), liveFailing) : null,
    disruption: item && full ? detail(item, desk) : null,
  };
}

const IMPACT_KEYS = Object.keys(IMPACTS);

// Only someone who may edit the work item changes its plan; the people being checked could
// otherwise make the check pass by editing what it checks against.
async function mayEdit(key) {
  const p = await jira(route`/rest/api/3/mypermissions?issueKey=${key}&permissions=EDIT_ISSUES`);
  return !!p?.permissions?.EDIT_ISSUES?.havePermission;
}

// A real calendar day in a sensible range, not just something shaped like one.
const realDate = (d) => DATE.test(d) && d >= '2000-01-01' && d <= '2100-12-31' && new Date(`${d}T12:00:00Z`).toISOString().slice(0, 10) === d;

export async function savePlan(key, changes, loaded = null) {
  const [plan, allowed] = await Promise.all([getPlan(key), mayEdit(key)]);
  need(plan, 'That work item is not a change request from the desk');
  need(allowed, `You cannot edit ${key}`);
  if (changes.impact !== undefined) need(IMPACT_KEYS.includes(changes.impact), `Impact is one of ${IMPACT_KEYS.join(', ')}`);
  if (changes.directions !== undefined) need(['both', 'one'].includes(changes.directions), 'Directions is both or one');
  if (changes.ends !== undefined) need(realDate(changes.ends), 'End date is a real day, YYYY-MM-DD');
  if (changes.starts !== undefined) need(realDate(changes.starts), 'Start date is a real day, YYYY-MM-DD');
  const starts = changes.starts ?? plan.starts;
  const ends = changes.ends ?? plan.ends;
  need(!starts || !ends || ends >= starts, 'The works cannot end before they start');
  // The permit's dates are the floor: a plan can say the works run longer, never shorter.
  if (changes.ends !== undefined || changes.starts !== undefined) {
    const item = (loaded || await currentDesk()).desk.byId.get(plan.item);
    need(changes.ends === undefined || !item?.ends || changes.ends >= item.ends, `The permit runs until ${item?.ends}. A plan can say the works run longer, never shorter.`);
    need(changes.starts === undefined || !item?.starts || changes.starts <= item.starts, `The permit starts on ${item?.starts}. A plan can say the works start sooner, never later.`);
  }
  // Sign-offs approved the plan as it was. Any change to what is checked needs them again, and the
  // work item's history says what changed, since narrowing the plan can turn a failing check green.
  const LABELS = { impact: 'Impact', directions: 'Directions', ends: 'Plan end', starts: 'Plan start' };
  const changed = Object.keys(LABELS).filter((k) => changes[k] !== undefined && changes[k] !== plan[k]);
  // "Road closed" and "stops not served" are checked the same way, so swapping one for the other
  // changes nothing the teams approved: it is noted, and the sign-offs stand.
  const SAME = ['closed', 'stops'];
  const rechecked = changed.filter((k) => !(k === 'impact' && SAME.includes(plan.impact) && SAME.includes(changes.impact)));
  // Lowering the impact, or dropping a direction, needs a reason; raising it clears the reason.
  const next = { ...plan, ...Object.fromEntries(changed.map((k) => [k, changes[k]])) };
  // A plan lowered before reasons were asked for can be given one without changing anything else.
  // Whoever gives it, the person who lowered it stays on record: the plan never said who that was,
  // so the person who opened the plan stands in, and neither of them confirms it for Operations.
  let why;
  if (rechecked.some((k) => k === 'impact' || k === 'directions')) why = lowering(next, changes.reason, changes.by);
  else if (!plan.lowered && lowered(plan) && changes.reason) {
    const given = lowering(plan, changes.reason, changes.by);
    const opener = (await kvs.get(`cr:${plan.item}`))?.by || null;
    why = { ...given, by: opener, reasonBy: changes.by };
  }
  const said = changed.map((k) => `${LABELS[k]}: ${k === 'impact' ? IMPACTS[plan[k]] || 'not answered' : plan[k] || 'none'} → ${k === 'impact' ? IMPACTS[changes[k]] : changes[k]}`);
  if (why) said.push(`Reason: ${why.reason}`, 'Operations must sign off as someone else.');
  const signed = Object.keys(plan.signoffs || {}).length;
  // The first answer on a new plan is not news; changing a plan someone answered or approved is.
  const audit = changed.length && (signed || changed.some((k) => k !== 'impact') || plan.impact || why);
  // Who to ask: everyone the plan now needs when it is first answered or its sign-offs were cleared,
  // and Operations when it was lowered.
  const firstAnswer = changed.includes('impact') && !plan.impact;
  const ask = firstAnswer || (rechecked.length && signed) ? neededRoles(next) : why ? ['ops'] : [];
  if (!changed.length && !changes.notice && !why) return plan;
  const raw = await versioned(key, await kvs.get(`plan:${key}`));
  for (const k of changed) raw[k] = changes[k];
  if (why) raw.lowered = why;
  else if (why === null) delete raw.lowered;
  if (rechecked.length) raw.version += 1;
  if (changes.notice) raw.notice = { at: new Date().toISOString() };
  await kvs.set(`plan:${key}`, raw);
  Object.assign(plan, raw, rechecked.length ? { signoffs: {} } : {});
  if (!raw.lowered) delete plan.lowered;
  await Promise.all([
    audit || firstAnswer ? addComment(key, firstAnswer && !audit ? 'Sign-off needed' : signed && rechecked.length ? 'Plan changed: sign-offs cleared' : 'Plan changed', said.join('\n'), 'user', ask).catch((e) => console.warn(`Change comment on ${key} failed: ${e.message}`)) : null,
    publishStatus(key, plan, loaded),
  ]);
  if (changed.length) await syncFields(key, plan, loaded);
  return plan;
}

// The change request's own fields follow the plan: planned dates, risk, impact and the
// implementation plan. A field the space will not take is skipped, never fatal.
async function syncFields(key, plan, loaded) {
  try {
    const { desk } = loaded || await currentDesk();
    const item = desk.byId.get(plan.item);
    if (!item) return;
    const { fields } = await spaceMeta(key.split('-')[0]);
    const { values, text } = changeFields(fields, item, summary(item, desk), desk, plan);
    // Text the team rewrote in Jira is theirs: a field changes only while it still holds what the
    // app last wrote, and the work item says which were left alone.
    const [written, now] = await Promise.all([
      kvs.get(`written:${key}`),
      jira(route`/rest/api/3/issue/${key}?fields=${Object.keys(text).join(',')}`).catch(() => null),
    ]);
    const kept = Object.keys(text).filter((id) => written?.[id] !== undefined && now?.fields && textOf(now.fields[id]) !== written[id]);
    for (const id of kept) delete values[id];
    await kvs.set(`written:${key}`, { ...(written || {}), ...Object.fromEntries(Object.keys(text).filter((id) => !kept.includes(id)).map((id) => [id, text[id]])) });
    if (kept.length) {
      const label = (id) => (id === 'description' ? 'Description' : fields.find((f) => f.fieldId === id)?.name || id);
      await addComment(key, 'Plan changed: fields edited in Jira were left as they are', kept.map(label).join(', ')).catch(() => null);
    }
    if (!Object.keys(values).length) return;
    try { await jira(route`/rest/api/3/issue/${key}`, { method: 'PUT', body: JSON.stringify({ fields: values }) }); } catch (e) {
      // One read-only field fails the whole update, so the fields go one at a time.
      console.warn(`Fields on ${key} not updated together: ${e.message}`);
      await Promise.all(Object.entries(values).map(([id, v]) => jira(route`/rest/api/3/issue/${key}`, { method: 'PUT', body: JSON.stringify({ fields: { [id]: v } }) }).catch(() => null)));
    }
  } catch (e) { console.warn(`Fields on ${key} not synced: ${e.message}`); }
}

// Who may sign off for a team: members of the site group "detour-check-<team>" when the site has
// one, otherwise anyone who can edit the change request.
const roleGroup = (role) => `detour-check-${role}`;
const groupCache = { at: 0, names: [] };
async function siteGroups() {
  if (Date.now() - groupCache.at < 5 * 60 * 1000) return groupCache.names;
  let names = [];
  try { names = (await jira(route`/rest/api/3/groups/picker?query=detour-check&maxResults=20`, {}, 'app'))?.groups?.map((g) => g.name) || []; } catch { /* no group lookup: fall back */ }
  Object.assign(groupCache, { at: Date.now(), names });
  return names;
}
async function maySignOff(key, role) {
  // Both answers are asked for at once; only one of them decides.
  const [groups, perms] = await Promise.all([
    siteGroups(),
    jira(route`/rest/api/3/mypermissions?issueKey=${key}&permissions=EDIT_ISSUES`),
  ]);
  if (groups.includes(roleGroup(role))) {
    const me = await jira(route`/rest/api/3/myself?expand=groups`);
    return (me?.groups?.items || []).some((g) => g.name === roleGroup(role));
  }
  return !!perms?.permissions?.EDIT_ISSUES?.havePermission;
}

// A sign-off says a team has done its part. A plan only counts as ready once the checks pass too,
// so a team can sign off while, say, Operations is still extending the detour.
export async function signOff(key, role, accountId, undo = false, loaded = null) {
  need(ROLES[role], 'Unknown sign-off');
  const [plan, allowed] = await Promise.all([getPlan(key), ROLES[role] && ISSUE_KEY.test(key) ? maySignOff(key, role) : false]);
  need(plan, 'That work item is not a change request from the desk');
  need(plan.impact, 'Answer whether buses can get through first');
  need(allowed, `You cannot sign off for ${ROLES[role]} on ${key}`);
  // The page sends the state it wants. When storage already has it (a stale page, a second tab),
  // nothing is written and no comment is posted.
  if (!!plan.signoffs?.[role] === !undo) return plan;
  need(undo || role !== 'ops' || !lowerers(plan).includes(accountId), 'You lowered the impact of this plan, so someone else signs off for Operations');
  if (!undo && OWNS[role]) {
    const { desk } = loaded || await currentDesk();
    const item = desk.byId.get(plan.item);
    const failing = item ? runChecks(plan, item, desk).checks.filter((c) => c.state === 'fail' && OWNS[role].includes(c.id)) : [];
    need(!failing.length, `${ROLES[role]} can't sign off while ${failing.map((c) => `"${c.label}"`).join(' and ')} fails.`);
  }
  const raw = await versioned(key, await kvs.get(`plan:${key}`));
  const at = `${signoffPrefix(key)}${role}`;
  if (undo) await kvs.delete(at);
  else await kvs.set(at, { by: accountId || null, at: new Date().toISOString(), version: raw.version });
  // Read back, so the answer and the status include sign-offs other teams made meanwhile.
  const now = await getPlan(key);
  // The work item's own history shows who signed off for which team.
  await Promise.all([
    addComment(key, undo ? `${ROLES[role]} sign-off withdrawn` : `${ROLES[role]} signed off`, `Impact: ${IMPACTS[now.impact]}.`).catch((e) => console.warn(`Sign-off comment on ${key} failed: ${e.message}`)),
    publishStatus(key, now, loaded),
  ]);
  return now;
}

// Where a plan stands, written on its work item as the "detour-check" property. Jira indexes it
// (manifest: jira:entityProperty), so JQL and queues can find "detourCheck = failing", and the
// workflow validator reads it to hold a change back until it is ready.
// The desk can only vouch for a plan when it holds the data the site chose, and that data is recent.
const LIVE_TRUSTED = 2 * 60 * 60 * 1000;
export function verifiable({ desk, settings }) {
  if (desk.liveLoading || desk.liveError || desk.mode !== (settings.mode || 'demo')) return false;
  return desk.mode !== 'live' || Date.now() - Date.parse(desk.takenAt) < LIVE_TRUSTED;
}

// "unknown" when the desk cannot vouch for it right now, and "gone" when the roadworks have left the
// feed (finished or withdrawn): neither is ready.
export function statusOf(plan, item, desk, trusted = true) {
  const r = item ? readiness(plan, item, desk) : { ready: false, signed: Object.keys(plan.signoffs || {}).length, roles: Object.keys(ROLES).length, failing: 0 };
  const status = !trusted ? 'unknown' : !item ? 'gone' : !plan.impact ? 'unanswered' : r.ready ? 'ready' : r.failing ? 'failing' : 'waiting';
  return { plan: true, status, ready: trusted && !!item && r.ready, signed: r.signed, roles: r.roles, failing: r.failing || 0 };
}

// Always writes, and writes "not ready" when unsure, so the status never stays "ready" after the
// plan changed. What was written is kept, so the hourly check only rewrites what moved.
export async function publishStatus(key, plan, loaded = null) {
  try {
    loaded ||= await currentDesk();
    const status = statusOf(plan, loaded.desk.byId.get(plan.item), loaded.desk, verifiable(loaded));
    await jira(route`/rest/api/3/issue/${key}/properties/detour-check`, { method: 'PUT', body: JSON.stringify(status) }, 'app');
    await kvs.set(`status:${key}`, status);
    return status;
  } catch (e) { console.warn(`Status on ${key} not written: ${e.message}`); return null; }
}

// ---------- changes already live ----------
// The go-live check only runs on a transition, so a change that went live and whose published
// detour later falls short would pass unnoticed. Nothing moves it back; the desk, the panel and the
// hourly check flag it instead. Live means a status the go-live check guards on the way in, or
// In Progress in a space without Jira Service Management's change statuses.
const LIVE_ELSEWHERE = /^(in progress|en cours)$/i;
export const isLive = (status) => !!status?.name && (LIVE.test(status.name) || (status.statusCategory?.key === 'indeterminate' && LIVE_ELSEWHERE.test(status.name)));

// Every plan whose work item is live now, in one search. Work items the person cannot see are left
// out, and a failed search flags none rather than stopping the page from loading.
export async function liveKeys(as = 'user') {
  const out = new Set();
  let nextPageToken;
  try {
    for (let page = 0; page < 5; page += 1) {
      const res = await jira(route`/rest/api/3/search/jql`, { method: 'POST', body: JSON.stringify({ jql: 'detourCheck IS NOT EMPTY AND statusCategory = 4', fields: ['status'], maxResults: 100, ...(nextPageToken ? { nextPageToken } : {}) }) }, as);
      for (const issue of res?.issues || []) if (isLive(issue.fields?.status)) out.add(issue.key);
      nextPageToken = res?.nextPageToken;
      if (!nextPageToken) break;
    }
  } catch (e) { console.warn(`Live changes not read: ${e.message}`); }
  return out;
}

// One work item's status, for the panel and the card.
export async function liveNow(key) {
  if (!ISSUE_KEY.test(key || '')) return false;
  try { return isLive((await jira(route`/rest/api/3/issue/${key}?fields=status`))?.fields?.status); } catch { return false; }
}

// The workflow validator: a change from Detour Check moves on only when its plan is ready now,
// computed here from storage and the published data, never from anything an editor can set.
// Unsure means no. Work items Detour Check did not open are not its business.
// A plan is found by the work item's id as well as its key, so moving the work item to another
// space (a new key) does not lose it.
async function findPlan(key, id) {
  const plan = ISSUE_KEY.test(key || '') ? await getPlan(key) : null;
  if (plan || !/^\d{1,18}$/.test(String(id || ''))) return plan ? { key, plan } : null;
  const first = await kvs.get(`issue:${id}`);
  const moved = first && first !== key ? await getPlan(first) : null;
  return moved ? { key: first, plan: moved } : null;
}

export async function goLiveCheck(key, id = null) {
  if (!ISSUE_KEY.test(key || '')) return { result: true };
  let found;
  try { found = await findPlan(key, id); } catch (e) {
    // Work items in spaces Detour Check does not plan in are never held back by its own trouble.
    const settings = await getSettings().catch(() => null);
    if (settings && settings.project !== key.split('-')[0]) return { result: true };
    throw e;
  }
  if (!found) return { result: true };
  const { plan } = found;
  const loaded = await currentDesk();
  const item = loaded.desk.byId.get(plan.item);
  if (!verifiable(loaded)) return { result: false, errorMessage: 'Detour Check cannot confirm this change right now: its data is still loading or out of date. Try again in a few minutes.' };
  // Roadworks that have left the feed are over or withdrawn: there is nothing left to hold back.
  if (!item) return { result: true };
  const r = readiness(plan, item, loaded.desk);
  if (r.ready) return { result: true };
  // What to fix first (a failing check), then who still has to sign off, then where to do it.
  const quoted = (cs) => cs.map((c) => `"${c.label}"`).join(' and ');
  const failing = r.checks.filter((c) => c.state === 'fail');
  const due = r.checks.filter((c) => c.state === 'pending');
  const teams = (r.state === 'no-impact' ? ['ops'] : Object.keys(ROLES)).filter((x) => !plan.signoffs?.[x] && !(x === 'ops' && r.blocker));
  const said = [
    ...(r.state === 'not-assessed' ? ['Say what the works do to buses.'] : []),
    ...(failing.length ? [`${quoted(failing)} ${failing.length === 1 ? 'fails' : 'fail'}.`] : []),
    ...(due.length ? [`${quoted(due)} can't be checked before ${dayLabel(due[0].due, loaded.desk.now)}.`] : []),
    ...(teams.length ? [`Waiting for ${andList(teams.map((x) => ROLES[x]))} to sign off.`] : []),
    ...(r.blocker ? [`${r.blocker}.`] : []),
  ];
  return { result: false, errorMessage: `Detour Check: ${said.join(' ')} Open Detour Check on this work item.` };
}

// A deleted work item takes its plan with it, so the roadworks can be planned again.
export async function forgetIssue(key) {
  if (!ISSUE_KEY.test(key || '')) return false;
  const plan = await kvs.get(`plan:${key}`);
  if (!plan) return false;
  const cr = await kvs.get(`cr:${plan.item}`);
  const signed = await allWithPrefix(signoffPrefix(key));
  await Promise.all([kvs.delete(`plan:${key}`), kvs.delete(`written:${key}`), plan.issueId ? kvs.delete(`issue:${plan.issueId}`) : null, kvs.delete(`status:${key}`), kvs.delete(`check:${key}`), ...signed.map((s) => kvs.delete(s.key)), cr?.key === key ? kvs.delete(`cr:${plan.item}`) : null]);
  return true;
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
const rangeText = (a, b, now) => (a && b && a.slice(0, 4) !== b.slice(0, 4)
  ? `${shortDay(a, `${b.slice(0, 4)}-01-01`)} → ${shortDay(b, `${a.slice(0, 4)}-01-01`)}`
  : `${shortDay(a, now)} → ${shortDay(b, now)}`);
const shortDay = (iso, now) => (iso ? new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: iso.slice(0, 4) !== new Date(now).toISOString().slice(0, 4) ? 'numeric' : undefined, timeZone: 'Europe/Paris' }) : 'further notice');

// The fields a plan fills, by their names in Jira Service Management.
const FIELD_NAMES = ['planned start', 'planned end', 'change type', 'change risk', 'impact', 'change reason', 'implementation plan', 'backout plan', 'test plan'];

// A space's issue type for plans and its change fields rarely change, and reading them costs two
// Jira calls, so they are kept for a day.
async function spaceMeta(project) {
  const cached = await kvs.get(`meta2:${project}`);
  if (cached?.name) return cached;
  const meta = await jira(route`/rest/api/3/issue/createmeta/${project}/issuetypes`);
  const types = (meta.issueTypes || meta.values || []).filter((t) => !t.subtask);
  // A service space's Change type carries the change fields; any other space gets a Task. Names
  // are matched untranslated, since a French site calls a Task "Tâche".
  const base = (t) => t.untranslatedName || t.name;
  const type = types.find((t) => /^(\[system\] )?change$/i.test(base(t))) || types.find((t) => /^task$/i.test(base(t))) || types[0];
  const issuetype = type?.id;
  need(issuetype, `No issue type found in ${project}`);
  let fields = [];
  try {
    const f = await jira(route`/rest/api/3/issue/createmeta/${project}/issuetypes/${issuetype}?maxResults=200`);
    fields = (f.fields || f.values || []).filter((x) => FIELD_NAMES.includes(String(x.name).toLowerCase()) || x.fieldId === 'priority')
      .map((x) => ({ fieldId: x.fieldId, name: x.fieldId === 'priority' ? 'priority' : x.name, allowedValues: x.allowedValues?.map((o) => ({ id: o.id, value: o.value ?? o.name })) }));
  } catch { /* the plan is created without change fields */ }
  const out = { issuetype, name: type.name.replace(/^\[system\] /i, ''), fields };
  await kvs.set(`meta2:${project}`, out, { ttl: { value: 1, unit: 'DAYS' } });
  return out;
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
function changeFields(fields, item, s, desk, plan = defaultPlan(item)) {
  const byName = (n) => fields.find((f) => String(f.name).toLowerCase() === n);
  const values = {};
  const ids = {};
  const set = (name, key, value) => { const f = byName(name); if (f) { values[f.fieldId] = value; if (key) ids[key] = f.fieldId; } };
  const option = (name, test) => { const f = byName(name); const v = f?.allowedValues?.find((o) => test.test(o.value || '')); if (v) values[f.fieldId] = { id: v.id }; };
  // Risk and impact grow with the lines affected, and drop when buses are only slowed or unaffected.
  const n = plan.impact === 'none' ? 0 : plan.impact === 'narrowed' ? 1 : item.lines.length;
  const lines = linesText(s.lines);
  const { starts, ends } = planDates(plan, item);
  const until = shortDay(ends, desk.now);
  // "MÉCA", "MÉCA (Paludate)" and "MECA (Paludate)" are one stop to a reader.
  const base = (name) => name.replace(/\s*\(.*\)\s*$/, '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const stopNames = [...new Map(item.stops.map((x) => [base(x.name), x.name.replace(/\s*\(.*\)\s*$/, '')])).values()].slice(0, 3);
  // Noon in Paris is the same calendar day in every time zone a viewer is likely to be in.
  if (starts) set('planned start', 'plannedStart', parisDateTime(starts, '12:00'));
  if (ends) set('planned end', 'plannedEnd', parisDateTime(ends, '23:59'));
  option('change type', /^normal$/i);
  option('change risk', n >= 4 ? /^high$/i : n >= 2 ? /^medium$/i : /^low$/i);
  option('impact', n >= 4 ? /^significant/i : n >= 2 ? /^moderate/i : /^minor/i);
  option('change reason', /^maintenance$/i);
  // Priority follows the risk. Its names are translated, so it goes by place in the list, which runs
  // from highest to lowest.
  const prio = fields.find((f) => f.fieldId === 'priority');
  if (prio?.allowedValues?.length >= 3) {
    const list = prio.allowedValues;
    const at = Math.min(list.length - 1, Math.round(((n >= 4 ? 1 : n >= 2 ? 2 : 3) / 4) * (list.length - 1)));
    values.priority = { id: list[at].id };
  }
  // Plain paragraphs: these text fields show list markup as literal asterisks.
  const steps = plan.impact === 'none'
    ? ['Operations: confirm buses are not affected']
    : plan.impact === 'narrowed'
      ? [`Operations: plan for delays on ${lines} until ${until}`, 'Scheduling: adjust running times if needed', `Drivers: brief ${lines}`]
      : [
        `Operations: publish the detour${plan.directions === 'one' ? ' one way' : ', both ways,'} until ${until}`,
        'Scheduling: update timetables and the journey planner',
        `Passenger information: post the notice${stopNames.length ? ` at ${stopNames.join(', ')}` : ''}`,
        `Drivers: brief ${lines}`,
      ];
  set('implementation plan', null, doc(steps.map((t) => para(t))));
  set('backout plan', null, doc([para(plan.impact === 'none'
    ? 'If buses turn out to be affected: change the impact in Detour Check, and every team signs off again.'
    : plan.impact === 'narrowed'
      ? 'If buses cannot get through: divert them, publish a detour and tell riders.'
      : `If the works end before ${until}: withdraw the detour and notices, restore timetables, tell drivers.`)]));
  // Works already under way can't be checked "before" their start, so the test is today's.
  const begun = starts && starts <= (desk.today || String(desk.now).slice(0, 10));
  set('test plan', null, doc([para(plan.impact === 'none'
    ? (begun ? 'Operations confirms buses run normally past the works.' : `Operations confirms buses run normally past the works on ${shortDay(starts, desk.now)}.`)
    : begun ? 'Detour Check shows every check green.' : `Detour Check shows every check green before ${shortDay(starts, desk.now)}.`)]));
  values.description = description(item, s, desk, plan);
  // The plain text of each text field, to tell later whether someone rewrote it in Jira.
  const text = Object.fromEntries(Object.entries(values).filter(([, v]) => v?.type === 'doc').map(([id, v]) => [id, textOf(v)]));
  return { values, ids, text };
}

const textOf = (adf) => {
  const out = [];
  const walk = (n) => { if (!n || typeof n !== 'object') return; if (typeof n.text === 'string') out.push(n.text); (n.content || []).forEach(walk); };
  walk(adf);
  return out.join('\n').trim();
};

// The work item's description: where and when, and the plan as it stands now.
function description(item, s, desk, plan) {
  const { starts, ends } = planDates(plan, item);
  const t = timelineOf(item, desk);
  return doc([bullets([
    `Where: ${item.title}`,
    `When: ${rangeText(starts, ends, desk.now)}`,
    `Lines: ${linesText(s.lines)}`,
    `Published detour: ${t.detour ? `${shortDay(t.detour.from, desk.now)} → ${shortDay(t.detour.to, desk.now)}` : 'none'}`,
    `Impact: ${plan.impact ? IMPACTS[plan.impact] : 'not answered yet'}${plan.directions === 'one' && !['none', 'narrowed'].includes(plan.impact) ? ', one way' : ''}`,
    ...(plan.lowered ? [`Why: ${plan.lowered.reason}`] : []),
  ]), para(`${item.what} · ${s.source} ${s.ref}`, [{ type: 'em' }])]);
}

export async function createChangeRequest(itemId, accountId, initial = {}, loaded = null) {
  need(ITEM.test(itemId), 'Unknown disruption');
  const { settings, desk } = loaded || await currentDesk();
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
    return await openChangeRequest(itemId, item, settings, desk, accountId, initial, { settings, desk });
  } finally {
    await kvs.delete(`claim:${itemId}`);
  }
}

async function openChangeRequest(itemId, item, settings, desk, accountId, initial, loaded) {
  const s = summary(item, desk);
  const lineList = linesText(s.lines);
  const { issuetype, fields } = await spaceMeta(settings.project);
  const extra = changeFields(fields, item, s, desk, { ...defaultPlan(item), ...initial });
  const post = (more) => jira(route`/rest/api/3/issue`, {
    method: 'POST',
    body: JSON.stringify({
      fields: {
        ...more,
        project: { key: settings.project },
        issuetype: { id: issuetype },
        summary: `Roadworks · ${item.title.split(',')[0]} · ${lineList}`.slice(0, 250),
        labels: ['detour-check'],
        description: extra.values.description,
      },
    }),
  });
  // A space can make a change field read-only on create; the change request matters more than the field.
  let created;
  let ids = extra.ids;
  try { created = await post(extra.values); } catch (e) { console.warn(`Create with change fields failed, retrying without: ${e.message}`); created = await post({}); ids = {}; }
  const plan = { ...defaultPlan(item), ...initial, version: 1, fields: ids, issueId: created.id || null };
  await kvs.set(`plan:${created.key}`, plan);
  await Promise.all([
    created.id ? kvs.set(`issue:${created.id}`, created.key) : null,
    kvs.set(`written:${created.key}`, ids === extra.ids ? extra.text : { description: extra.text.description }),
  ]);
  // A first answer that lowers the impact says why on the work item, like any later change would.
  // The teams hear about a plan as soon as it has an answer. A first answer that lowers the impact
  // says why, like any later change would.
  if (initial.impact) {
    const said = initial.lowered
      ? `${IMPACTS[initial.impact]}\nReason: ${initial.lowered.reason}\nOperations must sign off as someone else.`
      : `${item.title}: ${IMPACTS[initial.impact]}.\nEach team below signs off once its part is done.`;
    await addComment(created.key, initial.lowered ? 'Impact lowered: sign-off needed' : 'Sign-off needed', said, 'user', neededRoles(initial)).catch((e) => console.warn(`First note on ${created.key} failed: ${e.message}`));
  }
  const view = { ...plan, signoffs: {} };
  // The marker shows the panel; if writing it fails, the desk tries again on its next load.
  const status = await publishStatus(created.key, view, loaded);
  const cr = { key: created.key, at: new Date().toISOString(), by: accountId || null, marked: status && status.status !== 'unknown' ? MARKED : null };
  await kvs.set(`cr:${itemId}`, cr);
  return { ...cr, created: true, plan: view };
}

// The issue panel shows only on work items carrying this property (see the manifest's display condition).
// Bumped when the status property's shape changes, so older plans get the current one once.
export const MARKED = 'detour-check-status';

// `ask` names the teams whose people should hear about it: each is @mentioned in the note and
// added as a watcher, so Jira's own notifications (bell, email, mobile) reach them.
// `text` is plain text, or [subheading, text] pairs for a note with several parts.
const paras = (text) => String(text || '').split(/\n{1,}/).filter(Boolean).slice(0, 40).map((t) => para(t));
export async function addComment(key, heading, text, as = 'user', ask = []) {
  need(ISSUE_KEY.test(key), 'Unknown work item key');
  const asked = ask.length ? await askTeams(key, ask) : [];
  const parts = Array.isArray(text) ? text.flatMap(([sub, t]) => [para(sub, [{ type: 'strong' }]), ...paras(t)]) : paras(text);
  const body = doc([para(heading, [{ type: 'strong' }]), ...parts, ...asked]);
  // Internal notes in a service space: a public comment there is a reply that emails the customer.
  return jira(route`/rest/api/3/issue/${key}/comment`, { method: 'POST', body: JSON.stringify({ body, properties: [{ key: 'sd.public.comment', value: { internal: true } }] }) }, as);
}

// ---------- asking each team ----------
// A team's people are the members of its group ("detour-check-ops" and so on). A team without a
// group has no one to ask by name, so its line is left out and the note reads as before.
const peopleCache = new Map();
async function teamPeople(role) {
  const hit = peopleCache.get(role);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.people;
  let people = [];
  if ((await siteGroups()).includes(roleGroup(role))) {
    try {
      const page = await jira(route`/rest/api/3/group/member?groupname=${roleGroup(role)}&maxResults=10`, {}, 'app');
      people = (page?.values || []).filter((u) => u.active !== false && u.accountId).map((u) => ({ id: u.accountId, name: u.displayName || 'someone' }));
    } catch (e) { console.warn(`Members of ${roleGroup(role)} not read: ${e.message}`); }
  }
  peopleCache.set(role, { at: Date.now(), people });
  return people;
}

// One line per team that has people, mentioning each of them, and each added as a watcher.
// Nothing here can stop the note itself from being written.
async function askTeams(key, roles) {
  const lines = [];
  const watchers = new Set();
  for (const role of [...new Set(roles)].filter((r) => ROLES[r])) {
    const people = await teamPeople(role).catch(() => []);
    if (!people.length) continue;
    people.forEach((p) => watchers.add(p.id));
    const mentions = people.flatMap((p, i) => [...(i ? [{ type: 'text', text: ' ' }] : []), { type: 'mention', attrs: { id: p.id, text: `@${p.name}` } }]);
    lines.push({ type: 'paragraph', content: [{ type: 'text', text: `${ROLES[role]}: `, marks: [{ type: 'strong' }] }, ...mentions] });
  }
  await Promise.all([...watchers].map((id) => jira(route`/rest/api/3/issue/${key}/watchers`, { method: 'POST', body: JSON.stringify(id) }, 'app')
    .catch((e) => console.warn(`Watcher on ${key} not added: ${e.message}`))));
  return lines;
}

// Which teams a plan needs: Operations alone for "no effect", every team otherwise.
const neededRoles = (plan) => (plan.impact === 'none' ? ['ops'] : Object.keys(ROLES));

// ---------- the hourly go-live check ----------
// Comments on a change request when its published information starts or stops matching the plan,
// so the change's own history shows when it went wrong and when it was fixed. A change already live
// whose checks fail is said so plainly, once, and its teams are asked; it is never moved back.
export async function checkAll() {
  const [loaded, live] = await Promise.all([currentDesk(), liveKeys('app')]);
  const { desk } = loaded;
  const trusted = verifiable(loaded);
  const results = [];
  for (const { key: kvKey } of await allWithPrefix('plan:')) {
    const key = kvKey.slice(5);
    // Each plan is read fresh with its sign-offs, and this check never writes the plan itself back,
    // so an edit or a sign-off made while it runs is never undone.
    const [plan, published, last] = await Promise.all([getPlan(key), kvs.get(`status:${key}`), kvs.get(`check:${key}`)]);
    if (!plan) continue;
    // Plans opened before ids were kept get theirs here, once; the plan itself is not written.
    if (!plan.issueId && !(await kvs.get(`id:${key}`))) {
      try {
        const issue = await jira(route`/rest/api/3/issue/${key}?fields=project`, {}, 'app');
        await Promise.all([kvs.set(`issue:${issue.id}`, key), kvs.set(`id:${key}`, issue.id)]);
      } catch (e) { console.warn(`Id for ${key} not found: ${e.message}`); }
    }
    const item = desk.byId.get(plan.item);
    // The status is rewritten whenever it moved, including to "unknown" or "gone".
    const status = statusOf(plan, item, desk, trusted);
    if (JSON.stringify(status) !== JSON.stringify(published)) await publishStatus(key, plan, loaded);
    // Comments only come from data the site chose and that is recent.
    if (!trusted || !item) continue;
    const r = readiness(plan, item, desk);
    const failing = r.checks.filter((c) => c.state === 'fail').map((c) => c.id).sort().join(',');
    const liveFailing = !!failing && live.has(key);
    const moved = failing !== (last?.failing ?? plan.lastFailing ?? '');
    if (moved || (liveFailing && !last?.live)) {
      const text = failing
        ? r.checks.filter((c) => c.state === 'fail').map((c) => `${c.label}: ${c.evidence}`).join('\n')
        : 'Every published check now matches the plan.';
      const heading = liveFailing ? 'Live, but the checks no longer pass' : failing ? 'Go-live check: published information does not match this change' : 'Go-live check passed';
      try { await addComment(key, heading, text, 'app', failing ? neededRoles(plan) : []); } catch (e) { console.warn(`Comment on ${key} failed: ${e.message}`); continue; }
      await kvs.set(`check:${key}`, { failing, live: liveFailing, at: new Date().toISOString() });
    } else if (!!last?.live !== liveFailing && last) await kvs.set(`check:${key}`, { ...last, live: liveFailing });
    results.push({ key, state: r.state });
  }
  return results;
}
