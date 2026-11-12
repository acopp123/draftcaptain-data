// Builds trending.json once a week: Sleeper's most-added players (official, documented endpoint).
// Runs inside the injuries workflow (every 15 min) but only fetches on Monday evening Pacific
// (7pm Mon - 6am Tue), once per week, so the app's Monday-night FAAB post has fresh data.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const OUT = 'trending.json';
const URL = 'https://api.sleeper.app/v1/players/nfl/trending/add?lookback_hours=48&limit=50';
const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { fetchedAt: null, adds: [] };

const pt = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
const day = pt.getDay(); // 0 Sun ... 1 Mon, 2 Tue
const hour = pt.getHours();
const inWindow = (day === 1 && hour >= 19) || (day === 2 && hour < 6);
const fetchedRecently = prev.fetchedAt && Date.now() - Date.parse(prev.fetchedAt) < 3 * 24 * 3600e3;
if (!process.env.FORCE_TRENDING && (!inWindow || fetchedRecently)) {
  console.log('Trending: not Monday evening (or already fetched this week); skipping.');
  process.exit(0);
}
try {
  const r = await fetch(URL);
  if (!r.ok) throw new Error(`Sleeper ${r.status}`);
  const rows = await r.json(); // [{ player_id, count }]
  const adds = rows.filter((x) => x.player_id && x.count > 0).map((x) => ({ id: String(x.player_id), count: x.count }));
  if (!adds.length) throw new Error('empty response');
  writeFileSync(OUT, JSON.stringify({ fetchedAt: new Date().toISOString(), adds }));
  console.log(`trending.json: ${adds.length} players, top: ${adds[0].id} (${adds[0].count} adds)`);
} catch (e) {
  console.warn('Trending update skipped:', e.message);
}
