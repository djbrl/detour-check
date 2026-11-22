// Builds the change desk from Bordeaux Métropole open data: which planned disruptions touch the bus
// and tram network, and whether what was approved for each one matches what is actually published.
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

// ---------- dates (the network runs on Paris time, wherever the viewer is) ----------

export const parisDate = (d) => new Date(d).toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
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
// Older changes were handled when they started; the desk is for what is new or coming.
const RECENT_DAYS = 14;
const PLANNED_HOURS = 24;
const NEAR_METRES = 800;

// Turns the three published feeds into the list of disruptions a change coordinator has to handle:
// roadworks permits on a bus route that are in force or start within four weeks, diversions the
// operator planned for a day or more, and tram suspensions announced to passengers.
export function buildDesk(feeds, now) {
  const { lines, stops, linesThroughStop } = net();
  const today = parisDate(now);
  const horizon = addDays(today, HORIZON_DAYS);
  const since = addDays(today, -RECENT_DAYS);
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
      title: toName ? `${fromName} → ${toName}` : fromName || 'Diversion',
      direction: d.sens || 'ALLER_RETOUR', starts: d.debut, ends: d.fin, days: d.jour_appli,
      hours: (new Date(d.fin) - new Date(d.debut)) / 36e5,
      lines: ids, shape, geo: parts.map((l) => thin(l, 10)),
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
    if (!w.geo_shape || !w.date_debut || !w.date_fin) continue;
    if (w.date_fin < today || w.date_debut < since || w.date_debut > horizon) continue;
    const parts = linesOf(w.geo_shape);
    const shape = prepare(parts);
    const ids = [...lines.values()].filter((l) => l.mode === 'BUS' && alongRoute(shape, l.shape, 10)).map((l) => l.id);
    if (!ids.length) continue;
    items.push({
      id: `works-${w.gid}`, kind: 'works', ref: w.ident, source: 'Roadworks permits',
      title: place(w.localisation), what: nature(w.alias_nature_n1, w.alias_nature_n2),
      starts: w.date_debut, ends: w.date_fin, lines: ids, stops: stopsNear(shape, ids), shape,
      geo: parts.map((l) => (l.length === 1 ? [[+l[0][1].toFixed(5), +l[0][0].toFixed(5)]] : thin(l, 5))),
    });
  }

  // 2. Diversions the operator planned for a day or more.
  for (const d of diversions) {
    if (d.hours < PLANNED_HOURS || !d.lines.length || parisDate(d.starts) < since || parisDate(d.starts) > horizon) continue;
    items.push({
      id: d.id, kind: 'diversion', ref: d.ref, source: 'Network diversions',
      title: d.title, what: d.stopMoved ? 'Stop moved' : `Diversion, ${DIRECTION[d.direction]?.toLowerCase() || 'both directions'}`,
      starts: parisDate(d.starts), ends: parisDate(d.ends), lines: d.lines, stops: stopsNear(d.shape, d.lines, 30),
      shape: d.shape, geo: d.geo, direction: d.direction,
    });
  }

  // 3. Messages shown to passengers, by line. A tram suspension is also a disruption in its own right.
  const messages = new Map();
  const trams = new Map();
  const tramId = (letter) => [...lines.values()].find((l) => l.mode === 'TRAM' && l.short === letter)?.id;
  for (const m of feeds.sv_messa_a || []) {
    const lineId = String(m.rs_sv_ligne_a);
    if (!m.message || !lines.has(lineId)) continue;
    const read = readMessage(m.message);
    const text = String(m.message).replace(/\s{2,}/g, ' ').replace(/\s*\n\s*/g, ' / ').trim();
    const list = messages.get(lineId) || [];
    if (!list.some((x) => x.text === text)) list.push({ headline: read.headline, severity: read.severity, text });
    messages.set(lineId, list);
    if (read.severity >= 3) for (const letter of read.trams || []) {
      const id = tramId(letter);
      if (!id) continue;
      const t = trams.get(letter) || { id, read, texts: new Set(), stretches: [] };
      t.texts.add(text);
      t.stretches.push(...(read.stretches || []).filter((x) => x.tram === letter));
      trams.set(letter, t);
    }
  }
  for (const [letter, t] of trams) {
    const seen = new Set();
    const ends = t.stretches.filter((x) => { const k = x.ends.join(); return !seen.has(k) && seen.add(k); });
    const geo = ends.flatMap((x) => stretch(t.id, x.ends));
    const parts = geo.map((g) => g.map(([lat, lon]) => [lon, lat]));
    const shape = parts.length ? prepare(parts) : null;
    items.push({
      id: `tram-${letter}`, kind: 'tram', ref: `Tram ${letter}`, source: 'Passenger information',
      title: t.read.headline, what: 'Tram service suspended', starts: today, ends: null, lines: [t.id],
      stops: shape ? stopsNear(shape, [t.id], 30) : [], shape, geo,
      quote: [...t.texts].sort((a, b) => b.length - a.length)[0],
    });
  }

  // The stretch of a line between two named stops, for "Tram B interrompu X <> Y".
  function stretch(lineId, names) {
    const line = lines.get(lineId);
    if (!line || names.length < 2) return [];
    const find = (name) => {
      const n = norm(name).replace(/^bre /, 'barriere ');
      const cands = [...stops.values()].filter((s) => norm(s.name) === n).concat([...stops.values()].filter((s) => norm(s.name).startsWith(n)));
      return cands.find((s) => { const [x, y] = toXY([s.lon, s.lat]); return distPointShape(x, y, line.shape) <= 35; });
    };
    const a = find(names[0]), b = find(names[1]);
    if (!a || !b) return [];
    let best = null;
    for (const part of line.geo) {
      const near = (s) => part.reduce((acc, [lat, lon], i) => { const d = Math.hypot((lon - s.lon) * KX, (lat - s.lat) * KY); return d < acc.d ? { i, d } : acc; }, { i: 0, d: Infinity });
      const ia = near(a), ib = near(b);
      if (!best || ia.d + ib.d < best.d) best = { part, from: Math.min(ia.i, ib.i), to: Math.max(ia.i, ib.i), d: ia.d + ib.d };
    }
    return best && best.d < 120 && best.to > best.from ? [best.part.slice(best.from, best.to + 1)] : [];
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

// What a change request starts from before anyone has assessed it.
export function defaultPlan(item) {
  return {
    item: item.id, impact: item.kind === 'tram' ? 'stops' : item.kind === 'diversion' ? 'closed' : null,
    lines: item.lines, starts: item.starts, ends: item.ends, stops: item.stops.map((s) => s.id),
    // A one-way diversion is often a one-way street; the coordinator says otherwise if not.
    directions: item.kind === 'diversion' && item.direction !== 'ALLER_RETOUR' ? 'one' : 'both',
  };
}

const NOTICE = /devi|report|interromp|non desservi|travaux|tvx|arret provisoire|perturb|ne dessert|supprim/;

// [[id, end], ...] -> [[end, [ids]], ...]
const groupBy = (pairs) => [...pairs.reduce((m, [id, k]) => m.set(k, [...(m.get(k) || []), id]), new Map())];

// Each check is pass, fail or pending (not due yet). Published information is due the day before the
// change starts, so an upcoming change is not shown as failing until it is late.
export function runChecks(plan, item, desk) {
  const checks = [];
  if (!plan.impact) return { state: 'not-assessed', checks, failing: 0 };
  if (plan.impact === 'none') return { state: 'no-impact', checks, failing: 0 };
  const due = plan.starts ? addDays(plan.starts, -1) : desk.today;
  const late = desk.today >= due;
  const add = (id, label, ok, evidence) => checks.push({ id, label, state: ok ? 'pass' : late ? 'fail' : 'pending', evidence, due });
  const buses = plan.lines.filter((id) => lineInfo(id)?.mode === 'BUS');

  if ((plan.impact === 'closed' || plan.impact === 'stops') && buses.length) {
    const found = new Map(buses.map((id) => [id, desk.diversions.filter((d) => d.lines.includes(id) && (d.id === item.id || (item.shape && distShapes(item.shape, d.shape) <= NEAR_METRES)))]));
    const missing = buses.filter((id) => !found.get(id).length);
    add('diversion', 'Diversion published', !missing.length, missing.length
      ? `No diversion published for ${lineLabel(missing)} within ${NEAR_METRES} m of the works.`
      : `Published for ${lineLabel(buses)}: ${[...new Set(buses.map((id) => found.get(id)[0].title))].slice(0, 3).join('; ')}.`);

    const covered = buses.filter((id) => found.get(id).length);
    if (covered.length && plan.directions === 'both') {
      const oneWay = covered.filter((id) => { const s = new Set(found.get(id).map((d) => d.direction)); return !s.has('ALLER_RETOUR') && !(s.has('ALLER') && s.has('RETOUR')); });
      add('directions', 'Both directions covered', !oneWay.length, oneWay.length
        ? `Published one way only on ${lineLabel(oneWay)}.`
        : 'Every diverted line has a diversion in both directions.');
    }
    if (covered.length && plan.ends) {
      const short = covered.map((id) => [id, found.get(id).reduce((m, d) => (parisDate(d.ends) > m ? parisDate(d.ends) : m), '')]).filter(([, end]) => end < plan.ends);
      add('dates', 'Diversion lasts as long as the works', !short.length, short.length
        ? `${groupBy(short).map(([end, ids]) => `On ${lineLabel(ids)} the diversion ends ${dayLabel(end, desk.now)}`).join('; ')}. The change runs until ${dayLabel(plan.ends, desk.now)}.`
        : `Published diversions run until ${dayLabel(plan.ends, desk.now)} or later.`);
    }
  }

  // Bordeaux's stop displays carry tram news only; bus notices go out on other channels, so the
  // published check covers trams and the bus notice is a sign-off instead.
  const trams = plan.lines.filter((id) => lineInfo(id)?.mode === 'TRAM');
  const stopNames = (plan.stops || []).map((id) => net().stops.get(id)?.name).filter(Boolean).map(norm);
  const told = (id) => (desk.messages.get(id) || []).find((m) => { const t = norm(m.text); return NOTICE.test(t) || stopNames.some((s) => s.length > 3 && t.includes(s)); });
  const silent = trams.filter((id) => !told(id));
  if (trams.length) add('notice', 'Passengers told at stops', !silent.length, silent.length
    ? `No passenger message on ${lineLabel(silent)} mentions a diversion, works or a stop not served.`
    : trams.map((id) => `Line ${lineInfo(id)?.short}: "${told(id).text.slice(0, 90)}${told(id).text.length > 90 ? '…' : ''}"`).join(' '));

  const failing = checks.filter((c) => c.state === 'fail').length;
  const pending = checks.filter((c) => c.state === 'pending').length;
  return { state: failing ? 'failing' : pending ? 'pending' : 'ready', checks, failing, pending, due };
}

// ---------- shapes for the page and for Rovo ----------

export function summary(item, desk) {
  return {
    id: item.id, kind: item.kind, title: item.title, what: item.what, status: item.status,
    starts: item.starts, ends: item.ends, startsLabel: dayLabel(item.starts, desk.now), endsLabel: dayLabel(item.ends, desk.now),
    lines: item.lines.map(lineInfo).filter(Boolean), source: item.source, ref: item.ref,
  };
}

export function detail(item, desk) {
  const nearby = item.shape ? desk.diversions.filter((d) => d.id !== item.id && d.lines.some((id) => item.lines.includes(id)) && distShapes(item.shape, d.shape) <= NEAR_METRES) : [];
  return {
    ...summary(item, desk),
    stops: item.stops, geo: item.geo, quote: item.quote || null,
    lineGeo: Object.fromEntries(item.lines.map((id) => [id, lineGeo(id)])),
    diversions: nearby.map((d) => ({ id: d.id, title: d.title, direction: DIRECTION[d.direction] || 'Both directions', starts: d.starts, ends: d.ends, endsLabel: dayLabel(d.ends, desk.now), lines: d.lines.map(lineInfo).filter(Boolean), geo: d.geo })),
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
