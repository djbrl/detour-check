const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const api = (p, body) => fetch(p, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}).then((r) => r.json());

let O = null; // overview
const KIND = { works: 'Roadworks', diversion: 'Diversion', message: 'Passenger message', instruction: 'Control instruction' };
const COLOR = { 3: '#d23a2a', 2: '#e08a00', 1: '#e08a00', 0: '#8a93a0' };
const lineById = (id) => O.lines.find((l) => l.id === id);
const chip = (id, extra = '') => { const l = lineById(id); return l ? `<span class="chip ${l.mode === 'TRAM' ? 'tram' : ''} ${extra}" data-line="${l.id}">${esc(l.short)}</span>` : ''; };

function makeMap(el) {
  const m = L.map(el, { zoomControl: true }).setView([44.84, -0.575], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors · data: Bordeaux Métropole open data' }).addTo(m);
  m.layer = L.layerGroup().addTo(m);
  // Leaflet measures the container when it is created; re-measure before every fit.
  const fit = m.fitBounds.bind(m);
  m.fitBounds = (b, o) => { m.invalidateSize(); return fit(b, o); };
  return m;
}
const maps = {};

// ---------- views ----------
document.querySelectorAll('nav button').forEach((b) => b.onclick = () => show(b.dataset.view));
function show(view) {
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('on', v.id === `view-${view}`));
  if (view === 'control') renderControl();
  Object.values(maps).forEach((m) => setTimeout(() => m.invalidateSize(), 50));
  history.replaceState(null, '', `#${view}`);
}

async function load() {
  O = await api('/api/overview');
  const at = new Date(O.fetchedAt);
  $('#meta').textContent = `Live Bordeaux data, fetched ${at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} · ${O.changes.length} changes in force today · duties are simulated`;
  $('#duties').innerHTML = O.duties.map((d) => `<option value="${d.id}">Line ${esc(d.lineShort)} · ${d.start}–${d.end} · ${esc(d.driver)}</option>`).join('');
  $('#gapcount').textContent = O.gaps.length;
}

// ---------- driver ----------
let currentDuty = null;
$('#duty').addEventListener('change', (e) => pickDuty(e.target.value.trim()));
$('#duty').addEventListener('keydown', (e) => { if (e.key === 'Enter') pickDuty(e.target.value.trim()); });

function pickDuty(v) {
  if (!v) return;
  let d = O.duties.find((x) => x.id.toLowerCase() === v.toLowerCase());
  if (!d) {
    // A line number: pick the shift running now.
    const now = new Date().getHours() * 60 + new Date().getMinutes();
    const onLine = O.duties.filter((x) => x.lineShort.toLowerCase() === v.toLowerCase());
    d = onLine.find((x) => { const [s, e] = [x.start, x.end].map((t) => +t.slice(0, 2) * 60 + +t.slice(3)); return e > s ? now >= s && now < e : now >= s || now < e; }) || onLine[0];
  }
  if (!d) { $('#brief').innerHTML = `<p class="muted">No duty found for “${esc(v)}”.</p>`; return; }
  $('#duty').value = d.id;
  currentDuty = d.id;
  renderBrief();
}

async function renderBrief() {
  const b = await api(`/api/brief/${currentDuty}`);
  const done = b.items.filter((i) => i.ack).length;
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  $('#brief').innerHTML = `
    <div class="hello">${greet}, ${esc(b.duty.driver.split(' ')[0])}</div>
    <div class="duty-line">Service ${b.duty.id} · ${esc(b.line.name)} · ${b.duty.start}–${b.duty.end}</div>
    ${b.items.length ? `
      <div class="progress"><div style="width:${(100 * done) / b.items.length}%"></div></div>
      <div class="duty-line"><b>${b.items.length} ${b.items.length === 1 ? 'thing is' : 'things are'} different on your shift today.</b> ${done} read.</div>
      ${b.items.map((i) => `
        <div class="item sev${i.severity} ${i.ack ? 'done' : ''}" data-id="${i.id}">
          <div class="kind">${KIND[i.kind]}</div>
          <div class="title">${esc(i.title.replace(/^(Road closed|Roadworks|Diversion|Passenger message|Instruction):\s*/, ''))}</div>
          ${i.window?.from ? `<div class="when">From ${i.window.from}${i.window.to ? ` to ${i.window.to}` : ''}</div>` : ''}
          <div class="detail">${esc(i.detail)}</div>
          <div class="ack">${i.ack ? `<span class="read">✓ Read ${i.ack.simulated ? '(simulated)' : 'at ' + new Date(i.ack.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span>` : `<button data-ack="${i.id}">Read and understood</button>`}</div>
        </div>`).join('')}
      ${done === b.items.length ? '<div class="allread">All read. Have a good shift.</div>' : ''}
      ${b.gaps.length ? `<div class="gapnote"><b>Control is checking:</b> ${b.gaps.map((g) => esc(g.text)).join(' ')}</div>` : ''}
    ` : '<div class="allread">Nothing is different on your shift today.</div>'}`;
  document.querySelectorAll('[data-ack]').forEach((btn) => btn.onclick = async (e) => {
    e.stopPropagation();
    await api('/api/ack', { duty: currentDuty, change: btn.dataset.ack });
    renderBrief(); load();
  });
  document.querySelectorAll('.item').forEach((el) => el.onclick = () => focusOn(maps.driver, b.items.find((i) => i.id === el.dataset.id)));
  drawBriefMap(b);
}

function drawBriefMap(b) {
  maps.driver ||= makeMap('driver-map');
  const m = maps.driver; m.layer.clearLayers();
  const bounds = [];
  b.line.geo.forEach((g) => { L.polyline(g, { color: '#1f5fd6', weight: 4, opacity: .55 }).addTo(m.layer); bounds.push(...g); });
  b.items.forEach((i) => drawChange(m, i));
  if (bounds.length) m.fitBounds(bounds, { padding: [20, 20] });
}

function drawChange(m, c, strong = false) {
  const color = c.kind === 'diversion' ? '#e08a00' : COLOR[c.severity];
  for (const g of c.geo || []) {
    if (g.length === 1) L.circleMarker(g[0], { radius: strong ? 10 : 7, color, weight: 3, fillOpacity: .5 }).bindTooltip(esc(c.title)).addTo(m.layer);
    else L.polyline(g, { color, weight: strong ? 8 : 6, opacity: .9, dashArray: c.kind === 'diversion' ? '8 6' : null }).bindTooltip(esc(c.title)).addTo(m.layer);
  }
  for (const s of c.stops || []) L.circleMarker([s.lat, s.lon], { radius: 9, color: '#d23a2a', weight: 3, fillOpacity: .3 }).bindTooltip(`Stop: ${esc(s.name)}`).addTo(m.layer);
}

function focusOn(m, c) {
  const pts = (c.geo || []).flat().concat((c.stops || []).map((s) => [s.lat, s.lon]));
  if (pts.length) m.fitBounds(pts, { padding: [60, 60], maxZoom: 17 });
}

// ---------- control ----------
let filter = 'all', selected = null;
document.querySelectorAll('.tabs button').forEach((b) => b.onclick = () => {
  filter = b.dataset.filter;
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
  renderControl();
});

function renderControl() {
  maps.control ||= makeMap('control-map');
  const box = $('#changes');
  if (filter === 'gaps') {
    const byKind = { 'closure-without-diversion': 'Road closed on a route, no diversion published', 'diversion-without-message': 'Diversion in force, passengers not told' };
    box.innerHTML = Object.entries(byKind).map(([k, label]) => {
      const gs = O.gaps.filter((g) => g.kind === k);
      return gs.length ? `<h4 class="muted">${label} (${gs.length})</h4>` + gs.map((g) => {
        const c = O.changes.find((x) => x.id === g.change);
        return `<div class="change gap ${selected === g.change ? 'sel' : ''}" data-id="${g.change}"><div class="t">${esc(g.text)}</div><div class="src">${esc(c?.title || '')}</div></div>`;
      }).join('') : '';
    }).join('') + '<p class="muted">These are leads, not verdicts: they compare what the operator publishes in one feed against another.</p>';
  } else {
    const list = O.changes.filter((c) => filter === 'all' || c.read < c.duties);
    box.innerHTML = list.map((c) => `
      <div class="change ${selected === c.id ? 'sel' : ''}" data-id="${c.id}">
        <div class="kind muted" style="font-size:11px;text-transform:uppercase">${KIND[c.kind]}${O.gaps.some((g) => g.change === c.id) ? ' · <span class="pill warn">check</span>' : ''}</div>
        <div class="t">${esc(c.title)}</div>
        <div class="lines">${c.lines.map((id) => chip(id)).join('')}</div>
        <div class="bar"><div class="track"><div style="width:${c.duties ? (100 * c.read) / c.duties : 0}%"></div></div>${c.read}/${c.duties} drivers read</div>
      </div>`).join('') || '<p class="muted">Everything has been read.</p>';
  }
  box.querySelectorAll('.change').forEach((el) => el.onclick = () => select(el.dataset.id));
  if (!selected && O.changes[0]) select(O.changes[0].id); else if (selected) select(selected, false);
}

async function select(id, redraw = true) {
  selected = id;
  document.querySelectorAll('.change').forEach((el) => el.classList.toggle('sel', el.dataset.id === id));
  const cov = await api(`/api/coverage/${id}`);
  if (!cov.change) return;
  const m = maps.control; m.layer.clearLayers();
  const bounds = [];
  Object.values(cov.lineGeo).forEach((l) => l.geo.forEach((g) => { L.polyline(g, { color: l.mode === 'TRAM' ? '#6b46c1' : '#1f5fd6', weight: 3, opacity: .35 }).addTo(m.layer); }));
  drawChange(m, cov.change, true);
  (cov.change.geo || []).forEach((g) => bounds.push(...g));
  (cov.change.stops || []).forEach((s) => bounds.push([s.lat, s.lon]));
  if (!bounds.length) Object.values(cov.lineGeo).forEach((l) => l.geo.forEach((g) => bounds.push(...g)));
  if (redraw && bounds.length) m.fitBounds(bounds, { padding: [40, 40], maxZoom: 17 });
  const unread = cov.rows.filter((r) => !r.ack);
  const soon = unread.filter((r) => r.startsIn <= 90);
  $('#coverage').innerHTML = `
    <div class="muted" style="font-size:11px;text-transform:uppercase">${KIND[cov.change.kind]}</div>
    <h3 style="margin:2px 0 6px">${esc(cov.change.title)}</h3>
    <div class="detail muted">${esc(cov.change.detail)}</div>
    <div class="src">Source: ${esc(cov.change.source)}</div>
    <p><b>${cov.rows.length}</b> drivers are on shifts this touches. <b class="${unread.length ? 'no' : 'ok'}">${unread.length} have not read it</b>${soon.length ? `, <b class="no">${soon.length} of them sign on within 90 minutes</b>` : ''}.</p>
    <table><tr><th>Driver</th><th>Service</th><th>Line</th><th>Shift</th><th>Read</th></tr>
    ${cov.rows.map((r) => `<tr class="${!r.ack && r.startsIn <= 90 ? 'soon' : ''}"><td>${esc(r.driver)}</td><td>${r.id}</td><td>${chip(r.line)}</td><td>${r.start}–${r.end}${!r.ack && r.startsIn <= 90 ? ` <span class="no">signs on in ${r.startsIn} min</span>` : ''}</td><td>${r.ack ? `<span class="ok">✓ ${r.ack.simulated ? 'sim.' : new Date(r.ack.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span>` : '<span class="no">not yet</span>'}</td></tr>`).join('')}
    </table>`;
}

// ---------- write ----------
let compiled = null;
$('#ins-preview').onclick = async () => {
  const text = $('#ins-text').value.trim();
  compiled = await api('/api/instructions/preview', { text });
  compiled.chosen = new Set(compiled.lines);
  renderCompiled();
};

function renderCompiled() {
  const c = compiled;
  $('#ins-result').innerHTML = `<div class="compiled">
    <h4>Lines named in the text</h4><div class="lines">${c.lines.map((id) => chip(id, c.chosen.has(id) ? '' : 'off')).join('') || '<span class="muted">none found</span>'}</div>
    <h4>Stops recognised</h4><div>${c.stops.map((s) => `<span class="chip">${esc(s.name)}</span>`).join(' ') || '<span class="muted">none found</span>'}</div>
    ${c.linesFromStops.length ? `<h4>Other lines that also serve ${c.stops.map((s) => esc(s.name)).join(', ')}. Add them?</h4><div class="lines">${c.linesFromStops.map((id) => chip(id, c.chosen.has(id) ? '' : 'off')).join('')}</div>` : ''}
    <h4>When</h4><div>${c.window ? `From ${c.window.from}${c.window.to ? ` to ${c.window.to}` : ' until end of service'}` : 'All day'}</div>
    <h4>Who gets it</h4><div id="ins-who"></div>
    <div class="row"><button id="ins-publish" class="primary">Publish to drivers</button></div>
  </div>`;
  $('#ins-result').querySelectorAll('.chip[data-line]').forEach((el) => el.onclick = () => {
    const id = el.dataset.line; c.chosen.has(id) ? c.chosen.delete(id) : c.chosen.add(id); renderCompiled();
  });
  const fake = { lines: [...c.chosen], window: c.window };
  const affected = O.duties.filter((d) => fake.lines.includes(d.line) && (!fake.window || shiftOverlaps(d, fake.window)));
  $('#ins-who').innerHTML = affected.length ? `${affected.length} drivers: ${affected.map((d) => `${esc(d.driver)} (${d.id}, ${d.start}–${d.end})`).join(', ')}` : '<span class="muted">Choose at least one line.</span>';
  $('#ins-publish').onclick = async () => {
    if (!c.chosen.size) return;
    await api('/api/instructions', { text: $('#ins-text').value.trim(), lines: [...c.chosen], window: c.window });
    await load();
    $('#ins-result').innerHTML = `<div class="allread">Published to ${affected.length} drivers. Open their sign-on, or watch it in the control room.</div>`;
  };
}

function shiftOverlaps(d, w) {
  const t = (s) => +s.slice(0, 2) * 60 + +s.slice(3);
  const s = t(d.start); let e = t(d.end); if (e < s) e += 1440;
  const f = t(w.from); const to = w.to ? t(w.to) : 1740;
  return f < e && to > s;
}

// ---------- start ----------
await load();
show(location.hash.slice(1) || 'driver');
pickDuty('S0202');
