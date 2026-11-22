// Stands in for the Forge backend when the page is opened outside Jira (local preview). It runs the
// same model on the frozen demo day, keeps change requests in memory, and applies the backend's rules
// (src/desk.js) so the preview behaves like Jira.
import { reviveDesk, runChecks, defaultPlan, summary, detail, outlook, lineInfo, IMPACTS, dayLabel, worksWeight } from '../../../src/model.js';
import day from '../../../src/demo-desk.json';

const desk = reviveDesk(day);
const ROLES = { ops: 'Operations', scheduling: 'Scheduling', passengers: 'Passenger information', drivers: 'Drivers' };
const state = { settings: { mode: 'demo', project: null }, crs: {}, plans: {}, n: 0 };

function readiness(plan, item) {
  const r = runChecks(plan, item, desk);
  const signed = Object.keys(ROLES).filter((k) => plan.signoffs[k]).length;
  return { ...r, signed, roles: 4, ready: r.state === 'no-impact' ? !!plan.signoffs.ops : r.state === 'ready' && signed === 4 };
}
function view(key) {
  const plan = state.plans[key];
  if (!plan) return null;
  const item = desk.byId.get(plan.item);
  const r = readiness(plan, item);
  return {
    key, item: plan.item, impact: plan.impact, impactLabel: plan.impact ? IMPACTS[plan.impact] : 'Not assessed yet',
    lines: plan.lines.map(lineInfo), starts: plan.starts, ends: plan.ends, startsLabel: dayLabel(plan.starts, desk.now), endsLabel: dayLabel(plan.ends, desk.now),
    directions: plan.directions, stops: plan.stops, notice: !!plan.notice,
    signoffs: Object.entries(ROLES).map(([role, label]) => ({ role, label, ...(plan.signoffs[role] || {}) })),
    readiness: r, outlook: outlook(item, desk, plan, r), disruption: detail(item, desk),
  };
}
const RANK = { red: 0, amber: 1, green: 2 };
const weight = (i) => (i.outlook.light === 'amber' ? worksWeight(i.what) : 0);
const need = (ok, message) => { if (!ok) throw new Error(message); };
// As in the app: road closed and stops not served are checked alike, so swapping them keeps the sign-offs.
const SAME = ['closed', 'stops'];
function setImpact(plan, impact) {
  need(IMPACTS[impact], 'Unknown answer');
  if (plan.impact !== impact && !(SAME.includes(plan.impact) && SAME.includes(impact))) plan.signoffs = {};
  plan.impact = impact;
}
const OWNS = { ops: ['diversion', 'directions', 'dates'], passengers: ['notice'] };
function sign(plan, role, undo) {
  need(ROLES[role], 'Unknown sign-off');
  need(plan.impact, 'Answer whether buses can get through first');
  const failing = undo ? [] : runChecks(plan, desk.byId.get(plan.item), desk).checks.filter((c) => c.state === 'fail' && OWNS[role]?.includes(c.id));
  need(!failing.length, `${ROLES[role]} can't sign off while ${failing.map((c) => `"${c.label}"`).join(' and ')} fails.`);
  if (undo) delete plan.signoffs[role]; else plan.signoffs[role] = { by: null, at: new Date().toISOString() };
}
// Pages send the sign-off state they want ("signed").
const wantsUndo = (p) => (typeof p.signed === 'boolean' ? !p.signed : !!p.undo);
const panelKey = () => new URLSearchParams(location.search).get('panel') || Object.keys(state.plans)[0];

const handlers = {
  getDesk: () => ({
    settings: state.settings, now: desk.now, today: desk.today, takenAt: day.takenAt, mode: 'demo',
    items: desk.items.map((item) => {
      const cr = state.crs[item.id];
      const plan = cr && state.plans[cr.key];
      const r = cr && readiness(plan, item);
      return { ...summary(item, desk), outlook: outlook(item, desk, plan, r), changeRequest: cr ? { key: cr.key, state: r.state, failing: r.failing, pending: r.pending, signed: r.signed, roles: r.roles, ready: r.ready } : null };
    }).sort((a, b) => RANK[a.outlook.light] - RANK[b.outlook.light] || weight(a) - weight(b) || !!b.outlook.underway - !!a.outlook.underway || a.starts.localeCompare(b.starts)),
  }),
  getItem: ({ id }) => { const v = state.crs[id] ? view(state.crs[id].key) : null; return { ...detail(desk.byId.get(id), desk), outlook: v?.outlook || outlook(desk.byId.get(id), desk), changeRequest: v }; },
  getSetup: () => ({ admin: true, project: state.settings.project || null, teamGroups: [], space: state.settings.project ? { found: true, name: 'Network Changes', serviceSpace: true, canCreate: true, issueType: 'Change', changeFields: ['Planned start', 'Planned end'], allFields: 9, gate: { workflow: 'Change workflow', guarded: ['Standard change', 'Emergency override', 'Approve', 'Implement'], missing: [] } } : null }),
  getGate: () => handlers.getSetup().space?.gate || null,
  setUp: (p) => { const created = !p?.project && !state.settings.project; state.settings.project = p?.project || state.settings.project || 'ROAD'; return { project: state.settings.project, created, gate: { guarded: ['Standard change'], missing: [] } }; },
  saveSettings: (p) => Object.assign(state.settings, Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined))),
  createChangeRequest: ({ id }) => {
    const key = `NET-${++state.n}`;
    state.crs[id] = { key };
    state.plans[key] = { ...defaultPlan(desk.byId.get(id)), signoffs: {} };
    return { key, created: true };
  },
  answer: ({ id, impact }) => {
    need(IMPACTS[impact], 'Unknown answer');
    need(state.settings.project, 'Choose a Jira space for change requests first');
    if (!state.crs[id]) handlers.createChangeRequest({ id });
    setImpact(state.plans[state.crs[id].key], impact);
    return handlers.getItem({ id });
  },
  tick: (p) => { need(state.crs[p.id], 'Answer whether buses can get through first'); sign(state.plans[state.crs[p.id].key], p.role, wantsUndo(p)); return handlers.getItem({ id: p.id }); },
  getPanel: () => ({ key: panelKey(), mode: 'demo', now: desk.now, changeRequest: view(panelKey()) }),
  savePlan: ({ impact, directions, ends }) => {
    const plan = state.plans[panelKey()];
    if (impact !== undefined) setImpact(plan, impact);
    // As in the app: changing what the plan is checked against clears its sign-offs.
    if (directions !== undefined) { need(['both', 'one'].includes(directions), 'Directions is both or one'); if (plan.directions !== directions) plan.signoffs = {}; plan.directions = directions; }
    if (ends !== undefined) { need(/^\d{4}-\d{2}-\d{2}$/.test(ends), 'End date is YYYY-MM-DD'); if (plan.ends !== ends) plan.signoffs = {}; plan.ends = ends; }
    return view(panelKey());
  },
  signOff: (p) => { sign(state.plans[panelKey()], p.role, wantsUndo(p)); return view(panelKey()); },
};

// Opening ?panel=works-199167 on its own creates that change request first, for previews.
const want = new URLSearchParams(location.search).get('panel');
if (want && desk.byId.has(want)) { handlers.createChangeRequest({ id: want }); history.replaceState(null, '', '?panel=NET-1'); }

export async function invoke(name, payload) {
  return structuredClone(handlers[name](payload || {}));
}
