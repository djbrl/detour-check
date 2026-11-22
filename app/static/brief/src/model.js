// Works out what is different today on each line, which drivers' shifts it touches, and where the
// operator's own feeds disagree. Runs in the browser on Bordeaux Métropole open data: the network
// comes from a bundled snapshot, today's changes are fetched live. Duties are simulated, because
// rosters are not public; a real deployment would read them from the scheduling system.
import network from './network.json';

const API = 'https://opendata.bordeaux-metropole.fr/api/explore/v2.1/catalog/datasets';
const LIVE = ['sv_devia_l', 'ci_chantier', 'sv_messa_a'];

// ---------- geometry (metres on a local flat projection; fine at city scale) ----------

const KX = 111320 * Math.cos((44.84 * Math.PI) / 180);
const KY = 110540;
const toXY = ([lon, lat]) => [lon * KX, lat * KY];

// GeoJSON geometry -> list of [lon, lat] lines; points become one-point lines.
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

// Does a works area lie along a route? Points must sit on it; lines must share at least 40 m with
// it, so works on a cross street at a junction do not count.
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

// [lon, lat] line -> [lat, lon] points for Leaflet, at least `step` metres apart.
function thin(line, step) {
  const out = [];
  let last = null;
  for (const c of line) {
    const xy = toXY(c);
    if (!last || Math.hypot(xy[0] - last[0], xy[1] - last[1]) >= step) { out.push([+c[1].toFixed(5), +c[0].toFixed(5)]); last = xy; }
  }
  const end = line[line.length - 1];
  if (end && out.length > 1) out.push([+end[1].toFixed(5), +end[0].toFixed(5)]);
  return out;
}

// ---------- text: the open data is French and terse; drivers and judges get plain English ----------

export const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const titleCase = (s) => norm(s).replace(/(^|[\s'-])([a-z])/g, (m, a, b) => a + b.toUpperCase()).replace(/\bSt\b/g, 'St').replace(/\bDe\b/g, 'de').replace(/\bDu\b/g, 'du').replace(/\bLa\b/g, 'la');
const until = (d) => {
  const t = new Date(d);
  if (Number.isNaN(+t)) return 'further notice';
  const year = t.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined;
  return t.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year, timeZone: 'Europe/Paris' });
};
const DAY_EN = { LUNDI: 'Mon', MARDI: 'Tue', MERCREDI: 'Wed', JEUDI: 'Thu', VENDREDI: 'Fri', SAMEDI: 'Sat', DIMANCHE: 'Sun' };
// ["LUNDI", "MARDI", ...] -> "except Thu" or "Sat only"
function days(list) {
  if (!Array.isArray(list) || list.length >= 7) return '';
  const missing = Object.keys(DAY_EN).filter((d) => !list.includes(d));
  return missing.length <= 3 ? `, except ${missing.map((d) => DAY_EN[d]).join(', ')}` : `, ${list.map((d) => DAY_EN[d]).join(', ')} only`;
}
const DIRECTION = { ALLER: 'Outbound', RETOUR: 'Inbound', ALLER_RETOUR: 'Both directions' };

// "Rue Surson au N° 59 (Bordeaux) situé en agglomération" -> "59 Rue Surson, Bordeaux"
function place(localisation) {
  // Permits list several addresses; the first is enough to find it.
  const s = String(localisation || '').split(/\s*(?:situ[ée]s?\s+)?en agglom[ée]ration\s*/i)[0].trim();
  const m = s.match(/^(.*?)(?:\s+au\s+N°\s*([\w/-]+))?\s*\(([^)]+)\)\s*$/i);
  if (!m) return s || 'Unnamed street';
  return `${m[2] ? `${m[2]} ` : ''}${m[1].trim()}, ${m[3].trim()}`;
}

// Roadworks permit nature codes, in English.
const NATURE = [
  [/immeuble/i, 'Building works'], [/eclairage/i, 'Street lighting'], [/electricit/i, 'Electricity'],
  [/eau potable/i, 'Water main'], [/assainissement/i, 'Sewer'], [/gaz/i, 'Gas'], [/t[ée]l[ée]com/i, 'Telecoms'],
  [/chaud|froid/i, 'District heating'], [/espace public/i, 'Street works'],
];
const NATURE2 = [
  [/cl[ôo]ture/i, 'site fence on the street'], [/[ée]chafaudage/i, 'scaffolding on the street'], [/manutention/i, 'lifting and handling'],
  [/voirie/i, 'road layout'], [/trottoir/i, 'pavement repair'], [/sondage/i, 'trial holes'], [/espaces verts/i, 'planting'],
  [/mobilier/i, 'street furniture'], [/s[ée]curit/i, 'safety works'], [/d[ée]molition/i, 'demolition'],
  [/cr[ée]ation/i, 'new'], [/renouvellement/i, 'renewal'], [/r[ée]paration/i, 'repair'], [/entretien/i, 'maintenance'],
  [/suppression/i, 'removal'], [/construction/i, 'construction'], [/am[ée]nagement/i, 'redesign'],
];
function nature(n1, n2) {
  const a = NATURE.find(([re]) => re.test(n1 || ''))?.[1] || 'Works';
  const kind = /branchement/i.test(n1 || '') ? ' connection' : /r[ée]seau/i.test(n1 || '') ? ' network' : '';
  const b = NATURE2.find(([re]) => re.test(n2 || ''))?.[1];
  return `${a}${kind}${b ? `: ${b}` : ''}`;
}

// Passenger messages carry the day's biggest news (tram suspensions) as free French text. Read the
// patterns operators actually use and turn them into a headline; keep the original as a quote.
function readMessage(text) {
  const t = norm(text);
  // Every "Tram X <from> <> <to>" stretch the message names.
  const stretches = [...t.matchAll(/tram ([a-f])(?: interrompu)? ([a-z' .-]+?) <> ([a-z' .-]+?)(?= \/| {2,}|\.| >|$| ligne| lignes| relais| nettoyage)/g)]
    .map((m) => ({ tram: m[1].toUpperCase(), ends: [m[2].trim(), m[3].trim()] }));
  const letters = [...new Set(stretches.map((x) => x.tram))];
  let m = t.match(/tram ([a-f]) interrompu/);
  if (m) {
    const x = stretches.find((y) => y.tram === m[1].toUpperCase());
    return { headline: `Tram ${m[1].toUpperCase()} suspended${x ? `: ${x.ends.map(titleCase).join(' – ')}` : ''}`, severity: 3, trams: [m[1].toUpperCase()], stretches };
  }
  m = t.match(/interruptions? ((?:[a-f]\s*){2,})/);
  if (m) {
    const trams = [...new Set(m[1].trim().toUpperCase().split(/\s+/))];
    return { headline: `Trams ${trams.join(', ')} suspended`, severity: 3, trams, stretches };
  }
  if (/station non desservie/.test(t)) return { headline: 'Stop not served', severity: 2, trams: letters, stretches };
  if (/quai oppose/.test(t)) return { headline: 'Departures from the opposite platform', severity: 1 };
  if (/(tvx|travaux).*arrets? report|arrets? report|arret provisoire/.test(t)) return { headline: 'Works: stops moved', severity: 2 };
  if (/devi/.test(t)) return { headline: 'Diversion announced to passengers', severity: 2 };
  return { headline: 'Passenger notice', severity: 0 };
}

// ---------- time (the network runs on Paris time, wherever the viewer is) ----------

const WEEKDAYS = ['DIMANCHE', 'LUNDI', 'MARDI', 'MERCREDI', 'JEUDI', 'VENDREDI', 'SAMEDI'];
export const todayISO = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
export const nowParis = () => new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
export const hm = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
export const fmt = (min) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

// The service day starts at 03:00, so a night shift ending at 01:05 belongs to the evening before.
const svc = (min) => (min - 180 + 1440) % 1440;

// Where a duty stands at a given minute of the day: not started, on the road, or over.
export function dutyState(duty, nowMin) {
  const s = svc(hm(duty.start)), e = svc(hm(duty.end)), n = svc(nowMin);
  if (n < s) return { state: 'later', inMin: s - n };
  if (n < e) return { state: 'road', inMin: 0 };
  return { state: 'done', inMin: Infinity };
}

// ---------- loading ----------

async function fetchLive(name) {
  const res = await fetch(`${API}/${name}/exports/json`);
  if (!res.ok) throw new Error(`Bordeaux open data (${name}) answered HTTP ${res.status}`);
  return res.json();
}

export async function build() {
  const raw = Object.fromEntries(await Promise.all(LIVE.map(async (n) => [n, await fetchLive(n)])));
  const fetchedAt = new Date();
  const today = todayISO();
  const now = new Date();
  const weekday = WEEKDAYS[nowParis().getDay()];

  // Lines from the snapshot; shapes are rebuilt from the [lat, lon] points it stores.
  const lines = new Map();
  for (const l of network.lines) {
    lines.set(l.id, { ...l, shapes: [prepare(l.geo.map((g) => g.map(([lat, lon]) => [lon, lat])))] });
  }
  const stops = new Map(network.stops.map(([id, name, lat, lon, active]) => [id, { id, name, lat, lon, active: !!active }]));

  const busLinesNear = (shape, metres) => [...lines.values()].filter((l) => l.mode === 'BUS' && l.shapes.some((s) => distShapes(shape, s) <= metres)).map((l) => l.id);
  const linesThroughStop = (stop, metres = 35) => {
    const [x, y] = toXY([stop.lon, stop.lat]);
    return [...lines.values()].filter((l) => l.shapes.some((s) => distPointShape(x, y, s) <= metres)).map((l) => l.id);
  };

  // The stretch of a line between two named stops, for messages like "Tram B interrompu X <> Y".
  function stretch(lineId, names) {
    const line = lines.get(lineId);
    if (!line || names.length < 2) return [];
    const find = (name) => {
      const n = norm(name).replace(/^st /, 'st ').replace(/^bre /, 'barriere ');
      const cands = [...stops.values()].filter((s) => norm(s.name) === n).concat([...stops.values()].filter((s) => norm(s.name).startsWith(n)));
      return cands.find((s) => { const [x, y] = toXY([s.lon, s.lat]); return line.shapes.some((sh) => distPointShape(x, y, sh) <= 35); });
    };
    const a = find(names[0]), b = find(names[1]);
    if (!a || !b) return [];
    // Cut the route part that passes closest to both stops between them.
    let best = null;
    for (const part of line.geo) {
      const near = (s) => part.reduce((acc, [lat, lon], i) => { const d = Math.hypot((lon - s.lon) * KX, (lat - s.lat) * KY); return d < acc.d ? { i, d } : acc; }, { i: 0, d: Infinity });
      const ia = near(a), ib = near(b);
      if (!best || ia.d + ib.d < best.d) best = { part, from: Math.min(ia.i, ib.i), to: Math.max(ia.i, ib.i), d: ia.d + ib.d };
    }
    return best && best.d < 120 && best.to > best.from ? [best.part.slice(best.from, best.to + 1)] : [];
  }

  const changes = [];

  // 1. Diversions the operator has published, in force right now. These change the drive.
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
    if (!affected.length) affected = busLinesNear(prepare(ls), 15);
    const [fromName, toName] = String(d.libelle || '').replace(/^D[ée]viation\s*/i, '').split(/\s*<=>\s*/);
    changes.push({
      id: `dev-${d.gid}`, kind: 'diversion', severity: 2, drive: true,
      title: toName ? `${fromName} → ${toName}` : fromName || 'Diversion',
      when: `${DIRECTION[d.sens] || 'Both directions'} · until ${until(d.fin)}${days(d.jour_appli)}`,
      detail: 'Follow the published diversion between these stops. The dashed line on the map is the route to take.',
      lines: affected, window: null, ref: d.ident,
      geo: ls.map((l) => thin(l, 10)), shape: prepare(ls), source: 'Network diversions',
    });
  }

  // 2. Roadworks permits in force today that run along a bus route. Trams have their own track.
  for (const w of raw.ci_chantier) {
    if (!w.geo_shape || !w.date_debut || !w.date_fin) continue;
    if (w.date_debut > today || w.date_fin < today) continue;
    const ls = linesOf(w.geo_shape);
    const shape = prepare(ls);
    const affected = [...lines.values()].filter((l) => l.mode === 'BUS' && l.shapes.some((s) => alongRoute(shape, s))).map((l) => l.id);
    if (!affected.length) continue;
    const measures = w.libelle || '';
    const blocking = /circulation interdite|mise en impasse|d[ée]viation/i.test(measures);
    const narrowed = /chauss[ée]e r[ée]tr[ée]cie|alternat|neutralis/i.test(measures);
    changes.push({
      id: `works-${w.gid}`, kind: 'works', severity: blocking ? 3 : 1, blocking, drive: blocking || narrowed,
      title: `${blocking ? 'Road closed' : narrowed ? 'Lane narrowed' : 'Roadworks'}: ${place(w.localisation)}`,
      when: `until ${until(w.date_fin)}`,
      detail: `${nature(w.alias_nature_n1, w.alias_nature_n2)}.${blocking ? ' The street is closed to traffic.' : narrowed ? ' Expect a narrowed lane.' : ' Traffic still passes.'}`,
      lines: affected, window: null, ref: w.ident,
      geo: ls.map((l) => (l.length === 1 ? [[l[0][1], l[0][0]]] : thin(l, 5))), shape, source: 'Roadworks permits',
    });
  }

  // 3. Messages shown to passengers. Variants of the same news (one per station) are merged.
  const msgGroups = new Map();
  for (const m of raw.sv_messa_a) {
    if (!m.message || !lines.has(String(m.rs_sv_ligne_a))) continue;
    const read = readMessage(m.message);
    const key = read.severity ? read.headline : `${read.headline}|${norm(m.message)}`;
    const g = msgGroups.get(key) || { read, texts: new Set(), lines: new Set(), stretches: [] };
    g.stretches.push(...(read.stretches || []));
    g.texts.add(String(m.message).replace(/\s{2,}/g, ' ').replace(/\s*\n\s*/g, ' / ').trim());
    g.lines.add(String(m.rs_sv_ligne_a));
    msgGroups.set(key, g);
  }
  let mi = 0;
  const tramId = (letter) => [...lines.values()].find((l) => l.mode === 'TRAM' && l.short === letter)?.id;
  for (const { read, texts, lines: ls, stretches } of msgGroups.values()) {
    // A suspension named for one tram goes to that tram's drivers, not every line at a shared stop.
    const named = (read.trams || []).map(tramId).filter(Boolean);
    const ids = named.length && (read.severity >= 3) ? named : [...ls];
    const seen = new Set();
    const geo = stretches.filter((x) => (read.trams || []).includes(x.tram)).filter((x) => { const k = x.tram + x.ends.join(); return !seen.has(k) && seen.add(k); })
      .flatMap((x) => stretch(tramId(x.tram), x.ends));
    const t = [...texts][0].match(/d[èe]s\s*(\d{1,2})\s*h\s*(\d{0,2})/i);
    changes.push({
      id: `msg-${mi++}`, kind: 'message', severity: read.severity, drive: read.severity >= 2,
      title: read.headline,
      when: t ? `from ${t[1].padStart(2, '0')}:${(t[2] || '00').padStart(2, '0')}` : 'now',
      detail: read.severity >= 2 ? 'Passengers are being told this at stops and online. Expect questions on board.' : '',
      quote: [...texts].sort((a, b) => b.length - a.length)[0],
      lines: ids,
      window: t ? { from: `${t[1].padStart(2, '0')}:${(t[2] || '00').padStart(2, '0')}`, to: null } : null,
      geo,
      source: 'Passenger information',
    });
  }

  // Where the operator's feeds disagree. These are leads to check, not verdicts.
  const gaps = [];
  const diversions = changes.filter((c) => c.kind === 'diversion');
  const toldLines = new Set(changes.filter((c) => c.kind === 'message' && c.severity >= 2).flatMap((c) => c.lines));
  const names = (ids) => ids.map((id) => lines.get(id).short).join(', ');
  for (const w of changes.filter((c) => c.kind === 'works' && c.blocking)) {
    const uncovered = w.lines.filter((id) => !diversions.some((d) => d.lines.includes(id) && distShapes(w.shape, d.shape) < 600));
    if (uncovered.length) gaps.push({
      id: `gap-${w.id}`, change: w.id, kind: 'closure-without-diversion', lines: uncovered,
      title: `Road closed on line ${names(uncovered)}, no diversion published`,
      text: `A roadworks permit closes ${w.title.replace(/^Road closed:\s*/, '')} on the route of ${uncovered.length === 1 ? 'line' : 'lines'} ${names(uncovered)}, and no diversion is published within 600 m.`,
    });
  }
  for (const d of diversions) {
    const silent = d.lines.filter((id) => !toldLines.has(id));
    if (silent.length) gaps.push({
      id: `gap-${d.id}`, change: d.id, kind: 'diversion-without-message', lines: silent,
      title: `Diversion ${d.title}: passengers not told`,
      text: `The diversion ${d.title} is in force on ${silent.length === 1 ? 'line' : 'lines'} ${names(silent)}, but no passenger message mentions a diversion or moved stop on ${silent.length === 1 ? 'that line' : 'those lines'}.`,
    });
  }

  // Simulated duties: three shifts per line, with made-up names.
  const FIRST = ['Amina', 'Bruno', 'Chloé', 'Damien', 'Élodie', 'Farid', 'Gaëlle', 'Hugo', 'Inès', 'Julien', 'Karim', 'Léa', 'Mehdi', 'Nora', 'Olivier', 'Pauline', 'Quentin', 'Rania', 'Samuel', 'Thomas', 'Yasmine', 'Zoé'];
  const LAST = 'BCDFGHJLMNPRSTV';
  const SHIFTS = [['05:10', '12:40'], ['11:50', '19:20'], ['18:30', '01:05']];
  const duties = [];
  let n = 0;
  for (const l of lines.values()) {
    SHIFTS.forEach(([start, end], i) => {
      duties.push({ id: `S${l.id.padStart(3, '0')}${i + 1}`, line: l.id, lineShort: l.short, lineName: l.name, mode: l.mode, start, end, driver: `${FIRST[n % FIRST.length]} ${LAST[(n * 7) % LAST.length]}.` });
      n++;
    });
  }

  for (let i = changes.length - 1; i >= 0; i--) if (!changes[i].lines.length) changes.splice(i, 1);
  for (const c of changes) delete c.shape;
  changes.sort((a, b) => b.drive - a.drive || b.severity - a.severity || b.lines.length - a.lines.length);
  return { fetchedAt, networkAt: network.takenAt, today, lines, changes, gaps, duties };
}

// A change concerns a duty when it is on the duty's line and in force during its hours.
export function concerns(change, duty) {
  if (!change.lines.includes(duty.line)) return false;
  if (!change.window?.from) return true;
  const s = hm(duty.start); let e = hm(duty.end); if (e < s) e += 1440;
  const f = hm(change.window.from);
  const t = change.window.to ? hm(change.window.to) : 1440 + 300;
  return f < e && t > s;
}

// For the demo, two thirds of the drivers who have signed on by `nowMin` read their brief within a
// few minutes of signing on. Marked simulated; real reads come from Forge storage and win.
export function simulatedReads(model, nowMin) {
  const reads = {};
  model.duties.forEach((d, i) => {
    // Spread the third who have not read across every shift, not one shift slot.
    if ((Math.floor(i / 3) + i) % 3 === 0 || dutyState(d, nowMin).state === 'later') return;
    const at = fmt(hm(d.start) + 2 + (i % 7));
    for (const c of model.changes) if (concerns(c, d)) (reads[d.id] ||= {})[c.id] = { at: `${model.today}T${at}:00`, simulated: true };
  });
  return reads;
}
