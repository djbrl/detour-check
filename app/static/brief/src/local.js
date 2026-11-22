// Stands in for the Forge backend when the page is opened outside Jira (local preview). It runs the
// same model on the frozen demo day and keeps change requests in memory.
import { reviveDesk, runChecks, defaultPlan, summary, detail, lineInfo, IMPACTS, dayLabel } from '../../../src/model.js';
import day from '../../../src/demo-desk.json';

const desk = reviveDesk(day);
const ROLES = { ops: 'Operations: diversion route approved', scheduling: 'Scheduling: timetables and journey planner updated', passengers: 'Passenger information: notice approved', drivers: 'Drivers briefed' };
const state = { settings: { mode: 'demo', project: null }, crs: {}, plans: {}, n: 0 };

function readiness(plan, item) {
  const r = runChecks(plan, item, desk);
  const signed = Object.keys(ROLES).filter((k) => plan.signoffs[k]).length;
  return { ...r, signed, roles: 4, ready: r.state === 'ready' && signed === 4 };
}
function view(key) {
  const plan = state.plans[key];
  if (!plan) return null;
  const item = desk.byId.get(plan.item);
  return {
    key, item: plan.item, impact: plan.impact, impactLabel: plan.impact ? IMPACTS[plan.impact] : 'Not assessed yet',
    lines: plan.lines.map(lineInfo), starts: plan.starts, ends: plan.ends, startsLabel: dayLabel(plan.starts, desk.now), endsLabel: dayLabel(plan.ends, desk.now),
    directions: plan.directions, stops: plan.stops,
    signoffs: Object.entries(ROLES).map(([role, label]) => ({ role, label, ...(plan.signoffs[role] || {}) })),
    readiness: readiness(plan, item), disruption: detail(item, desk),
  };
}
const panelKey = () => new URLSearchParams(location.search).get('panel') || Object.keys(state.plans)[0];

const handlers = {
  getDesk: () => ({
    settings: state.settings, now: desk.now, today: desk.today, takenAt: day.takenAt, mode: 'demo',
    items: desk.items.map((item) => {
      const cr = state.crs[item.id];
      const r = cr && readiness(state.plans[cr.key], item);
      return { ...summary(item, desk), changeRequest: cr ? { key: cr.key, state: r.state, failing: r.failing, pending: r.pending, signed: r.signed, roles: r.roles, ready: r.ready } : null };
    }),
  }),
  getItem: ({ id }) => ({ ...detail(desk.byId.get(id), desk), changeRequest: state.crs[id] ? view(state.crs[id].key) : null }),
  saveSettings: (p) => Object.assign(state.settings, Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined))),
  createChangeRequest: ({ id }) => {
    const key = `NET-${++state.n}`;
    state.crs[id] = { key };
    state.plans[key] = { ...defaultPlan(desk.byId.get(id)), signoffs: {} };
    return { key, created: true };
  },
  getPanel: () => ({ key: panelKey(), mode: 'demo', changeRequest: view(panelKey()) }),
  savePlan: (p) => { Object.assign(state.plans[panelKey()], Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined))); return view(panelKey()); },
  signOff: ({ role, undo }) => { const s = state.plans[panelKey()].signoffs; if (undo) delete s[role]; else s[role] = { by: null, at: new Date().toISOString() }; return view(panelKey()); },
};

// Opening ?panel=works-199167 on its own creates that change request first, for previews.
const want = new URLSearchParams(location.search).get('panel');
if (want && desk.byId.has(want)) { handlers.createChangeRequest({ id: want }); history.replaceState(null, '', '?panel=NET-1'); }

export async function invoke(name, payload) {
  return structuredClone(handlers[name](payload || {}));
}
