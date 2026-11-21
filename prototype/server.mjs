// Shift Brief prototype: every driver starts their shift with what's different today on their part
// of the network, and control can see who has read it. Runs on Bordeaux Métropole open data (live,
// no key). Driver duties and acknowledgements are synthetic: rosters are not public.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(here, 'data');
const PUBLIC = path.join(here, 'public');
const PORT = Number(process.env.PORT || 4310);
const API = 'https://opendata.bordeaux-metropole.fr/api/explore/v2.1/catalog/datasets';
const DATASETS = ['sv_ligne_a', 'sv_chem_l', 'sv_arret_p', 'sv_devia_l', 'ci_chantier', 'sv_messa_a'];
const MAX_AGE_MS = 10 * 60 * 1000;

// ---------- data loading ----------

async function loadDataset(name, force = false) {
  const file = path.join(DATA, `${name}.json`);
  let stat = null;
  try { stat = await fs.stat(file); } catch {}
  if (!force && stat && Date.now() - stat.mtimeMs < MAX_AGE_MS) {
    return { rows: JSON.parse(await fs.readFile(file, 'utf8')), fetchedAt: stat.mtime };
  }
  try {
    const res = await fetch(`${API}/${name}/exports/json`);
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    const text = await res.text();
    await fs.writeFile(file, text);
    return { rows: JSON.parse(text), fetchedAt: new Date() };
  } catch (err) {
    // Offline or the portal is down: keep working on the last copy.
    if (stat) {
      console.warn(`Using cached ${name}: ${err.message}`);
      return { rows: JSON.parse(await fs.readFile(file, 'utf8')), fetchedAt: stat.mtime };
    }
    throw err;
  }
}

// ---------- geometry (metres on a local flat projection; fine at city scale) ----------

const LAT0 = 44.84;
const KX = 111320 * Math.cos((LAT0 * Math.PI) / 180);
const KY = 110540;
const toXY = ([lon, lat]) => [lon * KX, lat * KY];

function linesOf(geom) {
  if (!geom) return [];
  const g = geom.geometry || geom;
  switch (g.type) {
    case 'LineString': return [g.coordinates];
    case 'MultiLineString': return g.coordinates;
    case 'Point': return [[g.coordinates]];
    case 'MultiPoint': return g.coordinates.map((c) => [c]);
    default: return [];
  }
}

function prepare(lines) {
  const parts = lines.map((l) => l.map(toXY));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of parts) for (const [x, y] of p) {
    if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y;
  }
  return { parts, box: [minX, minY, maxX, maxY] };
}

function distPointSeg(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  const len = dx * dx + dy * dy;
  let t = len ? ((px - ax) * dx + (py - ay) * dy) / len : 0;
  t = Math.max(0, Math.min(1, t));
  const x = ax + t * dx - px, y = ay + t * dy - py;
  return Math.sqrt(x * x + y * y);
}

function distPointShape(x, y, shape) {
  const [a, b, c, d] = shape.box;
  if (x < a - 2000 || x > c + 2000 || y < b - 2000 || y > d + 2000) return Infinity;
  let best = Infinity;
  for (const p of shape.parts) {
    if (p.length === 1) best = Math.min(best, Math.hypot(p[0][0] - x, p[0][1] - y));
    for (let i = 1; i < p.length; i++) best = Math.min(best, distPointSeg(x, y, p[i - 1], p[i]));
  }
  return best;
}

// Shortest distance between two shapes, sampling the first one's vertices and segment midpoints.
function distShapes(a, b) {
  const [a0, a1, a2, a3] = a.box, [b0, b1, b2, b3] = b.box;
  if (a0 > b2 + 500 || b0 > a2 + 500 || a1 > b3 + 500 || b1 > a3 + 500) return Infinity;
  let best = Infinity;
  for (const p of a.parts) for (let i = 0; i < p.length; i++) {
    best = Math.min(best, distPointShape(p[i][0], p[i][1], b));
    if (i > 0) best = Math.min(best, distPointShape((p[i][0] + p[i - 1][0]) / 2, (p[i][1] + p[i - 1][1]) / 2, b));
  }
  return best;
}

// Does a works area lie along a route? Points must sit on it; lines must share at least 40 m with it.
function alongRoute(work, route, near = 15, minShared = 40) {
  const [a0, a1, a2, a3] = work.box, [b0, b1, b2, b3] = route.box;
  if (a0 > b2 + 50 || b0 > a2 + 50 || a1 > b3 + 50 || b1 > a3 + 50) return false;
  let shared = 0;
  for (const p of work.parts) {
    if (p.length === 1) { if (distPointShape(p[0][0], p[0][1], route) <= near) return true; continue; }
    for (let i = 1; i < p.length; i++) {
      const [ax, ay] = p[i - 1], [bx, by] = p[i];
      const len = Math.hypot(bx - ax, by - ay);
      const steps = Math.max(1, Math.round(len / 5));
      for (let k = 0; k < steps; k++) {
        const t = (k + 0.5) / steps;
        if (distPointShape(ax + t * (bx - ax), ay + t * (by - ay), route) <= near) shared += len / steps;
      }
      if (shared >= minShared) return true;
    }
  }
  return false;
}

// Thin a polyline for the browser: keep points at least `step` metres apart.
function thin(line, step = 25) {
  const out = [];
  let last = null;
  for (const c of line) {
    const xy = toXY(c);
    if (!last || Math.hypot(xy[0] - last[0], xy[1] - last[1]) >= step) { out.push([+c[1].toFixed(5), +c[0].toFixed(5)]); last = xy; }
  }
  const end = line[line.length - 1];
  if (end) out.push([+end[1].toFixed(5), +end[0].toFixed(5)]);
  return out;
}

// ---------- text helpers ----------

const norm = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const WEEKDAYS = ['DIMANCHE', 'LUNDI', 'MARDI', 'MERCREDI', 'JEUDI', 'VENDREDI', 'SAMEDI'];
const todayISO = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
const nowParis = () => new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
const hm = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };

function shortName(name) {
  // "Lianes 1" -> "1", "Tram A" -> "A", "BUS EXPRESS G" -> "G", "Navette Tram 102" -> "102"
  const m = name.match(/([A-Z0-9]+)\s*$/i);
  return m ? m[1] : name;
}

// ---------- the model ----------

let model = null;
const state = { acks: {}, consignes: [] };
const STATE_FILE = path.join(DATA, 'state.json');

async function loadState() {
  try { Object.assign(state, JSON.parse(await fs.readFile(STATE_FILE, 'utf8'))); } catch {}
}
async function saveState() { await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2)); }

async function build(force = false) {
  await fs.mkdir(DATA, { recursive: true });
  const raw = {};
  let fetchedAt = null;
  for (const name of DATASETS) {
    const { rows, fetchedAt: at } = await loadDataset(name, force);
    raw[name] = rows;
    if (!fetchedAt || at < fetchedAt) fetchedAt = at;
  }
  const today = todayISO();
  const now = new Date();
  const weekday = WEEKDAYS[nowParis().getDay()];

  // Lines and their principal routes.
  const lines = new Map();
  for (const l of raw.sv_ligne_a) {
    if (!['BUS', 'TRAM'].includes(l.bm_vehicule) || String(l.bm_active) !== '1') continue;
    lines.set(String(l.bm_gid), { id: String(l.bm_gid), name: l.bm_libelle, short: shortName(l.bm_libelle), mode: l.bm_vehicule, shapes: [], geo: [] });
  }
  for (const p of raw.sv_chem_l) {
    const line = lines.get(String(p.rs_sv_ligne_a));
    if (!line || p.principal !== 'True' || !p.geo_shape) continue;
    const ls = linesOf(p.geo_shape);
    line.shapes.push(prepare(ls));
    line.geo.push(...ls.map((l) => thin(l)));
  }
  for (const [id, l] of lines) if (!l.shapes.length) lines.delete(id);

  const stops = new Map();
  for (const s of raw.sv_arret_p) {
    if (!s.geo_point_2d) continue;
    stops.set(String(s.gid), { id: String(s.gid), name: s.libelle, lon: s.geo_point_2d.lon, lat: s.geo_point_2d.lat, active: s.actif === 1 });
  }

  const linesNear = (shape, metres) => {
    const hit = [];
    for (const l of lines.values()) if (l.shapes.some((s) => distShapes(shape, s) <= metres)) hit.push(l.id);
    return hit;
  };
  const linesThroughStop = (stop, metres = 35) => {
    const [x, y] = toXY([stop.lon, stop.lat]);
    return [...lines.values()].filter((l) => l.shapes.some((s) => distPointShape(x, y, s) <= metres)).map((l) => l.id);
  };

  const changes = [];

  // 1. Diversions the operator has published, active right now.
  for (const d of raw.sv_devia_l) {
    if (d.actif !== 'True' || !d.geo_shape) continue;
    if (new Date(d.debut) > now || new Date(d.fin) < now) continue;
    if (Array.isArray(d.jour_appli) && !d.jour_appli.includes(weekday)) continue;
    const from = stops.get(String(d.rg_sv_arret_p_nd));
    const to = stops.get(String(d.rg_sv_arret_p_na));
    let affected = [];
    if (from && to) {
      // Published diversions are for buses; tram stops beside a bus stop would otherwise match.
      const a = new Set(linesThroughStop(from));
      affected = linesThroughStop(to).filter((id) => a.has(id) && lines.get(id).mode === 'BUS');
    }
    const ls = linesOf(d.geo_shape);
    if (!affected.length) affected = linesNear(prepare(ls), 15);
    changes.push({
      id: `dev-${d.gid}`, kind: 'diversion', severity: 2,
      title: d.libelle.replace(/^Déviation\s*/i, 'Diversion: '),
      detail: `Published diversion ${d.ident}${d.sens ? `, direction ${d.sens.toLowerCase()}` : ''}. Runs ${new Date(d.debut).toLocaleDateString('en-GB')} to ${new Date(d.fin).toLocaleDateString('en-GB')}${d.jour_appli?.length < 7 ? ` on ${d.jour_appli.map((j) => j.slice(0, 3).toLowerCase()).join(', ')}` : ''}.`,
      from: from?.name, to: to?.name, lines: affected, window: null,
      geo: ls.map((l) => thin(l, 10)), shape: prepare(ls), source: 'Operator diversions (sv_devia_l)',
    });
  }

  // 2. Roadworks permits active today that touch a route.
  for (const w of raw.ci_chantier) {
    if (!w.geo_shape || !w.date_debut || !w.date_fin) continue;
    if (w.date_debut > today || w.date_fin < today) continue;
    const ls = linesOf(w.geo_shape);
    const shape = prepare(ls);
    // Trams run on their own track, so street works are matched to buses only. A permit must run
    // along the route, not just cross it at a junction.
    const affected = [...lines.values()].filter((l) => l.mode === 'BUS' && l.shapes.some((s) => alongRoute(shape, s))).map((l) => l.id);
    if (!affected.length) continue;
    const measures = w.libelle || 'Works';
    const blocking = /circulation interdite|mise en impasse|d[ée]viation/i.test(measures);
    changes.push({
      id: `works-${w.gid}`, kind: 'works', severity: blocking ? 3 : 1, blocking,
      title: `${blocking ? 'Road closed' : 'Roadworks'}: ${(w.localisation || '').replace(/\s*situ[ée] en agglom[ée]ration/i, '')}`,
      detail: `${measures.replaceAll(';', ' · ')}. ${w.alias_nature_n1 || ''}${w.alias_nature_n2 ? ` (${w.alias_nature_n2})` : ''}. Permit ${w.ident}, ${w.date_debut} to ${w.date_fin}.${w.localisation_emprise ? ` Area: ${w.localisation_emprise}.` : ''}`,
      lines: affected, window: null, geo: ls.map((l) => thin(l, 5)), shape, source: 'Roadworks permits (ci_chantier)',
    });
  }

  // 3. Messages the operator is showing passengers, grouped across lines.
  const msgGroups = new Map();
  for (const m of raw.sv_messa_a) {
    const key = `${m.titre}|${m.message}`;
    if (!msgGroups.has(key)) msgGroups.set(key, { m, lines: [] });
    if (lines.has(String(m.rs_sv_ligne_a))) msgGroups.get(key).lines.push(String(m.rs_sv_ligne_a));
  }
  let mi = 0;
  for (const { m, lines: ls } of msgGroups.values()) {
    if (!ls.length) continue;
    const sev = Number(String(m.severite).slice(0, 1)) || 1;
    const t = (m.message || '').match(/d[èe]s\s*(\d{1,2})\s*h\s*(\d{0,2})/i);
    changes.push({
      id: `msg-${mi++}`, kind: 'message', severity: sev >= 3 ? 2 : 0,
      title: `Passenger message: ${m.message.split('\n').slice(0, 2).join(' ').trim()}`,
      detail: m.message.replace(/\n/g, ' '), lines: ls,
      window: t ? { from: `${t[1].padStart(2, '0')}:${(t[2] || '00').padStart(2, '0')}`, to: null } : null,
      geo: [], source: 'Passenger messages (sv_messa_a)',
    });
  }

  // 4. Instructions written by control today.
  for (const c of state.consignes) {
    if (c.date !== today) continue;
    changes.push({ ...c, kind: 'instruction', severity: 3, geo: c.geo || [], source: 'Control instruction' });
  }

  // Where the sources disagree. These are leads to check, not verdicts.
  const gaps = [];
  const diversions = changes.filter((c) => c.kind === 'diversion');
  const messageLines = new Set(changes.filter((c) => c.kind === 'message' && c.severity >= 2).flatMap((c) => c.lines));
  for (const w of changes.filter((c) => c.kind === 'works' && c.blocking)) {
    const uncovered = w.lines.filter((id) => !diversions.some((d) => d.lines.includes(id) && distShapes(w.shape, d.shape) < 600));
    if (uncovered.length) gaps.push({
      id: `gap-${w.id}`, change: w.id, kind: 'closure-without-diversion', lines: uncovered,
      text: `Road closure on the route of ${uncovered.length === 1 ? 'line' : 'lines'} ${uncovered.map((id) => lines.get(id).short).join(', ')}, and no diversion is published nearby.`,
    });
  }
  for (const d of diversions) {
    const silent = d.lines.filter((id) => !messageLines.has(id));
    if (silent.length) gaps.push({
      id: `gap-${d.id}`, change: d.id, kind: 'diversion-without-message', lines: silent,
      text: `Diversion in force, but passengers on ${silent.length === 1 ? 'line' : 'lines'} ${silent.map((id) => lines.get(id).short).join(', ')} get no message about it.`,
    });
  }

  // Synthetic duties: three shifts per line. Real rosters would come from the scheduling system.
  const FIRST = ['Amina', 'Bruno', 'Chloé', 'Damien', 'Élodie', 'Farid', 'Gaëlle', 'Hugo', 'Inès', 'Julien', 'Karim', 'Léa', 'Mehdi', 'Nora', 'Olivier', 'Pauline', 'Quentin', 'Rania', 'Samuel', 'Thomas', 'Yasmine', 'Zoé'];
  const LAST = 'BCDFGHJLMNPRSTV';
  const SHIFTS = [['05:10', '12:40'], ['11:50', '19:20'], ['18:30', '01:05']];
  const duties = [];
  let n = 0;
  for (const l of [...lines.values()].sort((a, b) => Number(a.id) - Number(b.id))) {
    SHIFTS.forEach(([start, end], i) => {
      duties.push({ id: `S${String(l.id).padStart(3, '0')}${i + 1}`, line: l.id, start, end, driver: `${FIRST[n % FIRST.length]} ${LAST[(n * 7) % LAST.length]}.` });
      n++;
    });
  }

  model = { fetchedAt, builtAt: new Date(), today, lines, stops, changes, gaps, duties };
  console.log(`Built: ${lines.size} lines, ${changes.length} changes (${gaps.length} gaps), ${duties.length} duties`);
}

// A change concerns a duty when it is on the duty's line and in force during its hours.
function concerns(change, duty) {
  if (!change.lines.includes(duty.line)) return false;
  if (!change.window?.from) return true;
  const s = hm(duty.start); let e = hm(duty.end); if (e < s) e += 1440;
  const f = hm(change.window.from);
  const t = change.window.to ? hm(change.window.to) : 1440 + 300;
  return f < e && t > s;
}

const ackKey = () => model.today;
const acked = (dutyId, changeId) => state.acks[ackKey()]?.[dutyId]?.[changeId];

// For the demo, pretend some drivers already signed on and read their brief: early shifts only.
function seedAcks() {
  const day = (state.acks[ackKey()] ||= {});
  if (day.__seeded) return;
  day.__seeded = true;
  model.duties.filter((d) => d.start === '05:10').forEach((d, i) => {
    if (i % 3 === 0) return; // a third of early drivers have not read theirs
    for (const c of model.changes) if (concerns(c, d)) ((day[d.id] ||= {})[c.id] = { at: `${model.today}T05:0${i % 9}:00`, simulated: true });
  });
}

function publicChange(c) {
  const { shape, ...rest } = c;
  const affected = model.duties.filter((d) => concerns(c, d));
  const read = affected.filter((d) => acked(d.id, c.id));
  return { ...rest, duties: affected.length, read: read.length };
}

function overview() {
  const lineList = [...model.lines.values()].map(({ id, name, short, mode }) => ({ id, name, short, mode }));
  const changes = model.changes.map(publicChange).sort((a, b) => b.severity - a.severity || b.duties - a.duties);
  return { fetchedAt: model.fetchedAt, builtAt: model.builtAt, today: model.today, lines: lineList, changes, gaps: model.gaps,
    duties: model.duties.map((d) => ({ ...d, lineShort: model.lines.get(d.line).short })) };
}

function brief(dutyId) {
  const duty = model.duties.find((d) => d.id === dutyId);
  if (!duty) return null;
  const line = model.lines.get(duty.line);
  const items = model.changes.filter((c) => concerns(c, duty)).map((c) => ({ ...publicChange(c), ack: acked(duty.id, c.id) || null }))
    .sort((a, b) => b.severity - a.severity);
  const gaps = model.gaps.filter((g) => g.lines.includes(duty.line));
  return { duty, line: { id: line.id, name: line.name, short: line.short, mode: line.mode, geo: line.geo }, items, gaps };
}

function coverage(changeId) {
  const c = model.changes.find((x) => x.id === changeId);
  if (!c) return null;
  const nowMin = hm(nowParis().toTimeString().slice(0, 5));
  const rows = model.duties.filter((d) => concerns(c, d)).map((d) => {
    const s = hm(d.start); const until = (s - nowMin + 1440) % 1440;
    return { ...d, lineShort: model.lines.get(d.line).short, ack: acked(d.id, c.id) || null, startsIn: until };
  }).sort((a, b) => (!!a.ack - !!b.ack) || a.startsIn - b.startsIn);
  const lineGeo = Object.fromEntries(c.lines.map((id) => [id, { short: model.lines.get(id).short, mode: model.lines.get(id).mode, geo: model.lines.get(id).geo }]));
  return { change: publicChange(c), rows, lineGeo };
}

// Compile a written instruction into lines and stops by matching what the network actually has.
function compileInstruction(text) {
  const t = norm(text);
  const found = new Set();
  const lineRe = /\b(?:lignes?|line|lines|tram|bus)\s+((?:[a-z0-9]{1,4})(?:\s*(?:,|et|and|&)\s*[a-z0-9]{1,4})*)/gi;
  for (const m of t.matchAll(lineRe)) {
    for (const tok of m[1].split(/\s*(?:,|et|and|&)\s*/)) {
      for (const l of model.lines.values()) if (norm(l.short) === tok.trim()) found.add(l.id);
    }
  }
  const stopHits = new Map();
  for (const s of model.stops.values()) {
    const n = norm(s.name);
    if (n.length < 5 || !s.active) continue;
    if (new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(t)) {
      if (!stopHits.has(n) || n.length > norm(stopHits.get(n).name).length) stopHits.set(n, s);
    }
  }
  // Drop stop names that are part of a longer matched name ("Victoire" inside "Place de la Victoire").
  const names = [...stopHits.keys()];
  const stopsFound = names.filter((n) => !names.some((o) => o !== n && o.includes(n))).map((n) => stopHits.get(n));
  const viaStops = new Set();
  for (const s of stopsFound) {
    for (const stop of model.stops.values()) if (norm(stop.name) === norm(s.name) && stop.active)
      for (const id of (() => { const [x, y] = toXY([stop.lon, stop.lat]); return [...model.lines.values()].filter((l) => l.shapes.some((sh) => distPointShape(x, y, sh) <= 35)).map((l) => l.id); })()) viaStops.add(id);
  }
  const time = t.match(/(?:a partir de|des|from|after)\s*(\d{1,2})\s*[h:]\s*(\d{0,2})/);
  const until = t.match(/(?:jusqu'?a|until|till|to)\s*(\d{1,2})\s*[h:]\s*(\d{0,2})/);
  return {
    lines: [...found],
    stops: stopsFound.map((s) => ({ name: s.name, lat: s.lat, lon: s.lon })),
    linesFromStops: [...viaStops].filter((id) => !found.has(id)),
    window: time ? { from: `${time[1].padStart(2, '0')}:${(time[2] || '00').padStart(2, '0')}`, to: until ? `${until[1].padStart(2, '0')}:${(until[2] || '00').padStart(2, '0')}` : null } : null,
  };
}

// ---------- http ----------

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};
const readBody = (req) => new Promise((resolve, reject) => {
  let s = ''; req.on('data', (c) => { s += c; if (s.length > 1e5) req.destroy(); });
  req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } }); req.on('error', reject);
});
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (p === '/api/overview') return send(res, 200, overview());
    if (p.startsWith('/api/brief/')) { const b = brief(decodeURIComponent(p.slice(11))); return b ? send(res, 200, b) : send(res, 404, { error: 'No such duty' }); }
    if (p.startsWith('/api/coverage/')) { const c = coverage(decodeURIComponent(p.slice(14))); return c ? send(res, 200, c) : send(res, 404, { error: 'No such change' }); }
    if (p === '/api/ack' && req.method === 'POST') {
      const { duty, change } = await readBody(req);
      if (!model.duties.some((d) => d.id === duty) || !model.changes.some((c) => c.id === change)) return send(res, 400, { error: 'Unknown duty or change' });
      ((state.acks[ackKey()] ||= {})[duty] ||= {})[change] = { at: new Date().toISOString() };
      await saveState();
      return send(res, 200, { ok: true });
    }
    if (p === '/api/instructions/preview' && req.method === 'POST') {
      const { text } = await readBody(req);
      return send(res, 200, compileInstruction(String(text || '').slice(0, 1000)));
    }
    if (p === '/api/instructions' && req.method === 'POST') {
      const { text, lines, window } = await readBody(req);
      const ids = (lines || []).filter((id) => model.lines.has(id));
      if (!text || !ids.length) return send(res, 400, { error: 'An instruction needs text and at least one line' });
      const compiled = compileInstruction(String(text));
      state.consignes.push({
        id: `ins-${Date.now()}`, date: model.today, title: `Instruction: ${String(text).slice(0, 90)}`, detail: String(text).slice(0, 1000),
        lines: ids, window: window?.from ? window : null,
        geo: [], stops: compiled.stops, createdAt: new Date().toISOString(),
      });
      await saveState();
      await build();
      return send(res, 200, { ok: true });
    }
    if (p === '/api/refresh' && req.method === 'POST') { await build(true); seedAcks(); return send(res, 200, { ok: true }); }
    const file = path.join(PUBLIC, p === '/' ? 'index.html' : path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(PUBLIC)) return send(res, 403, 'Forbidden', 'text/plain');
    const body = await fs.readFile(file).catch(() => null);
    if (!body) return send(res, 404, 'Not found', 'text/plain');
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch (err) {
    console.error(err);
    send(res, 500, { error: err.message });
  }
});

await loadState();
await build();
seedAcks();
await saveState();
setInterval(() => build().catch((e) => console.error('Refresh failed:', e.message)), MAX_AGE_MS);
server.listen(PORT, () => console.log(`Shift Brief on http://localhost:${PORT}`));
