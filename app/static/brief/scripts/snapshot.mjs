// Takes a snapshot of Bordeaux's network (lines, principal routes, stops) into src/network.json.
// Routes rarely change and the raw route export is 8 MB, so the app ships this snapshot and fetches
// only today's changes live. Run it again when the network changes: `npm run snapshot`.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, '..', '..', '..', 'src', 'network.json');
const API = 'https://opendata.bordeaux-metropole.fr/api/explore/v2.1/catalog/datasets';

async function get(dataset, query = '') {
  const res = await fetch(`${API}/${dataset}/exports/json${query}`);
  if (!res.ok) throw new Error(`${dataset}: HTTP ${res.status}`);
  return res.json();
}

// Metres on a local flat projection around Bordeaux; precise enough at city scale.
const KX = 111320 * Math.cos((44.84 * Math.PI) / 180);
const KY = 110540;

// Keep points at least `step` metres apart, always keeping both ends. Routes are matched within
// 15 m, and Bordeaux streets are straight over 8 m, so this keeps matching accurate.
function thin(line, step = 8) {
  const out = [];
  let last = null;
  for (const [lon, lat] of line) {
    const x = lon * KX, y = lat * KY;
    if (!last || Math.hypot(x - last[0], y - last[1]) >= step) { out.push([+lat.toFixed(5), +lon.toFixed(5)]); last = [x, y]; }
  }
  const [lon, lat] = line[line.length - 1];
  const end = [+lat.toFixed(5), +lon.toFixed(5)];
  if (out.length < 2 || out[out.length - 1][0] !== end[0] || out[out.length - 1][1] !== end[1]) out.push(end);
  return out;
}

// "Lianes 1" -> "1", "Tram A" -> "A", "BUS EXPRESS G" -> "G"
const shortName = (name) => name.match(/([A-Z0-9]+)\s*$/i)?.[1] || name;

const [lineRows, routeRows, stopRows] = await Promise.all([
  get('sv_ligne_a'),
  get('sv_chem_l', `?where=${encodeURIComponent('principal="True"')}&select=rs_sv_ligne_a,geo_shape`),
  get('sv_arret_p', '?select=gid,libelle,actif,geo_point_2d'),
]);

const lines = new Map();
for (const l of lineRows) {
  if (!['BUS', 'TRAM'].includes(l.bm_vehicule) || String(l.bm_active) !== '1') continue;
  lines.set(String(l.bm_gid), { id: String(l.bm_gid), name: l.bm_libelle, short: shortName(l.bm_libelle), mode: l.bm_vehicule, geo: [] });
}
for (const r of routeRows) {
  const line = lines.get(String(r.rs_sv_ligne_a));
  const g = r.geo_shape?.geometry;
  if (!line || !g) continue;
  const parts = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
  for (const p of parts) if (p.length > 1) line.geo.push(thin(p));
}
const stops = stopRows
  .filter((s) => s.geo_point_2d)
  .map((s) => [String(s.gid), s.libelle, +s.geo_point_2d.lat.toFixed(5), +s.geo_point_2d.lon.toFixed(5), s.actif === 1 ? 1 : 0]);

const network = {
  takenAt: new Date().toISOString(),
  lines: [...lines.values()].filter((l) => l.geo.length).sort((a, b) => Number(a.id) - Number(b.id)),
  stops,
};
await fs.writeFile(OUT, JSON.stringify(network));
const size = (await fs.stat(OUT)).size;
console.log(`Snapshot: ${network.lines.length} lines, ${stops.length} stops, ${(size / 1e6).toFixed(2)} MB`);
