// nflverse projection model: half-PPR projections for QB/RB/WR/TE for one NFL week.
//
// How it works (all inputs are free nflverse data, CC-BY 4.0):
//  1. Usage: recency-weighted pass attempts, carries and targets per game (recent games count most;
//     last season's games count a little early in the year).
//  2. Efficiency: yards and TDs per opportunity, pulled toward the position average so a
//     couple of big plays don't swing the projection.
//  3. Game script: the team's Vegas implied points (from the spread and total in the schedule)
//     versus how many points the team usually scores. More expected points = more TDs and yards.
//  4. Matchup: half-PPR points the opponent allows to the position versus league average,
//     shrunk toward average because defense samples are small.
// Pure functions here; scripts/projections-model.mjs downloads the data and writes the file.

export const OFFENSE = new Set(['QB', 'RB', 'WR', 'TE']);
const DECAY = 0.82; // weight of each older game (0.82^n)
const LAST_SEASON_WEIGHT = 0.35; // last season's games count about a third as much

/** Minimal CSV parser that handles quoted fields with commas */
export function parseCsv(text) {
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') (cur += '"'), i++;
        else q = false;
      } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') row.push(cur), (cur = '');
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cur), rows.push(row), (row = []), (cur = '');
    } else cur += ch;
  }
  if (cur || row.length) row.push(cur), rows.push(row);
  const head = rows.shift();
  return rows.filter((r) => r.length === head.length).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

const n = (v) => (v === '' || v === undefined || v === 'NA' ? 0 : Number(v) || 0);

/** Half-PPR fantasy points from a stat line */
export function halfPpr(s) {
  return 0.04 * s.passYds + 4 * s.passTd - 2 * s.int + 0.1 * (s.rushYds + s.recYds) + 6 * (s.rushTd + s.recTd) + 0.5 * s.rec - 2 * s.fumLost + 2 * s.twoPt;
}

export function statLine(r) {
  return {
    att: n(r.attempts), cmp: n(r.completions), passYds: n(r.passing_yards), passTd: n(r.passing_tds), int: n(r.passing_interceptions),
    car: n(r.carries), rushYds: n(r.rushing_yards), rushTd: n(r.rushing_tds),
    tgt: n(r.targets), rec: n(r.receptions), recYds: n(r.receiving_yards), recTd: n(r.receiving_tds),
    fumLost: n(r.fumbles_lost_total || r.rushing_fumbles_lost) , twoPt: n(r.passing_2pt_conversions) + n(r.rushing_2pt_conversions) + n(r.receiving_2pt_conversions),
  };
}

/** Index games: per team, ordered list of {season, week, pts, opp} for played regular-season games */
function teamGames(games, season, week) {
  const byTeam = new Map();
  for (const g of games) {
    if (g.game_type !== 'REG') continue;
    const s = n(g.season), w = n(g.week);
    if (!(s === season - 1 || (s === season && w < week))) continue;
    if (g.home_score === '' || g.home_score === 'NA') continue;
    for (const [t, o, pts] of [[g.home_team, g.away_team, n(g.home_score)], [g.away_team, g.home_team, n(g.away_score)]]) {
      if (!byTeam.has(t)) byTeam.set(t, []);
      byTeam.get(t).push({ season: s, week: w, pts, opp: o });
    }
  }
  for (const l of byTeam.values()) l.sort((a, b) => b.season - a.season || b.week - a.week); // newest first
  return byTeam;
}

/** The target week's matchups with Vegas implied points */
export function weekMatchups(games, season, week) {
  const out = new Map();
  for (const g of games) {
    if (g.game_type !== 'REG' || n(g.season) !== season || n(g.week) !== week) continue;
    const total = n(g.total_line), spread = n(g.spread_line); // spread_line > 0: home favored by that much
    const home = total ? total / 2 + spread / 2 : 0, away = total ? total / 2 - spread / 2 : 0;
    out.set(g.home_team, { opp: g.away_team, implied: home, home: true, kickoff: `${g.gameday}T${g.gametime}` });
    out.set(g.away_team, { opp: g.home_team, implied: away, home: false, kickoff: `${g.gameday}T${g.gametime}` });
  }
  return out;
}

const clip = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

/**
 * Project one week.
 * @param stats rows from stats_player_week_{season-1}.csv and {season}.csv
 * @param games rows from nflverse schedules games.csv
 * @returns { proj: { gsisId: halfPpr }, detail: { gsisId: {...} }, dvp: { team: { pos: factor } } }
 */
export function project(stats, games, season, week) {
  const matchups = weekMatchups(games, season, week);
  const tg = teamGames(games, season, week);
  // Only regular-season games strictly before the target week
  const rows = stats.filter((r) => r.season_type === 'REG' && OFFENSE.has(r.position) && (n(r.season) === season - 1 || (n(r.season) === season && n(r.week) < week)));

  // Recency rank of each team-game (0 = team's most recent game)
  const gameRank = new Map();
  for (const [t, l] of tg) l.forEach((g, i) => gameRank.set(`${t}|${g.season}|${g.week}`, i));
  const weightOf = (r) => {
    const s = n(r.season), w = n(r.week);
    const thisSeason = s === season;
    // rank by the player's own team that week
    const rank = gameRank.get(`${r.team}|${s}|${w}`) ?? 17;
    return Math.pow(DECAY, rank) * (thisSeason ? 1 : LAST_SEASON_WEIGHT);
  };

  // League position averages (this season if enough, else both)
  const avg = {};
  for (const r of rows) {
    const s = statLine(r);
    const a = (avg[r.position] ??= { att: 0, cmp: 0, passYds: 0, passTd: 0, int: 0, car: 0, rushYds: 0, rushTd: 0, tgt: 0, rec: 0, recYds: 0, recTd: 0 });
    for (const k of Object.keys(a)) a[k] += s[k];
  }
  const rate = (pos, num, den, fallback) => (avg[pos] && avg[pos][den] > 0 ? avg[pos][num] / avg[pos][den] : fallback);

  // Defense vs position: half-PPR allowed per game, this season only, vs league average
  const allowed = {}; // opp -> pos -> {pts, games:Set}
  for (const r of rows) {
    if (n(r.season) !== season) continue;
    const opp = r.opponent_team;
    const a = ((allowed[opp] ??= {})[r.position] ??= { pts: 0, games: new Set() });
    a.pts += halfPpr(statLine(r));
    a.games.add(r.week);
  }
  const lg = {};
  for (const t of Object.keys(allowed)) for (const [pos, a] of Object.entries(allowed[t])) {
    const l = (lg[pos] ??= { pts: 0, g: 0 });
    l.pts += a.pts;
    l.g += a.games.size;
  }
  const dvp = {};
  for (const t of Object.keys(allowed)) {
    dvp[t] = {};
    for (const [pos, a] of Object.entries(allowed[t])) {
      const g = a.games.size;
      const ratio = a.pts / g / (lg[pos].pts / lg[pos].g);
      const shrink = g / (g + 6); // 6 games of "average" prior
      dvp[t][pos] = Math.round(clip(1 + (ratio - 1) * shrink, 0.8, 1.2) * 1000) / 1000;
    }
  }

  // Team scoring baseline (recency weighted)
  const teamPts = {};
  for (const [t, l] of tg) {
    let sw = 0, sp = 0;
    l.forEach((g, i) => {
      const w = Math.pow(DECAY, i) * (g.season === season ? 1 : LAST_SEASON_WEIGHT);
      sw += w;
      sp += w * g.pts;
    });
    teamPts[t] = sw ? sp / sw : 22;
  }

  // Player aggregates
  const players = new Map();
  for (const r of rows) {
    const id = r.player_id;
    let p = players.get(id);
    if (!p) players.set(id, (p = { id, name: r.player_display_name, pos: r.position, team: r.team, last: [-1, -1], w: 0, s: {}, games: 0 }));
    const s = statLine(r);
    const w = weightOf(r);
    p.w += w;
    p.games++;
    for (const [k, v] of Object.entries(s)) p.s[k] = (p.s[k] ?? 0) + w * v;
    const key = [n(r.season), n(r.week)];
    if (key[0] > p.last[0] || (key[0] === p.last[0] && key[1] > p.last[1])) (p.last = key), (p.team = r.team);
  }

  const proj = {}, detail = {};
  for (const p of players.values()) {
    const m = matchups.get(p.team);
    if (!m) continue; // bye week or team not found
    // Must have played in one of the team's last 3 games (otherwise likely injured / benched / cut)
    const recent = (tg.get(p.team) ?? []).slice(0, 3).some((g) => g.season === p.last[0] && g.week === p.last[1]);
    if (!recent || p.w <= 0) continue;
    const pg = (k) => p.s[k] / p.w; // weighted per-game
    const pos = p.pos;
    // Shrunk efficiencies: (player total + prior opportunities * league rate) / (player opps + prior)
    const shr = (num, den, prior, lgRate) => (p.s[num] + prior * lgRate) / (p.s[den] + prior);
    const ypa = shr('passYds', 'att', 80, rate('QB', 'passYds', 'att', 6.8));
    const tdPa = shr('passTd', 'att', 150, rate('QB', 'passTd', 'att', 0.045));
    const intPa = shr('int', 'att', 150, rate('QB', 'int', 'att', 0.024));
    const ypc = shr('rushYds', 'car', 40, rate(pos, 'rushYds', 'car', 4.2));
    const tdPc = shr('rushTd', 'car', 60, rate(pos, 'rushTd', 'car', 0.03));
    const cRate = shr('rec', 'tgt', 30, rate(pos, 'rec', 'tgt', 0.65));
    const ypt = shr('recYds', 'tgt', 30, rate(pos, 'recYds', 'tgt', 7.5));
    const tdPt = shr('recTd', 'tgt', 60, rate(pos, 'recTd', 'tgt', 0.045));

    // Game script: Vegas implied points vs team's usual output
    const f = m.implied ? clip(m.implied / teamPts[p.team], 0.7, 1.4) : 1;
    const vol = 1 + 0.25 * (f - 1), yds = 1 + 0.5 * (f - 1), tds = f;
    const d = dvp[m.opp]?.[pos] ?? 1;

    const att = pg('att') * vol, car = pg('car') * vol, tgt = pg('tgt') * vol;
    const line = {
      passYds: att * ypa * yds, passTd: att * tdPa * tds, int: att * intPa,
      rushYds: car * ypc * yds, rushTd: car * tdPc * tds,
      rec: tgt * cRate, recYds: tgt * ypt * yds, recTd: tgt * tdPt * tds,
      fumLost: pg('fumLost'), twoPt: 0,
    };
    const pts = Math.max(0, halfPpr(line) * d);
    if (pts < 0.5) continue;
    proj[p.id] = Math.round(pts * 10) / 10;
    detail[p.id] = { n: p.name, p: pos, t: p.team, opp: `${m.home ? 'vs' : '@'} ${m.opp}`, implied: Math.round(m.implied * 10) / 10, dvp: d, att: +att.toFixed(1), car: +car.toFixed(1), tgt: +tgt.toFixed(1) };
  }
  return { proj, detail, dvp };
}
