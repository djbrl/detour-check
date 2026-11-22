// Backend for the Change Desk: resolvers for the page and the issue panel, actions for the Rovo agent
// and its MCP server, and the hourly go-live check. Every entry point checks its own inputs.
import Resolver from '@forge/resolver';
import { kvs } from '@forge/kvs';
import {
  ITEM, ISSUE_KEY, need, getSettings, saveSettings, currentDesk, changeRequests, changeRequestView,
  readiness, createChangeRequest, savePlan, signOff, addComment, checkAll, getPlan,
} from './desk.js';
import { summary, detail, IMPACTS } from './model.js';

const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);

// The desk list: every disruption with its change request, if any, and where it stands.
async function deskList() {
  const { settings, desk } = await currentDesk();
  const crs = await changeRequests();
  const items = [];
  for (const item of desk.items) {
    const cr = crs[item.id];
    let state = null;
    if (cr) {
      const plan = await getPlan(cr.key);
      if (plan) { const r = readiness(plan, item, desk); state = { state: r.state, failing: r.failing, pending: r.pending, signed: r.signed, roles: r.roles, ready: r.ready, impact: plan.impact }; }
    }
    items.push({ ...summary(item, desk), changeRequest: cr ? { key: cr.key, ...state } : null });
  }
  return { settings, now: desk.now, today: desk.today, takenAt: desk.takenAt, mode: desk.mode, items };
}

// ---------- resolvers for the page and the issue panel ----------

const resolver = new Resolver();

resolver.define('getDesk', async () => deskList());

resolver.define('getItem', async ({ payload }) => {
  const id = str(payload?.id, 40);
  need(ITEM.test(id), 'Unknown disruption');
  const { desk } = await currentDesk();
  const item = desk.byId.get(id);
  need(item, 'That disruption is no longer on the desk');
  const cr = await kvs.get(`cr:${id}`);
  return { ...detail(item, desk), changeRequest: cr ? await changeRequestView(cr.key, desk) : null };
});

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

resolver.define('signOff', async ({ payload, context }) => {
  await signOff(panelKey(context), str(payload?.role, 20), context.accountId, !!payload?.undo);
  const { desk } = await currentDesk();
  return changeRequestView(panelKey(context), desk);
});

export const handler = resolver.getDefinitions();

// ---------- Rovo actions (also served over MCP) ----------
// Inputs come from a model, so each one is validated, and limits stay in code.

const contextKey = (payload) => str(payload?.context?.jira?.issueKey, 40);

export async function listDisruptions(payload) {
  const list = await deskList();
  const status = str(payload?.status, 20).toLowerCase();
  const line = str(payload?.line, 10).toUpperCase();
  let items = list.items;
  if (status === 'upcoming' || status === 'in-force') items = items.filter((i) => i.status === status);
  if (status === 'no-change-request') items = items.filter((i) => !i.changeRequest);
  if (status === 'failing') items = items.filter((i) => i.changeRequest?.state === 'failing');
  if (line) items = items.filter((i) => i.lines.some((l) => l.short.toUpperCase() === line));
  return {
    data: list.mode === 'demo' ? `Frozen demo day, as published on ${list.takenAt}` : 'Live Bordeaux open data',
    today: list.today,
    count: items.length,
    disruptions: items.slice(0, 40).map((i) => ({
      id: i.id, title: i.title, what: i.what, status: i.status, starts: i.startsLabel, ends: i.endsLabel,
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
    need(view, `${id} is not a change request from the Change Desk`);
    return view;
  }
  need(ITEM.test(id), 'Give a disruption id like works-199167, or a change request key');
  const item = desk.byId.get(id);
  need(item, 'That disruption is not on the desk');
  const { geo, lineGeo, diversions, ...rest } = detail(item, desk);
  const cr = await kvs.get(`cr:${id}`);
  return { ...rest, publishedDiversionsNearby: diversions.map(({ geo: g, ...d }) => d), changeRequest: cr?.key || null };
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
  need(view, `${key} is not a change request from the Change Desk`);
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
  const impact = str(payload?.impact, 20);
  if (impact) await savePlan(key, { impact });
  const assessment = str(payload?.assessment, 3000);
  const notice = str(payload?.passengerNotice, 3000);
  need(impact || assessment || notice, 'Nothing to record');
  if (assessment) await addComment(key, 'Impact assessment (drafted by Rovo, check before approving)', assessment);
  if (notice) await addComment(key, 'Draft passenger notice (drafted by Rovo, for Passenger information to approve)', notice);
  return { key, recorded: { impact: impact ? IMPACTS[impact] : 'unchanged', assessment: !!assessment, passengerNotice: !!notice } };
}

// ---------- scheduled ----------

export async function hourly() {
  const results = await checkAll();
  console.log(`Go-live check: ${results.length} change requests`);
}
