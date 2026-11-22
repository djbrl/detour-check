// Backend for Detour Check: resolvers for the page and the issue panel, actions for the Rovo agent
// and its MCP server, and the hourly go-live check. Every entry point checks its own inputs.
import Resolver from '@forge/resolver';
import { kvs } from '@forge/kvs';
import {
  ITEM, ISSUE_KEY, need, getSettings, saveSettings, currentDesk, changeRequests, changeRequestView,
  readiness, createChangeRequest, savePlan, signOff, checkAll, getPlan, markIssue,
} from './desk.js';
import { summary, detail, outlook, IMPACTS } from './model.js';

const MARK = 'detour-check';
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);

// The desk list: every disruption with its change request, if any, and where it stands.
async function deskList() {
  const { settings, desk } = await currentDesk();
  const crs = await changeRequests();
  const items = [];
  for (const item of desk.items) {
    const cr = crs[item.id];
    // Plans opened before the panel had its current display condition get the marker once.
    if (cr && cr.marked !== MARK && await markIssue(cr.key)) await kvs.set(`cr:${item.id}`, { ...cr, marked: MARK });
    let state = null;
    let plan = null;
    let r = null;
    if (cr) {
      plan = await getPlan(cr.key);
      if (plan) { r = readiness(plan, item, desk); state = { state: r.state, failing: r.failing, pending: r.pending, signed: r.signed, roles: r.roles, ready: r.ready, impact: plan.impact }; }
    }
    items.push({ ...summary(item, desk), outlook: outlook(item, desk, plan, r), changeRequest: cr ? { key: cr.key, ...state } : null });
  }
  // Problems first, then what needs checking, then what is covered; sooner first within each.
  const rank = { red: 0, amber: 1, green: 2 };
  items.sort((a, b) => rank[a.outlook.light] - rank[b.outlook.light] || a.starts.localeCompare(b.starts));
  return { settings, now: desk.now, today: desk.today, takenAt: desk.takenAt, mode: desk.mode, items };
}

// ---------- resolvers for the page and the issue panel ----------

const resolver = new Resolver();

resolver.define('getDesk', async () => deskList());

// One disruption as the desk's card shows it. After an answer or a sign-off the card already has
// the map, so only what changed goes back.
async function itemView(id, { slim = false, desk = null, key = null, plan = null } = {}) {
  need(ITEM.test(id), 'Unknown disruption');
  desk ||= (await currentDesk()).desk;
  const item = desk.byId.get(id);
  need(item, 'That disruption is no longer on the desk');
  key ||= (await kvs.get(`cr:${id}`))?.key;
  const view = key ? await changeRequestView(key, desk, { full: false, plan }) : null;
  return { ...(slim ? { id } : detail(item, desk)), outlook: view?.outlook || outlook(item, desk), changeRequest: view };
}

// Logs how long each call from the page takes, next to the Jira calls inside it.
const timed = (name, fn) => async (req) => {
  const t0 = Date.now();
  try { return await fn(req); } finally { console.log(`timing ${name} ${Date.now() - t0}ms`); }
};

resolver.define('getItem', async ({ payload }) => itemView(str(payload?.id, 40)));

// The card's first step. Answering opens the plan in Jira if there is none yet, so nobody has to
// "create a change request" before they can say what the works mean.
resolver.define('answer', timed('answer', async ({ payload, context }) => {
  const id = str(payload?.id, 40);
  const impact = str(payload?.impact, 20);
  need(IMPACTS[impact], 'Unknown answer');
  // The desk and the plan are read once and handed along, since each read is a round trip.
  const loaded = await currentDesk();
  const cr = await createChangeRequest(id, context.accountId, { impact }, loaded);
  const plan = cr.created ? cr.plan : await savePlan(cr.key, { impact });
  return itemView(id, { slim: true, desk: loaded.desk, key: cr.key, plan });
}));

resolver.define('tick', timed('tick', async ({ payload, context }) => {
  const id = str(payload?.id, 40);
  need(ITEM.test(id), 'Unknown disruption');
  const cr = await kvs.get(`cr:${id}`);
  need(cr, 'Answer whether buses can get through first');
  const plan = await signOff(cr.key, str(payload?.role, 20), context.accountId, !!payload?.undo);
  return itemView(id, { slim: true, key: cr.key, plan });
}));

resolver.define('saveSettings', async ({ payload }) => saveSettings({ mode: payload?.mode, project: payload?.project }));
resolver.define('getSettings', async () => getSettings());

resolver.define('createChangeRequest', async ({ payload, context }) => createChangeRequest(str(payload?.id, 40), context.accountId));

// The issue panel reads its work item from the platform context, never from the page.
const panelKey = (context) => str(context?.extension?.issue?.key, 40);

resolver.define('getPanel', async ({ context }) => {
  const key = panelKey(context);
  need(ISSUE_KEY.test(key), 'Open this panel on a work item');
  const { desk } = await currentDesk();
  return { key, mode: desk.mode, now: desk.now, changeRequest: await changeRequestView(key, desk) };
});

resolver.define('savePlan', async ({ payload, context }) => {
  await savePlan(panelKey(context), { impact: payload?.impact, directions: payload?.directions, ends: payload?.ends });
  const { desk } = await currentDesk();
  return changeRequestView(panelKey(context), desk);
});

resolver.define('signOff', timed('signOff', async ({ payload, context }) => {
  const plan = await signOff(panelKey(context), str(payload?.role, 20), context.accountId, !!payload?.undo);
  const { desk } = await currentDesk();
  return changeRequestView(panelKey(context), desk, { plan });
}));

export const handler = resolver.getDefinitions();

// ---------- Rovo actions (also served over MCP) ----------
// Inputs come from a model, so each one is validated, and limits stay in code.

const contextKey = (payload) => str(payload?.context?.jira?.issueKey, 40);

// Map geometry means nothing to a model and costs tokens, so Rovo gets the view without it.
function forModel(view) {
  if (!view?.disruption) return view;
  const { geo, lineGeo, diversions, ...d } = view.disruption;
  const { timeline, ...o } = view.outlook || {};
  return { ...view, outlook: o, disruption: { ...d, publishedDetours: diversions.map(({ geo: g, ...x }) => x) } };
}

export async function listDisruptions(payload) {
  const list = await deskList();
  const status = str(payload?.status, 20).toLowerCase();
  const line = str(payload?.line, 10).toUpperCase();
  let items = list.items;
  if (status === 'upcoming' || status === 'in-force') items = items.filter((i) => i.status === status);
  if (status === 'no-change-request') items = items.filter((i) => !i.changeRequest);
  if (status === 'failing') items = items.filter((i) => i.changeRequest?.state === 'failing');
  if (status === 'problem') items = items.filter((i) => i.outlook.light === 'red');
  if (line) items = items.filter((i) => i.lines.some((l) => l.short.toUpperCase() === line));
  return {
    data: list.mode === 'demo' ? `Frozen demo day, as published on ${list.takenAt}` : 'Live Bordeaux open data',
    today: list.today,
    count: items.length,
    disruptions: items.slice(0, 40).map((i) => ({
      id: i.id, title: i.title, what: i.what, status: i.status, starts: i.startsLabel, ends: i.endsLabel,
      light: i.outlook.label, summary: i.outlook.story, problem: i.outlook.problem, nextStep: i.outlook.next,
      lines: i.lines.map((l) => `${l.mode === 'TRAM' ? 'Tram' : 'Bus'} ${l.short}`),
      changeRequest: i.changeRequest ? `${i.changeRequest.key} (${i.changeRequest.state}, ${i.changeRequest.signed}/${i.changeRequest.roles} signed off)` : 'none',
    })),
  };
}

export async function getDisruption(payload) {
  const { desk } = await currentDesk();
  let id = str(payload?.disruption, 40) || contextKey(payload);
  if (ISSUE_KEY.test(id)) {
    const view = await changeRequestView(id, desk);
    need(view, `${id} is not a plan from Detour Check`);
    return forModel(view);
  }
  need(ITEM.test(id), 'Give a disruption id like works-199167, or a change request key');
  const item = desk.byId.get(id);
  need(item, 'That disruption is not on the desk');
  const { geo, lineGeo, diversions, ...rest } = detail(item, desk);
  const cr = await kvs.get(`cr:${id}`);
  const { timeline, ...o } = outlook(item, desk);
  return { ...rest, outlook: o, publishedDetours: diversions.map(({ geo: g, ...d }) => d), changeRequest: cr?.key || null };
}

export async function createChangeRequestAction(payload, context) {
  const id = str(payload?.disruption, 40);
  const cr = await createChangeRequest(id, context?.principal?.accountId || payload?.context?.accountId);
  return { key: cr.key, created: cr.created, note: cr.created ? 'Change request created in Jira.' : 'This disruption already had a change request.' };
}

export async function checkChangeRequest(payload) {
  const key = str(payload?.changeRequest, 40) || contextKey(payload);
  need(ISSUE_KEY.test(key), 'Give a change request key like NET-12');
  const { desk } = await currentDesk();
  const view = await changeRequestView(key, desk);
  need(view, `${key} is not a plan from Detour Check`);
  const r = view.readiness;
  return {
    key, impact: view.impactLabel, state: r.state, readyToGoLive: r.ready,
    signOffs: view.signoffs.map((s) => `${s.label}: ${s.at ? 'signed' : 'waiting'}`),
    checks: r.checks.map((c) => ({ check: c.label, result: c.state, evidence: c.evidence })),
  };
}

export async function recordAssessment(payload) {
  const key = str(payload?.changeRequest, 40) || contextKey(payload);
  need(ISSUE_KEY.test(key), 'Give a change request key like NET-12');
  // Only plans Detour Check opened take comments from here, never any work item a model names.
  need(await getPlan(key), `${key} is not a plan from Detour Check`);
  const impact = str(payload?.impact, 20);
  const assessment = str(payload?.assessment, 3000);
  const notice = str(payload?.passengerNotice, 3000);
  need(impact || assessment || notice, 'Nothing to record');
  if (impact || notice) await savePlan(key, { ...(impact ? { impact } : {}), notice: !!notice });
  if (assessment) await addComment(key, 'Impact assessment (drafted by Rovo, check before approving)', assessment);
  if (notice) await addComment(key, 'Draft passenger notice (drafted by Rovo, for Passenger information to approve)', notice);
  return { key, recorded: { impact: impact ? IMPACTS[impact] : 'unchanged', assessment: !!assessment, passengerNotice: !!notice } };
}

// ---------- scheduled ----------

export async function hourly() {
  const results = await checkAll();
  console.log(`Go-live check: ${results.length} change requests`);
}
