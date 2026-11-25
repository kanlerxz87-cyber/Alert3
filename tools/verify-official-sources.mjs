#!/usr/bin/env node
/* Network-enabled final integration check. Fetches official MLB StatsAPI
 * responses and compares exact values with the combined site's documented
 * verification report. No values are inferred: a mismatch fails the run.
 * Run from GitHub Actions (or any host with access to statsapi.mlb.com):
 *   node tools/verify-official-sources.mjs
 */
import assert from 'node:assert/strict';

const API = 'https://statsapi.mlb.com/api';
const SCHEDULE_0826_FIELDS = 'totalGames,dates,date,totalGames,games,gamePk,teams,away,home,team,name,score,status,detailedState';
const PBP_FIELDS = 'allPlays,about,atBatIndex,result,description,awayScore,homeScore,reviewDetails,reviewType,isOverturned,inProgress,challengeTeamId';
const COUNTER_FIELDS = 'gameData,review,absChallenges,hasChallenges,away,home,used,remaining,usedSuccessful,usedFailed';

const expectedSlate = [
  [824234, 'Tampa Bay Rays', 3, 'Detroit Tigers', 0],
  [825039, 'Chicago Cubs', 0, 'Arizona Diamondbacks', 2],
  [823180, 'Cincinnati Reds', 10, 'San Francisco Giants', 9],
  [823988, 'Cleveland Guardians', 4, 'Los Angeles Angels', 3],
  [823255, 'Pittsburgh Pirates', 0, 'San Diego Padres', 3],
  [823096, 'Philadelphia Phillies', 6, 'Seattle Mariners', 0],
  [823825, 'Boston Red Sox', 0, 'Miami Marlins', 4],
  [822692, 'Colorado Rockies', 13, 'Washington Nationals', 1],
  [823506, 'Houston Astros', 3, 'New York Yankees', 9],
  [822772, 'Kansas City Royals', 0, 'Toronto Blue Jays', 3],
  [823584, 'Milwaukee Brewers', 8, 'New York Mets', 1],
  [824878, 'Los Angeles Dodgers', 5, 'Atlanta Braves', 6],
  [824555, 'Texas Rangers', 4, 'Chicago White Sox', 10],
  [823015, 'Baltimore Orioles', 8, 'St. Louis Cardinals', 7],
  [824963, 'Minnesota Twins', 4, 'Athletics', 7],
];

let passed = 0;
const failures = [];

async function getJSON(url) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'Alert3 official-source verification' },
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }
  throw new Error(`${url}: ${lastError?.message || 'request failed'}`);
}

async function check(name, url, fn) {
  try {
    const data = await getJSON(url);
    await fn(data);
    passed += 1;
    console.log(`PASS ${name} — ${url}`);
  } catch (error) {
    failures.push(`${name}: ${error.message} — ${url}`);
    console.error(`FAIL ${name}: ${error.message} — ${url}`);
  }
}

const q = (base, params) => `${base}?${new URLSearchParams(params)}`;

await check(
  '2026-08-26 official slate (15 rows)',
  q(`${API}/v1/schedule`, { sportId: '1', date: '2026-08-26', fields: SCHEDULE_0826_FIELDS }),
  (data) => {
    assert.equal(data.totalGames, 15, 'totalGames');
    const games = data.dates[0].games;
    assert.equal(games.length, 15, 'game count');
    for (let i = 0; i < expectedSlate.length; i += 1) {
      const [gamePk, awayName, awayScore, homeName, homeScore] = expectedSlate[i];
      const g = games[i];
      assert.equal(g.gamePk, gamePk, `row ${i + 1} gamePk`);
      assert.equal(g.status.detailedState, 'Final', `row ${i + 1} status`);
      assert.equal(g.teams.away.team.name, awayName, `row ${i + 1} away team`);
      assert.equal(g.teams.home.team.name, homeName, `row ${i + 1} home team`);
      assert.equal(g.teams.away.score, awayScore, `row ${i + 1} away score`);
      assert.equal(g.teams.home.score, homeScore, `row ${i + 1} home score`);
    }
  },
);

await check(
  '2026-11-25 offseason slate',
  q(`${API}/v1/schedule`, { sportId: '1', date: '2026-11-25', fields: 'totalGames,dates,date,totalGames' }),
  (data) => {
    assert.equal(data.totalGames, 0, 'totalGames');
    assert.deepEqual(data.dates, [], 'dates');
  },
);

await check(
  'first upcoming official game date',
  q(`${API}/v1/schedule`, { sportId: '1', startDate: '2026-11-25', endDate: '2027-04-30', fields: 'dates,date,totalGames' }),
  (data) => {
    assert.equal(data.dates[0].date, '2027-02-19', 'first date');
    assert.equal(data.dates[0].totalGames, 17, 'first date game count');
  },
);

await check(
  '2027-02-19 scheduled slate',
  q(`${API}/v1/schedule`, { sportId: '1', date: '2027-02-19', fields: 'totalGames,dates,date,totalGames,games,gamePk,status,abstractGameState,detailedState,statusCode' }),
  (data) => {
    assert.equal(data.totalGames, 17, 'totalGames');
    assert.equal(data.dates[0].games.length, 17, 'game count');
    assert.equal(data.dates[0].games[0].gamePk, 868573, 'first gamePk');
    assert.ok(data.dates[0].games.every((g) => g.status.abstractGameState === 'Preview'), 'all games Preview');
  },
);

await check(
  '2027-03-25 scheduled slate',
  q(`${API}/v1/schedule`, { sportId: '1', date: '2027-03-25', fields: 'totalGames,dates,date,totalGames,games,gamePk,status,abstractGameState,detailedState,statusCode,review,hasChallenges,away,home,used,remaining' }),
  (data) => {
    assert.equal(data.totalGames, 14, 'totalGames');
    assert.equal(data.dates[0].games.length, 14, 'game count');
    assert.ok(data.dates[0].games.every((g) => g.status.abstractGameState === 'Preview'), 'all games Preview');
  },
);

await check(
  'official gameStatus review codes',
  `${API}/v1/gameStatus`,
  (rows) => {
    const byCode = Object.fromEntries(rows.map((r) => [r.statusCode, r]));
    assert.equal(byCode.MF.detailedState, 'Manager challenge: Close play at 1st');
    assert.equal(byCode.MF.reason, 'Close play at 1st');
    assert.equal(byCode.MA.detailedState, 'Manager challenge: Tag play');
    assert.equal(byCode.NF.detailedState, 'Umpire review: Close play at 1st');
    assert.equal(byCode.NH.detailedState, 'Umpire review: Home run');
    assert.equal(byCode.MJ.detailedState, 'Player challenge: Pitch Result');
    assert.equal(byCode.NJ.detailedState, 'Umpire Challenge: Pitch Result');
  },
);

await check(
  'official pending-ruling event types',
  q(`${API}/v1/eventTypes`, { fields: 'code,description' }),
  (rows) => {
    const byCode = Object.fromEntries(rows.map((r) => [r.code, r]));
    assert.equal(byCode.os_ruling_pending_primary.description, 'Official Scorer Ruling Pending');
    assert.equal(byCode.os_ruling_pending_prior.description, 'Official Scorer Ruling Pending');
  },
);

await check(
  '823096 reviewed play',
  q(`${API}/v1/game/823096/playByPlay`, { fields: PBP_FIELDS }),
  (data) => {
    const play = data.allPlays.find((p) => p.about?.atBatIndex === 36);
    assert.ok(play, 'at-bat 36 exists');
    assert.equal(play.reviewDetails.reviewType, 'MF');
    assert.equal(play.reviewDetails.challengeTeamId, 136);
    assert.equal(play.reviewDetails.isOverturned, false);
    assert.equal(play.result.awayScore, 6);
    assert.equal(play.result.homeScore, 0);
    assert.match(play.result.description, /Mariners challenged \(play at 1st\)/);
  },
);

await check(
  '823180 reviewed plays',
  q(`${API}/v1/game/823180/playByPlay`, { fields: PBP_FIELDS }),
  (data) => {
    const p57 = data.allPlays.find((p) => p.about?.atBatIndex === 57);
    const p84 = data.allPlays.find((p) => p.about?.atBatIndex === 84);
    assert.ok(p57 && p84, 'at-bats 57 and 84 exist');
    assert.equal(p57.reviewDetails.reviewType, 'MA');
    assert.equal(p57.reviewDetails.challengeTeamId, 137);
    assert.equal(p57.reviewDetails.isOverturned, false);
    assert.equal(p57.result.awayScore, 3);
    assert.equal(p57.result.homeScore, 6);
    assert.equal(p84.reviewDetails.reviewType, 'NF');
    assert.equal(p84.reviewDetails.isOverturned, false);
    assert.equal(p84.result.awayScore, 10);
    assert.equal(p84.result.homeScore, 9);
  },
);

await check(
  '823096 official counters',
  q(`${API}/v1.1/game/823096/feed/live`, { fields: COUNTER_FIELDS }),
  (data) => {
    assert.deepEqual(data.gameData.review, { hasChallenges: true, away: { used: 0, remaining: 1 }, home: { used: 1, remaining: 0 } });
    assert.deepEqual(data.gameData.absChallenges, { hasChallenges: true, away: { usedSuccessful: 1, usedFailed: 1, remaining: 1 }, home: { usedSuccessful: 2, usedFailed: 2, remaining: 0 } });
  },
);

await check(
  '823180 official counters',
  q(`${API}/v1.1/game/823180/feed/live`, { fields: COUNTER_FIELDS }),
  (data) => {
    assert.deepEqual(data.gameData.review, { hasChallenges: true, away: { used: 0, remaining: 1 }, home: { used: 1, remaining: 0 } });
    assert.deepEqual(data.gameData.absChallenges, { hasChallenges: true, away: { usedSuccessful: 4, usedFailed: 0, remaining: 2 }, home: { usedSuccessful: 2, usedFailed: 1, remaining: 1 } });
  },
);

console.log(`\nofficial-source-check: ${passed}/${passed + failures.length} checks passed`);
if (failures.length) process.exit(1);
