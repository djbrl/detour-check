// Builds the frozen demo day's desk once, at build time, into src/demo-desk.json, so the app answers
// from it without redoing the geometry on every cold start. Run by `npm run build`.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { useNetwork, buildDesk, serializeDesk } from '../src/model.js';

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = async (f) => JSON.parse(await fs.readFile(path.join(src, f), 'utf8'));
const [network, day] = await Promise.all([read('network.json'), read('demo-day.json')]);
useNetwork(network);
const desk = buildDesk(day, new Date(day.takenAt));
const out = path.join(src, 'demo-desk.json');
await fs.writeFile(out, JSON.stringify(serializeDesk(desk, day.takenAt)));
console.log(`Demo desk: ${desk.items.length} disruptions, ${((await fs.stat(out)).size / 1e6).toFixed(2)} MB`);
