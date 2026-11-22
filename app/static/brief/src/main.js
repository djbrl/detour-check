// Change Desk: one page for the change coordinator (every planned disruption and its change request)
// and one panel on each change request (impact, go-live check, sign-offs). Same bundle, two modules.
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './app.css';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const when = (iso) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });

// ---------- backend: Forge inside Jira, an in-page stand-in when the page is opened on its own ----------

const inJira = window.parent !== window;
// The bridge is CommonJS and throws outside Jira, so it is loaded lazily and only inside it.
const bridge = inJira ? import('@forge/bridge').then((m) => m.default ?? m) : null;
const local = inJira ? null : import('./local.js');
const call = async (name, payload = {}) => (inJira ? (await bridge).invoke(name, payload) : (await local).invoke(name, payload));

const AGENT = { type: 'forge', agentKey: 'change-desk-agent', agentName: 'Change Desk' };
async function askRovo(prompt) {
  if (!inJira) { alert(`Rovo would open with:\n\n${prompt}`); return; }
  const b = await bridge;
  try { await b.rovo.open({ ...AGENT, prompt }); } catch (e) { showFlag(`Rovo is not available here: ${e.message}`); }
}
async function openIssue(key) {
  if (inJira) (await bridge).router.open(`/browse/${key}`);
}
function showFlag(text) {
  const el = document.createElement('div');
  el.className = 'flag';
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 6000);
}

// ---------- shared pieces ----------

const chip = (l) => `<span class="chip ${l.mode === 'TRAM' ? 'tram' : ''}" title="${esc(l.name)}">${esc(l.short)}</span>`;
const chips = (lines, max = 4) => `<span class="chips-row">${lines.slice(0, max).map(chip).join('')}${lines.length > max ? `<span class="chip more" title="${esc(lines.slice(max).map((l) => l.short).join(', '))}">+${lines.length - max}</span>` : ''}</span>`;
const KIND = { works: 'Works', diversion: 'Diversion', tram: 'Tram' };
const dates = (d) => (d.ends ? `${d.startsLabel} – ${d.endsLabel}` : `From ${d.startsLabel}`);

// A change request's state as one lozenge.
function crLozenge(cr) {
  if (!cr) return '<span class="dim">–</span>';
  const s = cr.state;
  const [tone, text] = s === 'failing' ? ['danger', `${cr.failing} failing`]
    : s === 'pending' ? ['', 'Checks due']
      : s === 'ready' ? (cr.ready ? ['ok', 'Ready'] : ['info', `${cr.signed}/${cr.roles} signed`])
        : s === 'no-impact' ? ['', 'No impact']
          : ['warn', 'Not assessed'];
  return `<span class="lozenge ${tone}">${text}</span>`;
}

const CHECK_ICON = { pass: ['ok', '✓', 'Matches'], fail: ['danger', '✕', 'Does not match'], pending: ['pending', '◷', 'Not due yet'] };
function checksList(r) {
  if (r.state === 'not-assessed') return '<p class="dim">Set the impact to run the go-live check.</p>';
  if (r.state === 'no-impact') return '<p class="dim">No service impact, so nothing has to be published.</p>';
  return `<ul class="checks">${r.checks.map((c) => {
    const [tone, icon, label] = CHECK_ICON[c.state];
    return `<li class="${tone}"><span class="icon" aria-label="${label}">${icon}</span><div><b>${esc(c.label)}</b>
      <div class="evidence">${esc(c.evidence)}${c.state === 'pending' ? ` <span class="dim">Due ${esc(new Date(`${c.due}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }))}.</span>` : ''}</div></div></li>`;
  }).join('')}</ul>`;
}

// ---------- map ----------

const COLORS = { route: '#1d7afc', tram: '#8270db', works: '#c9372c', diversion: '#e2740b', stop: '#172b4d' };
function makeMap(el) {
  const m = L.map(el, { zoomControl: true }).setView([44.84, -0.575], 13);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap · Bordeaux Métropole open data' }).addTo(m);
  m.layer = L.layerGroup().addTo(m);
  // Leaflet measures its container when created, and a hidden tab gives it no size. Re-measure
  // before every fit, and fit again whenever the container is resized or shown.
  const fit = m.fitBounds.bind(m);
  m.fitBounds = (b, o) => { m.lastFit = [b, o]; m.invalidateSize(); return b.length && el.offsetWidth ? fit(b, o) : m; };
  new ResizeObserver(() => { if (!el.offsetWidth) return; m.invalidateSize(); if (m.lastFit?.[0].length) fit(...m.lastFit); }).observe(el);
  return m;
}

function drawMap(map, d) {
  map.layer.clearLayers();
  for (const l of d.lines) for (const g of d.lineGeo?.[l.id] || []) L.polyline(g, { color: l.mode === 'TRAM' ? COLORS.tram : COLORS.route, weight: 3, opacity: 0.4 }).addTo(map.layer);
  for (const v of d.diversions || []) for (const g of v.geo) L.polyline(g, { color: COLORS.diversion, weight: 5, dashArray: '9 7' }).bindTooltip(`Published diversion: ${esc(v.title)}`).addTo(map.layer);
  const main = d.kind === 'diversion' ? COLORS.diversion : COLORS.works;
  for (const g of d.geo || []) {
    (g.length === 1 ? L.circleMarker(g[0], { radius: 10, color: main, weight: 3, fillOpacity: 0.5 }) : L.polyline(g, { color: main, weight: 7, dashArray: d.kind === 'diversion' ? '9 7' : null }))
      .bindTooltip(esc(d.title)).addTo(map.layer);
  }
  for (const s of d.stops || []) L.circleMarker([s.lat, s.lon], { radius: 5, color: COLORS.stop, weight: 2, fillColor: '#fff', fillOpacity: 1 }).bindTooltip(esc(s.name)).addTo(map.layer);
  const pts = (d.geo || []).flat();
  map.fitBounds(pts.length ? pts : d.lines.flatMap((l) => (d.lineGeo?.[l.id] || []).flat()), { padding: [40, 40], maxZoom: 17 });
}

// One map element, moved between containers so Leaflet keeps its state across re-renders.
let map = null;
function mapInto(container, d) {
  if (!map) { const el = document.createElement('div'); el.className = 'map'; map = makeMap(el); }
  container.appendChild(map.getContainer());
  drawMap(map, d);
}

// ---------- the desk page ----------

let D = null; // { settings, items, mode, takenAt, today }
let seg = 'todo';
let query = '';
let selected = null;
let tab = 'map';
let current = null; // detail of the selected disruption

function renderHead() {
  const demo = D.mode !== 'live';
  const day = new Date(demo ? D.takenAt : Date.now()).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Paris' });
  $('#sub').textContent = `Bordeaux Métropole bus and tram network · ${day}`;
  $('#live').textContent = demo ? 'Demo day' : 'Live data';
  $('#live').className = `lozenge ${demo ? 'info' : 'ok'}`;
  $('#mode-chips').innerHTML = [['demo', 'Frozen demo day'], ['live', 'Live open data']].map(([k, t]) => `<button data-mode="${k}" aria-pressed="${D.mode === k}">${t}</button>`).join('');
  $$('#mode-chips button').forEach((b) => (b.onclick = async () => { await call('saveSettings', { mode: b.dataset.mode }); location.reload(); }));
  $('#space-name').textContent = D.settings.project || 'not chosen';
}

async function loadProjects() {
  if (!inJira) return [{ key: 'NET', name: 'Network Changes' }];
  const b = await bridge;
  const res = await b.requestJira('/rest/api/3/project/search?maxResults=50&orderBy=name');
  return (await res.json()).values || [];
}

async function renderSetup() {
  const box = $('#setup');
  if (D.settings.project) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = `<div class="notice info"><span class="icon" aria-hidden="true">i</span><div class="body">
    <b>Choose where change requests go</b>Change requests are Jira work items. Pick the space for them; a service space with a Change work type works best.
    <div class="actions"><label class="sr" for="space">Space</label><select id="space"><option>Loading spaces…</option></select><button class="btn primary" id="save-space">Use this space</button></div></div></div>`;
  const projects = await loadProjects().catch(() => []);
  $('#space').innerHTML = projects.length ? projects.map((p) => `<option value="${esc(p.key)}">${esc(p.name)} (${esc(p.key)})</option>`).join('') : '<option value="">No space available</option>';
  $('#save-space').disabled = !projects.length;
  $('#save-space').onclick = async () => { D.settings = await call('saveSettings', { project: $('#space').value }); renderHead(); renderSetup(); renderDetail(); };
}

const matches = (i) => !query || norm(i.title).includes(norm(query)) || norm(i.what).includes(norm(query)) || i.lines.some((l) => norm(l.short) === norm(query));

function renderList() {
  const todo = D.items.filter((i) => !i.changeRequest);
  const crs = D.items.filter((i) => i.changeRequest);
  const failing = crs.filter((i) => i.changeRequest.state === 'failing').length;
  const segs = [['todo', 'Needs a change request', todo.length, ''], ['crs', 'Change requests', crs.length, failing ? 'danger' : ''], ['all', 'All', D.items.length, '']];
  $('#seg').innerHTML = segs.map(([k, label, n, tone]) => `<button data-k="${k}" aria-pressed="${seg === k}">${label}<span class="n ${tone}">${n}</span></button>`).join('');
  $$('#seg button').forEach((b) => (b.onclick = () => { seg = b.dataset.k; renderList(); }));

  const list = (seg === 'todo' ? todo : seg === 'crs' ? crs : D.items).filter(matches);
  if (!list.some((i) => i.id === selected)) select(list[0]?.id || null);
  const box = $('#list');
  const scroll = box.scrollTop;
  box.innerHTML = list.length ? `<table class="list" role="grid">
    <thead><tr><th>Type</th><th>Disruption</th><th>Lines</th><th>Dates</th><th>Change request</th></tr></thead>
    <tbody>${list.map((i) => `<tr data-id="${esc(i.id)}" aria-selected="${i.id === selected}" tabindex="0">
      <td><span class="lozenge ${i.status === 'in-force' ? 'warn' : ''}">${KIND[i.kind]}</span></td>
      <td class="title" title="${esc(i.title)}">${esc(i.title)} <span class="dim">· ${esc(i.what)}</span></td>
      <td>${chips(i.lines)}</td>
      <td class="dim nowrap">${esc(dates(i))}</td>
      <td class="nowrap">${i.changeRequest ? `<span class="key">${esc(i.changeRequest.key)}</span> ${crLozenge(i.changeRequest)}` : '<span class="dim">–</span>'}</td>
    </tr>`).join('')}</tbody></table>`
    : `<div class="empty">${seg === 'todo' ? 'Every disruption on the desk has a change request.' : seg === 'crs' ? 'No change requests yet. Open one from Needs a change request.' : 'Nothing matches.'}</div>`;
  box.scrollTop = scroll;
  $$('tbody tr', box).forEach((tr) => {
    const go = () => { select(tr.dataset.id); renderList(); };
    tr.onclick = go;
    tr.onkeydown = (e) => { if (e.key === 'Enter') go(); };
  });
}

async function select(id) {
  if (id === selected) return;
  selected = id;
  current = null;
  renderDetail();
  if (!id) return;
  try {
    const d = await call('getItem', { id });
    if (selected === id) { current = d; renderDetail(); }
  } catch (e) {
    if (selected === id) $('#detail').innerHTML = `<div class="error">Could not load this disruption: ${esc(e.message)}</div>`;
  }
}

function renderDetail() {
  const panel = $('#detail');
  const item = D.items.find((i) => i.id === selected);
  if (!item) { panel.innerHTML = '<div class="empty">Select a disruption.</div>'; return; }
  const d = current;
  const cr = d?.changeRequest;
  panel.innerHTML = `
    <h2>${esc(item.title)}</h2>
    <div class="fields">
      <div class="field"><div class="k">Type</div><div class="v">${esc(item.what)}</div></div>
      <div class="field"><div class="k">Lines</div><div class="v">${chips(item.lines, 8)}</div></div>
      <div class="field"><div class="k">Dates</div><div class="v">${esc(dates(item))}</div></div>
      <div class="field"><div class="k">Status</div><div class="v">${item.status === 'in-force' ? 'In force' : 'Upcoming'}</div></div>
    </div>
    <div id="cr-box">${!d ? '<div class="skeleton"></div>' : cr ? crSummary(cr) : crStart()}</div>
    <div class="tabs" role="tablist">${[['map', 'Map'], ['stops', `Stops nearby ${d?.stops.length ?? ''}`], ['published', 'Published']].map(([k, label]) => `<button class="tab" role="tab" data-tab="${k}" aria-selected="${tab === k}">${label}</button>`).join('')}</div>
    <div id="tab-body">${d ? '' : '<div class="skeleton"></div>'}</div>
    <div class="source">${esc(item.source)} · ${esc(item.ref)}</div>`;
  $$('.tab', panel).forEach((b) => (b.onclick = () => { tab = b.dataset.tab; renderDetail(); }));
  if (!d) return;
  const body = $('#tab-body');
  if (tab === 'map') mapInto(body, d);
  else if (tab === 'stops') body.innerHTML = d.stops.length ? `<ul class="plain">${d.stops.map((s) => `<li>${esc(s.name)}</li>`).join('')}</ul>` : '<p class="dim">No stop within 40 m of the works.</p>';
  else body.innerHTML = published(d);
  wireCr(item, d);
}

function published(d) {
  const divs = d.diversions.length
    ? `<ul class="plain">${d.diversions.map((v) => `<li>${chips(v.lines)} ${esc(v.title)} <span class="dim">· ${esc(v.direction.toLowerCase())}, until ${esc(v.endsLabel)}</span></li>`).join('')}</ul>`
    : '<p class="dim">No published diversion on these lines within 800 m.</p>';
  const msgs = d.messages.filter((m) => m.messages.length);
  return `<h3 class="h3">Diversions</h3>${divs}<h3 class="h3">Messages at stops</h3>${msgs.length
    ? msgs.map((m) => `<div class="msg">${chip(m.line)} ${m.messages.map((x) => `<span class="quote">${esc(x.text)}</span>`).join('')}</div>`).join('')
    : '<p class="dim">No message at stops on these lines.</p>'}${d.quote ? `<h3 class="h3">Announcement</h3><p class="quote">${esc(d.quote)}</p>` : ''}`;
}

function crStart() {
  return `<div class="cr-card"><div><b>No change request yet</b><div class="dim">Open one to assess the impact, collect sign-offs and check what gets published.</div></div>
    <div class="row">${D.settings.project ? '<button class="btn primary" id="create-cr">Open change request</button>' : '<span class="dim">Choose a space for change requests first.</span>'}
    <button class="btn" id="ask-rovo">Ask Rovo to assess</button></div></div>`;
}

function crSummary(cr) {
  const r = cr.readiness;
  const headline = r.ready ? 'Ready to go live' : r.state === 'failing' ? `${r.failing} ${r.failing === 1 ? 'check does' : 'checks do'} not match what is published` : r.state === 'not-assessed' ? 'Impact not assessed yet' : r.state === 'no-impact' ? 'No service impact' : r.state === 'pending' ? 'Published checks not due yet' : 'Published information matches';
  return `<div class="cr-card ${r.state === 'failing' ? 'bad' : r.ready ? 'good' : ''}">
    <div><button class="link key" id="open-cr">${esc(cr.key)}</button> · ${esc(cr.impactLabel)}<div class="cr-head">${esc(headline)}</div><div class="dim">${r.signed} of ${r.roles} sign-offs</div></div>
    ${checksList(r)}
    <div class="row"><button class="btn" id="open-cr2">Open work item</button><button class="btn" id="ask-rovo">Ask Rovo about it</button></div></div>`;
}

function wireCr(item, d) {
  $('#create-cr')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Opening…';
    try {
      const cr = await call('createChangeRequest', { id: item.id });
      await refresh();
      showFlag(`${cr.key} created`);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Try again';
      showFlag(`Could not create the change request: ${err.message}`);
    }
  });
  for (const id of ['open-cr', 'open-cr2']) $(`#${id}`)?.addEventListener('click', () => openIssue(d.changeRequest.key));
  $('#ask-rovo')?.addEventListener('click', () => askRovo(d.changeRequest
    ? `Check change request ${d.changeRequest.key} and tell me what has to happen before it can go live.`
    : `Assess disruption ${item.id} (${item.title}): which lines and stops it affects, and whether it needs a change request.`));
}

async function refresh() {
  D = await call('getDesk');
  const id = selected;
  selected = null;
  renderList();
  if (id) await select(id);
}

async function startDesk() {
  $('#menu-btn').onclick = () => { const p = $('#menu-panel'); p.hidden = !p.hidden; $('#menu-btn').setAttribute('aria-expanded', String(!p.hidden)); };
  document.addEventListener('click', (e) => { if (!e.target.closest('.menu')) { $('#menu-panel').hidden = true; $('#menu-btn').setAttribute('aria-expanded', 'false'); } });
  $('#change-space').onclick = async () => { D.settings = await call('saveSettings', { project: null }); renderHead(); renderSetup(); renderDetail(); };
  $('#search').oninput = (e) => { query = e.target.value.trim(); renderList(); };
  $('#ask-week').onclick = () => askRovo('What needs my attention this week? Start with change requests that fail their go-live check, then disruptions starting soon with no change request.');
  D = await call('getDesk');
  $('#loading').remove();
  $('#desk').hidden = false;
  $('#app').hidden = false;
  renderHead();
  renderSetup();
  renderList();
}

// ---------- the panel on a change request ----------

let P = null;
const names = {};
async function loadNames(ids) {
  const missing = ids.filter((id) => id && !(id in names));
  if (!missing.length || !inJira) return;
  try {
    const b = await bridge;
    const res = await b.requestJira(`/rest/api/3/user/bulk?${missing.map((id) => `accountId=${encodeURIComponent(id)}`).join('&')}`);
    for (const u of (await res.json()).values || []) names[u.accountId] = u.displayName;
  } catch { /* names are a nicety; the sign-off stands without them */ }
}

const IMPACTS = [['closed', 'Road closed', 'Buses divert'], ['stops', 'Stops not served', 'Stops skipped or moved'], ['narrowed', 'Lane narrowed', 'Delays only'], ['none', 'No impact', 'Nothing to publish']];

async function renderPanel() {
  const root = $('#panel');
  const cr = P.changeRequest;
  if (!cr) {
    root.innerHTML = '<p class="dim">This work item was not opened from the Change Desk. Open the Change Desk from the Apps menu to create change requests from planned disruptions.</p>';
    return;
  }
  await loadNames(cr.signoffs.map((s) => s.by));
  const r = cr.readiness;
  const d = cr.disruption;
  root.innerHTML = `
    <div class="panel-top ${r.state === 'failing' ? 'bad' : r.ready ? 'good' : ''}">
      <div><div class="cr-head">${r.ready ? 'Ready to go live' : r.state === 'failing' ? 'Not ready: published information does not match' : 'Not ready to go live yet'}</div>
      <div class="dim">${d ? `${esc(d.what)} · ${esc(cr.startsLabel)} – ${esc(cr.endsLabel)} · ` : ''}${r.signed} of ${r.roles} sign-offs${P.mode !== 'live' ? ' · demo day' : ''}</div></div>
      <button class="btn" id="ask-rovo">Draft with Rovo</button>
    </div>
    <h3 class="h3">Impact</h3>
    <div class="impact" role="radiogroup" aria-label="Impact">${IMPACTS.map(([k, t, sub]) => `<button role="radio" data-impact="${k}" aria-checked="${cr.impact === k}"><b>${t}</b><span>${sub}</span></button>`).join('')}</div>
    ${cr.impact === 'closed' || cr.impact === 'stops' ? `<label class="inline"><input type="checkbox" id="both" ${cr.directions === 'both' ? 'checked' : ''}> Both directions are affected</label>` : ''}
    <label class="inline">Until <input type="date" id="ends" value="${esc(cr.ends || '')}"></label>
    <h3 class="h3">Go-live check</h3>
    ${checksList(r)}
    <h3 class="h3">Sign-offs</h3>
    <ul class="signoffs">${cr.signoffs.map((s) => `<li><span>${esc(s.label)}</span>${s.at
      ? `<span class="ok-text">✓ ${esc(names[s.by] || 'Signed')} · ${esc(when(s.at))}</span><button class="btn subtle" data-undo="${s.role}">Undo</button>`
      : `<button class="btn" data-role="${s.role}">Sign off</button>`}</li>`).join('')}</ul>
    ${d ? '<details id="map-details"><summary>Map</summary><div id="panel-map"></div></details>' : ''}`;

  const save = async (changes) => { P.changeRequest = await call('savePlan', changes); renderPanel(); };
  $$('[data-impact]').forEach((b) => (b.onclick = () => save({ impact: b.dataset.impact })));
  $('#both')?.addEventListener('change', (e) => save({ directions: e.target.checked ? 'both' : 'one' }));
  $('#ends').onchange = (e) => e.target.value && save({ ends: e.target.value });
  $$('[data-role]').forEach((b) => (b.onclick = async () => { b.disabled = true; P.changeRequest = await call('signOff', { role: b.dataset.role }); renderPanel(); }));
  $$('[data-undo]').forEach((b) => (b.onclick = async () => { P.changeRequest = await call('signOff', { role: b.dataset.undo, undo: true }); renderPanel(); }));
  $('#ask-rovo').onclick = () => askRovo(`For change request ${P.key}: write the impact assessment and a passenger notice in French and English, then record both on ${P.key}.`);
  $('#map-details')?.addEventListener('toggle', (e) => { if (e.target.open) mapInto($('#panel-map'), d); });
}

async function startPanel() {
  P = await call('getPanel');
  $('#loading').remove();
  $('#panel').hidden = false;
  await renderPanel();
}

// ---------- start ----------

const within = (ms, what, promise) => Promise.race([promise, new Promise((_, no) => setTimeout(() => no(new Error(`${what} did not answer within ${ms / 1000} s`)), ms))]);

async function start() {
  let isPanel = new URLSearchParams(location.search).has('panel');
  if (inJira) {
    const b = await bridge;
    b.view.theme.enable().catch(() => {});
    const ctx = await b.view.getContext();
    isPanel = ctx?.extension?.type === 'jira:issuePanel';
  }
  document.body.classList.toggle('in-panel', isPanel);
  try {
    await within(40000, 'The Change Desk', isPanel ? startPanel() : startDesk());
  } catch (err) {
    const box = $('#loading') || document.body;
    box.innerHTML = `<div class="error"><span>Could not load: ${esc(err.message)}</span><button class="btn" id="retry">Retry</button></div>`;
    $('#retry').onclick = () => location.reload();
  }
}

start();
