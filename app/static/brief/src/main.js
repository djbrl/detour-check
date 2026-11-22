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
// Forge wraps every thrown error in its own sentence; people only need ours.
const call = async (name, payload = {}) => {
  try { return await (inJira ? (await bridge).invoke(name, payload) : (await local).invoke(name, payload)); } catch (e) {
    throw new Error(String(e?.message || e).replace(/^There was an error invoking the function - /, '').replace(/^Error: /, ''));
  }
};

const AGENT = { type: 'forge', agentKey: 'detour-check-agent', agentName: 'Detour Check' };
async function askRovo(prompt) {
  if (!inJira) { alert(`Rovo would open with:\n\n${prompt}`); return; }
  const b = await bridge;
  try { await b.rovo.open({ ...AGENT, prompt }); } catch (e) { showFlag(`Rovo is not available here: ${e.message}`); }
}
async function openIssue(key) {
  if (inJira) (await bridge).router.open(`/browse/${key}`);
}
// The page runs in Jira's iframe, which cannot follow a link itself: Jira opens it in a new tab.
async function openExternal(url) {
  if (inJira) (await bridge).router.open(url);
  else window.open(url, '_blank', 'noopener');
}
document.addEventListener('click', (e) => {
  const a = e.target.closest?.('a[href^="http"]');
  if (!a) return;
  e.preventDefault();
  openExternal(a.href);
});
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
const fullDay = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/Paris' });
const shortDay = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: iso.slice(0, 4) !== TODAY.slice(0, 4) ? 'numeric' : undefined, timeZone: 'Europe/Paris' });

// ---------- where the data comes from ----------

// Every feed is Bordeaux Métropole open data under the Licence Ouverte; the map tiles are OpenStreetMap.
const PORTAL = 'https://opendata.bordeaux-metropole.fr/explore/dataset/';
const LICENCE = 'https://www.etalab.gouv.fr/wp-content/uploads/2014/05/Licence_Ouverte.pdf';
const OSM = 'https://www.openstreetmap.org/copyright';
const ext = (href, text) => `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(text)}</a>`;
const feed = (id, text) => ext(`${PORTAL}${id}/`, text);
const ATTRIBUTION = `${ext(OSM, '© OpenStreetMap')} · ${ext('https://opendata.bordeaux-metropole.fr/', 'Bordeaux Métropole open data')}`;

// Which data the page shows, and from when: the frozen demo day, or the last live refresh.
const longDay = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Paris' });
const dataWhen = (d) => (d.mode === 'live' ? `Live, updated ${when(d.takenAt)}` : `Demo day, ${longDay(d.takenAt)}`);
const sources = (d) => `<p class="src-when">${esc(dataWhen(d))}</p>
  <ul class="src-list">
    <li>${feed('ci_chantier', 'Roadworks permits')}</li>
    <li>${feed('sv_devia_l', 'Bus detours')}</li>
    <li>${feed('sv_messa_a', 'Passenger messages')}</li>
    <li>${feed('sv_ligne_a', 'Lines')}, ${feed('sv_chem_l', 'routes')} and ${feed('sv_arret_p', 'stops')}</li>
  </ul>
  <p class="src-foot">${ext(LICENCE, 'Licence Ouverte')} · Map ${ext(OSM, '© OpenStreetMap')}</p>`;

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
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: ATTRIBUTION }).addTo(m);
  m.layer = L.layerGroup().addTo(m);
  // Leaflet measures its container when created, and a hidden tab gives it no size. Re-measure
  // before every fit, and fit again whenever the container is resized or shown.
  const fit = m.fitBounds.bind(m);
  m.fitBounds = (b, o) => { m.lastFit = [b, o]; m.invalidateSize(); return b.length && el.offsetWidth ? fit(b, o) : m; };
  new ResizeObserver(() => { if (!el.offsetWidth) return; m.invalidateSize(); if (m.lastFit?.[0].length) fit(...m.lastFit); }).observe(el);
  return m;
}

// Pins where the detours leave the route and where they rejoin it, named after the stop, so the
// stretch they cover reads at a glance. Each line has its own detour, so ends within a short walk
// of each other share one pin.
const NEAR = 0.0015; // about 150 m in Bordeaux, in degrees
const stopName = (n) => n?.replace(/\s*\(.*\)\s*$/, '');
const sameName = (n) => stopName(n)?.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
function detourEnds(d, layer) {
  const pins = [];
  for (const v of d.diversions || []) {
    const first = v.geo[0]?.[0];
    const last = v.geo.at(-1)?.at(-1);
    for (const [role, at, name] of [['Start', v.leaves ? [v.leaves.lat, v.leaves.lon] : first, v.leaves?.name], ['End', v.rejoins ? [v.rejoins.lat, v.rejoins.lon] : last, v.rejoins?.name]]) {
      if (!at) continue;
      let pin = pins.find((x) => Math.abs(x.at[0] - at[0]) < NEAR && Math.abs(x.at[1] - at[1]) < NEAR * 1.4);
      if (!pin) pins.push((pin = { at, names: [], roles: new Set() }));
      pin.roles.add(role);
      if (name && !pin.names.some((n) => sameName(n) === sameName(name))) pin.names.push(stopName(name));
    }
  }
  // A short label stays on the map; hovering it names the stop.
  for (const { at, names, roles } of pins) {
    const short = roles.size > 1 ? 'Start / End' : [...roles][0];
    const full = esc(`${short} of detour${names.length ? ` · ${names.slice(0, 2).join(', ')}` : ''}`);
    const pin = L.circleMarker(at, { radius: 7, color: COLORS.detour, weight: 3, fillColor: '#fff', fillOpacity: 1 })
      .bindTooltip(short, { permanent: true, direction: 'top', offset: [0, -8], className: 'pin-label' }).addTo(layer);
    pin.on('mouseover', () => pin.setTooltipContent(full)).on('mouseout', () => pin.setTooltipContent(short));
  }
}

function drawMap(map, d) {
  map.layer.clearLayers();
  for (const l of d.lines) for (const g of d.lineGeo?.[l.id] || []) L.polyline(g, { color: COLORS.route, weight: 4, opacity: 0.55 }).bindTooltip(`${l.mode === 'TRAM' ? 'Tram' : 'Bus'} ${esc(l.short)}: normal route`).addTo(map.layer);
  for (const v of d.diversions || []) for (const g of v.geo) L.polyline(g, { color: COLORS.detour, weight: 5, dashArray: '9 7' }).bindTooltip(`Published detour, ${esc(v.direction.toLowerCase())}, until ${esc(v.endsLabel)}`).addTo(map.layer);
  detourEnds(d, map.layer);
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
const badge = (l, picked) => {
  const inner = `${l.mode === 'TRAM' ? TRAM_ICON : BUS_ICON}${esc(l.short)}`;
  const title = `${l.mode === 'TRAM' ? 'Tram' : 'Bus'} ${esc(l.short)} · ${esc(l.name)}`;
  return picked === undefined
    ? `<span class="badge ${l.mode === 'TRAM' ? 'tram' : ''}" title="${title}">${inner}</span>`
    : `<button class="badge ${l.mode === 'TRAM' ? 'tram' : ''}" data-line="${esc(l.id)}" aria-pressed="${l.id === picked}" title="Show ${title} on the map">${inner}</button>`;
};
// With `picked`, the badges choose which line the map shows; without it they only name the lines.
const badges = (lines, picked) => `<div class="badges" ${picked === undefined ? '' : 'role="group" aria-label="Line on the map"'}>${lines.map((l) => badge(l, picked)).join('')}</div>`;

// The map shows one line at a time: its normal route and its own detours. A site on five lines can
// have six detours, and drawn together they hide each other.
const servesLine = (v, id) => v.lines.some((l) => l.id === id);
const firstLine = (d) => (d.lines.find((l) => d.diversions?.some((v) => servesLine(v, l.id))) || d.lines[0])?.id;
const oneLine = (d, id) => (d && id ? { ...d, lines: d.lines.filter((l) => l.id === id), diversions: (d.diversions || []).filter((v) => servesLine(v, id)) } : d);

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
  const range = (a, b) => `${a && b && a.slice(0, 4) !== b.slice(0, 4) ? fullDay(a) : shortDay(a)} – ${b ? (a && a.slice(0, 4) !== b.slice(0, 4) ? fullDay(b) : shortDay(b)) : '?'}`;
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
    ${row('Detour', d ? 'on' : o.light === 'red' ? 'off' : 'idle', d ? range(d.from, d.to) : 'None published')}
    ${missed ? row('No detour', 'off', missed) : ''}
  </div>`;
}

// What the works do to buses, in the words the card uses.
const ANSWERS = [['closed', 'Road closed, buses detour'], ['stops', 'Buses skip some stops'], ['narrowed', 'Buses slowed, lane narrowed'], ['none', 'No effect on buses']];
const ANSWER_TEXT = Object.fromEntries(ANSWERS);
const CHECK_SHORT = { diversion: 'Detour', directions: 'Both ways', dates: 'Whole time', notice: 'Riders told' };
const CHECK_MARK = { pass: ['ok', '✓'], fail: ['bad', '✕'], pending: ['wait', '◷'] };
// The checks each team's own work answers to (OWNS in src/desk.js).
const OWNS = { ops: ['diversion', 'directions', 'dates'], passengers: ['notice'] };
const TEAMS = [['ops', 'Operations'], ['scheduling', 'Scheduling'], ['passengers', 'Passenger info'], ['drivers', 'Drivers']];

// What the published information says about the works, and the answer that goes with it, so the
// first step is a yes or no on something the person can see.
function published(o) {
  const t = o?.timeline;
  // With no detour published there is no plan to confirm, and "no effect" is the one answer a safety
  // check must not suggest, so the question is asked plainly.
  if (!t?.detour) return { text: null, suggest: null };
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
  else if (gaps.includes('dates')) ops = `Extend the detour to ${shortDay([t.plan?.to, t.to].filter(Boolean).sort().at(-1))}`;
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
    ${keys.map((k, i) => `<button role="radio" data-impact="${k}" aria-checked="${cr?.impact === k}" tabindex="${cr?.impact === k || (!keys.includes(cr?.impact) && !i) ? 0 : -1}" ${off}>${ANSWER_TEXT[k]}</button>`).join('')}</div>`;
  const first = cr?.impact
    ? `<div class="step-k">Impact on buses</div>
      <div class="answered"><span>${ANSWER_TEXT[cr.impact]}${cr.directions === 'one' && !LOWER.has(cr.impact) ? ' · one way' : ''}</span><button class="link small" data-other aria-expanded="false" ${off}>Change</button></div>
      ${loweredNote(cr)}${choices(ANSWERS.map(([k]) => k))}${checks}`
    : pub.suggest ? `<div class="step-k">Is the published plan right?</div>
      <p class="published">${pub.text}</p>
      <div class="confirm"><button class="btn primary" data-impact="${pub.suggest}" ${off}>Yes, ${esc(ANSWER_TEXT[pub.suggest].toLowerCase())}</button><button class="btn" data-other aria-expanded="false" ${off}>No</button></div>
      ${choices(ANSWERS.map(([k]) => k).filter((k) => k !== pub.suggest))}`
    : `<div class="step-k">What happens to buses here?</div>
      ${choices(ANSWERS.map(([k]) => k)).replace(' hidden>', '>')}`;
  const jobs = tasks(cr, o);
  const notMine = (role) => role === 'ops' && cr?.lowered && ME && [cr.lowered.by, cr.lowered.reasonBy].includes(ME) && !sign(role)?.at;
  // As the backend refuses it: a team cannot sign off while a check its own work answers to fails.
  const held = (role) => !sign(role)?.at && r?.checks?.some((c) => c.state === 'fail' && OWNS[role]?.includes(c.id));
  if (notMine('ops')) jobs.ops = 'Someone else confirms: you lowered the impact';
  else if (held('ops')) jobs.ops = `${jobs.ops} first`;
  if (held('passengers')) jobs.passengers = `${jobs.passengers} first`;
  const teams = cr?.impact === 'none' ? TEAMS.slice(0, 1) : TEAMS;
  return `${cr?.liveFailing ? '<div class="live-fail">Live, but the checks no longer pass</div>' : r?.ready ? '<div class="ready">✓ Ready to go live: every team signed off and the checks pass.</div>' : ''}
  <ol class="steps">
    <li class="${cr?.impact ? 'answered' : 'now'}">${first}</li>
    <li class="${!cr?.impact ? 'later' : r?.ready ? 'done' : 'now'}"><div class="step-k">Team sign-offs</div>
      <div class="step-sub">Each team confirms its part is done${cr?.key ? `, recorded on ${esc(cr.key)}` : ''}.</div>
      <ul class="teams">${teams.map(([role, t]) => { const s = sign(role); return `<li><span class="team"><b>${t}</b><span>${esc(jobs[role])}</span></span>
        <button data-role="${role}" aria-pressed="${!!s?.at}" ${s?.at ? `title="Signed ${esc(when(s.at))}"` : ''} ${cr?.impact && !notMine(role) && !held(role) ? '' : 'disabled'}>${s?.at ? `✓ ${esc(names[s.by] || 'Signed')}` : 'Sign off'}</button></li>`; }).join('')}</ul></li>
    ${cr?.impact === 'none' ? '' : `<li class="${!cr?.impact ? 'later' : cr.notice ? 'answered' : 'now'}"><div class="step-k">Passenger notice</div>
      ${cr?.notice
        ? `<div class="answered"><span>Drafted on ${esc(cr.key)}, for Passenger info to check</span><button class="link small" id="write-notice">Rewrite</button></div>`
        : `<button class="btn" id="write-notice" ${cr?.impact ? '' : 'disabled'}>Write with Rovo</button>`}</li>`}
  </ol>`;
}

// Answers that ask less of the detour need a reason, and someone else then signs off for Operations.
const LOWER = new Set(['none', 'narrowed']);
// Asks for that reason in place, under the step that asked. Resolves to the text, or null on Cancel.
function askReason(anchor) {
  const li = anchor.closest('li') || anchor.closest('.panel-more');
  $('.why', li)?.remove();
  li.insertAdjacentHTML('beforeend', `<form class="why"><label for="why-text">Why?</label>
    <textarea id="why-text" rows="2" maxlength="500" required minlength="10"></textarea>
    <div class="actions"><button class="btn primary" type="submit" disabled>Save</button><button class="btn subtle" type="button" data-cancel>Cancel</button></div></form>`);
  const form = $('.why', li);
  const text = $('textarea', form);
  text.focus();
  text.oninput = () => { $('[type=submit]', form).disabled = text.value.trim().length < 10; };
  return new Promise((done) => {
    form.onsubmit = (e) => { e.preventDefault(); form.remove(); done(text.value.trim()); };
    $('[data-cancel]', form).onclick = () => { form.remove(); done(null); };
  });
}
const loweredNote = (cr) => (cr?.lowered ? `<p class="published">Why: ${esc(cr.lowered.reason)}${names[cr.lowered.by] ? ` · ${esc(names[cr.lowered.by])}` : ''}</p>`
  : cr?.readiness?.blocker === 'A reason for the lower impact' ? '<button class="link small" id="add-reason">Add a reason</button>' : '');

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
// A sign-off flips as soon as it is clicked; the answer that comes back confirms or restores it.
async function working(button, scope, fn) {
  scope.classList.add('waiting');
  if (button.matches('[data-role]')) button.setAttribute('aria-pressed', String(button.getAttribute('aria-pressed') !== 'true'));
  if (!button.querySelector('.spin')) button.insertAdjacentHTML('beforeend', '<i class="spin" aria-hidden="true"></i>');
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
let line = null; // the line the map shows for it
let big = null; // the desk's map, with one layer for every disruption and one for the selected one
const LIGHT_COLOR = { red: '#c9372c', amber: '#e56910', green: '#1f845a' };
// The card has its own column, so fitted shapes only keep clear of the map's edges.
const CARD_PAD = { padding: [40, 40], maxZoom: 16 };

function renderHead() {
  const demo = D.mode !== 'live';
  const day = new Date(demo ? D.takenAt : Date.now()).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Paris' });
  $('#sub').textContent = `Bordeaux bus network · ${day}`;
  // Live data older than half an hour says how old it is, so a stalled refresh never passes for now.
  const age = !demo && Date.now() - Date.parse(D.takenAt) > 30 * 60 * 1000 ? ` · ${when(D.takenAt)}` : '';
  const [label, tone] = D.liveLoading ? ['Getting live data', 'info'] : D.liveError ? ['Demo day · live unavailable', 'warn'] : demo ? ['Demo day', 'info'] : [`Live data${age}`, age ? 'warn' : 'ok'];
  $('#live').title = D.liveError ? `Live data is unavailable: ${D.liveError}. Showing the demo day.` : '';
  $('#live').innerHTML = `${D.liveLoading || refreshing ? '<i class="spin" aria-hidden="true"></i>' : ''}${label}`;
  $('#live').className = `lozenge ${tone}`;
  const chosen = D.settings.mode || D.mode;
  // Only an admin changes the data or the space, so nobody else is offered buttons that would refuse them.
  const admin = SETUP?.admin === true || setupFailed;
  $('#mode-chips').hidden = !admin;
  $('#change-space').hidden = !admin || !D.settings.project;
  $('#mode-chips').innerHTML = [['demo', 'Frozen demo day'], ['live', 'Live open data']].map(([k, t]) => `<button data-mode="${k}" aria-pressed="${chosen === k}">${t}</button>`).join('');
  $$('#mode-chips button').forEach((b) => (b.onclick = () => working(b, $('#mode-chips'), async () => {
    try { D.settings = await call('saveSettings', { mode: b.dataset.mode }); await refreshDesk(); } catch (e) { showFlag(e.message); }
  })));
  const sp = SETUP?.space;
  $('#space-name').textContent = !D.settings.project ? 'not chosen' : sp?.found ? `${sp.name} (${D.settings.project})` : D.settings.project;
  $('#space-facts').innerHTML = spaceFacts();
  $('#sources').innerHTML = sources(D);
}

// Only spaces this person can create work items in, service spaces first: their Change type
// carries the change fields a plan fills in.
async function loadProjects() {
  if (!inJira) return [{ key: 'NET', name: 'Network Changes', projectTypeKey: 'service_desk' }, { key: 'OPS', name: 'Operations', projectTypeKey: 'software' }];
  const b = await bridge;
  const out = [];
  for (let at = 0; at < 500; at += 100) {
    const res = await b.requestJira(`/rest/api/3/project/search?maxResults=100&startAt=${at}&orderBy=name&action=create`);
    const page = await res.json();
    out.push(...(page.values || []));
    if (page.isLast !== false) break;
  }
  return out;
}

// What the site has for Detour Check, asked once per page after the desk is drawn.
let SETUP = null;
// If the check itself fails, the controls show and the server still refuses non-admins.
let setupFailed = false;
// "Change" in the menu opens the chooser without clearing the current space.
let choosingSpace = false;
// The last answer this browser saw is drawn first. The gate's state takes longest to read (every
// workflow in the space), so it is asked for on its own and filled in when it arrives.
async function loadSetup() {
  const cached = store.get('setup');
  SETUP ||= cached;
  if (SETUP && D) { renderHead(); renderSetup(); }
  try { SETUP = await call('getSetup'); } catch (e) { console.warn(e); setupFailed = true; }
  // The backend keeps a reading for ten minutes; without one, this browser's last stands in.
  const kept = !!SETUP?.space?.gate;
  if (SETUP?.space && !kept && cached?.project === SETUP.project) SETUP.space.gate = cached.space?.gate || null;
  if (D) { renderHead(); renderSetup(); }
  if (SETUP?.admin && SETUP.space?.found && !kept) {
    try { const gate = await call('getGate'); if (SETUP?.space && gate) SETUP.space.gate = gate; } catch (e) { console.warn(e); }
    if (D) { renderHead(); renderSetup(); }
  }
  if (SETUP) store.set('setup', SETUP);
}

function spaceFacts() {
  const sp = SETUP?.space;
  if (!sp?.found) return '';
  const type = sp.issueType ? `${sp.issueType} work items` : '';
  const fields = sp.changeFields.length ? `${sp.changeFields.length} of ${sp.allFields} change fields` : 'no change fields';
  const teams = SETUP.teamGroups.length ? `Team groups for ${SETUP.teamGroups.length} of 4 teams` : 'Anyone who can edit a plan signs off';
  const g = sp.gate;
  const gate = !g ? '' : g.error ? 'Go-live check unknown' : g.missing.length ? `Go-live check missing on ${g.missing.length} of ${g.missing.length + g.guarded.length} transitions` : `Go-live check on ${g.guarded.length} transitions`;
  return `<p class="menu-note">${[type, fields, teams, gate].filter(Boolean).map(esc).join(' · ')}</p>`;
}

let setupDrawn = '';
// A fresh site is set up with one button: Detour Check creates a service space and adds its
// go-live check to the space's workflow. An admin can pick a space they already have instead.
async function renderSetup() {
  const box = $('#setup');
  const sp = SETUP?.space;
  // Drawn again only when something it shows changed, so a refresh never resets a choice in progress.
  const sig = JSON.stringify([D.settings.project, SETUP, setupFailed, choosingSpace]);
  if (sig === setupDrawn) return;
  setupDrawn = sig;
  // A chosen space that has since gone, or that this person cannot open plans in, says so here
  // rather than on the first plan.
  const broken = D.settings.project && sp && (!sp.found || !sp.canCreate);
  const noGate = D.settings.project && !broken && SETUP?.admin && sp?.gate && (sp.gate.error || sp.gate.missing.length);
  if ((D.settings.project && !broken && !noGate && !choosingSpace) || (!SETUP && !setupFailed)) { box.hidden = true; return; }
  box.hidden = false;
  if (SETUP && !SETUP.admin) {
    box.innerHTML = `<div class="notice info"><span class="icon" aria-hidden="true">i</span><div class="body">
      <b>${broken ? `Plans cannot be opened in ${esc(D.settings.project)}` : 'Detour Check is not set up yet'}</b>A Jira admin sets it up on this page.</div></div>`;
    return;
  }
  if (noGate && !choosingSpace) {
    box.innerHTML = `<div class="notice warn"><span class="icon" aria-hidden="true">!</span><div class="body">
      <b>Jira does not check plans before they go live in ${esc(sp.name)}</b>
      <div class="actions"><button class="btn primary" id="add-gate">Add the go-live check</button></div></div></div>`;
    $('#add-gate').onclick = () => setUp(D.settings.project, $('#add-gate'));
    return;
  }
  const fresh = !D.settings.project && !choosingSpace;
  box.innerHTML = `<div class="notice info"><span class="icon" aria-hidden="true">i</span><div class="body">
    <b>${broken ? `${esc(D.settings.project)} ${sp.found ? 'does not let you create work items' : 'is no longer on this site'}. Choose another space for plans.` : fresh ? 'Set up Detour Check' : 'Where should plans go?'}</b>
    ${fresh ? `<p>Creates a ${SPACE_NAME} space for plans, with Jira's go-live check on its workflow.</p>
    <div class="actions"><button class="btn primary" id="set-up">Set up</button><button class="btn subtle" id="pick-space">Use a space I have</button></div>`
    : `<div class="actions"><label class="sr" for="space">Space</label><select id="space"><option>Loading spaces…</option></select><button class="btn primary" id="save-space">Use this space</button>${(choosingSpace && !broken) || !D.settings.project ? '<button class="btn subtle" id="keep-space">Cancel</button>' : ''}</div>`}</div></div>`;
  if (fresh) {
    $('#set-up').onclick = () => setUp(null, $('#set-up'));
    $('#pick-space').onclick = () => { choosingSpace = true; renderSetup(); };
    return;
  }
  $('#keep-space')?.addEventListener('click', () => { choosingSpace = false; renderSetup(); });
  const projects = await loadProjects().catch(() => []);
  const group = (label, ps) => (ps.length ? `<optgroup label="${label}">${ps.map((p) => `<option value="${esc(p.key)}">${esc(p.name)} (${esc(p.key)})</option>`).join('')}</optgroup>` : '');
  const service = projects.filter((p) => p.projectTypeKey === 'service_desk');
  $('#space').innerHTML = `<option value="${NEW}">New space: ${SPACE_NAME}</option>${group('Service spaces', service)}${group('Other spaces', projects.filter((p) => p.projectTypeKey !== 'service_desk'))}`;
  if (D.settings.project) $('#space').value = D.settings.project;
  $('#save-space').onclick = () => setUp($('#space').value, $('#save-space'));
}

const SPACE_NAME = 'Roadworks Changes';
const NEW = '+new';
async function setUp(project, btn) {
  await working(btn, $('#setup'), async () => {
    let out;
    const create = project === NEW;
    try {
      out = await call('setUp', create ? { create } : { project });
      // A new space is made in one call and gets its go-live check in the next.
      if (out.next === 'gate') out = { ...(await call('setUp', { project: out.project }).catch((e) => ({ gate: { error: e.message } }))), project: out.project, created: out.created };
    } catch (e) { showFlag(e.message); return; }
    D.settings = { ...D.settings, project: out.project };
    choosingSpace = false;
    if (SETUP) SETUP.space = null;
    const gate = out.gate?.error ? ` The go-live check could not be added: ${out.gate.error}` : '';
    showFlag(`${out.created ? `Created ${SPACE_NAME} (${out.project}).` : `Plans go to ${out.project}.`}${gate}`);
    renderHead(); renderSetup(); renderDetail();
    await loadSetup();
  });
}

const matches = (i) => !query || norm(i.title).includes(norm(query)) || norm(i.what).includes(norm(query)) || i.lines.some((l) => norm(l.short) === norm(query));
const count = (k) => D.items.filter((i) => i.outlook.light === k).length;
// A search looks at every site, so each tab counts what matches it.
const found = (k) => D.items.filter((i) => (k === 'all' || i.outlook.light === k) && matches(i)).length;
const street = (i) => i.title.replace(/, (Bordeaux|Bègles|Mérignac|Pessac|Talence|Cenon|Floirac|Lormont|Bruges|Eysines|Le Bouscat|Villenave-d'Ornon)$/, '');
// The row's one fact, in a few words: what is wrong, or what covers it.
function fact(i) {
  const { timeline: t, gaps = [] } = i.outlook;
  if (i.changeRequest?.liveFailing) return 'Live, but the checks no longer pass';
  if (!t.detour) return 'No detour';
  if (t.gapDays) return `Detour ends ${shortDay(t.detour.to)} · ${t.gapDays} ${t.gapDays === 1 ? 'day' : 'days'} short`;
  if (gaps[0] === 'directions') return 'Detour runs one way';
  return `Detour until ${shortDay(t.detour.to)}`;
}
const shown = () => (seg === 'all' ? D.items : D.items.filter((i) => i.outlook.light === seg)).filter(matches);
// An empty tab says where the matches are instead, so a search never looks like it found nothing.
function empty(segs) {
  const [, here] = segs.find(([k]) => k === seg);
  const elsewhere = segs.filter(([k, , n]) => k !== seg && k !== 'all' && n).map(([, label, n]) => `${n} in ${label}.`);
  if (elsewhere.length) return `None in ${here}. ${elsewhere.join(' ')}`;
  return query ? 'Nothing matches.' : seg === 'red' ? 'No problems.' : 'None here.';
}

function renderList() {
  // The filters double as the legend for the coloured dots on the list and the map.
  const segs = [['red', 'Problems', found('red')], ['amber', 'To check', found('amber')], ['green', 'Covered', found('green')], ['all', 'All', found('all')]];
  $('#seg').innerHTML = segs.map(([k, label, n]) => `<button data-k="${k}" aria-pressed="${seg === k}">${k === 'all' ? '' : `<i class="dot ${k}" aria-hidden="true"></i>`}${label}<span class="n">${n}</span></button>`).join('');
  $$('#seg button').forEach((b) => (b.onclick = () => { seg = b.dataset.k; renderList(); drawOverview(); }));

  const list = shown();
  const box = $('#list');
  const scroll = box.scrollTop;
  box.innerHTML = list.length ? `<ul class="rows">${list.map((i) => `<li><button class="row" data-id="${esc(i.id)}" aria-pressed="${i.id === selected}">
      <span class="dot ${i.outlook.light}" role="img" aria-label="${esc(i.outlook.label)}"></span>
      <span class="body"><span class="t">${esc(street(i))}</span><span class="p">${esc(fact(i))}</span></span>
      <span class="when">${esc(shortDay(i.starts))}</span></button></li>`).join('')}</ul>`
    : `<div class="empty">${empty(segs)}</div>`;
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
  detourEnds(d, big.focus);
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
  if (d) keys.push(['sw route', 'Bus route'], ...(oneLine(d, line).diversions?.length ? [['sw detour', 'Detour']] : []));
  $('#map-legend').innerHTML = keys.map(([c, t]) => `<span><i class="${c}"></i>${t}</span>`).join('');
}

// Draws the chosen line and frames the works with its detours, so the gap between them is on screen.
function showLine(item) {
  const d = oneLine(current, line);
  drawFocus(d);
  flyTo([...item.geo.flat(), ...d.diversions.flatMap((v) => v.geo.flat())]);
}

async function select(id) {
  if (!id || id === selected) return;
  selected = id;
  current = null;
  line = null;
  const item = D.items.find((i) => i.id === id);
  renderList();
  drawOverview();
  drawFocus(null);
  flyTo(item.geo.flat());
  renderDetail();
  $(`.row[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest' });
  // On a phone the card sits below the map, so bring it into view.
  if (matchMedia('(max-width: 899px)').matches) $('#detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
  await loadItem(id, item);
}

// A cold start can leave the first request hanging; after 12 s it is asked again once, and a
// failure says so with a way to retry, so the card never waits on a grey placeholder for good.
async function loadItem(id, item, attempt = 1) {
  try {
    const d = await within(12000, 'This roadworks site', call('getItem', { id }));
    if (selected !== id) return;
    current = d;
    line = firstLine(d);
    showLine(item);
    renderDetail();
  } catch (e) {
    if (selected !== id || current) return;
    if (attempt === 1) return loadItem(id, item, 2);
    $('#detail').innerHTML = `<div class="error">Could not load this: ${esc(e.message)} <button class="btn" id="retry-item">Retry</button></div>`;
    $('#retry-item').onclick = () => { renderDetail(); loadItem(id, item); };
  }
}

// ---------- the card over the map ----------

function renderDetail() {
  renderLegend();
  const card = $('#detail');
  const item = D.items.find((i) => i.id === selected);
  card.hidden = !item;
  $('.stage').classList.toggle('with-card', !!item);
  if (!item) return;
  const d = current;
  const cr = d?.changeRequest;
  // Who signed is a second round trip, so the card is drawn first and again once names arrive.
  const who = [...(cr?.signoffs || []).map((s) => s.by), cr?.lowered?.by].filter((id) => id && !(id in names));
  if (who.length && inJira) loadNames(who).then(() => { if (current === d) renderDetail(); });
  const o = d?.outlook || item.outlook;
  const space = !!D.settings.project;
  card.innerHTML = `
    ${cr ? `<div class="card-top"><button class="link small" id="open-cr">Open in Jira ↗</button></div>` : ''}
    <h2>${esc(street(item))}</h2>
    <div class="what">${esc(item.what)}</div>
    ${badges(item.lines, d ? line : undefined)}
    ${coverage(o)}
    ${space ? '' : '<div class="need-space">Choose a Jira space for plans first. <button class="link" id="go-space">Choose</button></div>'}
    ${d ? steps(cr, space, o) : SKELETON_STEPS}
    ${d ? `<button class="btn rovo" id="rovo-handle" ${space ? '' : 'disabled'}>${ROVO_ICON}Let Rovo handle it</button>` : ''}`;
  $$('#detail [data-line]').forEach((b) => (b.onclick = () => { line = b.dataset.line; showLine(item); renderDetail(); }));
  $('#go-space')?.addEventListener('click', () => { $('#space')?.focus(); $('#setup')?.scrollIntoView({ block: 'nearest' }); });
  if (d) wireCard(item, d);
}

// Placeholders the size of what replaces them, so nothing below moves when it arrives.
const SKELETON_STEPS = `<div class="sk-steps" aria-hidden="true"><i class="skeleton sk-line"></i><i class="skeleton sk-block"></i><i class="skeleton sk-line"></i>${'<i class="skeleton sk-team"></i>'.repeat(4)}<i class="skeleton sk-line"></i><i class="skeleton sk-btn"></i></div>`;
const SKELETON_PANEL = `<div class="sk-panel" aria-hidden="true"><i class="skeleton sk-top"></i><i class="skeleton sk-title"></i><i class="skeleton sk-line"></i><i class="skeleton sk-badges"></i><i class="skeleton sk-cov"></i>${SKELETON_STEPS}</div>`;

const ROVO_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5l1.6 4.1 4.4.3-3.4 2.8 1.1 4.3L8 10.6 4.3 13l1.1-4.3L2 5.9l4.4-.3z" fill="currentColor"/></svg>';

// Takes a fresh card from the backend and brings the list and map in line with it.
function update(d) {
  current = d;
  const i = D.items.findIndex((x) => x.id === d.id);
  if (i >= 0) D.items[i] = { ...D.items[i], outlook: d.outlook, changeRequest: d.changeRequest ? { key: d.changeRequest.key, liveFailing: d.changeRequest.liveFailing } : null };
  renderList();
  drawOverview();
  renderDetail();
}

// Rovo works in its own chat, so while it may be writing to this plan the card asks again every few
// seconds and shows what it recorded, for up to five minutes or until another card is opened.
const said = (d) => JSON.stringify([d?.changeRequest?.key, d?.changeRequest?.impact, d?.changeRequest?.notice, d?.changeRequest?.signoffs?.map((s) => s.at)]);
let following = null;
function follow(id) {
  clearInterval(following);
  const until = Date.now() + 5 * 60 * 1000;
  following = setInterval(async () => {
    if (selected !== id || Date.now() > until) { clearInterval(following); return; }
    try {
      const out = await call('getItem', { id, slim: true });
      if (selected === id && current?.id === id && said(out) !== said(current)) update({ ...current, ...out });
    } catch { /* the next round tries again */ }
  }, 5000);
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
  $$('#detail [data-impact]').forEach((b) => (b.onclick = async () => {
    const impact = b.dataset.impact;
    const reason = (LOWER.has(impact) || cr?.directions === 'one') && impact !== cr?.impact ? await askReason(b) : '';
    if (reason === null) return;
    run(b, 'answer', { id: item.id, impact, reason }, (out) => { if (!cr) showFlag(`Saved in Jira as ${out.changeRequest.key}`); });
  }));
  $$('#detail [data-role]').forEach((b) => (b.onclick = () => { const signed = b.getAttribute('aria-pressed') !== 'true'; run(b, 'tick', { id: item.id, role: b.dataset.role, signed }); }));
  $('#add-reason')?.addEventListener('click', async (e) => {
    const reason = await askReason(e.target);
    if (reason) run(e.target, 'answer', { id: item.id, impact: cr.impact, reason });
  });
  $('#write-notice')?.addEventListener('click', () => { askRovo(noticePrompt(cr.key)); follow(item.id); });
  $('#open-cr')?.addEventListener('click', () => openIssue(cr.key));
  $('#rovo-handle')?.addEventListener('click', () => { askRovo(handlePrompt(item)); follow(item.id); });
}

// ---------- the welcome screen: the situation, the problem, the fix, then how to start ----------

// The demo day's case is the new road layout on Cours de la Marne, where the detour ends a week
// before the works. On live data it is the first roadworks whose published detour falls short.
const realCase = () => D.items.find((i) => i.id === 'works-197100') || D.items.find((i) => i.outlook.light === 'red') || D.items[0];

// Today's roadworks as dots where they really are, so the first steps show this data, not a drawing.
// `paint` sorts each one into base, ok (has a detour), check or gap (falls short); gaps are drawn last.
function dotMap(paint, label) {
  const pts = D.items.map((i) => ({ at: i.geo[0]?.[0], k: paint(i) })).filter((p) => p.at);
  if (!pts.length) return '';
  const W = 320;
  const H = 150;
  const pad = 16;
  const k = Math.cos((44.84 * Math.PI) / 180); // a degree of longitude is shorter than one of latitude here
  const lats = pts.map((p) => p.at[0]);
  const lons = pts.map((p) => p.at[1]);
  const [x0, x1, y0, y1] = [Math.min(...lons), Math.max(...lons), Math.min(...lats), Math.max(...lats)];
  const s = Math.min((W - 2 * pad) / ((x1 - x0) * k || 1e-3), (H - 2 * pad) / (y1 - y0 || 1e-3));
  const ox = (W - (x1 - x0) * k * s) / 2;
  const oy = (H - (y1 - y0) * s) / 2;
  const rank = { base: 0, ok: 1, check: 1, gap: 2 };
  const dots = pts.sort((a, b) => rank[a.k] - rank[b.k]).map((p) => {
    const x = (ox + (p.at[1] - x0) * k * s).toFixed(1);
    const y = (oy + (y1 - p.at[0]) * s).toFixed(1);
    return `${p.k === 'gap' ? `<circle cx="${x}" cy="${y}" r="9" class="ring"/>` : ''}<circle cx="${x}" cy="${y}" r="${p.k === 'base' ? 3.5 : 4.5}" class="${p.k}"/>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" class="dotmap" role="img" aria-label="${esc(label)}">${dots.join('')}</svg>`;
}

// Drawings in the map's own colours. Each draws one idea: the problem, the fix, the desk.
const STUCK = `<svg viewBox="0 0 320 150" aria-hidden="true">
  <defs><pattern id="tut-hatch" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="10" height="10" class="works"/><rect width="5" height="10" class="hatch"/></pattern></defs>
  <path d="M16 110 H304" class="route"/>
  <g transform="translate(52 72)"><rect width="62" height="32" rx="8" class="bus"/><rect x="7" y="7" width="13" height="10" rx="2" class="win"/><rect x="24" y="7" width="13" height="10" rx="2" class="win"/><rect x="41" y="7" width="13" height="10" rx="2" class="win"/><circle cx="15" cy="33" r="5" class="wheel"/><circle cx="47" cy="33" r="5" class="wheel"/></g>
  <g transform="translate(134 76)"><path d="M8 14 V36 M44 14 V36" class="leg"/><rect width="52" height="16" rx="3" fill="url(#tut-hatch)"/></g>
  <path d="M246 112 V50" class="pole"/><rect x="235" y="34" width="22" height="22" rx="5" class="sign"/><path d="M241 41 h10 v8 h-10 z M241 45 h10" class="glyph"/>
  <circle cx="276" cy="74" r="7" class="person"/><path d="M266 110 V92 a10 10 0 0 1 20 0 V110 z" class="person"/>
  <circle cx="294" cy="50" r="10" class="clock"/><path d="M294 44 V50 H299" class="hand"/>
</svg>`;
const PLAN = `<svg viewBox="0 0 320 150" aria-hidden="true">
  <rect x="24" y="16" width="272" height="118" rx="10" class="paper"/>
  <rect x="40" y="32" width="18" height="18" rx="4" class="cr"/><path d="M44 38 h9 l-3 -3 M54 44 h-9 l3 3" class="glyph"/>
  <text x="66" y="45" class="key">177 Cours de la Marne</text>
  ${[0, 1, 2, 3].map((n) => `<g transform="translate(${52 + n * 30} 82)">${n < 3 ? '<circle r="12" class="signed"/><path d="M-5 0 l3.5 3.5 l6.5 -7" class="tick"/>' : '<circle r="11" class="unsigned"/>'}</g>`).join('')}
  <text x="40" y="117" class="small">3 of 4 teams signed off</text>
  <rect x="180" y="62" width="100" height="58" rx="8" class="note"/>
  <path d="M194 70 l2.2 5.4 5.8 .4 -4.5 3.7 1.5 5.7 -5 -3.2 -5 3.2 1.5 -5.7 -4.5 -3.7 5.8 -.4z" class="star"/>
  <rect x="210" y="73" width="56" height="6" rx="3" class="line"/><rect x="190" y="90" width="76" height="6" rx="3" class="line"/><rect x="190" y="104" width="52" height="6" rx="3" class="line"/>
</svg>`;
const DESK = `<svg viewBox="0 0 320 150" aria-hidden="true">
  <rect x="14" y="12" width="292" height="126" rx="10" class="paper"/>
  <rect x="20" y="20" width="92" height="20" rx="4" class="sel"/>
  ${[['gap', 58], ['gap', 44], ['check', 52], ['ok', 40], ['ok', 50]].map(([k, w], n) => `<circle cx="32" cy="${30 + n * 22}" r="4" class="${k}"/><rect x="42" y="${27 + n * 22}" width="${w}" height="6" rx="3" class="bar"/>`).join('')}
  <path d="M118 12 V138" class="rule"/>
  <path d="M124 118 C160 112 170 70 206 64 S250 52 300 40" class="route thin"/>
  <path d="M184 76 C192 70 200 66 212 63" class="works-line"/>
  <path d="M150 104 C150 128 196 120 192 86" class="detour"/>
  <rect x="226" y="58" width="72" height="72" rx="8" class="paper"/>
  ${[0, 1, 2].map((n) => `<circle cx="240" cy="${76 + n * 18}" r="6" class="${n ? 'todo' : 'now'}"/><rect x="252" y="${73 + n * 18}" width="${36 - n * 6}" height="6" rx="3" class="bar"/>`).join('')}
</svg>`;

const num = (n, k) => `<b class="num ${k}">${n}</b>`;
// Each step: a picture, a title and one line. The counts are today's, in demo or live mode alike.
function tourSteps() {
  const detoured = D.items.filter((i) => i.outlook.timeline?.detour).length;
  const gaps = count('red');
  const checks = count('amber');
  const cap = `<figcaption>${feed('ci_chantier', 'Bordeaux Métropole open data')}<span>${esc(dataWhen(D))}</span></figcaption>`;
  return [
    {
      art: dotMap((i) => (i.outlook.timeline?.detour ? 'ok' : 'base'), 'Roadworks on bus routes, as dots on a map of Bordeaux') + cap,
      title: `${D.items.length} roadworks on Bordeaux bus routes`,
      text: `The bus network publishes a detour for ${num(detoured, 'ok')} of them.`,
    },
    {
      art: STUCK,
      title: 'No detour, no bus',
      text: 'Buses get stuck at the works, and riders wait at stops no bus will reach.',
    },
    {
      art: dotMap((i) => ({ red: 'gap', amber: 'check' })[i.outlook.light] || 'base', 'Roadworks whose detour falls short or is missing, on a map of Bordeaux'),
      title: 'Detour Check finds the gaps',
      text: gaps || checks ? `${num(gaps, 'gap')} ${gaps === 1 ? 'is a problem' : 'are problems'}, and ${num(checks, 'check')} more roadworks need a closer look.` : 'None today: every published detour covers its roadworks.',
    },
    {
      art: PLAN,
      title: 'Each fix becomes a change request',
      text: 'Each team signs off on the change request in Jira, and Rovo drafts the passenger notice.',
    },
    {
      art: DESK,
      title: 'Start with the red ones',
      text: 'Pick one, confirm what happens to buses, then collect the sign-offs.',
    },
  ];
}

function showTutorial(at = 0) {
  const box = $('#tutorial');
  box.hidden = false;
  const steps = tourSteps();
  const { art, title, text } = steps[at];
  const last = at === steps.length - 1;
  box.innerHTML = `<div class="tut" role="dialog" aria-modal="true" aria-labelledby="tut-title">
    <figure class="art">${art}</figure>
    <div class="dots" aria-label="Step ${at + 1} of ${steps.length}">${steps.map((_, i) => `<i class="${i === at ? 'on' : ''}"></i>`).join('')}</div>
    <h2 id="tut-title">${esc(title)}</h2><p>${text}</p>
    <div class="tut-actions"><button class="btn subtle" id="tut-skip">Skip</button><span></span>
      ${at ? '<button class="btn" id="tut-back">Back</button>' : ''}<button class="btn primary" id="tut-next">${last ? 'Show me a real case' : 'Next'}</button></div></div>`;
  const done = () => { store.set('tutorial-done', true); box.hidden = true; box.innerHTML = ''; box.onkeydown = null; };
  $('#tut-skip').onclick = done;
  // Escape closes it, the arrow keys move between steps, and Tab stays inside it while it is open.
  box.onkeydown = (e) => {
    if (e.key === 'Escape') { done(); return; }
    if (e.key === 'ArrowRight' && !last) { showTutorial(at + 1); return; }
    if (e.key === 'ArrowLeft' && at) { showTutorial(at - 1); return; }
    if (e.key !== 'Tab') return;
    const f = $$('button, a', box);
    const i = f.indexOf(document.activeElement);
    if (e.shiftKey && i <= 0) { e.preventDefault(); f.at(-1).focus(); } else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
  };
  $('#tut-back')?.addEventListener('click', () => showTutorial(at - 1));
  $('#tut-next').onclick = () => {
    if (!last) return showTutorial(at + 1);
    done();
    const real = realCase();
    seg = real.outlook.light === 'red' ? 'red' : 'all';
    renderList();
    select(real.id);
  };
  $('#tut-next').focus();
}

async function startDesk() {
  $('#menu-btn').onclick = () => { const p = $('#menu-panel'); p.hidden = !p.hidden; $('#menu-btn').setAttribute('aria-expanded', String(!p.hidden)); };
  const closeMenu = () => { $('#menu-panel').hidden = true; $('#menu-btn').setAttribute('aria-expanded', 'false'); };
  document.addEventListener('click', (e) => { if (!e.target.closest('.menu')) closeMenu(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#menu-panel').hidden) { closeMenu(); $('#menu-btn').focus(); } });
  $('#change-space').onclick = () => {
    $('#menu-panel').hidden = true;
    choosingSpace = true;
    renderSetup();
    $('#setup').scrollIntoView({ block: 'nearest' });
  };
  $('#search').oninput = (e) => { query = e.target.value.trim(); renderList(); drawOverview(); };
  $('#show-guide').onclick = () => { $('#menu-panel').hidden = true; showTutorial(); };
  $('#ask-week').onclick = () => askRovo('What needs my attention this week? Start with change requests that fail their go-live check, then disruptions starting soon with no change request.');
  // The last desk this browser saw is drawn straight away, so nobody waits on a blank page; the fresh
  // one replaces it a moment later. Without one, the skeleton waits for the first answer.
  const saved = store.get('desk');
  if (saved?.items?.length) showDesk(saved);
  const setup = loadSetup();
  await refreshDesk(!saved?.items?.length);
  await setup;
}

let refreshing = false;
let livePoll = null;
let waitingSince = 0;
// Fetches the desk and redraws what changed. While live data is still being built, the demo day
// stands in and the page asks again every five seconds until it lands.
async function refreshDesk(first = false) {
  refreshing = true;
  if (D) renderHead();
  try {
    const fresh = await call('getDesk');
    const wasLoading = D?.liveLoading;
    store.set('desk', fresh);
    refreshing = false;
    clearTimeout(livePoll);
    // Waiting on live data stops after three minutes; the demo day stays and the page says so.
    if (fresh.liveLoading && !waitingSince) waitingSince = Date.now();
    if (fresh.liveLoading && Date.now() - waitingSince > 3 * 60 * 1000) Object.assign(fresh, { liveLoading: false, liveError: 'it is taking too long' });
    if (!fresh.liveLoading) waitingSince = 0;
    showDesk(fresh);
    if (wasLoading && fresh.liveError) showFlag(`Live data is unavailable (${fresh.liveError}), so this is the demo day.`);
    else if (wasLoading && !fresh.liveLoading) showFlag('Live data is ready');
    if (fresh.liveLoading) livePoll = setTimeout(() => refreshDesk(), 5000);
  } catch (e) {
    refreshing = false;
    if (first) throw e;
    if (D) renderHead();
    showFlag(`Could not refresh: ${e.message}`);
  }
}

function showDesk(data) {
  const firstTime = !D;
  D = data;
  TODAY = D.today;
  if (firstTime) {
    if (seg === 'red' && !count('red')) seg = 'all';
    $('#loading')?.remove();
    $('#desk').hidden = false;
    $('#app').hidden = false;
    big = makeMap($('#bigmap'));
    big.all = L.featureGroup().addTo(big);
    big.focus = L.layerGroup().addTo(big);
  }
  renderHead();
  renderSetup();
  renderList();
  drawOverview();
  if (firstTime) {
    big.fitBounds(D.items.flatMap((i) => i.geo.flat()), { padding: [30, 30] });
    if (store.get('tutorial-done')) select(realCase()?.id);
    else showTutorial();
  } else if (!D.items.some((i) => i.id === selected)) {
    // The selected roadworks is not in this data (another mode or day), so start from the real case.
    selected = null;
    current = null;
    select(realCase()?.id);
  } else renderDetail();
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
  // Asked once: a name Jira does not give stays "Signed", and is not asked for again on every redraw.
  for (const id of missing) if (!(id in names)) names[id] = null;
}

let followingPanel = null;
function followPanel() {
  clearInterval(followingPanel);
  const until = Date.now() + 5 * 60 * 1000;
  followingPanel = setInterval(async () => {
    if (Date.now() > until) { clearInterval(followingPanel); return; }
    try {
      const next = await call('getPanel');
      if (said(next) !== said(P)) { P = next; renderPanel(); }
    } catch { /* the next round tries again */ }
  }, 5000);
}

let panelLine = null;
async function renderPanel() {
  const root = $('#panel');
  const cr = P.changeRequest;
  if (!cr) {
    root.innerHTML = '<p class="dim">This work item was not planned from Detour Check. Open Detour Check from the Apps menu.</p>';
    return;
  }
  // Names are a second round trip, so the panel is drawn first and again once they arrive.
  const who = [...cr.signoffs.map((s) => s.by), cr.lowered?.by].filter((id) => id && !(id in names));
  if (who.length && inJira) loadNames(who).then(() => { if (P?.changeRequest === cr) renderPanel(); });
  const d = cr.disruption;
  const o = cr.outlook;
  if (d && !d.lines.some((l) => l.id === panelLine)) panelLine = firstLine(d);
  root.innerHTML = `
    <div class="card-top">${o ? light(o) : ''}<button class="link small" id="rovo-handle">Let Rovo handle it</button></div>
    ${d ? `<h2>${esc(d.title)}</h2><div class="what">${esc(d.what)}</div>` : ''}
    ${badges(cr.lines, d ? panelLine : undefined)}
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
    await (b ? working(b, b.closest('li') || b.closest('.panel-more') || b, go) : go());
    renderPanel();
  };
  $$('[data-impact]', root).forEach((b) => (b.onclick = async () => {
    const impact = b.dataset.impact;
    const lowering = LOWER.has(impact) || (cr.directions === 'one' && !LOWER.has(cr.impact));
    const reason = lowering && impact !== cr.impact ? await askReason(b) : '';
    if (reason !== null) save({ impact, reason }, b);
  }));
  $('#both')?.addEventListener('change', async (e) => {
    const reason = e.target.checked ? '' : await askReason(e.target);
    if (reason === null) { e.target.checked = true; return; }
    save({ directions: e.target.checked ? 'both' : 'one', reason }, e.target.closest('label'));
  });
  // A typed date passes through several valid days on the way (0002, 0020, 0202, 2026), so it is
  // saved once typing settles or the field is left, not on every keystroke.
  const ends = $('#ends');
  let endsTimer = null;
  const saveEnds = () => { clearTimeout(endsTimer); endsTimer = null; if (ends.value && ends.value !== ends.defaultValue) save({ ends: ends.value }, ends.closest('label')); };
  ends.oninput = ends.onchange = () => { clearTimeout(endsTimer); endsTimer = setTimeout(saveEnds, 1200); };
  ends.onblur = () => { if (endsTimer) saveEnds(); };
  $$('[data-role]', root).forEach((b) => (b.onclick = async () => {
    const signed = b.getAttribute('aria-pressed') !== 'true';
    await working(b, b.closest('li'), async () => {
      try { P.changeRequest = await call('signOff', { role: b.dataset.role, signed }); } catch (e) { showFlag(e.message); }
    });
    renderPanel();
  }));
  $('#add-reason')?.addEventListener('click', async (e) => {
    const reason = await askReason(e.target);
    if (reason) save({ reason }, e.target);
  });
  $('#write-notice')?.addEventListener('click', () => { askRovo(noticePrompt(P.key)); followPanel(); });
  $('#rovo-handle').onclick = () => { askRovo(d ? handlePrompt(d) : noticePrompt(P.key)); followPanel(); };
  $('#map-details')?.addEventListener('toggle', (e) => { if (e.target.open) mapInto($('#panel-map'), oneLine(d, panelLine)); });
  $$('[data-line]', root).forEach((b) => (b.onclick = () => {
    panelLine = b.dataset.line;
    $$('[data-line]', root).forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.line === panelLine)));
    const details = $('#map-details');
    details.open = true;
    mapInto($('#panel-map'), oneLine(d, panelLine));
  }));
}

// The work item can change elsewhere (Rovo, the desk, another tab), so the panel re-reads it when
// it comes back into view and every 30 seconds while visible.
async function refreshPanel() {
  if (document.hidden) return;
  try { const next = await call('getPanel'); if (said(next) !== said(P)) { P = next; renderPanel(); } } catch { /* the next round tries again */ }
}

async function startPanel() {
  document.addEventListener('visibilitychange', refreshPanel);
  window.addEventListener('focus', refreshPanel);
  setInterval(refreshPanel, 30000);
  // The panel's own outline holds its place while it loads, so Jira resizes it once.
  $('#loading').innerHTML = SKELETON_PANEL;
  P = await call('getPanel');
  if (P.now) TODAY = new Date(P.now).toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
  $('#loading').remove();
  $('#panel').hidden = false;
  await renderPanel();
}

// ---------- start ----------

// The person using the page, so a button they may not use is shown that way before they click it.
let ME = null;
const within = (ms, what, promise) => Promise.race([promise, new Promise((_, no) => setTimeout(() => no(new Error(`${what} did not answer within ${ms / 1000} s`)), ms))]);

async function start() {
  let isPanel = new URLSearchParams(location.search).has('panel');
  if (inJira) {
    const b = await bridge;
    b.view.theme.enable().catch(() => {});
    const ctx = await b.view.getContext();
    isPanel = ctx?.extension?.type === 'jira:issuePanel';
    ME = ctx?.accountId || null;
  }
  document.body.classList.toggle('in-panel', isPanel);
  try {
    await within(40000, 'Detour Check', isPanel ? startPanel() : startDesk());
  } catch (err) {
    const box = $('#loading') || document.body;
    box.innerHTML = `<div class="error"><span>Could not load: ${esc(err.message)}</span><button class="btn" id="retry">Retry</button>${isPanel ? '' : '<button class="btn" id="to-demo">Use the demo day</button>'}</div>`;
    $('#retry').onclick = () => location.reload();
    $('#to-demo')?.addEventListener('click', async (e) => {
      e.target.disabled = true;
      try { await call('saveSettings', { mode: 'demo' }); location.reload(); } catch (x) { e.target.disabled = false; showFlag(x.message); }
    });
  }
}

start();
