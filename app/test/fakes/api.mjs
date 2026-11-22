// A small fake Jira behind @forge/api, with just the endpoints Detour Check calls. Tests change
// `jira.site` to play different sites: a fresh install, a non-admin, a space without Change.
import { fetchFeed } from './feeds.mjs';

export const jira = {
  site: null,
  calls: [],
  reset(site = {}) {
    this.site = {
      admin: true, canCreate: true, canEdit: true, groups: [], myGroups: [],
      projects: { NET: { name: 'Network Changes', projectTypeKey: 'service_desk', types: [{ id: '10', name: '[System] Change' }, { id: '11', name: 'Task' }] } },
      fields: ['Planned start', 'Planned end', 'Change type', 'Change risk', 'Impact', 'Change reason', 'Implementation plan', 'Backout plan', 'Test plan'],
      issues: {}, comments: {}, properties: {}, next: 1, failOnChangeFields: false,
      workflows: {}, schemes: {}, templates: ['service_desk', 'business'], created: [],
      ...site,
    };
    this.calls = [];
  },
};
jira.reset();

const json = (status, body) => ({ ok: status < 300, status, text: async () => (body === undefined ? '' : JSON.stringify(body)) });
const OPTIONS = { 'change type': ['Normal', 'Standard'], 'change risk': ['Low', 'Medium', 'High'], impact: ['Minor', 'Moderate', 'Significant'], 'change reason': ['Maintenance', 'Upgrade'] };

function handle(path, init = {}, as) {
  const s = jira.site;
  const method = init.method || 'GET';
  const url = new URL(path, 'https://site.example');
  const p = url.pathname;
  jira.calls.push({ method, path, as, body: init.body ? JSON.parse(init.body) : undefined });
  let m;
  if (p === '/rest/api/3/mypermissions') {
    const project = url.searchParams.get('projectKey');
    return json(200, { permissions: {
      ADMINISTER: { havePermission: s.admin },
      CREATE_ISSUES: { havePermission: s.canCreate && (!project || !!s.projects[project]) },
      EDIT_ISSUES: { havePermission: s.canEdit },
    } });
  }
  if (p === '/rest/api/3/groups/picker') return json(200, { groups: s.groups.map((name) => ({ name })) });
  if (p === '/rest/api/3/myself') return json(200, { accountId: 'me', groups: { items: s.myGroups.map((name) => ({ name })) } });
  if (p === '/rest/api/3/project/search') {
    const q = (url.searchParams.get('query') || '').toLowerCase();
    return json(200, { isLast: true, values: Object.entries(s.projects).filter(([k, v]) => !q || v.name.toLowerCase().includes(q) || k.toLowerCase().includes(q)).map(([key, v]) => ({ key, name: v.name, projectTypeKey: v.projectTypeKey })) });
  }
  if (p === '/rest/api/3/project' && method === 'POST') {
    const b = JSON.parse(init.body);
    if (!s.admin) return json(403, { errorMessages: ['Admins only'] });
    if (!s.templates.includes(b.projectTypeKey)) return json(400, { errorMessages: ['Unknown project template'] });
    if (s.projects[b.key]) return json(400, { errors: { projectKey: 'A project with that key already exists.' } });
    const change = b.projectTypeKey === 'service_desk';
    s.projects[b.key] = { name: b.name, projectTypeKey: b.projectTypeKey, types: change ? [{ id: '10', name: '[System] Change' }] : [{ id: '11', name: 'Task' }] };
    s.created.push(b);
    return json(201, { key: b.key });
  }
  if (p === '/rest/api/3/workflows' && method === 'POST') {
    const pairs = JSON.parse(init.body).projectAndIssueTypes;
    const found = new Map();
    for (const { projectId, issueTypeId } of pairs) {
      const key = Object.keys(s.projects).find((k) => projectIdOf(k) === projectId);
      const w = workflowOf(key, issueTypeId);
      found.set(w.workflow.id, w);
    }
    const list = [...found.values()];
    return json(200, { statuses: list.flatMap((w) => w.statusList), workflows: list.map((w) => w.workflow) });
  }
  if ((m = p.match(/^\/rest\/api\/3\/workflow\/([^/]+)\/projectUsages$/))) {
    const w = s.workflows[decodeURIComponent(m[1])];
    return json(200, { projects: { values: [...(w?.projects || [])].map((k) => ({ id: projectIdOf(k) })) } });
  }
  if (p === '/rest/api/3/workflows/update' && method === 'POST') {
    const b = JSON.parse(init.body);
    if (!s.admin) return json(403, { errorMessages: ['Admins only'] });
    for (const next of b.workflows) {
      const entry = s.workflows[next.id];
      entry.workflow = { ...entry.workflow, ...next, version: { versionNumber: entry.workflow.version.versionNumber + 1 } };
    }
    s.updates = (s.updates || 0) + 1;
    return json(200, { workflows: b.workflows });
  }
  if ((m = p.match(/^\/rest\/api\/3\/project\/([A-Z0-9_]+)$/))) return s.projects[m[1]] ? json(200, { key: m[1], id: projectIdOf(m[1]), ...s.projects[m[1]] }) : json(404, { errorMessages: ['No project'] });
  if ((m = p.match(/^\/rest\/api\/3\/issue\/createmeta\/([A-Z0-9_]+)\/issuetypes$/))) return s.projects[m[1]] ? json(200, { issueTypes: s.projects[m[1]].types }) : json(404, {});
  if ((m = p.match(/^\/rest\/api\/3\/issue\/createmeta\/([A-Z0-9_]+)\/issuetypes\/(\d+)$/))) {
    const type = s.projects[m[1]].types.find((t) => t.id === m[2]);
    const change = /change/i.test(type?.untranslatedName || type?.name || '');
    return json(200, { fields: change ? s.fields.map((name, i) => ({ fieldId: `customfield_${100 + i}`, name, allowedValues: OPTIONS[name.toLowerCase()]?.map((value, j) => ({ id: `${i}${j}`, value })) })) : [] });
  }
  if (p === '/rest/api/3/issue' && method === 'POST') {
    const { fields } = JSON.parse(init.body);
    if (s.failOnChangeFields && Object.keys(fields).some((k) => k.startsWith('customfield_'))) return json(400, { errors: { customfield_100: 'read-only' } });
    if (!s.projects[fields.project.key] || !s.canCreate) return json(403, { errorMessages: ['No permission'] });
    const id = String(20000 + s.next);
    const key = `${fields.project.key}-${s.next++}`;
    s.ids = { ...(s.ids || {}), [key]: id };
    s.issues[key] = fields;
    return json(201, { key, id });
  }
  if ((m = p.match(/^\/rest\/api\/3\/issue\/([A-Z0-9_]+-\d+)\/properties\/([\w-]+)$/)) && method === 'PUT') { s.properties[`${m[1]}/${m[2]}`] = JSON.parse(init.body); return json(200); }
  if ((m = p.match(/^\/rest\/api\/3\/issue\/([A-Z0-9_]+-\d+)\/comment$/)) && method === 'POST') {
    (s.comments[m[1]] ||= []).push({ as, body: JSON.parse(init.body).body });
    return json(201, { id: String(s.comments[m[1]].length) });
  }
  if ((m = p.match(/^\/rest\/api\/3\/issue\/([A-Z0-9_]+-\d+)$/)) && method === 'GET') {
    // A moved work item answers under its new key.
    const key = s.moved?.[m[1]] || m[1];
    return s.issues[key] ? json(200, { id: s.ids[key], key, fields: s.issues[key] }) : json(404, { errorMessages: ['No issue'] });
  }
  if ((m = p.match(/^\/rest\/api\/3\/issue\/([A-Z0-9_]+-\d+)$/)) && method === 'PUT') { Object.assign(s.issues[m[1]] || {}, JSON.parse(init.body).fields); return json(204); }
  return json(404, { errorMessages: [`Fake Jira has no ${method} ${p}`] });
}

const projectIdOf = (key) => String(10000 + [...key].reduce((n, c) => n + c.charCodeAt(0), 0));
// Jira Service Management's change workflow, cut down to the statuses and transitions that matter,
// or a plain To Do / In Progress / Done for any other space.
function workflowFor(project) {
  const st = (id, name, statusCategory) => ({ id, name, statusCategory, statusReference: id });
  const tr = (id, name, to, from) => ({ id, name, toStatusReference: to, links: [{ fromStatusReference: from }], validators: [] });
  const change = project.projectTypeKey === 'service_desk';
  const statusList = change
    ? [st('1', 'Review', 'TODO'), st('2', 'Planning', 'IN_PROGRESS'), st('3', 'Authorize', 'IN_PROGRESS'), st('4', 'Awaiting implementation', 'IN_PROGRESS'), st('5', 'Implementing', 'IN_PROGRESS'), st('6', 'Completed', 'DONE'), st('c1', 'Canceled', 'DONE')]
    : [st('7', 'To Do', 'TODO'), st('8', 'In Progress', 'IN_PROGRESS'), st('9', 'Done', 'DONE'), st('10', "Won't do", 'DONE')];
  const transitions = change
    ? [tr('11', 'Normal change', '2', '1'), tr('12', 'Standard change', '4', '1'), tr('13', 'Emergency override', '5', '1'), tr('14', 'Approve', '4', '3'), tr('15', 'Implement', '5', '4'), tr('16', 'Complete', '6', '5'), tr('17', 'Cancel', 'c1', '1')]
    : [tr('21', 'Start', '8', '7'), tr('22', 'Done', '9', '8'), tr('23', "Won't do", '10', '7')];
  return { statusList, workflow: { id: `wf-${String(Math.random()).slice(2)}`, name: change ? 'Change workflow' : 'Task workflow', version: { versionNumber: 1 }, statuses: statusList.map((x) => ({ statusReference: x.id })), transitions } };
}

// Each project's issue type gets its own workflow, unless a test shares one through `schemes`.
export function workflowOf(key, typeId) {
  const s = jira.site;
  const scheme = `${key}:${typeId}`;
  if (!s.schemes[scheme]) {
    const type = s.projects[key].types.find((t) => t.id === String(typeId));
    const w = workflowFor({ projectTypeKey: /change/i.test(type?.untranslatedName || type?.name || '') ? 'service_desk' : 'business' });
    s.workflows[w.workflow.id] = { ...w, projects: new Set() };
    s.schemes[scheme] = w.workflow.id;
  }
  const w = s.workflows[s.schemes[scheme]];
  w.projects.add(key);
  return w;
}

const client = (as) => ({ requestJira: async (path, init) => handle(path, init, as) });
export default { asUser: () => client('user'), asApp: () => client('app') };
// Like the real `route`, values are encoded, so a crafted key cannot change the path.
export const route = (strings, ...values) => strings.reduce((out, s, i) => out + s + (i < values.length ? encodeURIComponent(values[i]) : ''), '');
export const fetch = async (url) => fetchFeed(url);
export const getAppContext = () => ({ environmentAri: 'ari:cloud:ecosystem::environment/app-1/env-1' });
