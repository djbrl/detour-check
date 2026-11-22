// Builds the desk from Bordeaux Métropole open data: which roadworks permits touch a bus route,
// and whether the detour published for each one goes round it for the whole time.
// The network (lines, routes, stops) comes from a snapshot the caller passes to useNetwork(); the
// three feeds are fetched live or read from a frozen demo day, so judges see what the video shows.

export const API = 'https://opendata.bordeaux-metropole.fr/api/explore/v2.1/catalog/datasets';
export const FEEDS = ['sv_devia_l', 'ci_chantier', 'sv_messa_a'];

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
const DIRECTION = { ALLER: 'Outbound', RETOUR: 'Inbound', ALLER_RETOUR: 'Both directions' };

// "Rue Surson au N° 59 (Bordeaux) situé en agglomération" -> "59 Rue Surson, Bordeaux";
// "Rue Frantz Schrader à partir du N° 6 jusqu'au N° 8 (Bordeaux)" -> "6 Rue Frantz Schrader, Bordeaux".
function place(localisation) {
  // Permits list several addresses; the first is enough to find it.
  const s = String(localisation || '').split(/\s*(?:situ[ée]s?\s+)?en agglom[ée]ration\s*/i)[0].trim();
  const m = s.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (!m) return s || 'Unnamed street';
  let street = m[1];
  const no = street.match(/\b(?:au|du) N°\s*([\w/-]+)/i)?.[1];
  street = street.replace(/\s+(?:au N°|à partir d[ue]|de l'intersection|jusqu'|sur le côté|côté|entre |face au|à l'angle|à l'intersection).*$/i, '').trim();
  return `${no ? `${no} ` : ''}${street || m[1].trim()}, ${m[2].trim()}`;
}

// Roadworks permits describe the works with two French codes: what is worked on, and what is done to
// it. Together they make one plain phrase, such as "Replacing a water connection".
const UTILITIES = [
  [/eau potable/i, { connection: 'a water connection', network: 'the water main' }],
  [/gaz/i, { connection: 'a gas connection', network: 'the gas main' }],
  [/electricit/i, { connection: 'a power connection', network: 'power cables', furniture: 'electrical cabinets' }],
  [/eclairage/i, { connection: 'a street light connection', network: 'street lighting', furniture: 'street lights' }],
  [/t[ée]l[ée]com/i, { connection: 'a telecoms connection', network: 'telecoms cables' }],
  [/assainissement/i, { connection: 'a sewer connection', network: 'the sewer' }],
  [/chaud|froid/i, { connection: 'a district heating connection', network: 'district heating pipes' }],
];
const ACTIONS = [
  [/cr[ée]ation/i, (x) => `New ${bare(x)}`], [/renouvellement/i, (x) => `Replacing ${x}`],
  [/r[ée]paration/i, (x) => `Repairing ${x}`], [/entretien/i, (x) => `${cap(bare(x))} maintenance`],
  [/suppression/i, (x) => `Removing ${x}`], [/modification/i, (x) => `Changing ${x}`],
];
const PUBLIC_SPACE = [
  [/espaces verts/i, (n2) => (/entretien/i.test(n2) ? 'Tree and planting upkeep' : 'New planting')],
  [/voie nouvelle/i, () => 'New road'], [/voirie|DVL|am[ée]nagement/i, (n2) => (/entretien/i.test(n2) ? 'Road maintenance' : 'Road layout changes')],
  [/mobilier/i, () => 'Street furniture'], [/sondage/i, () => 'Trial holes'],
];
const bare = (x) => x.replace(/^(a|the) /, '');
const cap = (x) => x[0].toUpperCase() + x.slice(1);
function nature(n1 = '', n2 = '') {
  const utility = UTILITIES.find(([re]) => re.test(n1))?.[1];
  if (utility) {
    const part = /branchement/i.test(n1) ? 'connection' : /mobilier/i.test(n1) ? 'furniture' : 'network';
    const x = utility[part] || utility.network;
    return (ACTIONS.find(([re]) => re.test(n2))?.[1] || ((y) => `Works on ${y}`))(x);
  }
  if (/immeuble/i.test(n1)) {
    const what = /[ée]chafaudage/i.test(n2) ? 'Scaffolding' : 'Site fence';
    return `${what} for ${/d[ée]molition/i.test(n1) ? 'a demolition' : 'building works'}`;
  }
  if (/voies ferr[ée]es/i.test(n1)) return 'Tram track works';
  if (/espace public/i.test(n1)) return PUBLIC_SPACE.find(([re]) => re.test(n2))?.[1](n2) || 'Street works';
  return 'Roadworks';
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

// ---------- dates (the network runs on Paris time, wherever the viewer is) ----------

export const parisDate = (d) => new Date(d).toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
const DAY = /^\d{4}-\d{2}-\d{2}$/;
// Multi-phase permits list each phase's dates joined by "#"; the desk takes the whole span.
function permitSpan(debut, fin) {
  const days = (v) => String(v || '').split('#').map((x) => x.trim().slice(0, 10)).filter((x) => DAY.test(x)).sort();
  const s = days(debut), e = days(fin);
  return s.length && e.length && s[0] <= e.at(-1) ? [s[0], e.at(-1)] : null;
}
// A detour that ends in the small hours stops before that day's service, so it covers the day before.
const endDay = (iso) => parisDate(new Date(new Date(iso) - 5 * 36e5));
const addDays = (iso, n) => { const t = new Date(`${iso}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
export const daysBetween = (a, b) => Math.round((new Date(`${b}T12:00:00Z`) - new Date(`${a}T12:00:00Z`)) / 864e5);
export function dayLabel(iso, now = new Date()) {
  if (!iso) return 'further notice';
  const t = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  if (Number.isNaN(+t)) return 'further notice';
  const year = parisDate(t).slice(0, 4) !== parisDate(now).slice(0, 4) ? 'numeric' : undefined;
  return t.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year, timeZone: 'Europe/Paris' });
}

// ---------- network: built once per snapshot ----------

let RAW = null;
let NET = null;
// Sets the network snapshot the model works on: the full one for live data, or the slice of it that
// a precomputed demo day needs.
export function useNetwork(raw) {
  if (raw !== RAW) { RAW = raw; NET = null; }
}
function net() {
  if (NET) return NET;
  if (!RAW) throw new Error('No network loaded');
  const network = RAW;
  const lines = new Map();
  // Route shapes are only needed for matching, not for listing the desk, so they are built on first use.
  for (const l of network.lines) {
    let shape = null;
    lines.set(l.id, Object.defineProperty({ ...l }, 'shape', { get: () => (shape ||= prepare(l.geo.map((g) => g.map(([lat, lon]) => [lon, lat])))) }));
  }
  const stops = new Map(network.stops.map(([id, name, lat, lon]) => [id, { id, name, lat, lon }]));
  const through = new Map();
  // Lines that pass a stop, within 35 m of the stop pole.
  const linesThroughStop = (stop) => {
    if (!through.has(stop.id)) {
      const [x, y] = toXY([stop.lon, stop.lat]);
      through.set(stop.id, [...lines.values()].filter((l) => distPointShape(x, y, l.shape) <= 35).map((l) => l.id));
    }
    return through.get(stop.id);
  };
  NET = { lines, stops, linesThroughStop, takenAt: network.takenAt };
  return NET;
}

export const lineInfo = (id) => { const l = net().lines.get(id); return l ? { id, short: l.short, name: l.name, mode: l.mode } : null; };
export const lineGeo = (id) => net().lines.get(id)?.geo || [];
export const lineLabel = (ids) => {
  const shorts = ids.map((id) => net().lines.get(id)?.short).filter(Boolean);
  return `${shorts.length === 1 ? 'line' : 'lines'} ${shorts.join(', ')}`;
};

// ---------- the desk ----------

const HORIZON_DAYS = 28;
// A detour serves a works site when it leaves and rejoins the route on either side of it, or, when
// its end stops are unknown, passes within this distance of it.
const MATCH_METRES = 150;

// Turns the three published feeds into the list of disruptions a change coordinator has to handle:
// roadworks permits on a bus route that are in force or start within four weeks. Published detours
// and passenger messages are kept as the evidence the checks compare against.
export function buildDesk(feeds, now) {
  const { lines, stops, linesThroughStop } = net();
  const today = parisDate(now);
  const horizon = addDays(today, HORIZON_DAYS);
  const items = [];

  // Every published diversion still running, short ones included: they are evidence for checks.
  const diversions = [];
  for (const d of feeds.sv_devia_l || []) {
    if (d.actif !== 'True' || !d.geo_shape || new Date(d.fin) < now) continue;
    const from = stops.get(String(d.rg_sv_arret_p_nd));
    const to = stops.get(String(d.rg_sv_arret_p_na));
    let ids = [];
    if (from && to) {
      // Diversions are for buses; a tram stop beside a bus stop would otherwise match.
      const a = new Set(linesThroughStop(from));
      ids = linesThroughStop(to).filter((id) => a.has(id) && lines.get(id).mode === 'BUS');
    }
    const parts = linesOf(d.geo_shape);
    const shape = prepare(parts);
    if (!ids.length) ids = [...lines.values()].filter((l) => l.mode === 'BUS' && distShapes(shape, l.shape) <= 15).map((l) => l.id);
    const [fromName, toName] = String(d.libelle || '').replace(/^D[ée]viation\s*/i, '').split(/\s*<=>\s*/);
    diversions.push({
      id: `dev-${d.gid}`, gid: d.gid, ref: d.ident, stopMoved: d.type === 'REPORT_ARRET',
      title: toName ? `${fromName} → ${toName}` : fromName || 'Detour',
      direction: d.sens || 'ALLER_RETOUR', starts: d.debut, ends: d.fin, days: d.jour_appli,
      hours: (new Date(d.fin) - new Date(d.debut)) / 36e5,
      lines: ids, shape, geo: parts.map((l) => thin(l, 10)),
      // Where the detour leaves and rejoins the route, in metres.
      from: from ? toXY([from.lon, from.lat]).map(Math.round) : null, to: to ? toXY([to.lon, to.lat]).map(Math.round) : null,
      // The same two stops for the map, where the detour is pinned at both ends.
      leaves: from ? { name: from.name, lat: from.lat, lon: from.lon } : null, rejoins: to ? { name: to.name, lat: to.lat, lon: to.lon } : null,
    });
  }

  // Stops on the given lines within `metres` of a shape, nearest first.
  const stopsNear = (shape, ids, metres = 40) => {
    const want = new Set(ids);
    const found = [];
    for (const s of stops.values()) {
      const [x, y] = toXY([s.lon, s.lat]);
      const d = distPointShape(x, y, shape);
      if (d <= metres && linesThroughStop(s).some((id) => want.has(id))) found.push({ id: s.id, name: s.name, lat: s.lat, lon: s.lon, d });
    }
    // One entry per stop name: both platforms of a stop share it.
    const seen = new Set();
    return found.sort((a, b) => a.d - b.d).filter((s) => !seen.has(s.name) && seen.add(s.name)).map(({ d, ...s }) => s);
  };

  // 1. Roadworks permits on a bus route, in force or starting within the horizon.
  for (const w of feeds.ci_chantier || []) {
    const when = w.geo_shape && permitSpan(w.date_debut, w.date_fin);
    // Everything still in force counts, however long ago it started: its detour can still run out.
    if (!when || when[1] < today || when[0] > horizon) continue;
    const parts = linesOf(w.geo_shape);
    const shape = prepare(parts);
    const ids = [...lines.values()].filter((l) => l.mode === 'BUS' && alongRoute(shape, l.shape, 10)).map((l) => l.id);
    if (!ids.length) continue;
    items.push({
      id: `works-${w.gid}`, kind: 'works', ref: w.ident, source: 'Roadworks permits',
      title: place(w.localisation), what: nature(w.alias_nature_n1, w.alias_nature_n2),
      starts: when[0], ends: when[1], lines: ids, stops: stopsNear(shape, ids), shape,
      geo: parts.map((l) => (l.length === 1 ? [[+l[0][1].toFixed(5), +l[0][0].toFixed(5)]] : thin(l, 5))),
    });
  }

  // 2. Messages shown to passengers, by line.
  const messages = new Map();
  for (const m of feeds.sv_messa_a || []) {
    const lineId = String(m.rs_sv_ligne_a);
    if (!m.message || !lines.has(lineId)) continue;
    const read = readMessage(m.message);
    const text = String(m.message).replace(/\s{2,}/g, ' ').replace(/\s*\n\s*/g, ' / ').trim();
    const list = messages.get(lineId) || [];
    if (!list.some((x) => x.text === text)) list.push({ headline: read.headline, severity: read.severity, text });
    messages.set(lineId, list);
  }

  for (const it of items) it.status = it.starts <= today ? 'in-force' : 'upcoming';
  items.sort((a, b) => (a.status === b.status ? 0 : a.status === 'in-force' ? -1 : 1) || a.starts.localeCompare(b.starts) || b.lines.length - a.lines.length);
  return { now: new Date(now).toISOString(), today, items, byId: new Map(items.map((i) => [i.id, i])), diversions, messages };
}

// ---------- the go-live check: does what was approved match what passengers and drivers see? ----------

export const IMPACTS = {
  closed: 'Road closed: buses divert',
  stops: 'Stops not served',
  narrowed: 'Lane narrowed: delays only',
  none: 'No service impact',
};

// The permit's dates are the floor: a plan can say the works run longer or start sooner, but never
// that they are shorter than permitted, or narrowing the plan would make a missing detour pass.
// Everything that shows the plan's dates (checks, fields, timeline) goes through this.
export function planDates(plan, item) {
  return {
    starts: [plan.starts, item.starts].filter(Boolean).sort()[0],
    ends: item.ends && plan.ends ? [plan.ends, item.ends].sort()[1] : plan.ends || item.ends,
  };
}

// What a change request starts from before anyone has assessed it.
export function defaultPlan(item) {
  return { item: item.id, impact: null, lines: item.lines, starts: item.starts, ends: item.ends, stops: item.stops.map((x) => x.id), directions: 'both' };
}

// Does a published detour go round this works site? It must leave and rejoin the route on either side
// of it (the site lies inside the ellipse between its two end stops), or, without known end stops,
// run right past it.
function serves(d, shape) {
  if (d.from && d.to) {
    const reach = 1.2 * Math.hypot(d.to[0] - d.from[0], d.to[1] - d.from[1]) + 150;
    for (const p of shape.parts) for (const [x, y] of p) if (Math.hypot(x - d.from[0], y - d.from[1]) + Math.hypot(x - d.to[0], y - d.to[1]) <= reach) return true;
    return false;
  }
  return distShapes(shape, d.shape) <= MATCH_METRES;
}

// The published detours for each bus line of a works site, and the stretch of days each line is
// covered without a break, counted from the later of the works' start and today. The checks, the
// card's timeline and the Jira description all read this, so they give the same dates.
export function coverage(item, desk, plan = defaultPlan(item)) {
  const from = [plan.starts || item.starts, desk.today].sort()[1];
  const buses = (plan.lines || item.lines).filter((id) => lineInfo(id)?.mode === 'BUS');
  const found = new Map();
  const span = new Map();
  for (const id of buses) {
    const ds = item.shape ? desk.diversions.filter((d) => d.lines.includes(id) && endDay(d.ends) >= from && serves(d, item.shape)) : [];
    found.set(id, ds);
    if (!ds.length) continue;
    const runs = ds.map((d) => [parisDate(d.starts), endDay(d.ends)]).sort((x, y) => x[0].localeCompare(y[0]));
    let until = runs[0][1];
    for (const [st, en] of runs.slice(1)) if (st <= addDays(until, 1) && en > until) until = en;
    span.set(id, { start: runs[0][0], until });
  }
  return { from, buses, found, span };
}

const NOTICE = /devi|report|interromp|non desservi|travaux|tvx|arret provisoire|perturb|ne dessert|supprim/;

// Each check is pass, fail or pending (not due yet). Published information is due the day before the
// change starts, so an upcoming change is not shown as failing until it is late.
export function runChecks(plan, item, desk) {
  const checks = [];
  if (!plan.impact) return { state: 'not-assessed', checks, failing: 0 };
  if (plan.impact === 'none') return { state: 'no-impact', checks, failing: 0 };
  plan = { ...plan, ...planDates(plan, item) };
  const due = plan.starts ? addDays(plan.starts, -1) : desk.today;
  const late = desk.today >= due;
  const add = (id, label, ok, evidence, data = {}) => checks.push({ id, label, state: ok ? 'pass' : late ? 'fail' : 'pending', evidence, due, data });
  if (plan.impact === 'closed' || plan.impact === 'stops') {
    const { from, buses, found, span } = coverage(item, desk, plan);
    const missing = buses.filter((id) => !found.get(id).length);
    if (buses.length) add('diversion', 'Detour published', !missing.length, missing.length
      ? `No published detour goes round the works on ${lineLabel(missing)}.`
      : `Published for ${lineLabel(buses)}: ${[...new Set(buses.map((id) => found.get(id)[0].title))].slice(0, 3).join('; ')}.`, { missing, found: buses.length - missing.length });

    const covered = buses.filter((id) => found.get(id).length);
    if (covered.length && plan.directions === 'both') {
      const oneWay = covered.filter((id) => { const k = new Set(found.get(id).map((d) => d.direction)); return !k.has('ALLER_RETOUR') && !(k.has('ALLER') && k.has('RETOUR')); });
      add('directions', 'Detour runs both ways', !oneWay.length, oneWay.length
        ? `Published one way only on ${lineLabel(oneWay)}.`
        : 'Every diverted line has a detour in both directions.', { lines: oneWay });
    }
    if (covered.length && plan.ends) {
      const late = covered.filter((id) => span.get(id).start > from);
      const short = covered.filter((id) => span.get(id).until < plan.ends);
      const ends = short.map((id) => span.get(id).until).sort()[0] || null;
      const starts = late.map((id) => span.get(id).start).sort().at(-1) || null;
      const said = [
        ...(late.length ? [`On ${lineLabel(late)} the detour only starts ${dayLabel(starts, desk.now)}`] : []),
        ...(short.length ? [`On ${lineLabel(short)} the detour ends ${dayLabel(ends, desk.now)}`] : []),
      ];
      add('dates', 'Detour covers the whole works', !said.length, said.length
        ? `${said.join('; ')}. The works run until ${dayLabel(plan.ends, desk.now)}.`
        : `Published detours run from ${dayLabel(from, desk.now)} to ${dayLabel(plan.ends, desk.now)} or longer.`,
      { ends, starts, lines: [...new Set([...late, ...short])], gapDays: (ends ? daysBetween(ends, plan.ends) : 0) + (starts ? daysBetween(from, starts) : 0) });
    }
  }

  // Bordeaux's stop displays carry tram news only; bus notices go out on other channels, so the
  // published check covers trams and the bus notice is a sign-off instead.
  const trams = plan.lines.filter((id) => lineInfo(id)?.mode === 'TRAM');
  const stopNames = (plan.stops || []).map((id) => net().stops.get(id)?.name).filter(Boolean).map(norm);
  const told = (id) => (desk.messages.get(id) || []).find((m) => { const t = norm(m.text); return NOTICE.test(t) || stopNames.some((s) => s.length > 3 && t.includes(s)); });
  const silent = trams.filter((id) => !told(id));
  if (trams.length) add('notice', 'Passengers told at stops', !silent.length, silent.length
    ? `No passenger message on ${lineLabel(silent)} mentions a detour, works or a stop not served.`
    : trams.map((id) => `Line ${lineInfo(id)?.short}: "${told(id).text.slice(0, 90)}${told(id).text.length > 90 ? '…' : ''}"`).join(' '), { lines: silent });

  const failing = checks.filter((c) => c.state === 'fail').length;
  const pending = checks.filter((c) => c.state === 'pending').length;
  return { state: failing ? 'failing' : pending ? 'pending' : 'ready', checks, failing, pending, due };
}

// ---------- the outlook: what is going on, in words someone outside bus planning can follow ----------

export const LIGHTS = { red: 'Problem', amber: 'To check', green: 'Covered' };

const andList = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
function linesSaid(ids) {
  const ls = ids.map(lineInfo).filter(Boolean);
  const said = [];
  const buses = ls.filter((l) => l.mode !== 'TRAM').map((l) => l.short);
  const trams = ls.filter((l) => l.mode === 'TRAM').map((l) => l.short);
  if (buses.length) said.push(`${buses.length === 1 ? 'bus' : 'buses'} ${andList(buses)}`);
  if (trams.length) said.push(`${trams.length === 1 ? 'tram' : 'trams'} ${andList(trams)}`);
  return andList(said) || 'no line';
}
const day = (iso, now) => {
  const t = new Date(`${iso}T12:00:00Z`);
  const year = iso.slice(0, 4) !== parisDate(now).slice(0, 4) ? 'numeric' : undefined;
  return t.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year, timeZone: 'Europe/Paris' });
};
// Always in days, so the card, the timeline and Rovo give the same number.
const days = (n) => `${n} ${n === 1 ? 'day' : 'days'}`;

// The disruption itself, in one sentence.
function storyOf(item, desk) {
  const until = item.ends ? ` to ${day(item.ends, desk.now)}` : '';
  return `${item.what} at ${item.title}, from ${day(item.starts, desk.now)}${until}, on the route of ${linesSaid(item.lines)}.`;
}

// Each gap the go-live check found, as a sentence and the step that closes it.
function gapOf(c, plan, desk) {
  if (c.id === 'diversion') return c.data.found
    ? [`No detour goes round the works for ${linesSaid(c.data.missing)}.`, 'Check whether those lines can still get through. If not, publish a detour for them.']
    : ['No published detour goes round the works.', 'Check whether buses can still get through. If not, publish a detour.'];
  if (c.id === 'directions') return [`The detour for ${linesSaid(c.data.lines)} runs one way only.`, 'Publish a detour for the other direction, or confirm only one direction is affected.'];
  if (c.id === 'dates') {
    const { starts, ends, gapDays } = c.data;
    const said = starts && ends ? `The detour runs ${day(starts, desk.now)} to ${day(ends, desk.now)}`
      : starts ? `The detour only starts ${day(starts, desk.now)}` : `The detour ends ${day(ends, desk.now)}`;
    return [`${said}: ${days(gapDays)} of works with no detour.`, 'Extend the detour to cover the works, or confirm the road reopens sooner.'];
  }
  return [`Passengers on ${linesSaid(c.data.lines)} have not been told at the stops.`, 'Put a notice up at the stops.'];
}

// The works and the published detour as date ranges, so the card can draw the gap between them
// instead of describing it. The works bar is the permit; the plan's dates show only when they differ.
// The detour bar runs until the first line runs out, the same rule as the "covers the whole works" check.
export function timelineOf(item, desk, plan = null, result = null) {
  const p = plan ? { ...plan, ...planDates(plan, item) } : defaultPlan(item);
  const { span } = coverage(item, desk, p);
  const spans = [...span.values()];
  const detour = spans.length ? { from: spans.map((x) => x.start).sort()[0], to: spans.map((x) => x.until).sort()[0] } : null;
  const dates = result?.checks?.find((c) => c.id === 'dates');
  const differs = p.starts !== item.starts || p.ends !== item.ends;
  return {
    kind: item.kind, from: item.starts, to: item.ends, today: desk.today,
    plan: differs ? { from: p.starts, to: p.ends } : null,
    detour,
    // A gap only matters if buses cannot get through.
    gapDays: dates && dates.state !== 'pass' && !['narrowed', 'none'].includes(plan?.impact) ? dates.data.gapDays : 0,
  };
}

// A traffic light with a short label, a sentence on what is happening, the problem if there is one,
// and the next step. Before anyone has assessed a disruption it is judged on the worst case (buses
// cannot get through): a published detour that falls short is a problem, while no detour at all may
// only mean the road stays open, so that is something to check.
export function outlook(item, desk, plan = null, r = null) {
  const story = storyOf(item, desk);
  const assessed = !!plan?.impact;
  const worst = assessed ? plan : { ...defaultPlan(item), ...(plan || {}), impact: 'closed' };
  const result = assessed && r ? r : runChecks(worst, item, desk);
  const ORDER = ['diversion', 'dates', 'directions', 'notice'];
  const gaps = result.checks.filter((c) => c.state !== 'pass').sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
  const [problem, next] = gaps.length ? gapOf(gaps[0], worst, desk) : [null, null];
  const more = gaps.slice(1).map((c) => gapOf(c, worst, desk)[0]);
  const timeline = timelineOf(item, desk, plan, result);
  // Unassessed, only a published detour that falls short is a problem; a missing one is to check.
  // A detour over less than a third of a long permit is likely for one phase of it, so that is to
  // check too: the permit does not say when each phase closes the road.
  const t = timeline.detour;
  const overlap = t ? daysBetween([t.from, item.starts].sort()[1], [t.to, item.ends].sort()[0]) + 1 : 0;
  const phase = overlap * 3 < daysBetween(item.starts, item.ends) + 1;
  // One-way detours are common on one-way streets, so a single direction is to check as well.
  const short = gaps.filter((c) => c.id === 'dates' && !phase);
  const out = (light, label, p, n) => ({ light, label, story, problem: p, more: p === problem ? more : [], next: n, timeline, gaps: gaps.map((c) => c.id) });

  if (assessed) {
    // "No effect" is green only once someone other than the person who said so has confirmed it.
    if (plan.impact === 'none') return r?.ready
      ? out('green', 'No effect', 'Operations confirmed buses get through.', null)
      : out('amber', 'Confirm', 'Marked as no effect on buses.', r?.blocker || 'Operations signs off to confirm.');
    const none = gaps[0]?.id === 'diversion' && !gaps[0].data.found;
    if (result.failing) return out('red', none ? 'No detour' : gaps[0]?.id === 'diversion' ? 'Partly covered' : 'Falls short', problem, next);
    if (gaps.length) return out('amber', `Due ${day(result.due, desk.now)}`, problem, next);
    if (r?.ready) return out('green', 'Ready', 'Everything is published and every team has signed off.', null);
    const left = r ? r.roles - r.signed : 4;
    return out('amber', 'Sign-offs', 'What is published matches the plan.', left ? `Waiting for ${left} of ${r?.roles ?? 4} teams to sign off.` : r?.blocker || null);
  }
  if (short.length) {
    const [p, n] = gapOf(short[0], worst, desk);
    return { ...out('red', 'Falls short', p, n), more: gaps.filter((c) => c !== short[0]).map((c) => gapOf(c, worst, desk)[0]) };
  }
  if (gaps.length) return out('amber', gaps[0].id === 'diversion' && !gaps[0].data.found ? 'No detour' : 'Partly covered', problem, next);
  return out('green', 'Covered', 'A detour is published for the whole works.', null);
}

// ---------- shapes for the page and for Rovo ----------

export function summary(item, desk) {
  return {
    id: item.id, kind: item.kind, title: item.title, what: item.what, status: item.status,
    starts: item.starts, ends: item.ends, startsLabel: dayLabel(item.starts, desk.now), endsLabel: dayLabel(item.ends, desk.now),
    lines: item.lines.map(lineInfo).filter(Boolean), source: item.source, ref: item.ref,
    // The desk draws every disruption at once on its map.
    geo: item.geo || [],
  };
}

export function detail(item, desk) {
  const { found } = coverage(item, desk);
  const nearby = [...new Set([...found.values()].flat())];
  return {
    ...summary(item, desk),
    stops: item.stops, geo: item.geo, quote: item.quote || null,
    lineGeo: Object.fromEntries(item.lines.map((id) => [id, lineGeo(id)])),
    diversions: nearby.map((d) => ({ id: d.id, title: d.title, direction: DIRECTION[d.direction] || 'Both directions', starts: d.starts, ends: d.ends, endsLabel: dayLabel(d.ends && endDay(d.ends), desk.now), lines: d.lines.map(lineInfo).filter(Boolean), geo: d.geo, leaves: d.leaves, rejoins: d.rejoins })),
    messages: item.lines.map((id) => ({ line: lineInfo(id), messages: (desk.messages.get(id) || []).slice(0, 3) })),
  };
}

// ---------- precomputing a day ----------
// Building the desk takes a few seconds of geometry. For the frozen demo day it is done once at build
// time and shipped as JSON with only the part of the network it refers to.

// Shapes are in metres; a decimetre is precise enough and keeps the file small.
const roundShape = ({ parts, box }) => ({ parts: parts.map((p) => p.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10])), box });

export function serializeDesk(desk, takenAt) {
  const { lines, stops } = net();
  const lineIds = new Set([...desk.items.flatMap((i) => i.lines), ...desk.diversions.flatMap((d) => d.lines), ...desk.messages.keys()]);
  const stopIds = new Set(desk.items.flatMap((i) => i.stops.map((s) => s.id)));
  return {
    takenAt, now: desk.now, today: desk.today, messages: [...desk.messages],
    items: desk.items.map((i) => ({ ...i, shape: i.shape && roundShape(i.shape) })),
    diversions: desk.diversions.map((d) => ({ ...d, shape: roundShape(d.shape) })),
    network: {
      takenAt: RAW.takenAt,
      // Line geometry is only drawn on the map from here on, so 25 m between points is plenty.
      lines: [...lineIds].map((id) => lines.get(id)).filter(Boolean).map(({ shape, geo, ...l }) => ({ ...l, geo: geo.map((g) => thin(g.map(([lat, lon]) => [lon, lat]), 25)) })),
      stops: [...stopIds].map((id) => stops.get(id)).filter(Boolean).map((x) => [x.id, x.name, x.lat, x.lon]),
    },
  };
}

export function reviveDesk(pre) {
  useNetwork(pre.network);
  return { now: pre.now, today: pre.today, items: pre.items, byId: new Map(pre.items.map((i) => [i.id, i])), diversions: pre.diversions, messages: new Map(pre.messages) };
}
