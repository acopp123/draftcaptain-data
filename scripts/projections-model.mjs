// Builds projections.json from our own nflverse model (see scripts/model.mjs).
// Data: nflverse (CC-BY 4.0) weekly player stats + schedules with Vegas lines,
// and the DynastyProcess player-ID map (gsis -> Sleeper id) so the app's player ids match.
// Runs in the 15-minute workflow but only rebuilds every 6 hours or when the week changes.
// On any failure the existing file is left untouched.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parseCsv, project } from './model.mjs';

const OUT = 'projections.json';
const STATS = (s) => `https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_${s}.csv`;
const GAMES = 'https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv';
const IDS = 'https://raw.githubusercontent.com/dynastyprocess/data/master/files/db_playerids.csv';
const REBUILD_MS = 6 * 3600e3;

async function text(url) {
  if (process.env.DATA_DIR) {
    // local testing: DATA_DIR holds stats_<season>.csv, games.csv, ids.csv
    const name = url === GAMES ? 'games.csv' : url === IDS ? 'ids.csv' : `stats_${url.match(/_(\d{4})\.csv$/)[1]}.csv`;
    return readFileSync(`${process.env.DATA_DIR}/${name}`, 'utf8');
  }
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.text();
}

/** Current week: the earliest regular-season week of the latest season that still has an unplayed game */
function currentWeek(games) {
  const reg = games.filter((g) => g.game_type === 'REG');
  const season = Math.max(...reg.map((g) => Number(g.season)));
  const open = reg.filter((g) => Number(g.season) === season && (g.home_score === '' || g.home_score === 'NA')).map((g) => Number(g.week));
  return { season, week: open.length ? Math.min(...open) : 0 };
}

try {
  const games = parseCsv(await text(GAMES));
  const { season, week } = currentWeek(games);
  if (!week) {
    console.log('Model: regular season is over; skipping.');
    process.exit(0);
  }
  const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};
  const fresh = prev.source === 'nflverse-model' && prev.season === season && prev.week === week && Date.now() - Date.parse(prev.fetchedAt) < REBUILD_MS;
  if (fresh && !process.env.FORCE_MODEL) {
    console.log(`Model: week ${week} built ${prev.fetchedAt}; skipping.`);
    process.exit(0);
  }
  const [cur, last, idsCsv] = await Promise.all([
    text(STATS(season)).catch(() => ''), // early September: this season's file may not exist yet
    text(STATS(season - 1)),
    text(IDS),
  ]);
  const stats = [...parseCsv(last), ...(cur ? parseCsv(cur) : [])];
  const toSleeper = new Map();
  for (const r of parseCsv(idsCsv)) if (r.gsis_id && r.sleeper_id && r.gsis_id !== 'NA' && r.sleeper_id !== 'NA') toSleeper.set(r.gsis_id, r.sleeper_id);

  const { proj, detail, dvp } = project(stats, games, season, week);
  const out = {}, matchups = {};
  for (const [gsis, pts] of Object.entries(proj)) {
    const sid = toSleeper.get(gsis);
    if (!sid) continue;
    out[sid] = pts;
    matchups[sid] = detail[gsis].opp;
  }
  if (Object.keys(out).length < 100) throw new Error(`only ${Object.keys(out).length} players projected, so not overwriting`);
  writeFileSync(OUT, JSON.stringify({ season, week, fetchedAt: new Date().toISOString(), source: 'nflverse-model', credit: 'Data: nflverse (CC-BY 4.0)', proj: out, matchups, dvp }));
  const top = Object.entries(out).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id, p]) => `${id}=${p}`).join(', ');
  console.log(`projections.json (model): ${season} week ${week}, ${Object.keys(out).length} players. Top: ${top}`);
} catch (e) {
  console.warn('Model projections skipped:', e.message);
}
