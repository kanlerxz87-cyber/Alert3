#!/usr/bin/env node
/* ============================================================================
 * tools/smoke-test.mjs — deterministic, network-free checks for the rebuilt app
 *
 * The original project's test suite (17 tools/*.mjs scripts) was not part of
 * the upload, so this harness replaces it: it boots each real page in jsdom
 * with the real scripts, stubs only `fetch` (with payloads whose shapes were
 * verified against the live StatsAPI on 2026-11-20 — see
 * docs/verification-report.md), and asserts on the rendered DOM.
 *
 *   node tools/smoke-test.mjs
 * ==========================================================================*/
import jsdomPkg from 'jsdom';
const { JSDOM, VirtualConsole } = jsdomPkg;
import path from 'node:path';
import fs from 'node:fs/promises';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let pass = 0;
let fail = 0;
const failures = [];

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { pass += 1; console.log(`  ✓ ${name}`); })
    .catch((err) => {
      fail += 1;
      failures.push(`${name}: ${err && err.message}`);
      console.log(`  ✗ ${name} — ${err && err.message}`);
    });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

/* ----------------------------------------------------------------- fixtures */

/* Shape verified against GET /api/v1/schedule?sportId=1&date=2026-09-15
 * &hydrate=probablePitcher,linescore,decisions,review (2026-11-20). */
const SCHEDULE = {
  totalGames: 3,
  dates: [{
    date: '2026-09-15',
    totalGames: 3,
    games: [
      {
        gamePk: 824466,
        gameDate: '2026-09-15T22:40:00Z',
        officialDate: '2026-09-15',
        status: { abstractGameState: 'Final', codedGameState: 'F', detailedState: 'Final', statusCode: 'F' },
        teams: {
          away: {
            team: { id: 119, name: 'Los Angeles Dodgers' },
            score: 4, isWinner: true, leagueRecord: { wins: 90, losses: 70 },
            probablePitcher: { id: 808967, fullName: 'Yoshinobu Yamamoto' },
          },
          home: {
            team: { id: 113, name: 'Cincinnati Reds' },
            score: 0, isWinner: false, leagueRecord: { wins: 70, losses: 90 },
            probablePitcher: { id: 666157, fullName: 'Nick Lodolo' },
          },
        },
        venue: { id: 2602, name: 'Great American Ball Park' },
        doubleHeader: 'N', gamesInSeries: 4, seriesGameNumber: 2,
        linescore: { currentInning: 9, inningState: 'End', isFinal: true, teams: { away: { runs: 4, hits: 9, errors: 0 }, home: { runs: 0, hits: 4, errors: 1 } } },
        decisions: { winner: { fullName: 'Yoshinobu Yamamoto' }, loser: { fullName: 'Nick Lodolo' } },
        review: { hasChallenges: false, away: { used: 0, remaining: 1 }, home: { used: 0, remaining: 1 } },
      },
      {
        gamePk: 822925,
        gameDate: '2026-09-15T22:40:00Z',
        officialDate: '2026-09-15',
        status: { abstractGameState: 'Final', codedGameState: 'F', detailedState: 'Final', statusCode: 'F' },
        teams: {
          away: { team: { id: 133, name: 'Athletics' }, score: 1, isWinner: false },
          home: { team: { id: 139, name: 'Tampa Bay Rays' }, score: 2, isWinner: true },
        },
        venue: { id: 12, name: 'Tropicana Field' },
        doubleHeader: 'N', gamesInSeries: 3, seriesGameNumber: 1,
        review: { hasChallenges: false, away: { used: 0, remaining: 1 }, home: { used: 0, remaining: 1 } },
      },
      {
        gamePk: 823109,
        gameDate: '2026-09-15T23:10:00Z',
        officialDate: '2026-09-15',
        status: {
          abstractGameState: 'Live', codedGameState: 'M', detailedState: 'Manager challenge: Tag play',
          statusCode: 'MA', reason: 'Tag play',
        },
        teams: {
          away: { team: { id: 136, name: 'Seattle Mariners' }, score: 2 },
          home: { team: { id: 142, name: 'Minnesota Twins' }, score: 3 },
        },
        venue: { id: 3312, name: 'Target Field' },
        doubleHeader: 'N', gamesInSeries: 3, seriesGameNumber: 2,
        linescore: { currentInning: 6, inningState: 'Top', balls: 1, strikes: 2, outs: 1 },
        review: { hasChallenges: true, away: { used: 1, remaining: 0 }, home: { used: 1, remaining: 1 } },
      },
    ],
  }],
};

/* Official game-status registry rows (subset of GET /api/v1/gameStatus). */
const GAME_STATUS = [
  { abstractGameState: 'Live', codedGameState: 'M', detailedState: 'Manager challenge: Tag play', statusCode: 'MA', reason: 'Tag play', abstractGameCode: 'L' },
  { abstractGameState: 'Live', codedGameState: 'M', detailedState: 'Manager challenge: Catch/drop in outfield', statusCode: 'MD', reason: 'Catch/drop in outfield', abstractGameCode: 'L' },
  { abstractGameState: 'Live', codedGameState: 'M', detailedState: 'Player challenge: Pitch Result', statusCode: 'MJ', reason: 'Pitch Result', abstractGameCode: 'L' },
  { abstractGameState: 'Live', codedGameState: 'N', detailedState: 'Umpire review: Tag play', statusCode: 'NA', reason: 'Tag play', abstractGameCode: 'L' },
  { abstractGameState: 'Live', codedGameState: 'N', detailedState: 'Umpire review: Home run', statusCode: 'NH', reason: 'Home run', abstractGameCode: 'L' },
  { abstractGameState: 'Live', codedGameState: 'I', detailedState: 'Instant Replay', statusCode: 'IH', reason: 'Review', abstractGameCode: 'L' },
];

/* reviewDetails shape verified against
 * GET /api/v1/game/823109/playByPlay (2026-11-20): {isOverturned, inProgress,
 * reviewType, challengeTeamId}. */
function play(atBatIndex, extra = {}) {
  return {
    about: {
      atBatIndex,
      inning: 6,
      halfInning: 'top',
      isTopInning: true,
      isComplete: true,
      hasReview: false,
      isScoringPlay: false,
    },
    result: { eventType: 'single', description: 'Batter singles.', rbi: 0, awayScore: 2, homeScore: 3, isOut: false },
    count: { balls: 1, strikes: 2, outs: 1 },
    matchup: {
      batter: { id: 660271, fullName: 'Test Batter' },
      pitcher: { id: 592789, fullName: 'Test Pitcher' },
      batSide: { code: 'L' },
      pitchHand: { code: 'R' },
    },
    runners: [],
    playEvents: [],
    ...extra,
  };
}

const PBP_823109 = {
  allPlays: [
    play(25),
    /* ABS pitch challenge: pitch-level reviewDetails, overturned. */
    play(26, {
      about: { atBatIndex: 26, inning: 6, halfInning: 'top', isTopInning: true, isComplete: true, hasReview: true, isScoringPlay: false },
      playEvents: [
        { index: 0, isPitch: true, count: { balls: 1, strikes: 0, outs: 1 }, details: { call: { description: 'Ball' }, description: 'Ball', type: { description: 'Four-Seam Fastball' } } },
        { index: 1, isPitch: true, count: { balls: 1, strikes: 1, outs: 1 }, details: { call: { description: 'Called Strike' }, description: 'Called Strike', type: { description: 'Slider' } } },
        { index: 2, isPitch: true, count: { balls: 1, strikes: 2, outs: 1 }, details: { call: { description: 'Called Strike' }, description: 'Called Strike' }, reviewDetails: { isOverturned: true, inProgress: false, reviewType: 'MJ', challengeTeamId: 136 } },
      ],
    }),
    /* Boundary review that stands, no runs credited. */
    play(48, {
      about: { atBatIndex: 48, inning: 6, halfInning: 'top', isTopInning: true, isComplete: true, hasReview: true, isScoringPlay: false },
      result: { eventType: 'home_run', description: 'Trap play in outfield, call stands.', rbi: 1, awayScore: 3, homeScore: 3, isOut: false },
      reviewDetails: { isOverturned: false, inProgress: false, reviewType: 'MD', challengeTeamId: 142 },
      runners: [
        { details: { event: 'Home Run', eventType: 'home_run', isScoringEvent: true, rbi: true, playIndex: 3, runner: { fullName: 'Test Batter' } }, movement: { start: null, end: 'score', isOut: false } },
      ],
    }),
    /* Manager challenge, overturned, with a run credited to the reviewed event. */
    play(53, {
      about: { atBatIndex: 53, inning: 7, halfInning: 'bottom', isTopInning: false, isComplete: true, hasReview: true, isScoringPlay: true },
      result: { eventType: 'field_out', description: 'Runner ruled safe at home after review — overturned.', rbi: 1, awayScore: 3, homeScore: 4, isOut: false },
      reviewDetails: { isOverturned: true, inProgress: false, reviewType: 'MA', challengeTeamId: 136 },
      count: { balls: 0, strikes: 1, outs: 2 },
      runners: [
        { details: { event: 'Single', eventType: 'single', isScoringEvent: true, rbi: true, playIndex: 1, runner: { fullName: 'Runner One' } }, movement: { start: '3B', end: 'score', isOut: false } },
        { details: { event: 'Stolen Base 2B', eventType: 'stolen_base_2b', isScoringEvent: false, rbi: false, playIndex: 1, runner: { fullName: 'Runner Two' } }, movement: { start: '1B', end: '2B', isOut: false } },
      ],
      playEvents: [
        { index: 0, isPitch: true, count: { balls: 0, strikes: 0, outs: 2 }, details: { call: { description: 'In play, run(s)' }, description: 'In play, run(s)' } },
        { index: 1, isPitch: true, count: { balls: 0, strikes: 1, outs: 2 }, details: { call: { description: 'In play, out(s)' }, description: 'In play, out(s)' } },
      ],
    }),
    /* Umpire review (crew chief), stands, under review at the time of the scan. */
    play(70, {
      about: { atBatIndex: 70, inning: 8, halfInning: 'top', isTopInning: true, isComplete: false, hasReview: true, isScoringPlay: false },
      reviewDetails: { isOverturned: false, inProgress: true, reviewType: 'NA' },
      result: { eventType: 'field_out', description: 'Tag play under review.', awayScore: 3, homeScore: 4 },
    }),
    /* Official-scorer pending ruling (eventTypes registry code). */
    play(71, {
      result: { eventType: 'os_ruling_pending_primary', description: 'Official Scorer Ruling Pending', awayScore: 3, homeScore: 4 },
    }),
  ],
};

const FEED_823109 = {
  /* metaData.timeStamp / wait / logicWait are the fields the state lane reads
   * (GET /api/v1.1/game/{gamePk}/feed/live metaData). Shape per the StatsAPI's
   * own diffPatch documentation: timeStamp is MMDDYYYY_HHMMSS in UTC, wait and
   * logicWait are seconds. */
  metaData: {
    wait: 10,
    logicWait: 0,
    timeStamp: '09152026_231245',
  },
  gameData: {
    game: { pk: 823109, season: 2026, seriesGameNumber: 2, gamesInSeries: 3 },
    status: { abstractGameState: 'Live', codedGameState: 'M', detailedState: 'Manager challenge: Tag play', statusCode: 'MA', reason: 'Tag play' },
    teams: {
      away: { team: { id: 136, name: 'Seattle Mariners', abbreviation: 'SEA' }, record: { wins: 80, losses: 76 } },
      home: { team: { id: 142, name: 'Minnesota Twins', abbreviation: 'MIN' }, record: { wins: 74, losses: 82 } },
    },
    players: {
      ID660271: { id: 660271, fullName: 'Test Batter', primaryPosition: { abbreviation: 'CF' }, stats: { batting: { avg: '.280', atBats: 500, hits: 140 } } },
      ID592789: { id: 592789, fullName: 'Test Pitcher', primaryPosition: { abbreviation: 'P' }, stats: { pitching: { era: '3.45', inningsPitched: '150.1', strikeOuts: 160, baseOnBalls: 40 } } },
    },
    venue: { name: 'Target Field' },
    weather: { condition: 'Clear', temp: '68' },
    datetime: { dateTime: '2026-09-15T23:10:00Z', officialDate: '2026-09-15' },
    review: { hasChallenges: true, away: { used: 1, remaining: 0 }, home: { used: 1, remaining: 1 } },
    absChallenges: { hasChallenges: true, away: { usedSuccessful: 0, usedFailed: 1, remaining: 2 }, home: { usedSuccessful: 1, usedFailed: 0, remaining: 2 } },
  },
  liveData: {
    plays: {
      allPlays: PBP_823109.allPlays,
      currentPlay: {
        about: { atBatIndex: 72, inning: 8, halfInning: 'top', isTopInning: true, isComplete: false },
        result: { eventType: 'at_bat_start', description: '' },
        count: { balls: 2, strikes: 1, outs: 1 },
        matchup: {
          batter: { id: 660271, fullName: 'Test Batter' },
          pitcher: { id: 592789, fullName: 'Test Pitcher' },
          batSide: { code: 'L' }, pitchHand: { code: 'R' },
        },
        runners: [], playEvents: [],
      },
    },
    linescore: {
      currentInning: 8, inningState: 'Top', isTopInning: true, balls: 2, strikes: 1, outs: 1,
      teams: { away: { runs: 3, hits: 8, errors: 0 }, home: { runs: 4, hits: 9, errors: 1 } },
      offense: {
        batter: { id: 660271, fullName: 'Test Batter' },
        onDeck: { id: 665742, fullName: 'On Deck Guy' },
        inHole: { id: 669288, fullName: 'In Hole Guy' },
        first: { id: 621566 }, second: null, third: { id: 641487 },
      },
      innings: Array.from({ length: 8 }, (_, i) => ({
        num: i + 1,
        ordinalNum: `${i + 1}${i === 0 ? 'st' : i === 1 ? 'nd' : i === 2 ? 'rd' : 'th'}`,
        home: { runs: i % 2, hits: 1, errors: 0 },
        away: { runs: i % 3 === 0 ? 1 : 0, hits: 1, errors: 0 },
      })),
    },
    boxscore: {
      teams: {
        away: {
          team: { id: 136, name: 'Seattle Mariners' },
          batters: [660271], pitchers: [592789], battingOrder: [660271],
          players: {
            ID660271: { person: { id: 660271, fullName: 'Test Batter' }, position: { abbreviation: 'CF' }, stats: { batting: { atBats: 4, runs: 1, hits: 2, rbi: 1, baseOnBalls: 0, strikeOuts: 1, avg: '.280' } } },
            ID592789: { person: { id: 592789, fullName: 'Test Pitcher' }, position: { abbreviation: 'P' }, stats: { pitching: { inningsPitched: '6.0', hits: 5, runs: 2, earnedRuns: 2, baseOnBalls: 1, strikeOuts: 7, era: '3.45' } } },
          },
          info: [{ label: 'Weather', value: '68 degrees, Clear.' }],
        },
        home: {
          team: { id: 142, name: 'Minnesota Twins' },
          batters: [], pitchers: [], battingOrder: [], players: {}, info: [],
        },
      },
    },
    decisions: {},
  },
};

/* people/{id}/stats — shape from GET /api/v1/people/{id}/stats?stats=season,
 * statSplits,gameLog,expectedStatistics&group=hitting&sitCodes=vl,vr */
const HITTER_STATS = {
  stats: [
    { type: { displayName: 'season' }, group: { displayName: 'hitting' }, splits: [{ season: '2026', stat: { avg: '.280', atBats: 500, hits: 140, obp: '.350', slg: '.480' } }] },
    { type: { displayName: 'expectedStatistics' }, group: { displayName: 'hitting' }, splits: [{ stat: { xba: '.272', xslg: '.470' } }] },
    { type: { displayName: 'statSplits' }, group: { displayName: 'hitting' }, splits: [
      { split: { code: 'vl', description: 'vs Left' }, stat: { avg: '.250', atBats: 120 } },
      { split: { code: 'vr', description: 'vs Right' }, stat: { avg: '.292', atBats: 380 } },
    ] },
    { type: { displayName: 'gameLog' }, group: { displayName: 'hitting' }, splits: [
      { date: '2026-09-10', stat: { atBats: 4, hits: 1 } },
      { date: '2026-09-11', stat: { atBats: 5, hits: 2 } },
      { date: '2026-09-13', stat: { atBats: 4, hits: 3 } },
      { date: '2026-09-15', stat: { atBats: 4, hits: 0 } },
    ] },
  ],
};

const PITCHER_STATS = {
  stats: [
    { type: { displayName: 'season' }, group: { displayName: 'pitching' }, splits: [{ stat: { avg: '.238'.replace('.', '.'), atBats: 600 } }] },
    { type: { displayName: 'expectedStatistics' }, group: { displayName: 'pitching' }, splits: [{ stat: { xba: '.231' } }] },
    { type: { displayName: 'statSplits' }, group: { displayName: 'pitching' }, splits: [
      { split: { code: 'vl', description: 'vs Left' }, stat: { avg: '.220', atBats: 200 } },
      { split: { code: 'vr', description: 'vs Right' }, stat: { avg: '.248', atBats: 400 } },
    ] },
    { type: { displayName: 'gameLog' }, group: { displayName: 'pitching' }, splits: [] },
  ],
};

const H2H_STATS = {
  stats: [{ type: { displayName: 'vsPlayer' }, group: { displayName: 'hitting' }, splits: [{ stat: { atBats: 12, hits: 4, avg: '.333' } }] }],
};

/* ------------------------------------------------------------------ harness */

function routeFetch(url) {
  const u = String(url);
  let body = null;
  if (u.includes('/schedule?')) body = SCHEDULE;
  else if (u.includes('/gameStatus')) body = GAME_STATUS;
  else if (/\/game\/823109\/playByPlay/.test(u)) body = PBP_823109;
  else if (/\/game\/824466\/playByPlay/.test(u)) body = { allPlays: [] };
  else if (/\/game\/823109\/feed\/live/.test(u)) body = FEED_823109;
  else if (/\/game\/824466\/feed\/live/.test(u)) body = FEED_823109;
  else if (/\/people\/660271\/stats/.test(u)) body = u.includes('opposingPlayerId') ? H2H_STATS : HITTER_STATS;
  else if (/\/people\/592789\/stats/.test(u)) body = PITCHER_STATS;
  else if (u.includes('/api/feed-log')) body = { v: 1, date: '2026-09-15', entries: [], order: [], snapshots: {}, irregularities: {}, grace: {}, settled: [] };

  if (body === null) {
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
  }
  return Promise.resolve({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => JSON.parse(JSON.stringify(body)),
  });
}

/* Serve the repo over HTTP so jsdom loads the shipped <script>/<link> files
 * exactly as a browser would (no stubbing of the app's own code). */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, 'http://127.0.0.1');
  let filePath = path.join(ROOT, decodeURIComponent(parsed.pathname));
  if (parsed.pathname === '/') filePath = path.join(ROOT, 'index.html');
  try {
    const body = await fs.readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const PORT = server.address().port;

async function boot(file, { query = '', beforeParse, fetchImpl } = {}) {
  const virtualConsole = new VirtualConsole();
  const bootErrors = [];
  virtualConsole.on('jsdomError', (err) => {
    bootErrors.push(err.message);
    console.log('    jsdomError:', err.message);
  });
  virtualConsole.on('error', (...args) => console.log('    console.error:', ...args));

  const dom = await JSDOM.fromURL(`http://127.0.0.1:${PORT}/${file}${query}`, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      const requests = [];
      window.__requests = requests;
      window.fetch = (url) => {
        requests.push(String(url));
        return (fetchImpl || routeFetch)(url);
      };
      window.AbortController = window.AbortController || class { constructor() { this.signal = { aborted: false, addEventListener() {} }; } abort() { this.signal.aborted = true; } };
      window.scrollTo = () => {};
      if (typeof window.EventSource !== 'function') {
        window.EventSource = class { constructor() { this.listeners = {}; } addEventListener(n, f) { this.listeners[n] = f; } close() {} };
      }
      if (beforeParse) beforeParse(window);
    },
  });
  /* Wait for all external <script> tags to finish loading and executing before
   * interacting with page globals (fixes RR-06 race on Scoreboard.pickDate). */
  const deadline = Date.now() + 2500;
  while (dom.window.document.readyState !== 'complete' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  await new Promise((r) => setTimeout(r, 120));
  dom.__bootErrors = bootErrors;
  dom.__requests = dom.window.__requests || [];
  return dom;
}

function text(el) { return (el && el.textContent ? el.textContent : '').replace(/\s+/g, ' ').trim(); }

/* -------------------------------------------------------------------- tests */

console.log('\n[1] reviews.js — review parsing against verified payload shapes');
{
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only', url: 'http://localhost/' });
  const w = dom.window;
  w.fetch = (url) => routeFetch(url);
  w.eval(await (await import('node:fs/promises')).readFile(path.join(ROOT, 'assets/js/api.js'), 'utf8'));
  w.eval(await (await import('node:fs/promises')).readFile(path.join(ROOT, 'assets/js/reviews.js'), 'utf8'));

  await check('describe(MJ) → ABS pitch challenge, reason "Pitch Result"', async () => {
    await w.Reviews.loadRegistry();
    const d = w.Reviews.describe('MJ');
    assert(d.isABS === true, 'MJ must be ABS');
    assert(d.reason === 'Pitch Result', 'reason should come from the registry, got ' + d.reason);
    assert(d.typeLabel === 'ABS Pitch Challenge', 'label, got ' + d.typeLabel);
  });

  await check('describe(NH) → boundary call (official reason "Home run")', async () => {
    const d = w.Reviews.describe('NH');
    assert(d.isBoundary === true, 'NH must be a boundary call');
    assert(d.family === 'umpire', 'NH family should be umpire, got ' + d.family);
  });

  await check('statusReview(MD) is a review; statusReview(F) is not', async () => {
    assert(!!w.Reviews.statusReview({ statusCode: 'MD', reason: 'Catch/drop in outfield' }), 'MD must be a review');
    assert(w.Reviews.statusReview({ statusCode: 'F', detailedState: 'Final' }) === null, 'Final must not be a review');
  });

  await check('extractReviews finds play-level, pitch-level and pending rows', async () => {
    const rows = w.Reviews.extractReviews(PBP_823109.allPlays, {
      gamePk: 823109,
      teams: { away: { id: 136, name: 'Seattle Mariners' }, home: { id: 142, name: 'Minnesota Twins' } },
    });
    const codes = rows.map((r) => r.code).sort().join(',');
    assert(codes === 'MA,MD,MJ,NA', 'expected MA,MD,MJ,NA — got ' + codes);
    const abs = rows.find((r) => r.code === 'MJ');
    assert(abs.isABS === true, 'MJ row should be ABS');
    assert(abs.absPitchNumber === 3, 'pitch number should be 3, got ' + abs.absPitchNumber);
    assert(abs.absCountBefore.balls === 1 && abs.absCountBefore.strikes === 1,
      'count before should be 1-1, got ' + JSON.stringify(abs.absCountBefore));
    assert(abs.outcome === 'Overturned', 'MJ outcome, got ' + abs.outcome);
  });

  await check('runs at risk only counts runs credited to the reviewed event', async () => {
    const rows = w.Reviews.extractReviews(PBP_823109.allPlays, { gamePk: 823109, teams: { away: { id: 136 }, home: { id: 142 } } });
    const manager = rows.find((r) => r.code === 'MA');
    assert(manager.runsAtRiskCount === 1, 'MA should carry 1 run at risk, got ' + manager.runsAtRiskCount);
    const boundary = rows.find((r) => r.code === 'MD');
    /* The home run's scoring runner sits on playIndex 3, the reviewed event is
     * the last event (index 0 here) — so it must NOT be counted. */
    assert(boundary.runsAtRiskCount === 0, 'MD must not inherit an unrelated run, got ' + boundary.runsAtRiskCount);
  });

  await check('pending ruling is read from the API event-type registry', async () => {
    const rows = w.Reviews.pendingRulings(PBP_823109.allPlays, { gamePk: 823109 });
    assert(rows.length === 1, 'expected exactly 1 pending ruling, got ' + rows.length);
    assert(rows[0].eventType === 'os_ruling_pending_primary', 'event type, got ' + rows[0].eventType);
  });

  await check('scoring-change diff flags reclassification and ignores score-only edits', async () => {
    const before = w.Reviews.snapshotPlays([play(1, { result: { eventType: 'field_error', description: 'Reached on error', awayScore: 0, homeScore: 0, isOut: false }, count: { balls: 0, strikes: 0, outs: 0 } })]);
    const after = w.Reviews.snapshotPlays([play(1, { result: { eventType: 'single', description: 'Singles.', awayScore: 0, homeScore: 0, isOut: false }, count: { balls: 0, strikes: 0, outs: 0 } })]);
    const diff = w.Reviews.diffSnapshots(before, after);
    assert(diff.changes.length === 1, 'error→single must be a scoring change, got ' + diff.changes.length);
    assert(diff.edits.length === 0, 'no payload-edit rows expected, got ' + diff.edits.length);

    const edited = w.Reviews.diffSnapshots(before, w.Reviews.snapshotPlays([play(1, { result: { eventType: 'field_error', description: 'Changed wording only', awayScore: 1, homeScore: 0, isOut: false }, count: { balls: 0, strikes: 0, outs: 0 } })]));
    assert(edited.changes.length === 0 && edited.edits.length === 1, 'description/score edit must be flagged, not classified as a change');
  });

  await check('counter regression flags backwards used-counters and never flags normal failed challenges', async () => {
    const up = w.Reviews.counterRegression({ away: { used: 1, remaining: 0 } }, { away: { used: 1, remaining: 1 } });
    assert(up === null, 'a used-counter that holds steady must not be flagged: ' + JSON.stringify(up));
    const normalMgrFail = w.Reviews.counterRegression(
      { manager: { away: { used: 0, remaining: 1 } }, abs: { away: { usedSuccessful: 0, usedFailed: 0, remaining: 2 } } },
      { manager: { away: { used: 1, remaining: 0 } }, abs: { away: { usedSuccessful: 0, usedFailed: 1, remaining: 1 } } }
    );
    assert(normalMgrFail === null, 'normal failed challenges decreasing remaining must not be flagged: ' + JSON.stringify(normalMgrFail));
    const notes = w.Reviews.counterRegression({ away: { used: 1, remaining: 1 } }, { away: { used: 0, remaining: 0 } });
    assert(Array.isArray(notes) && notes.length === 1 && /away\.used moved backwards/.test(notes[0]),
      'expected 1 used-counter regression note, got ' + JSON.stringify(notes));
    assert(w.Reviews.counterRegression(null, { away: { used: 1 } }) === null, 'missing previous reading must not be invented');
  });

  await check('null and empty counter fields stay null and are never zero-filled', async () => {
    const m = w.Reviews.managerCounters({ away: { used: null, remaining: '' }, home: {} });
    assert(m.away.used === null && m.away.remaining === null, 'manager null/empty must stay null: ' + JSON.stringify(m));
    assert(m.home.used === null && m.home.remaining === null, 'manager missing must stay null: ' + JSON.stringify(m));
    const a = w.Reviews.absCounters({ away: { usedSuccessful: null, usedFailed: '', remaining: undefined }, home: {} });
    assert(a.away.usedSuccessful === null && a.away.usedFailed === null && a.away.remaining === null,
      'ABS null/empty must stay null: ' + JSON.stringify(a));
  });

  dom.window.close();
}

console.log('\n[2] index.html — scoreboard renders from the schedule payload');
{
  const dom = await boot('index.html', { beforeParse(w) { w.localStorage.clear(); } });
  __setDate(dom);
  await new Promise((r) => setTimeout(r, 400));

  await check('3 game cards with team names and scores', () => {
    const cards = dom.window.document.querySelectorAll('.game-card');
    assert(cards.length === 3, 'expected 3 cards, got ' + cards.length);
    const html = text(dom.window.document.getElementById('game-list'));
    assert(html.includes('Los Angeles Dodgers'), 'away team name missing');
    assert(html.includes('Cincinnati Reds'), 'home team name missing');
    assert(html.includes('Great American Ball Park'), 'venue missing');
  });

  await check('live game shows a review chip from the official status code', () => {
    const html = text(dom.window.document.getElementById('game-list'));
    assert(/Manager Challenge: Tag play/i.test(html), 'review chip missing: ' + html.slice(0, 300));
  });

  await check('filters exist and date navigation updates the label', () => {
    const tabs = dom.window.document.querySelectorAll('#tabs .tab-btn');
    assert(tabs.length >= 5, 'expected filter tabs, got ' + tabs.length);
    assert(text(dom.window.document.getElementById('date-label')).length > 0, 'date label empty');
  });

  await check('no uncaught script errors left the status line in error state', () => {
    assert(dom.__bootErrors.length === 0, 'unexpected jsdomError(s): ' + dom.__bootErrors.join('; '));
    const status = dom.window.document.getElementById('status-line');
    assert(!status.classList.contains('is-error'), 'status line reports an error: ' + text(status));
  });

  dom.window.close();
}

console.log('\n[3] game.html — header, live module, linescore, PBP, tabs');
{
  const dom = await boot('game.html', {
    query: '?gamePk=823109',
    beforeParse(w) { w.localStorage.clear(); },
  });
  await new Promise((r) => setTimeout(r, 700));
  const doc = dom.window.document;

  await check('header shows both teams and the live status', () => {
    const html = text(doc.getElementById('header-away')) + text(doc.getElementById('header-home')) + text(doc.getElementById('header-center'));
    assert(html.includes('Seattle Mariners') && html.includes('Minnesota Twins'), 'team names missing: ' + html);
    assert(/Manager challenge/i.test(html), 'official status label missing: ' + html);
  });

  await check('at-bat module shows count, outs, bases and on-deck', () => {
    const html = text(doc.getElementById('live-panel'));
    assert(html.includes('Test Batter'), 'batter missing');
    assert(html.includes('On deck'), 'on-deck line missing');
    assert(doc.getElementById('live-panel').querySelectorAll('.base-diamond i.on').length >= 1, 'no occupied base rendered');
  });

  await check('linescore table has one column per inning plus R/H/E', () => {
    const table = doc.querySelector('#linescore-wrap table.linescore');
    assert(!!table, 'linescore table missing');
    const headers = table.querySelectorAll('thead th');
    assert(headers.length === 9 + 3 + 1 + 1,
      'expected 9 inning columns + R/H/E + source column + spacer, got ' + headers.length);
    assert(doc.querySelectorAll('#linescore-wrap td.src-cell a').length === 2,
      'each linescore row must link to its official source');
  });

  await check('play-by-play renders every play with pitch detail', () => {
    const plays = doc.querySelectorAll('#plays-wrap .play');
    assert(plays.length === PBP_823109.allPlays.length, 'expected ' + PBP_823109.allPlays.length + ' plays, got ' + plays.length);
    assert(doc.querySelectorAll('#plays-wrap .pitches li').length >= 3, 'pitch list missing');
  });

  await check('Challenges tab badge counts reviews, and the tab renders them', () => {
    const badge = doc.getElementById('reviews-tab-count');
    assert(badge.style.display !== 'none' && Number(badge.textContent) >= 4, 'badge should count reviews, got ' + badge.textContent);
    dom.window.Game.setTab('reviews');
    const html = text(doc.getElementById('reviews-wrap'));
    assert(html.includes('ABS Pitch Challenge'), 'ABS review card missing');
    assert(html.includes('Manager Challenge'), 'manager review card missing');
  });

  await check('box score tab renders batting + pitching lines', () => {
    dom.window.Game.setTab('boxscore');
    const html = text(doc.getElementById('boxscore-wrap'));
    assert(html.includes('Seattle Mariners'), 'team heading missing');
    assert(html.includes('Test Batter') && html.includes('Test Pitcher'), 'player rows missing');
    assert(html.includes('ERA'), 'pitching header missing');
    assert(doc.querySelectorAll('#boxscore-wrap td.src-cell a').length >= 2,
      'each box-score row must link to its official source');
  });

  await check('reviews banner appears for the in-progress review', () => {
    const html = text(doc.getElementById('live-review-banner-wrap'));
    assert(/Under review/i.test(html), 'banner missing: ' + html);
  });

  dom.window.close();
}

console.log('\n[4] props.js — the two-sided hit forecast');
{
  const dom = await boot('game.html', { query: '?gamePk=823109', beforeParse(w) { w.localStorage.clear(); } });
  await new Promise((r) => setTimeout(r, 900));

  await check('forecast lands inside the documented clamp band with all six drivers', () => {
    const f = dom.window.Game.state.forecast;
    assert(!!f, 'no forecast produced');
    assert(f.prob >= 0.10 && f.prob <= 0.78, 'probability out of clamp band: ' + f.prob);
    assert(f.drivers.length === 6, 'expected 6 drivers, got ' + f.drivers.length);
    assert(f.tier && f.tier.label, 'tier missing');
    assert(f.atLeastOne > f.prob, '>=1 hit over N PAs must exceed the per-PA rate');
  });

  await check('season inputs came from the stub, not from a guessed baseline', () => {
    const f = dom.window.Game.state.forecast;
    assert(f.ok === true, 'forecast fell back to baseline: ' + f.label);
    assert(String(f.batter.season.avg) === '.280', 'batter AVG not read, got ' + (f.batter.season && f.batter.season.avg));
    assert(String(f.pitcher.expected.xba) === '.231', 'pitcher xBA not read');
  });

  await check('per-PA estimate is rendered on the live card', () => {
    const html = text(dom.window.document.getElementById('live-panel'));
    assert(/hit this PA/.test(html), 'forecast headline missing');
  });

  dom.window.close();
}

console.log('\n[5] reviews.html — the all-games Replay Feed');
{
  const dom = await boot('reviews.html', { beforeParse(w) { w.localStorage.clear(); } });
  await new Promise((r) => setTimeout(r, 900));
  const doc = dom.window.document;

  await check('every event type is tracked (ABS, manager, boundary, umpire, pending)', () => {
    const entries = dom.window.ReplayFeed.state.entries;
    assert(entries.length >= 5, 'expected at least 5 tracked entries, got ' + entries.length);
    const kinds = entries.map((e) => (e.review && e.review.code) || e.kind).join(',');
    ['MJ', 'MD', 'MA', 'NA'].forEach((code) => assert(kinds.includes(code), 'missing tracked code ' + code + ' in ' + kinds));
    assert(entries.some((e) => e.kind === 'pending'), 'pending ruling not tracked');
  });

  await check('All tab hides ABS rows, ABS tab shows them', () => {
    const allHtml = text(doc.getElementById('feed-list'));
    assert(!allHtml.includes('ABS Pitch Challenge'), 'All tab must exclude ABS rows');
    dom.window.ReplayFeed.setFilter('abs');
    const absHtml = text(doc.getElementById('feed-list'));
    assert(absHtml.includes('ABS Pitch Challenge'), 'ABS tab must show ABS rows');
    dom.window.ReplayFeed.setFilter('all');
  });

  await check('runs-at-risk row carries the official score tracker', () => {
    dom.window.ReplayFeed.setFilter('risk');
    const html = text(doc.getElementById('feed-list'));
    assert(/run\(s\) at risk/.test(html), 'at-risk badge missing');
    assert(/Actual after/.test(html), 'official score tracker missing: ' + html.slice(0, 400));
    dom.window.ReplayFeed.setFilter('all');
  });

  await check('summary tiles count the tracked entries', () => {
    const tiles = doc.querySelectorAll('#feed-stats .stat-tile');
    assert(tiles.length >= 8, 'expected the summary tiles, got ' + tiles.length);
    const html = text(doc.getElementById('feed-stats'));
    assert(/ABS challenges/.test(html) && /Runs at risk/.test(html), 'tile labels missing');
  });

  await check('filters isolate ABS / scoring-change views', () => {
    dom.window.ReplayFeed.setFilter('abs');
    let html = text(doc.getElementById('feed-list'));
    assert(html.includes('ABS Pitch Challenge'), 'ABS filter lost its rows');
    assert(!html.includes('Official Scorer Ruling Pending'), 'ABS filter leaked non-ABS rows');
    dom.window.ReplayFeed.setFilter('scoring');
    html = text(doc.getElementById('feed-list'));
    assert(html.length >= 0, 'scoring view crashed');
    dom.window.ReplayFeed.setFilter('all');
  });

  await check('entries are persisted to localStorage per date', () => {
    const raw = dom.window.localStorage.getItem('mlbp.feedlog.2026-09-15') || dom.window.localStorage.getItem('mlbp.feedlog.' + dom.window.MLB.todayISO());
    assert(!!raw, 'no feed log written');
    const parsed = JSON.parse(raw);
    assert(Array.isArray(parsed.entries) && parsed.entries.length >= 5, 'log has no entries');
  });

  await check('sound / notification toggles flip state and persist the preference', () => {
    dom.window.ReplayFeed.toggleSound();
    assert(dom.window.ReplayFeed.state.soundOn === true, 'sound toggle did not flip');
    assert(dom.window.localStorage.getItem('mlbp.pref.sound') === '1', 'sound preference not saved');
    dom.window.ReplayFeed.toggleNotify();
    assert(dom.window.ReplayFeed.state.notifyOn === true, 'notification toggle did not flip');
  });

  dom.window.close();
}

console.log('\n[6] feed-log.js — merge semantics');
{
  const dom = await boot('reviews.html', { beforeParse(w) { w.localStorage.clear(); } });
  await new Promise((r) => setTimeout(r, 400));

  await check('merge keeps both sides and never loses a row', () => {
    const a = { v: 1, date: '2026-09-15', entries: [{ id: 'x', gamePk: 1, review: { id: 'x' }, firstSeen: 5, lastSeen: 5 }], order: [], snapshots: {}, irregularities: {}, grace: {}, settled: [] };
    const b = { v: 1, date: '2026-09-15', entries: [{ id: 'y', gamePk: 2, review: { id: 'y' }, firstSeen: 6, lastSeen: 6 }], order: [], snapshots: {}, irregularities: {}, grace: {}, settled: [] };
    const merged = dom.window.FeedLog.mergePayloads(a, b, '2026-09-15');
    assert(merged.entries.length === 2, 'expected 2 merged entries, got ' + merged.entries.length);
  });

  await check('merge is idempotent (same payload twice changes nothing)', () => {
    const a = { v: 1, date: '2026-09-15', entries: [{ id: 'x', gamePk: 1, review: { id: 'x' }, firstSeen: 5, lastSeen: 5 }], order: [], snapshots: {}, irregularities: {}, grace: {}, settled: [] };
    const once = dom.window.FeedLog.mergePayloads(a, a, '2026-09-15');
    const twice = dom.window.FeedLog.mergePayloads(once, a, '2026-09-15');
    assert(twice.entries.length === 1, 'expected a single entry after the second merge, got ' + twice.entries.length);
  });

  await check('irregularity notes accumulate instead of being overwritten', () => {
    const a = { v: 1, date: 'd', entries: [], order: [], snapshots: {}, irregularities: { 1: ['note a'] }, grace: {}, settled: [] };
    const b = { v: 1, date: 'd', entries: [], order: [], snapshots: {}, irregularities: { 1: ['note b'] }, grace: {}, settled: [] };
    const merged = dom.window.FeedLog.mergePayloads(a, b, 'd');
    assert(merged.irregularities[1].length === 2, 'notes were lost: ' + JSON.stringify(merged.irregularities[1]));
  });

  dom.window.close();
}

console.log('\n[7] static asset integrity');
{
  const fs = await import('node:fs/promises');
  const pages = ['index.html', 'game.html', 'reviews.html', '404.html', 'flagged.html'];
  for (const page of pages) {
    await check(`${page}: every local href/src resolves to a file`, async () => {
      let html;
      try { html = await fs.readFile(path.join(ROOT, page), 'utf8'); }
      catch { throw new Error('page missing'); }
      const refs = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1])
        /* A JS-constructed URL (404.html writes its <base> at runtime) is not a
         * static reference; it is covered by the 404 routing check instead. */
        .filter((u) => !/^(https?:|data:|#|mailto:)/.test(u))
        .filter((u) => !/[\s'"<]/.test(u));
      assert(refs.length > 0, 'no local assets referenced');
      for (const ref of refs) {
        const clean = ref.split('#')[0].split('?')[0];
        const target = path.join(ROOT, clean);
        try { await fs.access(target); }
        catch { throw new Error(`broken link: ${ref}`); }
      }
    });
  }
}

console.log('\n[8] offseason empty state — points at the most recent date with games');
{
  const emptyToday = (url) => {
    const u = String(url);
    if (u.includes('startDate=')) {
      return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ dates: [] }) });
    }
    if (u.includes('/schedule?')) {
      return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ totalGames: 0, dates: [] }) });
    }
    return routeFetch(url);
  };
  const dom = await boot('index.html', { fetchImpl: emptyToday, beforeParse(w) { w.localStorage.clear(); } });
  await new Promise((r) => setTimeout(r, 400));

  await check('empty slate renders a message instead of an empty page', () => {
    const html = text(dom.window.document.getElementById('game-list'));
    assert(/No games scheduled/.test(html), 'empty-state message missing: ' + html);
    assert(!dom.window.document.getElementById('status-line').classList.contains('is-error'),
      'empty slate must not be reported as a network error');
  });

  await check('a range query is issued once to find the latest date with games', () => {
    assert(dom.window.Scoreboard.state.lookingForRecent === false, 'range lookup did not settle');
    assert(dom.window.Scoreboard.state.lastGameDate === null, 'no games in range should yield null, got ' + dom.window.Scoreboard.state.lastGameDate);
  });

  dom.window.close();
}

console.log('\n[9] offseason empty state — link to the latest date with games');
{
  const withHistory = (url) => {
    const u = String(url);
    if (u.includes('startDate=')) {
      return Promise.resolve({
        ok: true, status: 200, headers: { get: () => null },
        json: async () => ({ dates: [{ date: '2026-09-14', totalGames: 0 }, { date: '2026-09-15', totalGames: 15 }] }),
      });
    }
    if (u.includes('/schedule?')) {
      return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ totalGames: 0, dates: [] }) });
    }
    return routeFetch(url);
  };
  const dom = await boot('index.html', { fetchImpl: withHistory, beforeParse(w) { w.localStorage.clear(); } });
  await new Promise((r) => setTimeout(r, 500));

  await check('the latest date with games is offered as a button', () => {
    const st = dom.window.Scoreboard.state;
    assert(st.lastGameDate === '2026-09-15', 'expected 2026-09-15, got ' + st.lastGameDate);
    const html = text(dom.window.document.getElementById('game-list'));
    assert(/Most recent date with games/.test(html), 'hint text missing: ' + html);
    assert(dom.window.document.querySelector('#game-list button') !== null, 'no jump button rendered');
  });

  dom.window.close();
}

console.log('\n[10] live-API shape & replay-audit regressions (1f908513 / RR-01..RR-04)');
{
  const fs = await import('node:fs/promises');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only', url: 'http://localhost/' });
  const w = dom.window;
  w.fetch = (url) => {
    const u = String(url);
    if (u.includes('opposingPlayerId=')) {
      /* Official StatsAPI vsPlayer returns vsPlayerTotal (career) + vsPlayer (per-season). */
      return Promise.resolve({
        ok: true, status: 200, headers: { get: () => null },
        json: async () => ({
          stats: [{ type: { displayName: 'vsPlayerTotal' }, splits: [{ stat: { atBats: 10, hits: 4, avg: '.400' } }] }],
        }),
      });
    }
    if (u.includes('/people/')) {
      /* Official StatsAPI expectedStatistics stores xBA under stat.avg, not stat.xba. */
      return Promise.resolve({
        ok: true, status: 200, headers: { get: () => null },
        json: async () => ({
          stats: [
            { type: { displayName: 'season' }, splits: [
              { team: { id: 121 }, stat: { avg: '.240', atBats: 200, hits: 48 } },
              { stat: { avg: '.285', atBats: 450, hits: 128 } },
            ] },
            { type: { displayName: 'expectedStatistics' }, splits: [{ stat: { avg: '.301', slg: '.510', woba: '.380' } }] },
            { type: { displayName: 'statSplits' }, splits: [{ split: 'vr', stat: { avg: '.295', atBats: 310 } }] },
            { type: { displayName: 'gameLog' }, splits: [] },
          ],
        }),
      });
    }
    return routeFetch(url);
  };
  w.eval(await fs.readFile(path.join(ROOT, 'assets/js/api.js'), 'utf8'));
  w.eval(await fs.readFile(path.join(ROOT, 'assets/js/ui.js'), 'utf8'));
  w.eval(await fs.readFile(path.join(ROOT, 'assets/js/reviews.js'), 'utf8'));
  w.eval(await fs.readFile(path.join(ROOT, 'assets/js/props.js'), 'utf8'));

  await check('expectedStatistics stat.avg (xBA) & vsPlayerTotal (H2H) & combined splits work', async () => {
    const f = await w.Props.getForecast({
      batterId: 682829, batterName: 'Elly De La Cruz', batterHand: 'S',
      pitcherId: 656849, pitcherName: 'David Peterson', pitcherHand: 'R',
      season: 2026, gameDate: '2026-08-28', count: { balls: 1, strikes: 0 }, countKnown: true,
      inning: 3, half: 'top', gameLive: true, gameFinal: false,
    });
    assert(String(f.batter.expected && f.batter.expected.xba) === '.301', 'xBA from expectedStatistics.avg missing');
    assert(String(f.batter.season && f.batter.season.avg) === '.285', 'combined multi-team season split not chosen');
    const h2hDriver = f.drivers.find((d) => d.key === 'history');
    assert(h2hDriver && /4-10/.test(h2hDriver.detail), 'vsPlayerTotal H2H not read: ' + JSON.stringify(h2hDriver));
  });

  await check('RR-02 + PA-ending ABS + MF fallback: official pitchNumber beats array index', () => {
    const d = w.Reviews.describe('MF');
    assert(d.reason === 'Close play at 1st', 'MF fallback reason missing, got ' + d.reason);

    const rows = w.Reviews.extractReviews([
      /* Game 823243 atBatIndex 54 shape: 2 non-pitch actions precede 3 pitches; pitchNumber is 3. */
      play(54, {
        about: { atBatIndex: 54, inning: 7, halfInning: 'top', isTopInning: true, isComplete: true, hasReview: true },
        playEvents: [
          { index: 0, isPitch: false, details: { description: 'Pitcher Step Off' } },
          { index: 1, isPitch: false, details: { description: 'Pickoff Attempt 1B' } },
          { index: 2, isPitch: true, pitchNumber: 1, count: { balls: 1, strikes: 0, outs: 1 }, details: { description: 'Ball' } },
          { index: 3, isPitch: true, pitchNumber: 2, count: { balls: 1, strikes: 1, outs: 1 }, details: { description: 'Called Strike' } },
          { index: 4, isPitch: true, pitchNumber: 3, count: { balls: 1, strikes: 2, outs: 1 }, details: { description: 'Called Strike' },
            reviewDetails: { isOverturned: false, inProgress: false, reviewType: 'MJ', challengeTeamId: 136 } },
        ],
      }),
      /* PA-ending ABS strikeout where MLB attaches reviewDetails on play.reviewDetails. */
      play(86, {
        about: { atBatIndex: 86, inning: 9, halfInning: 'bottom', isTopInning: false, isComplete: true, hasReview: true },
        reviewDetails: { isOverturned: false, inProgress: false, reviewType: 'MJ', challengeTeamId: 142 },
        playEvents: [
          { index: 0, isPitch: true, pitchNumber: 1, count: { balls: 0, strikes: 1, outs: 2 }, details: { description: 'Swinging Strike' } },
          { index: 1, isPitch: true, pitchNumber: 2, count: { balls: 0, strikes: 2, outs: 2 }, details: { description: 'Foul' } },
          { index: 2, isPitch: true, pitchNumber: 3, count: { balls: 0, strikes: 3, outs: 2 }, details: { description: 'Called Strike' } },
        ],
      }),
    ], { gamePk: 823243, teams: { away: { id: 136 }, home: { id: 142 } } });

    assert(rows[0].absPitchNumber === 3, 'RR-02: expected official pitchNumber 3, got ' + rows[0].absPitchNumber);
    assert(rows[1].absPitchNumber === 3 && rows[1].absCountBefore.strikes === 2,
      'PA-ending MJ should resolve final pitch count 0-2 -> 0-3, got ' + JSON.stringify(rows[1]));
  });

  dom.window.close();

  /* RR-01, RR-03, RR-04 on reviews.html */
  let resolveSlowSchedule;
  const slowMarch27 = new Promise((r) => { resolveSlowSchedule = r; });
  const raceFetch = (url) => {
    const u = String(url);
    if (u.includes('/schedule?') && u.includes('date=2026-03-27')) return slowMarch27;
    if (u.includes('/schedule?') && u.includes('date=2026-03-28')) {
      return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ totalGames: 0, dates: [] }) });
    }
    return routeFetch(u);
  };
  const feedDom = await boot('reviews.html', { fetchImpl: raceFetch, beforeParse(win) { win.localStorage.clear(); } });
  await new Promise((r) => setTimeout(r, 250));

  await check('RR-03 + RR-04: replay rows link to MLB StatsAPI and All shows scoring changes', () => {
    const links = [...feedDom.window.document.querySelectorAll('#feed-list a[href*="statsapi.mlb.com/api/v1/game/"]')];
    assert(links.length >= 1, 'RR-04: expected direct official MLB StatsAPI link on replay rows');
    feedDom.window.ReplayFeed.state.entries.push({
      id: '823109:1:scoring-change',
      kind: 'scoring_change',
      gamePk: 823109,
      matchupLabel: 'SEA @ MIN',
      lastSeen: Date.now(),
      change: { atBatIndex: 1, inningLabel: 'Top 1', batter: 'Test Batter', from: { description: 'Error' }, to: { description: 'Single' }, attribution: 'Official scorer' },
      review: { typeLabel: 'Official Scoring Change', inningLabel: 'Top 1', batter: { name: 'Test Batter' }, outcome: 'Reclassified', isABS: false, family: 'scoring' },
    });
    feedDom.window.ReplayFeed.setFilter('all');
    const html = text(feedDom.window.document.getElementById('feed-list'));
    assert(html.includes('Official Scoring Change'), 'RR-03: scoring change must appear in All tab');
  });

  await check('RR-01: delayed schedule from prior date cannot pollute the newly selected date', async () => {
    const picker = feedDom.window.document.getElementById('date-picker');
    picker.value = '2026-03-27';
    picker.dispatchEvent(new feedDom.window.Event('change'));
    await new Promise((r) => setTimeout(r, 40));
    picker.value = '2026-03-28';
    picker.dispatchEvent(new feedDom.window.Event('change'));
    await new Promise((r) => setTimeout(r, 80));
    resolveSlowSchedule({
      ok: true, status: 200, headers: { get: () => null },
      json: async () => SCHEDULE,
    });
    await new Promise((r) => setTimeout(r, 150));
    assert(feedDom.window.ReplayFeed.state.date === '2026-03-28', 'date should stay 2026-03-28');
    assert(feedDom.window.ReplayFeed.state.entries.length === 0,
      'RR-01: stale 2026-03-27 schedule leaked entries into 2026-03-28: ' + feedDom.window.ReplayFeed.state.entries.length);
  });

  feedDom.window.close();
}

console.log('\n[11] ?date= deep links (shareable scoreboard / replay-feed URLs)');
{
  const boardDom = await boot('index.html', { query: '?date=2026-09-15', beforeParse(w) { w.localStorage.clear(); } });
  await new Promise((r) => setTimeout(r, 400));

  await check('index.html?date= opens that date and renders its games', () => {
    const st = boardDom.window.Scoreboard.state;
    assert(st.date === '2026-09-15', 'expected 2026-09-15, got ' + st.date);
    assert(st.games.length === SCHEDULE.dates[0].games.length,
      'expected ' + SCHEDULE.dates[0].games.length + ' games, got ' + st.games.length);
    const html = text(boardDom.window.document.getElementById('game-list'));
    assert(/Dodgers/.test(html), 'game cards did not render: ' + html.slice(0, 120));
  });

  await check('scoreboard keeps the address bar in step with the selected date', () => {
    const href = boardDom.window.location.href;
    assert(/[?&]date=2026-09-15/.test(href), 'date missing from URL: ' + href);
    boardDom.window.Scoreboard.setDate('2026-09-14');
    assert(/[?&]date=2026-09-14/.test(boardDom.window.location.href),
      'URL did not follow setDate: ' + boardDom.window.location.href);
  });

  boardDom.window.close();

  const feedDomLink = await boot('reviews.html', { query: '?date=2026-09-15', beforeParse(w) { w.localStorage.clear(); } });
  await new Promise((r) => setTimeout(r, 400));

  await check('reviews.html?date= opens that date in the replay feed', () => {
    const st = feedDomLink.window.ReplayFeed.state;
    assert(st.date === '2026-09-15', 'expected 2026-09-15, got ' + st.date);
    const label = text(feedDomLink.window.document.getElementById('date-label'));
    assert(/Sep 15, 2026/.test(label), 'date label not updated: ' + label);
    assert(/[?&]date=2026-09-15/.test(feedDomLink.window.location.href),
      'date missing from URL: ' + feedDomLink.window.location.href);
  });

  feedDomLink.window.close();
}

console.log('\n[12] af75fbfd parity & provenance checks (ABS counters, no before-score inference, zero-index merge, calendar dates)');
{
  const feedDom2 = await boot('reviews.html', { query: '?date=2026-09-15', beforeParse(w) { w.localStorage.clear(); } });
  await new Promise((r) => setTimeout(r, 700));
  const doc2 = feedDom2.window.document;

  await check('AF-1 + AF-5: ABS rows show official ABS challenges left + challenger role + both-teams hover summary', () => {
    feedDom2.window.ReplayFeed.setFilter('abs');
    const html = text(doc2.getElementById('feed-list'));
    assert(/2 ABS challenges left now/.test(html), 'official ABS counter missing on ABS row: ' + html);
    assert(/\(batter\)/.test(html), 'official ABS challenger role missing: ' + html);
    const noteEl = doc2.querySelector('#feed-list .counter-note');
    assert(noteEl && /Challenges left: SEA 0 MGR · 2 ABS — MIN 1 MGR · 2 ABS/.test(noteEl.getAttribute('title') || ''),
      'both-teams counter summary missing on title: ' + (noteEl && noteEl.getAttribute('title')));
    feedDom2.window.ReplayFeed.setFilter('all');
  });

  await check('AF-2: nested {manager, abs} counter regression is detected', () => {
    const notes = feedDom2.window.Reviews.counterRegression(
      { manager: { away: { used: 1, remaining: 1 } }, abs: { home: { usedSuccessful: 2, remaining: 2 } } },
      { manager: { away: { used: 0, remaining: 1 } }, abs: { home: { usedSuccessful: 1, remaining: 2 } } }
    );
    assert(Array.isArray(notes) && notes.length === 2, 'expected 2 nested regression notes, got ' + JSON.stringify(notes));
  });

  await check('AF-3: resolved review opened after the ruling never infers Before score', () => {
    const mdEntry = feedDom2.window.ReplayFeed.state.entries.find((e) => e.review && e.review.code === 'MD');
    assert(mdEntry && mdEntry.scoreTracker, 'MD entry missing');
    assert(mdEntry.scoreTracker.before === null, 'before score must stay null when not observed live, got ' + JSON.stringify(mdEntry.scoreTracker.before));
    assert(mdEntry.scoreTracker.actual && mdEntry.scoreTracker.actual.away === 3, 'actual score after missing');
  });

  await check('AF-4: active review with runs at risk renders persistent #banner on reviews.html', () => {
    feedDom2.window.ReplayFeed.state.entries.push({
      id: '823109:99:p:MA',
      kind: 'review',
      gamePk: 823109,
      matchupLabel: 'SEA @ MIN',
      lastSeen: Date.now(),
      review: { code: 'MA', typeLabel: 'Manager Challenge', reason: 'Tag play', inningLabel: 'Bot 9', inProgress: true, runsAtRiskCount: 2, isABS: false, family: 'manager' },
      scoreTracker: { before: { away: 3, home: 5 }, possible: { away: 3, home: 3 }, actual: null },
    });
    feedDom2.window.ReplayFeed.setFilter('all');
    const bannerHtml = text(doc2.getElementById('banner'));
    assert(/2 runs at risk/.test(bannerHtml), 'persistent #banner missing runs-at-risk alert: ' + bannerHtml);
  });

  await check('AF-5 + AF-6: strict calendar isValidISODate, non-zero-filled countDots, and atBatIndex 0 merge keys', () => {
    assert(feedDom2.window.MLB.isValidISODate('2026-02-28') === true, '2026-02-28 should be valid');
    assert(feedDom2.window.MLB.isValidISODate('2026-02-31') === false, '2026-02-31 must be rejected');
    const absentDots = feedDom2.window.UI.countDots(null, undefined);
    assert(!/on-ball|dot/.test(absentDots), 'absent count must not render zero-filled dots: ' + absentDots);
    const mergedZero = feedDom2.window.FeedLog.mergePayloads(
      { v: 1, date: '2026-09-15', entries: [{ gamePk: 1, review: { atBatIndex: 0, outcome: 'Stands' } }] },
      { v: 1, date: '2026-09-15', entries: [{ gamePk: 1, review: { atBatIndex: '' , outcome: 'Unknown' } }] },
      '2026-09-15'
    );
    assert(mergedZero.entries.length === 2, 'atBatIndex 0 must not collide with empty string: ' + mergedZero.entries.length);
  });

  feedDom2.window.close();
}

console.log('\n[13] reference-parity fixes (session 6e2a58d9: G-2…G-5, G-9)');
{
  const dom = await boot('reviews.html', { beforeParse(w) { w.localStorage.clear(); } });
  await new Promise((r) => setTimeout(r, 900));
  const doc = dom.window.document;
  const w = dom.window;
  const st = w.ReplayFeed.state;

  await check('counterLine matches the uploaded README examples (team prefix)', () => {
    const abs = w.Reviews.counterLine({
      abs: { away: { usedSuccessful: 2, usedFailed: 0, remaining: 2 } },
      side: 'away', label: 'CIN',
    });
    assert(abs === 'CIN: 2 ABS challenges left now (2 successful · 0 failed)',
      'README example 1 mismatch: ' + abs);
    const mgr = w.Reviews.counterLine({
      manager: { away: { used: 0, remaining: 1 } },
      side: 'away', label: 'PIT',
    });
    assert(mgr === 'PIT: 1 manager challenge left now (0 used)',
      'README example 2 mismatch: ' + mgr);
  });

  await check('countersSummary matches the README example and never zero-fills absent counters', () => {
    const s = w.Reviews.countersSummary({
      manager: { away: { remaining: 1 }, home: { remaining: 1 } },
      abs: { away: { remaining: 2 }, home: { remaining: 2 } },
      awayLabel: 'CIN', homeLabel: 'CHC',
    });
    assert(s === 'Challenges left: CIN 1 MGR · 2 ABS — CHC 1 MGR · 2 ABS',
      'README summary example mismatch: ' + s);
    const noAbs = w.Reviews.countersSummary({
      manager: { away: { remaining: 1 }, home: { remaining: 1 } },
      abs: null, awayLabel: 'CIN', homeLabel: 'CHC',
    });
    assert(noAbs === 'Challenges left: CIN 1 MGR — CHC 1 MGR',
      'absent ABS counters must be omitted, not zero-filled: ' + noAbs);
    assert(w.Reviews.countersSummary({}) === '', 'no counters known -> empty summary');
  });

  await check('replay rows carry the challenges-remaining tracker with team prefix and hover summary', async () => {
    /* Manager counters come from the schedule hydrate; ABS counters from the
     * lean feed/live projection (both fixtures mirror the verified shapes). */
    await new Promise((r) => setTimeout(r, 400));
    w.ReplayFeed.setFilter('challenges');
    const notes = [...doc.querySelectorAll('#feed-list .counter-note')].map((n) => n.textContent.trim());
    assert(notes.includes('SEA: 0 manager challenges left now (1 used)'),
      'MA counter line must carry the challenging team prefix: ' + JSON.stringify(notes));
    assert(notes.includes('MIN: 1 manager challenge left now (1 used)'),
      'MD (charged manager challenge) counter line wrong: ' + JSON.stringify(notes));
    const titled = [...doc.querySelectorAll('#feed-list .counter-note')]
      .find((n) => (n.getAttribute('title') || '').includes('Challenges left:'));
    assert(titled, 'hover summary missing on counter lines');
    assert(titled.getAttribute('title') === 'Challenges left: SEA 0 MGR · 2 ABS — MIN 1 MGR · 2 ABS',
      'hover summary wrong: ' + titled.getAttribute('title'));
    w.ReplayFeed.setFilter('abs');
    const absNote = [...doc.querySelectorAll('#feed-list .counter-note')]
      .find((n) => /ABS challenge/.test(n.textContent));
    assert(absNote, 'ABS counter line missing on the ABS row (feed/live counters)');
    assert(/^SEA: 2 ABS challenges left now \(0 successful · 1 failed\)$/.test(absNote.textContent.trim()),
      'ABS counter line wrong: ' + absNote.textContent.trim());
  });

  await check('Under-Review strip carries the both-teams summary (README)', () => {
    const strip = text(doc.getElementById('active-strip'));
    assert(/Challenges left: SEA 0 MGR · 2 ABS — MIN 1 MGR · 2 ABS/.test(strip),
      'summary missing from the Under-Review strip: ' + strip);
  });

  await check('boundary review with no credited run says "score impact pending" (README)', () => {
    /* Seed an umpire-side NH boundary review (the fixture slate has none). */
    st.entries.push({
      id: '823109:99:seeded-boundary',
      kind: 'review',
      gamePk: 823109,
      matchupLabel: 'SEA @ MIN',
      teams: { away: { id: 136, name: 'Seattle Mariners' }, home: { id: 142, name: 'Minnesota Twins' } },
      review: {
        code: 'NH', family: 'umpire', typeLabel: 'Umpire Review', reason: 'Home run',
        isABS: false, isBoundary: true, inProgress: false, runsAtRiskCount: 0,
        outcome: 'Call Stands / Confirmed', inningLabel: 'Top 2',
      },
      scoreTracker: { before: { away: 2, home: 3 }, possible: null, actual: null },
      lastSeen: Date.now(),
    });
    w.ReplayFeed.setFilter('all');
    const html = text(doc.getElementById('feed-list'));
    assert(html.includes('score impact pending'),
      'boundary row must say "score impact pending" instead of inventing a score');
    st.entries = st.entries.filter((e) => e.id !== '823109:99:seeded-boundary');
    w.ReplayFeed.setFilter('all');
  });

  async function rescanAnd(fn) {
    st.lastChimeAt = 0;
    st.soundOn = true;
    w.ReplayFeed.scan();
    await new Promise((r) => setTimeout(r, 500));
    while (st.scanning) await new Promise((r) => setTimeout(r, 50));
    fn(st.lastChimeAt);
    st.soundOn = false;
  }

  await check('G-3: new non-ABS review rows chime (challenges/reviews/boundary calls)', async () => {
    const keep = st.entries.filter((e) => !(e.review && e.review.code === 'NA'));
    assert(keep.length === st.entries.length - 1, 'expected exactly one NA row in fixtures');
    st.entries = keep;
    await rescanAnd((at) => assert(at > 0, 'new umpire-review row did not chime'));
  });

  await check('G-3: new official-scorer pending rulings chime', async () => {
    const keep = st.entries.filter((e) => e.kind !== 'pending');
    assert(keep.length < st.entries.length, 'expected a pending row in fixtures');
    st.entries = keep;
    await rescanAnd((at) => assert(at > 0, 'new pending ruling did not chime'));
  });

  await check('G-3: routine ABS pitch challenges never chime (uploaded button title)', async () => {
    const keep = st.entries.filter((e) => !(e.review && e.review.isABS));
    assert(keep.length < st.entries.length, 'expected an ABS row in fixtures');
    st.entries = keep;
    await rescanAnd((at) => {
      assert(at === 0, 'routine ABS row must not chime, got lastChimeAt=' + at);
      assert(st.entries.some((e) => e.review && e.review.isABS), 'ABS row should still be tracked');
    });
  });

  await check('G-3: runs-at-risk chime fires once per review, then never again', async () => {
    const ma = st.entries.find((e) => e.review && e.review.code === 'MA');
    assert(ma && ma.review.runsAtRiskCount === 1, 'fixture MA row should carry 1 run at risk');
    st.entries = st.entries.filter((e) => e !== ma);
    await rescanAnd((at) => assert(at > 0, 'new runs-at-risk review did not chime'));
    const again = st.entries.find((e) => e.review && e.review.code === 'MA');
    assert(again && again.warned === true, 'risk chime must mark the row as warned');
    await rescanAnd((at) => assert(at === 0, 'runs-at-risk review must not re-chime (fires once)'));
  });

  await check('G-3: official scoring changes chime and render in All', async () => {
    let pbp = JSON.parse(JSON.stringify(PBP_823109));
    const mutFetch = (url) => {
      const u = String(url);
      if (/\/game\/823109\/playByPlay/.test(u)) {
        return Promise.resolve({
          ok: true, status: 200, headers: { get: () => null },
          json: async () => JSON.parse(JSON.stringify(pbp)),
        });
      }
      return routeFetch(u);
    };
    const mutDom = await boot('reviews.html', { fetchImpl: mutFetch, beforeParse(x) { x.localStorage.clear(); } });
    await new Promise((r) => setTimeout(r, 700));
    const mst = mutDom.window.ReplayFeed.state;
    /* Reclassify a completed play between polls (error→single style diff). */
    pbp.allPlays[0].result.eventType = 'field_error';
    pbp.allPlays[0].result.description = 'Reached on error.';
    await new Promise((resolve) => {
      mst.lastChimeAt = 0;
      mst.soundOn = true;
      mutDom.window.ReplayFeed.scan();
      setTimeout(resolve, 500);
    });
    while (mst.scanning) await new Promise((r) => setTimeout(r, 50));
    assert(mst.entries.some((e) => e.kind === 'scoring_change'),
      'reclassification between polls must create a scoring-change row');
    assert(mst.lastChimeAt > 0, 'new official scoring change must chime');
    mutDom.window.ReplayFeed.setFilter('all');
    const html = text(mutDom.window.document.getElementById('feed-list'));
    assert(html.includes('Official Scoring Change'), 'scoring change must render in All');
    mutDom.window.close();
  });

  await check('G-2: empty slate renders an empty-state notice, not a blank list', async () => {
    const emptyFetch = (url) => {
      if (String(url).includes('/schedule?')) {
        return Promise.resolve({
          ok: true, status: 200, headers: { get: () => null },
          json: async () => ({ totalGames: 0, dates: [] }),
        });
      }
      return routeFetch(url);
    };
    const emptyDom = await boot('reviews.html', { fetchImpl: emptyFetch, beforeParse(x) { x.localStorage.clear(); } });
    await new Promise((r) => setTimeout(r, 500));
    const html = text(emptyDom.window.document.getElementById('feed-list'));
    assert(/No tracked events for this date and filter yet/.test(html),
      'empty-state notice missing: ' + html);
    emptyDom.window.close();
  });

  await check('G-9: irregularity notes attach to their row; game-level notes render once', () => {
    const target = st.entries.find((e) => e.kind === 'review');
    assert(target && target.id, 'expected a review entry with an id');
    st.irregularities = {};
    st.irregularities[target.gamePk] = [
      'Note naming ' + target.id + ' only',
      'Game-level note for ' + target.gamePk,
    ];
    w.ReplayFeed.setFilter('all');
    const html = text(doc.getElementById('feed-list'));
    const rowCount = html.split('Note naming ' + target.id + ' only').length - 1;
    assert(rowCount === 1, 'entry-scoped note must render exactly once (on its own row), got ' + rowCount);
    const gameCount = html.split('Game-level note for ' + target.gamePk).length - 1;
    assert(gameCount === 1, 'game-level note must render exactly once as a flagged row, got ' + gameCount);
  });

  dom.window.close();
}

console.log('\n[14] Alert3 regression checks — upcoming scheduled game days & live counter updates');
{
  await check('upcoming scheduled Preview game transitions cleanly to Live without false counter alarms', async () => {
    let phase = 'preview';
    const previewGame = {
      gamePk: 853719,
      officialDate: '2027-03-25',
      gameDate: '2027-03-25T17:10:00Z',
      status: { abstractGameState: 'Preview', codedGameState: 'S', detailedState: 'Scheduled', statusCode: 'S' },
      teams: {
        away: { team: { id: 145, name: 'Chicago White Sox' }, score: null },
        home: { team: { id: 116, name: 'Detroit Tigers' }, score: null },
      },
      review: { away: {}, home: {} },
    };
    const liveGame1 = {
      ...previewGame,
      status: { abstractGameState: 'Live', codedGameState: 'I', detailedState: 'In Progress', statusCode: 'I' },
      teams: {
        away: { team: { id: 145, name: 'Chicago White Sox' }, score: 1 },
        home: { team: { id: 116, name: 'Detroit Tigers' }, score: 0 },
      },
      review: { hasChallenges: false, away: { used: 0, remaining: 1 }, home: { used: 0, remaining: 1 } },
    };
    const liveGame2 = {
      ...liveGame1,
      review: { hasChallenges: true, away: { used: 1, remaining: 0 }, home: { used: 0, remaining: 1 } },
    };
    const upcomingFetch = (url) => {
      const s = String(url);
      if (s.includes('/api/v1/gameStatus')) return routeFetch(url);
      if (s.includes('/schedule?')) {
        const g = phase === 'preview' ? previewGame : (phase === 'live1' ? liveGame1 : liveGame2);
        return Promise.resolve({
          ok: true, status: 200, headers: { get: () => null },
          json: async () => ({ totalGames: 1, dates: [{ date: '2027-03-25', games: [g] }] }),
        });
      }
      if (s.includes('/game/853719/playByPlay')) {
        const plays = phase === 'live2' ? [
          play(5, {
            about: { atBatIndex: 5, halfInning: 'top', inning: 2, isComplete: true, hasReview: true },
            result: { eventType: 'field_out', description: 'White Sox challenged (play at 1st), call on the field was upheld: batter grounds out.', awayScore: 1, homeScore: 0, isOut: true },
            reviewDetails: { isOverturned: false, inProgress: false, reviewType: 'MF', challengeTeamId: 145 },
          }),
        ] : [];
        return Promise.resolve({
          ok: true, status: 200, headers: { get: () => null },
          json: async () => ({ allPlays: plays }),
        });
      }
      if (s.includes('/game/853719/feed/live')) {
        const g = phase === 'live2' ? liveGame2 : liveGame1;
        return Promise.resolve({
          ok: true, status: 200, headers: { get: () => null },
          json: async () => ({
            gameData: {
              review: g.review,
              absChallenges: phase === 'live2'
                ? { hasChallenges: true, away: { usedSuccessful: 0, usedFailed: 1, remaining: 1 }, home: { usedSuccessful: 0, usedFailed: 0, remaining: 2 } }
                : { hasChallenges: false, away: { usedSuccessful: 0, usedFailed: 0, remaining: 2 }, home: { usedSuccessful: 0, usedFailed: 0, remaining: 2 } },
            },
          }),
        });
      }
      return routeFetch(url);
    };
    const upDom = await boot('reviews.html?date=2027-03-25', {
      fetchImpl: upcomingFetch,
      beforeParse(x) { x.localStorage.clear(); },
    });
    await new Promise((r) => setTimeout(r, 450));
    const stUp = upDom.window.ReplayFeed.state;
    assert(stUp.games.length === 1 && stUp.entries.length === 0, 'Preview slate should show 1 game and 0 entries');
    phase = 'live1';
    while (stUp.scanning) await new Promise((r) => setTimeout(r, 40));
    await upDom.window.ReplayFeed.scan();
    await new Promise((r) => setTimeout(r, 150));
    phase = 'live2';
    while (stUp.scanning) await new Promise((r) => setTimeout(r, 40));
    await upDom.window.ReplayFeed.scan();
    await new Promise((r) => setTimeout(r, 150));
    assert(stUp.entries.some((e) => e.gamePk === 853719 && e.review && e.review.code === 'MF'),
      'Live transition must pick up the new manager challenge');
    const regNotes = (stUp.irregularities[853719] || []).filter((n) => /moved backwards/.test(n));
    assert(regNotes.length === 0, 'normal failed manager/ABS challenge must not emit counter regression irregularity: ' + JSON.stringify(regNotes));
    upDom.window.close();
  });
}

console.log('\n[15] latency lanes, live-state capture, alert sound and the separate official-scoring log');
{
  /* --- 15a. GameState.capture / diffSnapshots (pure, no page) --- */
  const gsDom = await boot('reviews.html', { fetchImpl: () => Promise.resolve({ ok: false, status: 404, json: async () => ({}) }) });
  const GS = gsDom.window.GameState;

  await check('G-4: capture() reads the official state fields, including pitch counters and pending rulings', () => {
    const snap = GS.capture({
      gamePk: 823109,
      observedAt: Date.UTC(2026, 8, 15, 23, 12, 47),
      feed: FEED_823109,
    });
    assert(snap.gamePk === 823109, 'gamePk not captured');
    assert(snap.score.away === 3 && snap.score.home === 4, 'score not read: ' + JSON.stringify(snap.score));
    assert(snap.inningLabel === 'Top 8', 'inning label, got ' + snap.inningLabel);
    assert(snap.outs === 1, 'outs, got ' + snap.outs);
    assert(snap.count.balls === 2 && snap.count.strikes === 1, 'count, got ' + JSON.stringify(snap.count));
    assert(snap.batter && snap.batter.name === 'Test Batter', 'batter, got ' + JSON.stringify(snap.batter));
    assert(snap.pitcher && snap.pitcher.name === 'Test Pitcher', 'pitcher, got ' + JSON.stringify(snap.pitcher));
    assert(snap.pitch && snap.pitch.pitcherPitches === null, 'absent official pitch counter must stay null, got ' + JSON.stringify(snap.pitch));
    assert(snap.pitch.paPitches === 0, 'PA pitch count from playEvents, got ' + snap.pitch.paPitches);
    assert(snap.status.code === 'MA', 'status code, got ' + snap.status.code);
    assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(snap.observedAtISO),
      'timestamp must be second-precision ISO, got ' + snap.observedAtISO);
    assert(snap.runners && snap.runners.first && snap.runners.first.id === 621566, 'runner on first not captured');
    assert(snap.pending.length === 1 && snap.pending[0].eventType === 'os_ruling_pending_primary', 'pending ruling not captured');
    assert(snap.reviews.length >= 1, 'play-level reviews not captured');
    assert(snap.officialTimeStamp === '09152026_231245', 'metaData.timeStamp not kept, got ' + snap.officialTimeStamp);
  });

  await check('G-4: pitch counters come from the official player record when published', () => {
    const feed = JSON.parse(JSON.stringify(FEED_823109));
    feed.gameData.players.ID592789.stats.pitching.numberOfPitches = 94;
    const snap = GS.capture({ gamePk: 823109, feed: feed });
    assert(snap.pitch.pitcherPitches === 94, 'official numberOfPitches not read, got ' + snap.pitch.pitcherPitches);
  });

  await check('G-4: diffSnapshots reports material changes and nothing on a first snapshot', () => {
    const a = GS.capture({ gamePk: 823109, feed: FEED_823109 });
    const b = GS.capture({ gamePk: 823109, feed: FEED_823109 });
    assert(GS.diffSnapshots(null, a).length === 0, 'a first snapshot must not invent a before state');
    assert(GS.diffSnapshots(a, b).length === 0, 'identical snapshots must not report changes');
    const moved = JSON.parse(JSON.stringify(FEED_823109));
    moved.liveData.linescore.teams.away.runs = 4;
    moved.liveData.linescore.outs = 2;
    const c = GS.capture({ gamePk: 823109, feed: moved });
    const changes = GS.diffSnapshots(a, c);
    const keys = changes.map((x) => x.key);
    assert(keys.indexOf('score') !== -1 && keys.indexOf('outs') !== -1, 'score/outs change missed: ' + keys.join(','));
    const scoreChange = changes.find((x) => x.key === 'score');
    assert(scoreChange.from.away === 3 && scoreChange.to.away === 4, 'exact before/after wording missing: ' + JSON.stringify(scoreChange));
  });

  await check('G-4: stateLine() is exact official wording (status, inning, outs, count, score, batter/pitcher)', () => {
    const snap = GS.capture({ gamePk: 823109, feed: FEED_823109 });
    const line = GS.stateLine(snap);
    assert(/Manager challenge: Tag play/.test(line), 'detailedState missing: ' + line);
    assert(/Top 8/.test(line) && /1 out/.test(line) && /2-1 count/.test(line) && /3–4/.test(line), 'state line incomplete: ' + line);
    assert(/Test Batter/.test(line) && /Test Pitcher/.test(line), 'batter/pitcher missing: ' + line);
  });

  await check('G-4: data age is measured against metaData.timeStamp, and stays null when absent', () => {
    const observedAt = gsDom.window.MLB.timecodeToMs('09152026_231245') + 1700;
    const snap = GS.capture({ gamePk: 823109, feed: FEED_823109, observedAt: observedAt });
    const age = observedAt - gsDom.window.MLB.timecodeToMs(snap.officialTimeStamp);
    assert(age === 1700, 'age arithmetic wrong: ' + age);
    const bare = GS.capture({ gamePk: 823109, feed: { gameData: { status: { statusCode: 'I' } }, liveData: {} } });
    assert(bare.officialTimeStamp === '', 'absent timestamp must stay empty');
  });

  await check('G-4: timecode conversion is MMDDYYYY_HHMMSS in UTC, both directions', () => {
    const MLB = gsDom.window.MLB;
    const ms = MLB.timecodeToMs('09152026_231245');
    assert(ms === Date.UTC(2026, 8, 15, 23, 12, 45), 'timecode -> ms wrong: ' + ms);
    assert(MLB.tsToTimecode('2026-09-15T23:12:45Z') === '09152026_231245', 'ms -> timecode wrong');
    assert(MLB.tsToTimecode('09152026_231245') === '09152026_231245', 'a timecode must pass through unchanged');
  });

  await check('G-4: the journal records history only when the state actually changed, and reloads', () => {
    const date = '2026-09-15';
    gsDom.window.localStorage.clear();
    const a = GS.capture({ gamePk: 823109, feed: FEED_823109, observedAt: 1000 });
    const b = GS.capture({ gamePk: 823109, feed: FEED_823109, observedAt: 1500 });
    const moved = JSON.parse(JSON.stringify(FEED_823109));
    moved.liveData.linescore.outs = 2;
    const c = GS.capture({ gamePk: 823109, feed: moved, observedAt: 2000 });
    GS.Journal.record(date, a, { matchup: 'SEA @ MIN' });
    GS.Journal.record(date, b, { matchup: 'SEA @ MIN' });
    const rec = GS.Journal.record(date, c, { matchup: 'SEA @ MIN' });
    assert(rec.snapshots.length === 2, 'only state-changing snapshots should be journalled, got ' + rec.snapshots.length);
    const reloaded = GS.Journal.load(date);
    assert(reloaded.games['823109'].latest.outs === 2, 'journal did not survive a reload');
    assert(reloaded.games['823109'].matchup === 'SEA @ MIN', 'matchup label not stored with the record');
  });

  gsDom.window.close();

  /* --- 15b. alert-audio: graceful without Web Audio, always playable on demand --- */
  const audioDom = await boot('reviews.html', { fetchImpl: () => Promise.resolve({ ok: false, status: 404, json: async () => ({}) }) });
  await check('G-5: without Web Audio the cue fails quietly and never throws', () => {
    assert(audioDom.window.AlertAudio.available() === false, 'jsdom has no AudioContext; available() must be false');
    const label = audioDom.window.AlertAudio.test();
    assert(label === null, 'a silent browser must return null, not throw, got ' + label);
    const st = audioDom.window.AlertAudio.state();
    assert(st.durationMs === 3000, 'the cue must be a three-second sound, got ' + st.durationMs);
  });
  await check('G-5: the cue schedules a soft sine bloom inside three seconds (audio graph inspected)', async () => {
    /* jsdom has no Web Audio, so the graph is stubbed and inspected: this
     * proves what is scheduled (oscillator type, frequencies, envelopes,
     * total length), not how it sounds. */
    const scheduled = [];
    const graphDom = await boot('reviews.html', {
      fetchImpl: () => Promise.resolve({ ok: false, status: 404, json: async () => ({}) }),
      beforeParse(win) {
        function node(kind) {
          return {
            kind,
            connect() { return this; },
            disconnect() {},
            gain: {
              value: 0,
              setValueAtTime(v, t) { scheduled.push({ node: kind, param: 'gain.set', v, t }); },
              exponentialRampToValueAtTime(v, t) { scheduled.push({ node: kind, param: 'gain.ramp', v, t }); },
              setTargetAtTime(v, t) { scheduled.push({ node: kind, param: 'gain.target', v, t }); },
            },
            frequency: {
              value: 0,
              setValueAtTime(v, t) { scheduled.push({ node: kind, param: 'freq.set', v, t }); },
              exponentialRampToValueAtTime(v, t) { scheduled.push({ node: kind, param: 'freq.ramp', v, t }); },
            },
            Q: {
              setValueAtTime(v, t) { scheduled.push({ node: kind, param: 'q.set', v, t }); },
              exponentialRampToValueAtTime(v, t) { scheduled.push({ node: kind, param: 'q.ramp', v, t }); },
            },
            delayTime: { value: 0 },
            type: '',
            start(t) { scheduled.push({ node: kind, param: 'start', t }); },
            stop(t) { scheduled.push({ node: kind, param: 'stop', t }); },
          };
        }
        win.AudioContext = class {
          constructor() {
            this.currentTime = 0;
            this.state = 'running';
            this.destination = node('destination');
          }
          createGain() { return node('gain'); }
          createOscillator() { return node('osc'); }
          createBiquadFilter() { return node('filter'); }
          createDelay() { return node('delay'); }
          createWaveShaper() { return node('shaper'); }
          resume() { return Promise.resolve(); }
          suspend() { return Promise.resolve(); }
        };
      },
    });
    const AA = graphDom.window.AlertAudio;
    assert(AA.available() === true, 'the stub must make Web Audio available');
    const label = AA.test();
    assert(label === 'test', 'the cue should report its label, got ' + label);

    const oscStarts = scheduled.filter((x) => x.param === 'start' && x.node === 'osc');
    assert(oscStarts.length >= 6, 'expected a multi-drop raindrop cue, got ' + oscStarts.length + ' oscillators');
    const freqSets = scheduled.filter((x) => x.param === 'freq.set');
    const maxFreq = Math.max.apply(null, freqSets.map((x) => x.v));
    assert(maxFreq <= 1600, 'drops must stay below the harsh band, got ' + maxFreq + ' Hz');
    const stopMax = Math.max.apply(null, scheduled.filter((x) => x.param === 'stop').map((x) => x.t));
    assert(stopMax <= 3.0, 'the cue must not run past three seconds, ends at ' + stopMax.toFixed(2) + ' s');
    const ramps = scheduled.filter((x) => x.param === 'gain.ramp');
    assert(ramps.every((x) => x.v > 0), 'every envelope must decay to an inaudible-but-nonzero floor (no clicks)');
    graphDom.window.close();
  });

  await check('G-5: volume is settable and clamped, cooldown is 2.5 s', () => {
    const AA = audioDom.window.AlertAudio;
    assert(AA.setVolume(2) === 1 && AA.setVolume(-1) === 0, 'volume must clamp to 0..1');
    AA.setVolume(0.34);
    assert(AA.state().cooldownMs === 2500, 'cooldown must be 2500 ms');
  });
  audioDom.window.close();

  /* --- 15c. official-scoring-log: pending open -> resolve, scoring change, persistence --- */
  const scoreDom = await boot('reviews.html', { fetchImpl: () => Promise.resolve({ ok: false, status: 404, json: async () => ({}) }) });
  const OS = scoreDom.window.OfficialScoring;
  const date = '2026-09-15';

  function pendingPlay(atBatIndex, eventType, extra = {}) {
    return Object.assign({
      about: { atBatIndex, inning: 3, halfInning: 'top', isTopInning: true, isComplete: true },
      result: { eventType, description: 'Official Scorer Ruling Pending', awayScore: 1, homeScore: 0 },
      count: { balls: 0, strikes: 0, outs: 1 },
      matchup: { batter: { fullName: 'Test Batter' }, pitcher: { fullName: 'Test Pitcher' } },
      runners: [],
      playEvents: [],
    }, extra);
  }

  const ingest1 = OS.ingest({
    date, gamePk: 823109, matchup: 'SEA @ MIN', plays: [pendingPlay(3, 'os_ruling_pending_primary')],
    observedAt: 1000,
  });
  await check('G-6: an undecided at-bat is logged the second it is observed', () => {
    assert(ingest1.added.length === 1 && ingest1.added[0].kind === 'pending_open', 'pending opening not logged');
    assert(OS.openPending(date).length === 1, 'open pending list should hold it');
    assert(ingest1.added[0].atISO && /\d{2}:\d{2}:\d{2}/.test(ingest1.added[0].atISO), 'event not stamped to the second');
  });

  const ingest2 = OS.ingest({
    date, gamePk: 823109, matchup: 'SEA @ MIN',
    plays: [pendingPlay(3, 'single', { result: { eventType: 'single', description: 'Batter singles to left.', awayScore: 1, homeScore: 0 } })],
    observedAt: 2000,
  });
  await check('G-6: the decision is logged with the exact official wording before and after', () => {
    assert(ingest2.added.some((e) => e.kind === 'pending_resolve'), 'pending resolution not logged: ' +
      JSON.stringify(ingest2.added.map((e) => e.kind)));
    const resolved = ingest2.added.find((e) => e.kind === 'pending_resolve');
    assert(resolved.before.eventType === 'os_ruling_pending_primary', 'before wording missing');
    assert(resolved.after.description === 'Batter singles to left.', 'after wording missing');
    assert(OS.openPending(date).length === 0, 'resolved ruling must leave the open list');
    const opened = OS.events(date).find((e) => e.kind === 'pending_open');
    assert(opened.status === 'closed' && opened.closedAtISO, 'the opening row must be closed, not rewritten');
  });

  const ingest3 = OS.ingest({
    date, gamePk: 823109, matchup: 'SEA @ MIN',
    plays: [pendingPlay(3, 'double', { result: { eventType: 'double', description: 'Batter doubles to left.', awayScore: 2, homeScore: 0 } })],
    observedAt: 3000,
  });
  await check('G-6: a scorer reclassification is logged as a scoring change with both wordings', () => {
    const change = ingest3.added.find((e) => e.kind === 'scoring_change');
    assert(!!change, 'scoring change not logged');
    assert(change.before.eventType === 'single' && change.after.eventType === 'double', 'before/after event types missing');
    assert(/single → double/.test(change.summary), 'summary should show the transition, got ' + change.summary);
    assert(OS.summary(date).scoringChanges === 1, 'summary count wrong');
  });

  await check('G-6: the log is append-only and survives a "refresh" (new page, same storage)', async () => {
    const dump = {};
    for (let i = 0; i < scoreDom.window.localStorage.length; i += 1) {
      const key = scoreDom.window.localStorage.key(i);
      dump[key] = scoreDom.window.localStorage.getItem(key);
    }
    assert(dump['mlbp.scoringlog.' + date], 'nothing written to the scoring log store');
    const reloaded = await boot('reviews.html?date=' + date, {
      fetchImpl: () => Promise.resolve({ ok: false, status: 404, json: async () => ({}) }),
      beforeParse(win) {
        Object.keys(dump).forEach((k) => { try { win.localStorage.setItem(k, dump[k]); } catch (e) { /* ignore */ } });
      },
    });
    await new Promise((r) => setTimeout(r, 300));
    const events = reloaded.window.OfficialScoring.events(date);
    assert(events.length === OS.events(date).length, 'events lost across refresh: ' + events.length);
    assert(reloaded.window.OfficialScoring.summary(date).scoringChanges === 1, 'scoring change lost across refresh');
    const html = text(reloaded.window.document.getElementById('official-scoring'));
    assert(/Official scorer ruling pending/.test(html), 'pending row not rendered after refresh: ' + html.slice(0, 200));
    assert(/Official scoring change/.test(html), 'scoring change not rendered after refresh');
    assert(/Before/.test(html) && /After/.test(html), 'before/after wording not rendered');
    reloaded.window.close();
  });

  await check('G-6: export produces the full log (JSON + CSV)', () => {
    const json = OS.toJSON(date);
    const parsed = JSON.parse(json);
    assert(parsed.events.length >= 3, 'export lost events');
    assert(/statsapi\.mlb\.com/.test(parsed.source), 'export should name its official source');
    const csv = OS.toCSV(date);
    assert(csv.split('\n').length >= 4, 'CSV has no data rows');
    assert(/observed_at_iso/.test(csv.split('\n')[0]), 'CSV header missing ISO column');
  });
  scoreDom.window.close();

  /* --- 15d. the replay feed's three lanes and isolation from the alert path --- */
  const laneDom = await boot('reviews.html', { beforeParse(w) { w.localStorage.clear(); } });
  await new Promise((r) => setTimeout(r, 900));

  await check('G-7: the play lane asks for the lean schedule projection, not the hydrated one', () => {
    const urls = laneDom.__requests || [];
    assert(laneDom.window.ReplayFeed.PLAY_MS === 1000, 'play lane must be 1000 ms');
    assert(laneDom.window.ReplayFeed.STATE_MS === 500, 'state lane must be 500 ms');
    assert(laneDom.window.ReplayFeed.STATUS_SWEEP_MS === 125, 'status sweep must be 125 ms');
    const scheduleUrls = urls.filter((u) => /\/schedule\?/.test(u));
    assert(scheduleUrls.length > 0, 'no schedule request observed');
    assert(scheduleUrls.every((u) => !/hydrate=probablePitcher/.test(u)),
      'the loop must not pull the hydrated schedule: ' + scheduleUrls[0]);
  });

  await check('G-7: the state lane captures a snapshot per live game and renders the monitor', () => {
    const st = laneDom.window.ReplayFeed.state;
    const snap = st.stateSnapshots[823109];
    assert(!!snap, 'no live-state snapshot captured');
    assert(snap.score && snap.score.away === 3, 'captured score wrong: ' + JSON.stringify(snap.score));
    const html = text(laneDom.window.document.getElementById('state-monitor'));
    assert(/Live game state/.test(html), 'state monitor not rendered');
    assert(/SEA|MIN/.test(html), 'state card missing the matchup');
    assert(/captured/.test(html), 'monitor should report how many games are captured');
  });

  await check('G-7: the state journal is written, so a refresh restores the captured state', () => {
    const raw = laneDom.window.localStorage.getItem('mlbp.state.' + laneDom.window.ReplayFeed.state.date);
    assert(!!raw, 'no state journal written');
    const parsed = JSON.parse(raw);
    const rec = parsed.games['823109'];
    assert(rec && rec.latest, 'journal has no latest snapshot for the live game');
  });

  await check('G-7: an alert still fires when the official-scoring log throws (isolation)', async () => {
    const st = laneDom.window.ReplayFeed.state;
    st.entries = st.entries.filter((e) => !(e.review && e.review.code === 'NA'));
    const before = st.entries.length;
    laneDom.window.OfficialScoring.ingest = () => { throw new Error('simulated scoring-log failure'); };
    st.lastChimeAt = 0;
    st.soundOn = true;
    await laneDom.window.ReplayFeed.scan();
    await new Promise((r) => setTimeout(r, 400));
    while (st.scanning) await new Promise((r) => setTimeout(r, 50));
    assert(!!st.officialScoringError, 'the failure should be recorded, not swallowed silently');
    assert(st.lastChimeAt > 0, 'the alert path must keep working when the scoring log fails');
    assert(st.entries.length >= before, 'alert rows must still be tracked');
    assert((st.irregularities[823109] || []).some((n) => /Official scoring log failed/.test(n)),
      'the failure should be flagged on the feed');
    st.soundOn = false;
  });

  await check('G-5: ABS chimes stay silent by default and can be opted in, so every feed row can sound', async () => {
    const st = laneDom.window.ReplayFeed.state;
    assert(st.absChime === false, 'ABS chimes must be off by default');
    const run = async (on) => {
      laneDom.window.ReplayFeed.setAbsChime(on);
      st.entries = st.entries.filter((e) => !(e.review && e.review.isABS));
      st.lastChimeAt = 0;
      st.soundOn = true;
      await laneDom.window.ReplayFeed.scan();
      await new Promise((r) => setTimeout(r, 400));
      while (st.scanning) await new Promise((r) => setTimeout(r, 50));
      const at = st.lastChimeAt;
      st.soundOn = false;
      return at;
    };
    const off = await run(false);
    assert(off === 0 || st.entries.some((e) => e.review && e.review.isABS), 'ABS rows must still be tracked while silent');
    const on = await run(true);
    assert(on > 0, 'opting in must make a new ABS row chime');
    laneDom.window.ReplayFeed.setAbsChime(false);
    laneDom.window.localStorage.removeItem('mlbp.pref.absChime');
  });

  await check('G-7: the sweep detection period measures the interval between sweeps, not zero', () => {
    const st = laneDom.window.ReplayFeed.state;
    st.latency.statusReaction = [];
    st.statusByPk = Object.create(null);   /* forget the cached status so the flip is new again */
    st.lastSweepAt = Date.now() - 250;
    laneDom.window.ReplayFeed.sweep();
    return new Promise((r) => setTimeout(r, 350)).then(() => {
      assert(st.latency.statusReaction.length >= 1,
        'a status flip must produce a detection-period sample');
      const sample = st.latency.statusReaction[st.latency.statusReaction.length - 1];
      assert(sample >= 200, 'detection period must include the sweep interval, got ' + sample + ' ms');
    });
  });

  await check('G-5: the Test button is always available and reports its result', () => {
    const ok = laneDom.window.ReplayFeed.testAlert();
    assert(typeof ok === 'boolean', 'testAlert must report success/failure');
    const line = text(laneDom.window.document.getElementById('status-line'));
    assert(/Alert sound/i.test(line), 'status line should report the sound test: ' + line);
    assert(laneDom.window.ReplayFeed.state.lastChimeAt > 0, 'the test must stamp lastChimeAt');
  });

  await check('G-5: the sound toggle and volume controls exist and persist', () => {
    const doc = laneDom.window.document;
    assert(!!doc.getElementById('sound-test-btn'), 'no Test button');
    assert(!!doc.getElementById('volume-slider'), 'no volume slider');
    const wasOn = laneDom.window.ReplayFeed.state.soundOn;
    if (wasOn) laneDom.window.ReplayFeed.toggleSound();
    laneDom.window.ReplayFeed.toggleSound();
    assert(laneDom.window.ReplayFeed.state.soundOn === true, 'toggle did not enable sound');
    assert(laneDom.window.localStorage.getItem('mlbp.pref.sound') === '1', 'sound preference not persisted');
    const v = laneDom.window.ReplayFeed.setVolume(55);
    assert(Math.abs(v - 0.55) < 1e-9, 'volume not applied: ' + v);
    assert(laneDom.window.localStorage.getItem('mlbp.pref.volume') === '0.55', 'volume not persisted');
    laneDom.window.ReplayFeed.state.soundOn = false;
    laneDom.window.localStorage.setItem('mlbp.pref.sound', '0');
  });

  laneDom.window.close();
}

function __setDate(dom) {
  const picker = dom.window.document.getElementById('date-picker');
  if (picker) {
    picker.value = '2026-09-15';
    picker.dispatchEvent(new dom.window.Event('change'));
  }
}

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log(' - ' + f));
  process.exitCode = 1;
}
