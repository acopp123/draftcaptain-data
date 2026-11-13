// Builds sleeper-projections.json (kept for comparison; the app now uses our own model in projections.json): Sleeper's half-PPR projections for the current NFL week.
// Uses Sleeper's official /v1/state endpoint for the week, then the (unofficial) projections endpoint.
// On any failure the existing file is left untouched.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const OUT_FILE = 'sleeper-projections.json';
const POS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF']; // D/ST player ids are team codes (e.g. "KC")

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

try {
  const state = await getJson('https://api.sleeper.app/v1/state/nfl');
  const season = Number(state.season);
  // Between Tuesday and kickoff Sleeper's "week" is the upcoming week; during the offseason/preseason there's nothing to project
  const week = Number(state.week);
  if (state.season_type !== 'regular' || !week) {
    console.log(`Not regular season (${state.season_type} wk ${state.week}); skipping.`);
    process.exit(0);
  }
  const q = POS.map((p) => `position[]=${p}`).join('&');
  const data = await getJson(`https://api.sleeper.app/projections/nfl/${season}/${week}?season_type=regular&${q}`);
  // Response is usually an array of { player_id, stats }, older shapes are { [player_id]: stats }
  const rows = Array.isArray(data) ? data : Object.entries(data).map(([player_id, stats]) => ({ player_id, stats }));
  const proj = {};
  for (const r of rows) {
    const s = r.stats ?? {};
    const half = s.pts_half_ppr ?? (s.pts_std !== undefined && s.rec !== undefined ? s.pts_std + 0.5 * s.rec : undefined);
    if (r.player_id && typeof half === 'number' && half > 0) proj[r.player_id] = Math.round(half * 10) / 10;
  }
  if (Object.keys(proj).length < 50) throw new Error(`only ${Object.keys(proj).length} projections, so not overwriting`);
  const prev = existsSync(OUT_FILE) ? JSON.parse(readFileSync(OUT_FILE, 'utf8')) : {};
  if (prev.season === season && prev.week === week && JSON.stringify(prev.proj) === JSON.stringify(proj)) {
    console.log('No changes.');
  } else {
    writeFileSync(OUT_FILE, JSON.stringify({ season, week, fetchedAt: new Date().toISOString(), proj }));
    console.log(`sleeper-projections.json: ${season} week ${week}, ${Object.keys(proj).length} players`);
  }
} catch (e) {
  console.warn('Projections update skipped:', e.message);
}
