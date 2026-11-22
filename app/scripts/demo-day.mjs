// Freezes today's three Bordeaux feeds into src/demo-day.json. The app shows this frozen day by
// default, so a judge installing it weeks later sees the same disruptions and checks as the video.
// Run `npm run demo-day` to take a new one.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'demo-day.json');
const API = 'https://opendata.bordeaux-metropole.fr/api/explore/v2.1/catalog/datasets';
const KEEP = {
  sv_devia_l: ['gid', 'libelle', 'ident', 'actif', 'type', 'debut', 'fin', 'jour_appli', 'sens', 'rg_sv_arret_p_nd', 'rg_sv_arret_p_na', 'geo_shape'],
  ci_chantier: ['gid', 'ident', 'localisation', 'alias_nature_n1', 'alias_nature_n2', 'date_debut', 'date_fin', 'geo_shape'],
  sv_messa_a: ['gid', 'rs_sv_ligne_a', 'sens', 'titre', 'message', 'severite'],
};

const day = { takenAt: new Date().toISOString() };
for (const [name, fields] of Object.entries(KEEP)) {
  const res = await fetch(`${API}/${name}/exports/json`);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  day[name] = (await res.json()).map((row) => Object.fromEntries(fields.map((f) => [f, row[f] ?? null])));
}
await fs.writeFile(OUT, JSON.stringify(day));
console.log(`Demo day ${day.takenAt}: ${Object.keys(KEEP).map((n) => `${day[n].length} ${n}`).join(', ')}, ${((await fs.stat(OUT)).size / 1e3).toFixed(0)} kB`);
