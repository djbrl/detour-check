// Backend for Detour Check: resolvers for the page and the issue panel, actions for the Rovo agent
// and its MCP server, and the hourly go-live check. Every entry point checks its own inputs.
import Resolver from '@forge/resolver';
import { kvs } from '@forge/kvs';
import {
  ITEM, ISSUE_KEY, need, getSettings, saveSettings, setupStatus, gateStatus, setUp, currentDesk, changeRequests, changeRequestView,
  readiness, lowered, lowering, createChangeRequest, savePlan, signOff, checkAll, getPlan, addComment, publishStatus, forgetIssue, goLiveCheck, MARKED,
  liveKeys, liveNow, liveOutlook,
} from './desk.js';
import { summary, detail, outlook, coverage, lineInfo, IMPACTS, LIGHTS, dayLabel, worksWeight, daysWithoutDetour } from './model.js';

const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
// Pages send the sign-off state they want ("signed"); older pages sent "undo".
const wantsUndo = (payload) => (typeof payload?.signed === 'boolean' ? !payload.signed : !!payload?.undo);

// The desk list: every disruption with its change request, if any, and where it stands.
async function deskList() {
  // The desk, the plans and which work items are live are three round trips, asked at once.
  const [loaded, crs, live] = await Promise.all([currentDesk(), changeRequests(), liveKeys()]);
  const { settings, desk } = loaded;
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
      if (plan) { r = readiness(plan, item, desk); state = { state: r.state, failing: r.failing, pending: r.pending, signed: r.signed, roles: r.roles, ready: r.ready, impact: plan.impact, live: live.has(cr.key), liveFailing: live.has(cr.key) && r.failing > 0 }; }
    }
    items.push({ ...summary(item, desk), outlook: liveOutlook(outlook(item, desk, plan, r), !!state?.liveFailing), changeRequest: cr ? { key: cr.key, ...state } : null });
  }
  // Problems first, then what needs checking (works in the roadway before kerbside works, then works
  // already under way), then what is covered; sooner first within each.
  const rank = { red: 0, amber: 1, green: 2 };
  const weight = (i) => (i.outlook.light === 'amber' ? worksWeight(i.what) : 0);
  items.sort((a, b) => rank[a.outlook.light] - rank[b.outlook.light] || weight(a) - weight(b) || !!b.outlook.underway - !!a.outlook.underway || a.starts.localeCompare(b.starts));
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
  if (!desk || !key) {
    const [loaded, cr] = await Promise.all([desk ? null : currentDesk(), key ? null : kvs.get(`cr:${id}`)]);
    desk ||= loaded.desk;
    key ||= cr?.key;
  }
  const item = desk.byId.get(id);
  need(item, 'That disruption is no longer on the desk');
  const [view, live] = key ? await Promise.all([changeRequestView(key, desk, { full: false, plan }), liveNow(key)]) : [null, false];
  if (view && live) Object.assign(view, { live, liveFailing: view.readiness.failing > 0, outlook: liveOutlook(view.outlook, view.readiness.failing > 0) });
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
  const [loaded, existing] = await Promise.all([currentDesk(), kvs.get(`cr:${id}`)]);
  // A first answer that lowers the impact is checked before any work item is opened.
  const why = existing ? null : lowering({ impact, directions: 'both' }, reason, context.accountId);
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
resolver.define('getSetup', timed('getSetup', async () => setupStatus({ cachedGate: true })));
resolver.define('getGate', timed('getGate', async () => gateStatus()));
resolver.define('setUp', timed('setUp', async ({ payload }) => setUp({ project: payload?.project ? str(payload.project, 20) : null, create: payload?.create === true })));

resolver.define('createChangeRequest', async ({ payload, context }) => createChangeRequest(str(payload?.id, 40), context.accountId));

// The issue panel reads its work item from the platform context, never from the page.
const panelKey = (context) => str(context?.extension?.issue?.key, 40);

// The desk, the plan and the work item's status are read at once: each is a round trip.
resolver.define('getPanel', timed('getPanel', async ({ context }) => {
  const key = panelKey(context);
  need(ISSUE_KEY.test(key), 'Open this panel on a work item');
  const [{ desk }, plan, live] = await Promise.all([currentDesk(), getPlan(key), liveNow(key)]);
  return { key, mode: desk.mode, now: desk.now, changeRequest: plan ? await changeRequestView(key, desk, { plan, live }) : null };
}));

resolver.define('savePlan', timed('savePlan', async ({ payload, context }) => {
  const key = panelKey(context);
  const [loaded, live] = await Promise.all([currentDesk(), liveNow(key)]);
  const plan = await savePlan(key, { impact: payload?.impact, directions: payload?.directions, ends: payload?.ends, reason: payload?.reason ? str(payload.reason, 500) : undefined, by: context.accountId }, loaded);
  return changeRequestView(key, loaded.desk, { plan, live });
}));

resolver.define('signOff', timed('signOff', async ({ payload, context }) => {
  const key = panelKey(context);
  const [loaded, live] = await Promise.all([currentDesk(), liveNow(key)]);
  const plan = await signOff(key, str(payload?.role, 20), context.accountId, wantsUndo(payload), loaded);
  return changeRequestView(key, loaded.desk, { plan, live });
}));

export const handler = resolver.getDefinitions();

// ---------- Rovo actions (also served over MCP) ----------
// Inputs come from a model, so each one is validated, and limits stay in code.

const contextKey = (payload) => str(payload?.context?.jira?.issueKey, 40);

// What a model reads is what a person would say: streets, line numbers, team names and dates as
// labels, never map geometry, enum values or account ids. Each roadworks site keeps a `ref` only so
// the next action can name it; the prompt keeps refs out of replies.
const LINE = (l) => (l ? `${l.mode === 'TRAM' ? 'Tram' : 'Bus'} ${l.short}` : null);
const STATE = { 'not-assessed': 'Not answered yet', 'no-impact': 'No effect on buses, waiting for Operations', failing: 'Checks fail', pending: 'Checks not due yet', ready: 'Checks pass', 'not-found': 'Roadworks no longer published' };
const unique = (xs) => [...new Set(xs.filter(Boolean))];

function planForModel(view, now) {
  const r = view.readiness;
  const oneWay = view.directions === 'one' && (view.impact === 'closed' || view.impact === 'stops');
  return {
    key: view.key,
    impact: `${view.impactLabel}${oneWay ? ', one way only' : ''}`,
    worksUntil: view.endsLabel,
    status: r.ready ? 'Ready to go live' : STATE[r.state] || 'Not answered yet',
    liveInJira: !!view.live,
    ...(view.liveFailing ? { warning: 'Live in Jira, but the checks no longer pass' } : view.live ? { live: 'Live in Jira' } : {}),
    readyToGoLive: r.ready,
    ...(r.blocker ? { stillNeeded: r.blocker } : {}),
    signOffs: view.signoffs.map((s) => `${s.label}: ${s.at ? 'signed off' : 'waiting'}`),
    checks: r.checks.map((c) => ({ check: c.label, result: c.state === 'pass' ? 'Passes' : c.state === 'fail' ? 'Fails' : `Due ${dayLabel(c.due, now)}`, evidence: c.evidence })),
    passengerNotice: view.notice ? 'Drafted' : 'Not drafted yet',
    ...(view.lowered ? { reasonForLowerImpact: view.lowered.reason } : {}),
  };
}

// One roadworks site in full. The detour dates are given per line, so a passenger notice promises
// each detour only as far as it is published.
function siteForModel(item, desk, view = null) {
  const now = desk.now;
  const d = detail(item, desk);
  const o = view?.outlook || outlook(item, desk);
  const ends = view?.ends || item.ends;
  const { buses, span } = coverage(item, desk);
  return {
    ref: item.id,
    place: d.title,
    // Facts the model would otherwise guess: whether the change is live, and what was answered.
    liveInJira: !!view?.live,
    impact: view?.impact ? view.impactLabel : 'Not answered yet',
    works: d.what,
    status: d.status === 'in-force' ? 'In force' : 'Not started yet',
    starts: d.startsLabel,
    ends: d.endsLabel,
    lines: d.lines.map(LINE),
    stopsNearby: unique(d.stops.map((s) => s.name)).slice(0, 12),
    light: LIGHTS[o.light], label: o.label, summary: o.story, problem: o.problem, alsoWrong: o.more, nextStep: o.next,
    daysWithoutDetour: daysWithoutDetour(o, item, desk.today, view?.impact),
    worksUntil: dayLabel(ends, now),
    detourByLine: buses.map((id) => {
      const s = span.get(id);
      const line = LINE(lineInfo(id));
      return s ? { line, from: dayLabel(s.start, now), until: dayLabel(s.until, now), endsBeforeTheWorks: !!ends && s.until < ends } : { line, detour: 'None published' };
    }),
    publishedDetours: d.diversions.map((v) => ({ name: v.title, lines: v.lines.map(LINE), direction: v.direction, from: dayLabel(v.starts, now), until: v.endsLabel, leavesAt: v.leaves?.name || null, rejoinsAt: v.rejoins?.name || null })),
    messagesAtStops: d.messages.filter((m) => m.line && m.messages.length).map((m) => ({ line: LINE(m.line), messages: m.messages.map((x) => x.text) })),
    changeRequest: view ? planForModel(view, now) : 'None yet',
  };
}

// A street from the user's words finds the roadworks on it: every site whose address contains the
// words, or whose street the words name. Accents and punctuation do not matter.
const plain = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function sitesNamed(desk, text) {
  const q = plain(text);
  if (q.length < 4) return [];
  return desk.items.filter((i) => {
    const street = plain(i.title.replace(/,[^,]*$/, ''));
    return plain(i.title).includes(q) || (street.length >= 6 && q.includes(street));
  });
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
    data: list.mode === 'demo' ? `Frozen demo day, as published on ${dayLabel(list.takenAt, list.now)}` : 'Live Bordeaux open data',
    today: dayLabel(list.today, list.now),
    count: items.length,
    disruptions: items.slice(0, 40).map((i) => {
      const cr = i.changeRequest;
      return {
        ref: i.id, place: i.title, works: i.what, status: i.status === 'in-force' ? 'In force' : 'Not started yet', starts: i.startsLabel, ends: i.endsLabel,
        light: LIGHTS[i.outlook.light], label: i.outlook.label, summary: i.outlook.story, problem: i.outlook.problem, nextStep: i.outlook.next,
        daysWithoutDetour: daysWithoutDetour(i.outlook, i, list.today, cr?.impact),
        liveInJira: !!cr?.live,
        impact: cr?.impact ? IMPACTS[cr.impact] : 'Not answered yet',
        lines: i.lines.map(LINE),
        changeRequest: !cr ? 'None yet' : `${cr.key}: ${cr.ready ? 'ready to go live' : (STATE[cr.state] || 'not answered yet').toLowerCase()}, ${cr.signed ?? 0} of ${cr.roles ?? 4} teams signed off${cr.liveFailing ? '. Live in Jira, but the checks no longer pass' : ''}`,
      };
    }),
  };
}

export async function getDisruption(payload) {
  const { desk } = await currentDesk();
  const asked = str(payload?.disruption, 100) || contextKey(payload);
  if (ISSUE_KEY.test(asked)) {
    const [plan, live] = await Promise.all([getPlan(asked), liveNow(asked)]);
    need(plan, `${asked} is not a plan from Detour Check`);
    const view = await changeRequestView(asked, desk, { plan, live, full: false });
    const item = desk.byId.get(view.item);
    return item ? siteForModel(item, desk, view) : { changeRequest: planForModel(view, desk.now), note: 'These roadworks are no longer in the published data.' };
  }
  let item = ITEM.test(asked) ? desk.byId.get(asked) : null;
  if (!item) {
    need(!ITEM.test(asked), 'That roadworks site is not on the desk');
    const found = sitesNamed(desk, asked);
    need(found.length, `No roadworks on a bus route match "${asked.slice(0, 60)}". Give a disruption id, a change request key or a street name.`);
    if (found.length > 1) {
      return {
        several: `${found.length} roadworks match. List them and ask which one before doing anything else.`,
        matches: found.slice(0, 10).map((i) => ({ ref: i.id, place: i.title, works: i.what, dates: `${dayLabel(i.starts, desk.now)} to ${dayLabel(i.ends, desk.now)}`, lines: i.lines.map((id) => LINE(lineInfo(id))) })),
      };
    }
    [item] = found;
  }
  const cr = await kvs.get(`cr:${item.id}`);
  const [plan, live] = cr ? await Promise.all([getPlan(cr.key), liveNow(cr.key)]) : [null, false];
  const view = plan ? await changeRequestView(cr.key, desk, { plan, live, full: false }) : null;
  return siteForModel(item, desk, view);
}

export async function createChangeRequestAction(payload, context) {
  const id = str(payload?.disruption, 40);
  const cr = await createChangeRequest(id, context?.principal?.accountId || payload?.context?.accountId);
  return { key: cr.key, created: cr.created, note: cr.created ? 'Change request created in Jira.' : 'This disruption already had a change request.' };
}

export async function checkChangeRequest(payload) {
  const key = str(payload?.changeRequest, 40) || contextKey(payload);
  need(ISSUE_KEY.test(key), 'Give a change request key like ROAD-1');
  const [{ desk }, plan, live] = await Promise.all([currentDesk(), getPlan(key), liveNow(key)]);
  need(plan, `${key} is not a plan from Detour Check`);
  return planForModel(await changeRequestView(key, desk, { plan, live, full: false }), desk.now);
}

// A notice may only announce a detour that is published. "Pas de déviation" and "no detour" say
// the opposite, so they are taken out before looking.
const NO_DETOUR = /\b(no|without|pas de|aucune?|sans)\s+(déviations?|detours?|diversions?)\b/g;
const announcesDetour = (text) => /dévi|divert|diversion|detour/.test(text.normalize('NFC').toLowerCase().replace(NO_DETOUR, ''));

// Who drafted it, as far as the call says: Rovo names the agent module, an MCP client the MCP one.
// Anything else is just "an agent", never a guess.
function drafter(payload) {
  const module = str(payload?.context?.moduleKey, 100);
  if (module === 'detour-check-agent') return 'Rovo';
  if (module === 'detour-check-mcp') return 'an agent over MCP';
  return 'an agent';
}

export async function recordAssessment(payload) {
  const key = str(payload?.changeRequest, 40) || contextKey(payload);
  need(ISSUE_KEY.test(key), 'Give a change request key like ROAD-1');
  // Only plans Detour Check opened take comments from here, never any work item a model names.
  const plan = await getPlan(key);
  need(plan, `${key} is not a plan from Detour Check`);
  const impact = str(payload?.impact, 20);
  const assessment = str(payload?.assessment, 3000);
  const notice = str(payload?.passengerNotice, 3000);
  need(impact || assessment || notice, 'Nothing to record');
  // An agent can raise a plan's impact but never lower it: that takes a person and a reason.
  need(!impact || !lowered({ impact }), `An agent cannot set "${IMPACTS[impact] || impact}". A person sets it on the change request, with a reason, and someone else signs off for Operations.`);
  // An agent answers the impact only while nobody has. Changing an answer is a person's call.
  need(!impact || !plan.impact || impact === plan.impact, `The impact is already "${IMPACTS[plan.impact]}". A person changes it on the change request. Record the assessment and notice without an impact.`);
  if (notice && announcesDetour(notice)) {
    const { desk } = await currentDesk();
    const item = desk.byId.get(plan.item);
    const { buses, found } = item ? coverage(item, desk, plan) : { buses: [], found: new Map() };
    need(!item || buses.some((id) => found.get(id).length), 'The notice announces a detour, but none is published for these roadworks. Nothing was recorded. Say no detour is published yet.');
  }
  if (impact || notice) await savePlan(key, { ...(impact ? { impact } : {}), notice: !!notice });
  const by = drafter(payload);
  // Recorded together, they are one note: one thing for the teams to read and approve.
  if (assessment && notice) {
    await addComment(key, `Impact assessment and passenger notice (drafted by ${by}, check before approving)`, [['Impact assessment', assessment], ['Draft passenger notice, for Passenger information to approve', notice]]);
  } else if (assessment) await addComment(key, `Impact assessment (drafted by ${by}, check before approving)`, assessment);
  else if (notice) await addComment(key, `Draft passenger notice (drafted by ${by}, for Passenger information to approve)`, notice);
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
