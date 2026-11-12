// Builds injuries.json for the Who Knows Ball / Draft Captain Reddit app.
// - ESPN's public injuries feed (small: only listed players) every run
// - Sleeper's full player list at most once per ~20h, to map ESPN ids -> Sleeper ids (the app's player ids)
// - "since" = when this relay first saw the current status, so the app can void votes made after a player was ruled out
// Writes the file only when something changed, so the workflow only commits real changes.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries';
const SLEEPER = 'https://api.sleeper.app/v1/players/nfl';
const MAP_FILE = 'sleeper-map.json';
const OUT_FILE = 'injuries.json';
const MAP_MAX_AGE_H = 20;

const readJson = (f, fallback) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : fallback);
const now = new Date().toISOString();

// Normalize status names from both sources to the app's set
function norm(s) {
  if (!s) return '';
  const x = String(s).toLowerCase();
  if (x.startsWith('quest')) return 'Questionable';
  if (x.startsWith('doubt')) return 'Doubtful';
  if (x === 'ir' || x.includes('injured reserve')) return 'IR';
  if (x.includes('pup') || x.includes('physically unable')) return 'PUP';
  if (x.startsWith('sus')) return 'SUS';
  if (x === 'out' || x === 'inactive' || x.includes('non-football')) return 'Out';
  return ''; // day-to-day, probable, active, etc. = healthy for the app
}

// 1) Sleeper id map (cached)
let map = readJson(MAP_FILE, { fetchedAt: null, espnToSleeper: {}, sleeperStatus: {} });
const ageH = map.fetchedAt ? (Date.now() - Date.parse(map.fetchedAt)) / 3.6e6 : Infinity;
if (ageH > MAP_MAX_AGE_H) {
  try {
    const r = await fetch(SLEEPER);
    if (!r.ok) throw new Error(`Sleeper ${r.status}`);
    const all = await r.json();
    const espnToSleeper = {};
    const sleeperStatus = {};
    for (const [id, p] of Object.entries(all)) {
      if (p.espn_id) espnToSleeper[String(p.espn_id)] = id;
      const st = norm(p.injury_status);
      if (st && p.team) sleeperStatus[id] = st;
    }
    map = { fetchedAt: now, espnToSleeper, sleeperStatus };
    writeFileSync(MAP_FILE, JSON.stringify(map));
    console.log(`Sleeper map refreshed: ${Object.keys(espnToSleeper).length} ESPN ids`);
  } catch (e) {
    console.warn('Sleeper refresh failed, using cached map:', e.message);
  }
}

// 2) Current statuses: ESPN first, Sleeper as fallback
let current = {};
let source = 'espn';
try {
  const r = await fetch(ESPN);
  if (!r.ok) throw new Error(`ESPN ${r.status}`);
  const data = await r.json();
  for (const team of data.injuries ?? []) {
    for (const inj of team.injuries ?? []) {
      const a = inj.athlete ?? {};
      const espnId = String(a.id ?? (a.links?.[0]?.href?.match(/\/id\/(\d+)/)?.[1] ?? ''));
      const sid = map.espnToSleeper[espnId];
      const st = norm(inj.status ?? inj.type?.description);
      if (sid && st) current[sid] = st;
    }
  }
  if (!Object.keys(current).length) throw new Error('ESPN returned no mappable players');
} catch (e) {
  console.warn('ESPN failed, falling back to Sleeper statuses:', e.message);
  current = { ...map.sleeperStatus };
  source = 'sleeper';
  if (!map.fetchedAt) {
    console.warn('No data source available; leaving injuries.json unchanged.');
    process.exit(0);
  }
}

// 3) Keep "since" when the status hasn't changed
const prev = readJson(OUT_FILE, { updatedAt: null, players: {} });
const players = {};
for (const [id, status] of Object.entries(current)) {
  const was = prev.players?.[id];
  players[id] = { status, since: was && was.status === status ? was.since : now };
}

const changed = JSON.stringify(players) !== JSON.stringify(prev.players ?? {});
if (changed) {
  writeFileSync(OUT_FILE, JSON.stringify({ updatedAt: now, source, players }, null, 0));
  const outs = Object.values(players).filter((p) => ['Out', 'IR', 'PUP', 'SUS'].includes(p.status)).length;
  console.log(`injuries.json updated (${source}): ${Object.keys(players).length} listed, ${outs} ruled out`);
} else {
  console.log('No changes.');
}
