// Detour Check: one page for the change coordinator (every roadworks site on a bus route and its
// plan) and one panel on each plan's work item (impact, go-live check, sign-offs). Same bundle, two modules.
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

const AGENT = { type: 'forge', agentKey: 'change-desk-agent', agentName: 'Detour Check' };
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

const TONE = { red: 'danger', amber: 'warn', green: 'ok' };
const light = (o) => `<span class="lozenge ${TONE[o.light]}">${esc(o.label)}</span>`;

// Per-viewer conveniences only (the guide's progress); the page works the same without storage.
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(`change-desk:${k}`)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(`change-desk:${k}`, JSON.stringify(v)); } catch { /* private window */ } },
};
// Day and month only, with the year when it is not this one.
// Today on the network's clock (the demo day, or now), set by the desk or the panel when they load.
let TODAY = new Date().toISOString().slice(0, 10);
const shortDay = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: iso.slice(0, 4) !== TODAY.slice(0, 4) ? 'numeric' : undefined, timeZone: 'Europe/Paris' });
const shortDates = (d) => (d.ends ? `${shortDay(d.starts)} – ${shortDay(d.ends)}` : `From ${shortDay(d.starts)}`);

// ---------- map ----------

// One story per map: the normal route in grey, the roadworks in red, published detours in green.
const COLORS = { route: '#505f79', works: '#c9372c', detour: '#1f845a', stop: '#172b4d' };
// A white casing under a line keeps it readable on any part of the map.
const cased = (g, opts, layer) => { L.polyline(g, { color: '#fff', weight: opts.weight + 4, opacity: opts.opacity ?? 1, interactive: false }).addTo(layer); return L.polyline(g, opts).addTo(layer); };
const LEGEND = [['route', 'Bus route'], ['works', 'Roadworks'], ['detour', 'Published detour'], ['stop', 'Stop']];
const legend = (d) => `<ul class="legend">${LEGEND.filter(([k]) => k !== 'detour' || d.diversions?.length)
  .map(([k, t]) => `<li><span class="sw ${k}"></span>${t}</li>`).join('')}</ul>`;
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
  for (const l of d.lines) for (const g of d.lineGeo?.[l.id] || []) L.polyline(g, { color: COLORS.route, weight: 4, opacity: 0.55 }).bindTooltip(`${l.mode === 'TRAM' ? 'Tram' : 'Bus'} ${esc(l.short)}: normal route`).addTo(map.layer);
  for (const v of d.diversions || []) for (const g of v.geo) L.polyline(g, { color: COLORS.detour, weight: 5, dashArray: '9 7' }).bindTooltip(`Published detour, ${esc(v.direction.toLowerCase())}, until ${esc(v.endsLabel)}`).addTo(map.layer);
  for (const g of d.geo || []) {
    (g.length === 1 ? L.circleMarker(g[0], { radius: 10, color: COLORS.works, weight: 3, fillOpacity: 0.5 }) : L.polyline(g, { color: COLORS.works, weight: 8 }))
      .bindTooltip(esc(d.title)).addTo(map.layer);
  }
  for (const s of d.stops || []) L.circleMarker([s.lat, s.lon], { radius: 5, color: COLORS.stop, weight: 2, fillColor: '#fff', fillOpacity: 1 }).bindTooltip(esc(s.name)).addTo(map.layer);
  // Frame the works and the detours around them, so the gap between the two is on screen.
  const pts = [...(d.geo || []).flat(), ...(d.diversions || []).flatMap((v) => v.geo.flat())];
  map.fitBounds(pts.length ? pts : d.lines.flatMap((l) => (d.lineGeo?.[l.id] || []).flat()), { padding: [30, 30], maxZoom: 16 });
}

// One map element, moved between containers so Leaflet keeps its state across re-renders.
let map = null;
function mapInto(container, d) {
  if (!map) { const el = document.createElement('div'); el.className = 'map'; map = makeMap(el); }
  container.appendChild(map.getContainer());
  drawMap(map, d);
}

// ---------- the plan, as the card and the work item panel both show it ----------

const BUS_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="1.5" width="11" height="11" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M3 7.5h10" stroke="currentColor" stroke-width="1.4"/><circle cx="5.5" cy="10" r="1" fill="currentColor"/><circle cx="10.5" cy="10" r="1" fill="currentColor"/><path d="M5 13v1.5M11 13v1.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
const TRAM_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 1.5h6M8 1.5v2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><rect x="3" y="3.5" width="10" height="9.5" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M3.5 8h9" stroke="currentColor" stroke-width="1.4"/><path d="M5 13l-1 2M11 13l1 2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
const badge = (l) => `<span class="badge ${l.mode === 'TRAM' ? 'tram' : ''}" title="${l.mode === 'TRAM' ? 'Tram' : 'Bus'} ${esc(l.short)} · ${esc(l.name)}">${l.mode === 'TRAM' ? TRAM_ICON : BUS_ICON}${esc(l.short)}</span>`;
const badges = (lines) => `<div class="badges">${lines.map(badge).join('')}</div>`;

const dayNo = (iso) => Date.parse(`${iso}T00:00:00Z`) / 864e5;
const fromDay = (n) => new Date(n * 864e5).toISOString().slice(0, 10);

// What the card says about cover, one line per job: the problem, the works dates, one bar across
// them, then the days the detour covers and the days it misses. The day count comes from the
// backend, so the card, the list and Rovo say the same.
function coverage(o) {
  const t = o?.timeline;
  const other = o && o.light !== 'green' && o.problem && !t?.gapDays ? `<p class="cov-problem ${o.light}">${esc(o.problem)}</p>` : '';
  if (!t?.from) return other;
  const today = t.today || TODAY;
  const from = t.plan?.from || t.from;
  const to = t.plan?.to || t.to || fromDay(dayNo(from) + 30);
  const range = (a, b) => `${shortDay(a)} – ${b ? shortDay(b) : '?'}`;
  const days = (n) => `${n} ${n === 1 ? 'day' : 'days'}`;
  const d = t.detour;
  // Each day is covered, missed (only from today on, and only when the backend counts a gap), or neither.
  const lo = dayNo(from);
  const hi = dayNo(to);
  const now = dayNo(today);
  const kind = (n) => {
    if (d && n >= dayNo(d.from) && n <= dayNo(d.to)) return 'on';
    return t.gapDays && n >= now ? 'off' : 'idle';
  };
  const runs = [];
  for (let n = lo; n <= hi; n += 1) {
    const k = kind(n);
    if (runs.at(-1)?.k === k) runs.at(-1).b = n;
    else runs.push({ k, a: n, b: n });
  }
  const span = hi - lo + 1;
  const bar = runs.map((r) => `<i class="cov-seg ${r.k}" style="width:${((r.b - r.a + 1) / span) * 100}%"></i>`).join('');
  const missed = runs.filter((r) => r.k === 'off').map((r) => range(fromDay(r.a), fromDay(r.b))).join(', ');
  const row = (k, cls, v) => `<div class="cov-row"><span class="cov-k"><i class="dot ${cls}"></i>${k}</span><span>${v}</span></div>`;
  return `<div class="cov">
    ${t.gapDays ? `<p class="cov-problem ${o.light}">${days(t.gapDays)} without a detour</p>` : other}
    <div class="cov-row cov-works"><span class="cov-k">${t.plan ? 'Plan' : 'Works'}</span><span>${range(from, t.plan?.to || t.to)}</span></div>
    <div class="cov-bar" role="img" aria-label="${esc(d ? `Detour ${range(d.from, d.to)}` : 'No detour')}">${bar}</div>
    ${row('Detour', 'on', d ? range(d.from, d.to) : 'None published')}
    ${missed ? row('No detour', 'off', missed) : ''}
  </div>`;
}

// What the works do to buses, in the words the card uses.
const ANSWERS = [['closed', 'Road closed, buses detour'], ['stops', 'Buses skip some stops'], ['narrowed', 'Buses slowed, lane narrowed'], ['none', 'No effect on buses']];
const ANSWER_TEXT = Object.fromEntries(ANSWERS);
const CHECK_SHORT = { diversion: 'Detour', directions: 'Both ways', dates: 'Whole time', notice: 'Riders told' };
const CHECK_MARK = { pass: ['ok', '✓'], fail: ['bad', '✕'], pending: ['wait', '◷'] };
const TEAMS = [['ops', 'Operations'], ['scheduling', 'Scheduling'], ['passengers', 'Passenger info'], ['drivers', 'Drivers']];

// What the published information says about the works, and the answer that goes with it, so the
// first step is a yes or no on something the person can see.
function published(o) {
  const t = o?.timeline;
  if (!t?.detour) return { text: 'No detour is published, so buses should run as normal.', suggest: 'none' };
  return { text: `A detour is published${o.gaps?.includes('directions') ? ' one way' : ''}, so buses can't use this street.`, suggest: 'closed' };
}

// Each team's part, as the plan in Jira lists it. Operations' part names what is still missing.
function tasks(cr, o) {
  const t = o?.timeline;
  const gaps = o?.gaps || [];
  let ops = 'Publish the detour';
  if (cr?.impact === 'none') ops = 'Confirm buses are not affected';
  else if (cr?.impact === 'narrowed') ops = 'Plan for the delays';
  else if (!t?.detour) ops = 'Publish a detour';
  else if (gaps.includes('dates')) ops = `Extend the detour to ${shortDay(t.plan?.to || t.to)}`;
  else if (gaps.includes('directions')) ops = 'Run the detour both ways';
  return { ops, scheduling: 'Update the timetables', passengers: 'Post the notice at stops', drivers: 'Brief the drivers' };
}

// The three steps. `cr` is null until the first answer; `ready` is false until a space is chosen.
function steps(cr, ready, o) {
  const r = cr?.readiness;
  const sign = (role) => cr?.signoffs.find((s) => s.role === role);
  const checks = r?.checks?.length ? `<div class="checkchips">${r.checks.map((c) => { const [tone, mark] = CHECK_MARK[c.state]; return `<button class="cc ${tone}" data-check="${c.id}" aria-expanded="false">${mark} ${CHECK_SHORT[c.id]}</button>`; }).join('')}</div>
    ${r.checks.map((c) => `<p class="evidence" data-for="${c.id}" hidden>${esc(c.evidence)}</p>`).join('')}` : '';
  const off = ready ? '' : 'disabled';
  const pub = published(o);
  // The other answers stay folded away until someone says the published plan is wrong.
  const choices = (keys) => `<div class="options" role="radiogroup" aria-label="What happens to buses?" hidden>
    ${keys.map((k) => `<button role="radio" data-impact="${k}" aria-checked="${cr?.impact === k}" tabindex="-1" ${off}>${ANSWER_TEXT[k]}</button>`).join('')}</div>`;
  const first = cr?.impact
    ? `<div class="step-k">Impact on buses</div>
      <div class="answered"><span>${ANSWER_TEXT[cr.impact]}</span><button class="link small" data-other aria-expanded="false" ${off}>Change</button></div>
      ${choices(ANSWERS.map(([k]) => k))}${checks}`
    : `<div class="step-k">Is the published plan right?</div>
      <p class="published">${pub.text}</p>
      <div class="confirm"><button class="btn primary" data-impact="${pub.suggest}" ${off}>Yes</button><button class="btn" data-other aria-expanded="false" ${off}>No</button></div>
      ${choices(ANSWERS.map(([k]) => k).filter((k) => k !== pub.suggest))}`;
  const jobs = tasks(cr, o);
  const teams = cr?.impact === 'none' ? TEAMS.slice(0, 1) : TEAMS;
  return `<ol class="steps">
    <li class="${cr?.impact ? 'done' : 'now'}">${first}</li>
    <li class="${!cr?.impact ? 'later' : r?.ready ? 'done' : 'now'}"><div class="step-k">Team sign-offs</div>
      <div class="step-sub">Each team confirms its part is done${cr?.key ? `, recorded on ${esc(cr.key)}` : ''}.</div>
      <ul class="teams">${teams.map(([role, t]) => { const s = sign(role); return `<li><span class="team"><b>${t}</b><span>${esc(jobs[role])}</span></span>
        <button data-role="${role}" aria-pressed="${!!s?.at}" ${s?.at ? `title="Signed ${esc(when(s.at))}"` : ''} ${cr?.impact ? '' : 'disabled'}>${s?.at ? `✓ ${esc(names[s.by] || 'Signed')}` : 'Sign off'}</button></li>`; }).join('')}</ul></li>
    ${cr?.impact === 'none' ? '' : `<li class="${!cr?.impact ? 'later' : cr.notice ? 'done' : 'now'}"><div class="step-k">Passenger notice</div>
      <button class="btn" id="write-notice" ${cr?.impact ? '' : 'disabled'}>${cr?.notice ? 'Rewrite with Rovo' : 'Write with Rovo'}</button></li>`}
  </ol>`;
}

// Shared wiring for the steps: evidence chips, the folded answers, and arrow keys within them.
function wireSteps(root) {
  $$('[data-check]', root).forEach((b) => (b.onclick = () => {
    const open = b.getAttribute('aria-expanded') !== 'true';
    $$('[data-check]', root).forEach((x) => x.setAttribute('aria-expanded', 'false'));
    $$('.evidence', root).forEach((p) => (p.hidden = true));
    b.setAttribute('aria-expanded', String(open));
    $(`.evidence[data-for="${b.dataset.check}"]`, root).hidden = !open;
  }));
  const other = $('[data-other]', root);
  const options = $('.options', root);
  if (other && options) other.onclick = () => {
    const open = options.hidden;
    options.hidden = !open;
    other.setAttribute('aria-expanded', String(open));
    if (open) ($('[aria-checked="true"]', options) || $('[data-impact]', options)).focus();
  };
  const radios = $$('.options [data-impact]', root);
  radios.forEach((b, i) => (b.onkeydown = (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    radios[(i + step + radios.length) % radios.length].focus();
  }));
}

// While a click is saved, the button shows a spinner and the rest of its step waits, so a double
// click cannot send it twice and nothing looks switched off.
async function working(button, scope, fn) {
  scope.classList.add('waiting');
  button.insertAdjacentHTML('beforeend', '<i class="spin" aria-hidden="true"></i>');
  button.setAttribute('aria-busy', 'true');
  try { return await fn(); } finally {
    scope.classList.remove('waiting');
    button.removeAttribute('aria-busy');
    button.querySelector('.spin')?.remove();
  }
}

const noticePrompt = (key) => `For ${key}: write a passenger notice in French and English, and a short impact assessment, then record both on ${key}.`;
const handlePrompt = (item) => `Handle the roadworks ${item.id} (${item.title}) from start to finish.`;

// ---------- the desk page: a list on the left, the network map as the main view ----------

let D = null; // { settings, items, mode, takenAt, today }
let seg = 'red';
let query = '';
let selected = null;
let current = null; // detail of the selected disruption
let big = null; // the desk's map, with one layer for every disruption and one for the selected one
const LIGHT_COLOR = { red: '#c9372c', amber: '#e56910', green: '#1f845a' };
// The card covers the right of the map, so fitted shapes keep clear of it.
const CARD_PAD = { paddingTopLeft: [40, 40], paddingBottomRight: [400, 40], maxZoom: 16 };

function renderHead() {
  const demo = D.mode !== 'live';
  const day = new Date(demo ? D.takenAt : Date.now()).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Paris' });
  $('#sub').textContent = `Bordeaux bus network · ${day}`;
  $('#live').textContent = demo ? 'Demo day' : 'Live data';
  $('#live').className = `lozenge ${demo ? 'info' : 'ok'}`;
  $('#mode-chips').innerHTML = [['demo', 'Frozen demo day'], ['live', 'Live open data']].map(([k, t]) => `<button data-mode="${k}" aria-pressed="${D.mode === k}">${t}</button>`).join('');
  $$('#mode-chips button').forEach((b) => (b.onclick = async () => { try { await call('saveSettings', { mode: b.dataset.mode }); location.reload(); } catch (e) { showFlag(e.message); } }));
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
    <b>Where should plans go?</b>
    <div class="actions"><label class="sr" for="space">Space</label><select id="space"><option>Loading spaces…</option></select><button class="btn primary" id="save-space">Use this space</button></div></div></div>`;
  const projects = await loadProjects().catch(() => []);
  $('#space').innerHTML = projects.length ? projects.map((p) => `<option value="${esc(p.key)}">${esc(p.name)} (${esc(p.key)})</option>`).join('') : '<option value="">No space available</option>';
  $('#save-space').disabled = !projects.length;
  $('#save-space').onclick = async () => {
    try { D.settings = await call('saveSettings', { project: $('#space').value }); } catch (e) { showFlag(e.message); return; }
    renderHead(); renderSetup(); renderDetail();
  };
}

const matches = (i) => !query || norm(i.title).includes(norm(query)) || norm(i.what).includes(norm(query)) || i.lines.some((l) => norm(l.short) === norm(query));
const count = (k) => D.items.filter((i) => i.outlook.light === k).length;
const street = (i) => i.title.replace(/, (Bordeaux|Bègles|Mérignac|Pessac|Talence|Cenon|Floirac|Lormont|Bruges|Eysines|Le Bouscat|Villenave-d'Ornon)$/, '');
// The row's one fact, in a few words: what is wrong, or what covers it.
function fact(i) {
  const { timeline: t, gaps = [] } = i.outlook;
  if (!t.detour) return 'No detour';
  if (t.gapDays) return `Detour ends ${shortDay(t.detour.to)} · ${t.gapDays} ${t.gapDays === 1 ? 'day' : 'days'} short`;
  if (gaps[0] === 'directions') return 'Detour runs one way';
  return `Detour until ${shortDay(t.detour.to)}`;
}
const shown = () => (seg === 'all' ? D.items : D.items.filter((i) => i.outlook.light === seg)).filter(matches);

function renderList() {
  // The filters double as the legend for the coloured dots on the list and the map.
  const segs = [['red', 'Problems', count('red')], ['amber', 'To check', count('amber')], ['green', 'Covered', count('green')], ['all', 'All', D.items.length]];
  $('#seg').innerHTML = segs.map(([k, label, n]) => `<button data-k="${k}" aria-pressed="${seg === k}">${k === 'all' ? '' : `<i class="dot ${k}" aria-hidden="true"></i>`}${label}<span class="n">${n}</span></button>`).join('');
  $$('#seg button').forEach((b) => (b.onclick = () => { seg = b.dataset.k; renderList(); drawOverview(); }));

  const list = shown();
  const box = $('#list');
  const scroll = box.scrollTop;
  box.innerHTML = list.length ? `<ul class="rows">${list.map((i) => `<li><button class="row" data-id="${esc(i.id)}" aria-pressed="${i.id === selected}">
      <span class="dot ${i.outlook.light}" role="img" aria-label="${esc(i.outlook.label)}"></span>
      <span class="body"><span class="t">${esc(street(i))}</span><span class="p">${esc(fact(i))}</span></span>
      <span class="when">${esc(shortDay(i.starts))}</span></button></li>`).join('')}</ul>`
    : `<div class="empty">${seg === 'red' ? 'Every published detour covers its roadworks.' : 'Nothing matches.'}</div>`;
  box.scrollTop = scroll;
  $$('.row', box).forEach((b) => (b.onclick = () => select(b.dataset.id)));
}

// ---------- the map ----------

function drawOverview() {
  big.all.clearLayers();
  const ids = new Set(shown().map((i) => i.id));
  // The selected one goes last, so nothing is drawn over it.
  const order = [...D.items.filter((i) => i.id !== selected), ...D.items.filter((i) => i.id === selected)];
  for (const i of order) {
    const on = i.id === selected;
    if (!on && !ids.has(i.id)) continue;
    const color = LIGHT_COLOR[i.outlook.light];
    const faded = selected && !on;
    const go = () => select(i.id);
    for (const g of i.geo) if (g.length > 1) cased(g, { color, weight: on ? 10 : 7, opacity: faded ? 0.6 : 1 }, big.all).on('click', go);
    const at = i.geo[0]?.[0];
    if (at && on) L.circleMarker(at, { radius: 24, color, weight: 3, fillColor: color, fillOpacity: 0.15, interactive: false }).addTo(big.all);
    if (at) L.circleMarker(at, { radius: on ? 13 : 9, color: '#fff', weight: 3, opacity: faded ? 0.7 : 1, fillColor: color, fillOpacity: faded ? 0.7 : 1 }).bindTooltip(esc(street(i))).on('click', go).addTo(big.all);
  }
}

// The selected disruption's own story: its routes in grey, published detours in green, its stops.
function drawFocus(d) {
  big.focus.clearLayers();
  if (!d) return;
  for (const l of d.lines) for (const g of d.lineGeo?.[l.id] || []) L.polyline(g, { color: COLORS.route, weight: 5, opacity: 0.75 }).bindTooltip(`${l.mode === 'TRAM' ? 'Tram' : 'Bus'} ${esc(l.short)}`).addTo(big.focus);
  for (const v of d.diversions || []) for (const g of v.geo) cased(g, { color: COLORS.detour, weight: 6, dashArray: '10 7' }, big.focus).bindTooltip(`Detour until ${esc(v.endsLabel)}`);
  for (const s of d.stops || []) L.circleMarker([s.lat, s.lon], { radius: 5, color: COLORS.stop, weight: 2.5, fillColor: '#fff', fillOpacity: 1 }).bindTooltip(esc(s.name)).addTo(big.focus);
  big.all.bringToFront();
}

function flyTo(points) {
  if (!points.length) return;
  big.invalidateSize();
  big.flyToBounds(L.latLngBounds(points), { ...CARD_PAD, duration: 0.6 });
}

function renderLegend() {
  const d = current;
  const keys = [['dot red', 'Problem'], ['dot amber', 'To check'], ['dot green', 'Covered']];
  if (d) keys.push(['sw route', 'Bus route'], ...(d.diversions?.length ? [['sw detour', 'Detour']] : []));
  $('#map-legend').innerHTML = keys.map(([c, t]) => `<span><i class="${c}"></i>${t}</span>`).join('');
}

async function select(id) {
  if (!id || id === selected) return;
  selected = id;
  current = null;
  const item = D.items.find((i) => i.id === id);
  renderList();
  drawOverview();
  drawFocus(null);
  flyTo(item.geo.flat());
  renderDetail();
  $(`.row[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest' });
  // On a phone the card sits below the map, so bring it into view.
  if (matchMedia('(max-width: 760px)').matches) $('#detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
  try {
    const d = await call('getItem', { id });
    if (selected !== id) return;
    current = d;
    drawFocus(d);
    // Frame the works with the detours around them, so the gap between the two is on screen.
    flyTo([...item.geo.flat(), ...d.diversions.flatMap((v) => v.geo.flat())]);
    renderDetail();
  } catch (e) {
    if (selected === id) $('#detail').innerHTML = `<div class="error">Could not load this: ${esc(e.message)}</div>`;
  }
}

// ---------- the card over the map ----------

function renderDetail() {
  renderLegend();
  const card = $('#detail');
  const item = D.items.find((i) => i.id === selected);
  card.hidden = !item;
  if (!item) return;
  const d = current;
  const cr = d?.changeRequest;
  const o = d?.outlook || item.outlook;
  const space = !!D.settings.project;
  card.innerHTML = `
    ${cr ? `<div class="card-top"><button class="link small" id="open-cr">Open in Jira ↗</button></div>` : ''}
    <h2>${esc(street(item))}</h2>
    <div class="what">${esc(item.what)}</div>
    ${badges(item.lines)}
    ${coverage(o)}
    ${space ? '' : '<div class="need-space">Choose a Jira space for plans first. <button class="link" id="go-space">Choose</button></div>'}
    ${d ? steps(cr, space, o) : '<div class="skeleton"></div>'}
    ${d ? `<button class="btn rovo" id="rovo-handle" ${space ? '' : 'disabled'}>${ROVO_ICON}Let Rovo handle it</button>` : ''}`;
  $('#go-space')?.addEventListener('click', () => { $('#space')?.focus(); $('#setup')?.scrollIntoView({ block: 'nearest' }); });
  if (d) wireCard(item, d);
}

const ROVO_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5l1.6 4.1 4.4.3-3.4 2.8 1.1 4.3L8 10.6 4.3 13l1.1-4.3L2 5.9l4.4-.3z" fill="currentColor"/></svg>';

// Takes a fresh card from the backend and brings the list and map in line with it.
function update(d) {
  current = d;
  const i = D.items.findIndex((x) => x.id === d.id);
  if (i >= 0) D.items[i] = { ...D.items[i], outlook: d.outlook, changeRequest: d.changeRequest ? { key: d.changeRequest.key } : null };
  renderList();
  drawOverview();
  renderDetail();
}

function wireCard(item, d) {
  const cr = d.changeRequest;
  wireSteps($('#detail'));
  // Answers and sign-offs send back only what changed; the card keeps its map.
  const run = (b, name, payload, after) => working(b, b.closest('li'), async () => {
    try {
      const out = await call(name, payload);
      after?.(out);
      if (current?.id === item.id) update({ ...current, ...out });
    } catch (err) { showFlag(err.message); }
  });
  $$('#detail [data-impact]').forEach((b) => (b.onclick = () => run(b, 'answer', { id: item.id, impact: b.dataset.impact }, (out) => { if (!cr) showFlag(`Saved in Jira as ${out.changeRequest.key}`); })));
  $$('#detail [data-role]').forEach((b) => (b.onclick = () => run(b, 'tick', { id: item.id, role: b.dataset.role, undo: b.getAttribute('aria-pressed') === 'true' })));
  $('#write-notice')?.addEventListener('click', () => askRovo(noticePrompt(cr.key)));
  $('#open-cr')?.addEventListener('click', () => openIssue(cr.key));
  $('#rovo-handle')?.addEventListener('click', () => askRovo(handlePrompt(item)));
}

// ---------- the welcome screen: three steps, once, before the desk ----------

// The demo day's case is the new road layout on Cours de la Marne, where the detour ends a week
// before the works. On live data it is the first roadworks whose published detour falls short.
const realCase = () => D.items.find((i) => i.id === 'works-197100' && i.outlook.light === 'red') || D.items.find((i) => i.outlook.light === 'red') || D.items[0];

// Small drawings in the map's own colours: a bus route, roadworks on it, a detour that stops short.
const ART = [
  `<svg viewBox="0 0 280 120" aria-hidden="true"><path d="M10 90 C70 90 90 40 140 40 S220 60 270 30" stroke="${COLORS.route}" stroke-width="6" fill="none" stroke-linecap="round"/>
    <path d="M115 44 C125 41 132 40 140 40 S158 42 168 45" stroke="${COLORS.works}" stroke-width="10" fill="none" stroke-linecap="round"/><circle cx="140" cy="40" r="9" fill="${COLORS.works}" stroke="#fff" stroke-width="3"/></svg>`,
  `<svg viewBox="0 0 280 120" aria-hidden="true"><path d="M10 90 C70 90 90 40 140 40 S220 60 270 30" stroke="${COLORS.route}" stroke-width="6" fill="none" stroke-linecap="round"/>
    <path d="M115 44 C125 41 132 40 140 40 S158 42 168 45" stroke="${COLORS.works}" stroke-width="10" fill="none" stroke-linecap="round"/>
    <path d="M100 52 C105 95 175 100 185 50" stroke="${COLORS.detour}" stroke-width="5" stroke-dasharray="9 7" fill="none"/>
    <g transform="translate(196 74)"><rect width="74" height="26" rx="13" fill="${LIGHT_COLOR.red}"/><text x="37" y="17.5" text-anchor="middle" font-size="12" font-weight="700" fill="#fff">ends early</text></g></svg>`,
  `<svg viewBox="0 0 280 120" aria-hidden="true">${['Operations', 'Scheduling', 'Passengers', 'Drivers'].map((t, i) => `<g transform="translate(${18 + i * 66} 28)">
    <circle cx="22" cy="22" r="20" fill="${i < 3 ? LIGHT_COLOR.green : 'none'}" stroke="${LIGHT_COLOR.green}" stroke-width="3"/>${i < 3 ? '<path d="M13 22 l6 6 l12 -12" stroke="#fff" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>' : ''}
    <text x="22" y="66" text-anchor="middle" font-size="11" fill="currentColor">${t}</text></g>`).join('')}</svg>`,
];
const STEPS = [
  ['Roadworks block bus routes', 'Every roadworks site on a bus route, on one map.'],
  ['Detours have to match', 'Detour Check flags detours that end too early or only run one way.'],
  ['Plan the fix in Jira', 'Each team signs off, and Rovo drafts the passenger notice.'],
];

function showTutorial(at = 0) {
  const box = $('#tutorial');
  box.hidden = false;
  const [title, text] = STEPS[at];
  const last = at === STEPS.length - 1;
  box.innerHTML = `<div class="tut" role="dialog" aria-modal="true" aria-labelledby="tut-title">
    <div class="art">${ART[at]}</div>
    <div class="dots" aria-hidden="true">${STEPS.map((_, i) => `<i class="${i === at ? 'on' : ''}"></i>`).join('')}</div>
    <h2 id="tut-title">${title}</h2><p>${text}</p>
    <div class="tut-actions"><button class="btn subtle" id="tut-skip">Skip</button><span></span>
      ${at ? '<button class="btn" id="tut-back">Back</button>' : ''}<button class="btn primary" id="tut-next">${last ? 'Show me a real case' : 'Next'}</button></div></div>`;
  const done = () => { store.set('tutorial-done', true); box.hidden = true; box.innerHTML = ''; box.onkeydown = null; };
  $('#tut-skip').onclick = done;
  // Escape closes it, and Tab stays inside it while it is open.
  box.onkeydown = (e) => {
    if (e.key === 'Escape') { done(); return; }
    if (e.key !== 'Tab') return;
    const f = $$('button', box);
    const i = f.indexOf(document.activeElement);
    if (e.shiftKey && i <= 0) { e.preventDefault(); f.at(-1).focus(); } else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
  };
  $('#tut-back')?.addEventListener('click', () => showTutorial(at - 1));
  $('#tut-next').onclick = () => { if (!last) return showTutorial(at + 1); done(); seg = 'red'; select(realCase().id); };
  $('#tut-next').focus();
}

async function startDesk() {
  $('#menu-btn').onclick = () => { const p = $('#menu-panel'); p.hidden = !p.hidden; $('#menu-btn').setAttribute('aria-expanded', String(!p.hidden)); };
  document.addEventListener('click', (e) => { if (!e.target.closest('.menu')) { $('#menu-panel').hidden = true; $('#menu-btn').setAttribute('aria-expanded', 'false'); } });
  $('#change-space').onclick = async () => {
    try { D.settings = await call('saveSettings', { project: null }); } catch (e) { showFlag(e.message); return; }
    renderHead(); renderSetup(); renderDetail();
  };
  $('#search').oninput = (e) => { query = e.target.value.trim(); renderList(); drawOverview(); };
  $('#show-guide').onclick = () => { $('#menu-panel').hidden = true; showTutorial(); };
  $('#ask-week').onclick = () => askRovo('What needs my attention this week? Start with change requests that fail their go-live check, then disruptions starting soon with no change request.');
  D = await call('getDesk');
  if (seg === 'red' && !count('red')) seg = 'all';
  TODAY = D.today;
  $('#loading').remove();
  $('#desk').hidden = false;
  $('#app').hidden = false;
  renderHead();
  renderSetup();
  big = makeMap($('#bigmap'));
  big.all = L.featureGroup().addTo(big);
  big.focus = L.layerGroup().addTo(big);
  renderList();
  drawOverview();
  big.fitBounds(D.items.flatMap((i) => i.geo.flat()), { padding: [30, 30] });
  if (store.get('tutorial-done')) select(realCase()?.id);
  else showTutorial();
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

async function renderPanel() {
  const root = $('#panel');
  const cr = P.changeRequest;
  if (!cr) {
    root.innerHTML = '<p class="dim">This work item was not planned from Detour Check. Open Detour Check from the Apps menu.</p>';
    return;
  }
  await loadNames(cr.signoffs.map((s) => s.by));
  const d = cr.disruption;
  const o = cr.outlook;
  root.innerHTML = `
    <div class="card-top">${o ? light(o) : ''}<button class="link small" id="rovo-handle">Let Rovo handle it</button></div>
    ${d ? `<h2>${esc(d.title)}</h2><div class="what">${esc(d.what)}</div>` : ''}
    ${badges(cr.lines)}
    ${coverage(o)}
    ${steps(cr, true, o)}
    <div class="panel-more">
      ${cr.impact === 'closed' || cr.impact === 'stops' ? `<label class="inline"><input type="checkbox" id="both" ${cr.directions === 'both' ? 'checked' : ''}> Both ways</label>` : ''}
      <label class="inline">Until <input type="date" id="ends" value="${esc(cr.ends || '')}"></label>
    </div>
    ${d ? `<details id="map-details"><summary>Map</summary><div id="panel-map"></div>${legend(d)}</details>` : ''}`;

  wireSteps(root);
  const save = async (changes, b) => {
    const go = async () => { try { P.changeRequest = await call('savePlan', changes); } catch (e) { showFlag(e.message); } };
    await (b ? working(b, b.closest('li'), go) : go());
    renderPanel();
  };
  $$('[data-impact]', root).forEach((b) => (b.onclick = () => save({ impact: b.dataset.impact }, b)));
  $('#both')?.addEventListener('change', (e) => save({ directions: e.target.checked ? 'both' : 'one' }));
  $('#ends').onchange = (e) => e.target.value && save({ ends: e.target.value });
  $$('[data-role]', root).forEach((b) => (b.onclick = async () => {
    await working(b, b.closest('li'), async () => {
      try { P.changeRequest = await call('signOff', { role: b.dataset.role, undo: b.getAttribute('aria-pressed') === 'true' }); } catch (e) { showFlag(e.message); }
    });
    renderPanel();
  }));
  $('#write-notice')?.addEventListener('click', () => askRovo(noticePrompt(P.key)));
  $('#rovo-handle').onclick = () => askRovo(d ? handlePrompt(d) : noticePrompt(P.key));
  $('#map-details')?.addEventListener('toggle', (e) => { if (e.target.open) mapInto($('#panel-map'), d); });
}

async function startPanel() {
  P = await call('getPanel');
  if (P.now) TODAY = new Date(P.now).toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
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
    await within(40000, 'Detour Check', isPanel ? startPanel() : startDesk());
  } catch (err) {
    const box = $('#loading') || document.body;
    box.innerHTML = `<div class="error"><span>Could not load: ${esc(err.message)}</span><button class="btn" id="retry">Retry</button></div>`;
    $('#retry').onclick = () => location.reload();
  }
}

start();
