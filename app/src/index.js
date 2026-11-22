// Backend for Detour Check: resolvers for the page and the issue panel, actions for the Rovo agent
// and its MCP server, and the hourly go-live check. Every entry point checks its own inputs.
import Resolver from '@forge/resolver';
import { kvs } from '@forge/kvs';
import {
  ITEM, ISSUE_KEY, need, getSettings, saveSettings, setupStatus, setUp, currentDesk, changeRequests, changeRequestView,
  readiness, lowered, lowering, createChangeRequest, savePlan, signOff, checkAll, getPlan, addComment, publishStatus, forgetIssue, goLiveCheck, MARKED,
} from './desk.js';
import { summary, detail, outlook, IMPACTS } from './model.js';

const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
// Pages send the sign-off state they want ("signed"); older pages sent "undo".
const wantsUndo = (payload) => (typeof payload?.signed === 'boolean' ? !payload.signed : !!payload?.undo);

// The desk list: every disruption with its change request, if any, and where it stands.
async function deskList() {
  const loaded = await currentDesk();
  const { settings, desk } = loaded;
  const crs = await changeRequests();
  const items = [];
  // Every plan on the desk is read at once rather than one after another, and plans opened before
  // the panel had its current display condition get the marker once.
  const onDesk = Object.entries(crs).filter(([id]) => desk.byId.has(id));
  const plans = new Map(await Promise.all(onDesk.map(async ([id, cr]) => [id, await getPlan(cr.key)])));
  // The marker is only counted as written when the desk could vouch for the status it carries.
  await Promise.all(onDesk.filter(([id, cr]) => cr.marked !== MARKED && plans.get(id)).map(async ([id, cr]) => {
    const status = await publishStatus(cr.key, plans.get(id), loaded);
    if (status && status.status !== 'unknown') await kvs.set(`cr:${id}`, { ...cr, marked: MARKED });
  }));
  for (const item of desk.items) {
    const cr = crs[item.id];
    let state = null;
    let plan = null;
    let r = null;
    if (cr) {
      plan = plans.get(item.id);
      if (plan) { r = readiness(plan, item, desk); state = { state: r.state, failing: r.failing, pending: r.pending, signed: r.signed, roles: r.roles, ready: r.ready, impact: plan.impact }; }
    }
    items.push({ ...summary(item, desk), outlook: outlook(item, desk, plan, r), changeRequest: cr ? { key: cr.key, ...state } : null });
  }
  // Problems first, then what needs checking, then what is covered; sooner first within each.
  const rank = { red: 0, amber: 1, green: 2 };
  items.sort((a, b) => rank[a.outlook.light] - rank[b.outlook.light] || a.starts.localeCompare(b.starts));
  return { settings, now: desk.now, today: desk.today, takenAt: desk.takenAt, mode: desk.mode, liveLoading: !!desk.liveLoading, liveError: desk.liveError || null, items };
}

// ---------- resolvers for the page and the issue panel ----------

const resolver = new Resolver();

// Logs how long each call from the page takes.
const timed = (name, fn) => async (req) => {
  const t0 = Date.now();
  try { return await fn(req); } finally { console.log(`timing ${name} ${Date.now() - t0}ms`); }
};

resolver.define('getDesk', timed('getDesk', async () => deskList()));

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


resolver.define('getItem', timed('getItem', async ({ payload }) => itemView(str(payload?.id, 40), { slim: !!payload?.slim })));

// The card's first step. Answering opens the plan in Jira if there is none yet, so nobody has to
// "create a change request" before they can say what the works mean.
resolver.define('answer', timed('answer', async ({ payload, context }) => {
  const id = str(payload?.id, 40);
  const impact = str(payload?.impact, 20);
  need(IMPACTS[impact], 'Unknown answer');
  // The desk and the plan are read once and handed along, since each read is a round trip.
  const reason = str(payload?.reason, 500);
  const loaded = await currentDesk();
  // A first answer that lowers the impact is checked before any work item is opened.
  const why = (await kvs.get(`cr:${id}`)) ? null : lowering({ impact, directions: 'both' }, reason, context.accountId);
  const cr = await createChangeRequest(id, context.accountId, { impact, ...(why ? { lowered: why } : {}) }, loaded);
  const plan = cr.created ? cr.plan : await savePlan(cr.key, { impact, reason, by: context.accountId }, loaded);
  return itemView(id, { slim: true, desk: loaded.desk, key: cr.key, plan });
}));

resolver.define('tick', timed('tick', async ({ payload, context }) => {
  const id = str(payload?.id, 40);
  need(ITEM.test(id), 'Unknown disruption');
  const [cr, loaded] = await Promise.all([kvs.get(`cr:${id}`), currentDesk()]);
  need(cr, 'Answer whether buses can get through first');
  const plan = await signOff(cr.key, str(payload?.role, 20), context.accountId, wantsUndo(payload), loaded);
  return itemView(id, { slim: true, desk: loaded.desk, key: cr.key, plan });
}));

resolver.define('saveSettings', async ({ payload }) => saveSettings({ mode: payload?.mode, project: payload?.project }));
resolver.define('getSettings', async () => getSettings());
resolver.define('getSetup', timed('getSetup', async () => setupStatus()));
resolver.define('setUp', timed('setUp', async ({ payload }) => setUp({ project: payload?.project ? str(payload.project, 20) : null, create: payload?.create === true })));

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
  await savePlan(panelKey(context), { impact: payload?.impact, directions: payload?.directions, ends: payload?.ends, reason: payload?.reason ? str(payload.reason, 500) : undefined, by: context.accountId });
  const { desk } = await currentDesk();
  return changeRequestView(panelKey(context), desk);
});

resolver.define('signOff', timed('signOff', async ({ payload, context }) => {
  const plan = await signOff(panelKey(context), str(payload?.role, 20), context.accountId, wantsUndo(payload));
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
    key, impact: view.impactLabel, state: r.state, readyToGoLive: r.ready, ...(r.blocker ? { stillNeeded: r.blocker } : {}),
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
  // An agent can raise a plan's impact but never lower it: that takes a person and a reason.
  need(!impact || !lowered({ impact }), `An agent cannot set "${IMPACTS[impact] || impact}". A person sets it on the change request, with a reason, and someone else signs off for Operations.`);
  if (impact || notice) await savePlan(key, { ...(impact ? { impact } : {}), notice: !!notice });
  if (assessment) await addComment(key, 'Impact assessment (drafted by Rovo, check before approving)', assessment);
  if (notice) await addComment(key, 'Draft passenger notice (drafted by Rovo, for Passenger information to approve)', notice);
  return { key, recorded: { impact: impact ? IMPACTS[impact] : 'unchanged', assessment: !!assessment, passengerNotice: !!notice } };
}

// ---------- scheduled ----------

// The "Detour Check is ready" workflow validator. Jira passes the work item moving through the
// transition; the answer comes from storage and the published data, never from the work item.
export async function goLive(event) {
  try { return await goLiveCheck(str(event?.issue?.key, 40), str(event?.issue?.id, 20)); } catch (e) {
    console.error(`Go-live validator failed: ${e.message}`);
    return { result: false, errorMessage: 'Detour Check could not check this change. Try again in a moment.' };
  }
}

// Jira's "issue deleted" event: the plan goes too, so the roadworks can be planned again.
export async function issueDeleted(event) {
  if (await forgetIssue(str(event?.issue?.key, 40))) console.log(`Plan for ${event.issue.key} removed with its work item`);
}

export async function hourly() {
  const results = await checkAll();
  console.log(`Go-live check: ${results.length} change requests`);
}
