/* ============================================================================
 * reviews-feed.js — the all-games Replay Feed (reviews.html)
 *
 * Three poll lanes, each sized for what it carries, so the fastest-moving
 * signal never queues behind the biggest payload:
 *
 *   1. STATUS  (125 ms, one lean slate request)
 *        GET /api/v1/schedule?fields=…gamePk,status… — no hydrations.
 *        MLB flips `status.statusCode` the instant a review is *called*.
 *   2. STATE   (500 ms, per live game, ~ a few KB)
 *        GET /api/v1.1/game/{gamePk}/feed/live?fields=…  — linescore, count,
 *        outs, batter, pitcher, official pitch counters, review/ABS counters.
 *        Every response is captured by game-state.js with a to-the-second
 *        timestamp and kept in a refresh-proof journal.
 *   3. PLAY    (1000 ms, per live game)
 *        GET /api/v1/game/{gamePk}/playByPlay?fields=…  — reviewDetails,
 *        os_ruling_pending_*, and the classification diff that reveals an
 *        official scoring change.
 *
 * A status flip, a score change or a new at-bat also fires an immediate
 * out-of-band play fetch, so the 1 s play lane is only the worst case.
 *
 * Everything tracked is rendered as a live, chat-style feed:
 *   - manager challenges (M*), umpire/crew-chief reviews (N*), instant replay
 *     (IH), boundary calls
 *   - ABS pitch challenges (MJ/NJ) with count before/after
 *   - official-scorer pending rulings (os_ruling_pending_*)
 *   - official scoring changes, detected by diffing each completed play's
 *     classification between polls
 *
 * Two persistence stores, deliberately independent:
 *   - feed-log.js            every alert row (localStorage + optional server)
 *   - official-scoring-log.js official-scorer pending/rulings ONLY, its own
 *                             30-day store and its own render, so a change to
 *                             the scoring log can never disturb an alert
 *   - game-state.js Journal  the captured live game state per date
 * ==========================================================================*/
(function (global) {
  'use strict';

  var MLB = global.MLB;
  var UI = global.UI;
  var Reviews = global.Reviews;
  var FeedLog = global.FeedLog;
  var GameState = global.GameState;
  var AlertAudio = global.AlertAudio;
  var OfficialScoring = global.OfficialScoring;

  /* Cadences. See the header comment: lanes, not one loop. */
  var PLAY_MS = 1000;
  var STATE_MS = 500;
  var STATUS_SWEEP_MS = 125;
  var FETCH_CONCURRENCY = 8;
  var FINAL_GRACE_MS = 30 * 60 * 1000;
  var MAX_STATE_ENTRIES = 400;
  var RESTORE_GAP_MS = 15000;

  /* Schedule projection for the play lane: status + teams + score, no
   * hydrations. The old loop pulled the fully hydrated schedule (probable
   * pitchers, linescore, decisions, review) every cycle; this is the same
   * routing decision from a payload roughly two orders of magnitude smaller. */
  var SCHEDULE_FIELDS = 'dates,games,gamePk,season,status,abstractGameState,codedGameState,' +
    'detailedState,statusCode,reason,startTimeTBD,abstractGameCode,teams,away,home,team,id,name,' +
    'abbreviation,score,gameDate,officialDate,isTie,doubleHeader,venue';

  var PLAYBYPLAY_FIELDS = 'allPlays,about,atBatIndex,hasReview,isComplete,inning,halfInning,isTopInning,isScoringPlay,' +
    'result,eventType,description,isOut,rbi,awayScore,homeScore,count,balls,strikes,outs,matchup,batter,id,fullName,pitcher,' +
    'playEvents,details,call,reviewDetails,isOverturned,inProgress,reviewType,challengeTeamId,runners,' +
    'isScoringEvent,playIndex,movement,index,isPitch,pitchNumber,type,startTime,endTime,hasOutcome';

  var COUNTERS_FIELDS = 'gameData,review,absChallenges,hasChallenges,away,home,used,remaining,usedSuccessful,usedFailed';

  var FILTERS = [
    { id: 'all', label: 'All' },
    { id: 'abs', label: 'ABS' },
    { id: 'challenges', label: 'Challenges' },
    { id: 'reviews', label: 'Reviews' },
    { id: 'boundary', label: 'Boundary Calls' },
    { id: 'under', label: 'Under Review' },
    { id: 'risk', label: '⚠️ Runs at Risk' },
    { id: 'scoring', label: '✏️ Scoring Changes' },
    { id: 'state', label: '🕒 Live State' },
  ];

  var state = {
    date: MLB.todayISO(),
    dateSeq: 0,
    filter: 'all',
    games: [],
    log: null,
    entries: [],
    stateEntries: [],
    snapshots: Object.create(null),
    irregularities: Object.create(null),
    finalSeen: Object.create(null),
    nextDue: Object.create(null),
    nextStateAt: Object.create(null),
    statusByPk: Object.create(null),
    lastSweepAt: 0,
    stateSnapshots: Object.create(null),
    stateRestored: Object.create(null),
    scanning: false,
    stateBusy: false,
    scanError: null,
    soundOn: false,
    absChime: false,
    notifyOn: false,
    lastChimeAt: 0,
    alertCount: 0,
    lastAlert: null,
    latency: { dataAge: [], statusReaction: [], last: null },
    lastScanAt: 0,
    lastStateAt: 0,
    timers: { scan: null, sweep: null, countdown: null, state: null },
    nextScanAt: 0,
    lastRenderSignature: '',
    counterCache: Object.create(null),
    absFetchedRevCount: Object.create(null),
    lastGameDate: undefined,
    lookingForRecent: false,
    throttle: 1,
    stateAttempted: Object.create(null),
    journal: null,
    officialScoring: null,
    officialScoringError: null,
    scoringSummary: null,
    scoringInFlight: Object.create(null),
  };

  function $(id) { return document.getElementById(id); }

  function statusLine(text, isError) {
    var el = $('status-line');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('is-error', !!isError);
  }

  function fmtSeconds(ms) {
    if (!ms) return '';
    try { return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
    catch (e) { return ''; }
  }

  function urlDate() {
    try {
      var params = new URLSearchParams(global.location.search || '');
      var d = params.get('date');
      return MLB.isValidISODate(d) ? d : null;
    } catch (e) { return null; }
  }

  /* Keep the address bar in step with the selected date (shareable links). */
  function syncUrl() {
    try {
      var url = new URL(global.location.href);
      if (url.searchParams.get('date') === state.date) return;
      url.searchParams.set('date', state.date);
      global.history.replaceState(null, '', url.toString());
    } catch (e) { /* ignore */ }
  }

  function syncNav() {
    var picker = $('date-picker');
    if (picker && picker.value !== state.date) picker.value = state.date;
    var label = $('date-label');
    if (label) label.textContent = MLB.formatDateLabel(state.date);
    var backLink = document.querySelector('a.btn[href^="index.html"]');
    if (backLink) backLink.setAttribute('href', 'index.html?date=' + encodeURIComponent(state.date));
    syncUrl();
  }

  function parseDate() {
    var fromUrl = urlDate();
    if (fromUrl) return fromUrl;
    var input = $('date-picker');
    var value = input && input.value;
    return MLB.isValidISODate(value) ? value : MLB.todayISO();
  }

  /* ------------------------------------------------------------ log helpers */

  function upsertEntry(entry) {
    if (!entry || !entry.id) return false;
    var index = -1;
    for (var i = 0; i < state.entries.length; i += 1) {
      if (state.entries[i].id === entry.id) { index = i; break; }
    }
    var now = Date.now();
    if (index === -1) {
      entry.firstSeen = entry.firstSeen || now;
      entry.lastSeen = now;
      state.entries.push(entry);
      return true;
    }
    var prev = state.entries[index];
    var merged = Object.assign({}, prev, entry);
    merged.firstSeen = prev.firstSeen || now;
    merged.lastSeen = now;
    if (prev.scoreTracker && entry.scoreTracker) {
      merged.scoreTracker = Object.assign({}, prev.scoreTracker, entry.scoreTracker);
      if (prev.scoreTracker.before && !entry.scoreTracker.before) {
        merged.scoreTracker.before = prev.scoreTracker.before;
      }
    }
    state.entries[index] = merged;
    return false;
  }

  /* Captured live-state changes live beside the alert rows but never inside
   * them: they cannot re-render or re-chime an alert row. */
  function addStateEntry(entry) {
    if (!entry || !entry.id) return false;
    var exists = state.stateEntries.some(function (e) { return e.id === entry.id; });
    if (exists) return false;
    state.stateEntries.push(entry);
    state.stateEntries.sort(function (a, b) { return (b.at || 0) - (a.at || 0); });
    if (state.stateEntries.length > MAX_STATE_ENTRIES) {
      state.stateEntries = state.stateEntries.slice(0, MAX_STATE_ENTRIES);
    }
    return true;
  }

  function noteIrregularity(gamePk, text) {
    if (!gamePk || !text) return;
    var list = state.irregularities[gamePk] || [];
    if (list.indexOf(text) === -1) {
      list.push(text);
      state.irregularities[gamePk] = list.slice(-30);
    }
  }

  function persist(expectedSeq, expectedDate) {
    if (expectedSeq !== undefined && expectedSeq !== state.dateSeq) return;
    if (expectedDate !== undefined && expectedDate !== state.date) return;
    if (!state.log) state.log = FeedLog.emptyPayload(state.date);
    state.log.entries = state.entries.slice();
    state.log.snapshots = state.snapshots;
    state.log.irregularities = state.irregularities;
    state.log.savedAt = Date.now();
    FeedLog.save(state.date, state.log);
  }

  function adoptLog(log) {
    if (!log) return;
    if (log.date && MLB.isValidISODate(log.date) && log.date !== state.date) return;
    state.log = log;
    state.entries = Array.isArray(log.entries)
      ? log.entries.filter(function (e) {
          return !e || !e.officialDate || e.officialDate === state.date;
        })
      : [];
    state.snapshots = log.snapshots || Object.create(null);
    state.irregularities = log.irregularities || Object.create(null);
    /* Restored rows were not observed live: pre-mark runs-at-risk rows so the
     * warning state stays visible but the chime does not fire on restore. */
    state.entries.forEach(function (e) {
      if (e && e.review && e.review.runsAtRiskCount > 0) e.warned = true;
    });
  }

  /* ------------------------------------------------------------- scan cycle */

  function flattenGames(payload) {
    var out = [];
    ((payload && payload.dates) || []).forEach(function (d) {
      (d.games || []).forEach(function (g) { out.push(g); });
    });
    return out;
  }

  function teamsOf(game) {
    return {
      away: {
        id: game.teams && game.teams.away && game.teams.away.team ? game.teams.away.team.id : null,
        name: game.teams && game.teams.away && game.teams.away.team ? game.teams.away.team.name : '',
      },
      home: {
        id: game.teams && game.teams.home && game.teams.home.team ? game.teams.home.team.id : null,
        name: game.teams && game.teams.home && game.teams.home.team ? game.teams.home.team.name : '',
      },
    };
  }

  function finalGraceDelay(finalFirstSeen, elapsed) {
    if (elapsed < 2 * 60 * 1000) return 1000;
    if (elapsed < 5 * 60 * 1000) return 2500;
    return 15000;
  }

  function shouldFetch(game, now) {
    var status = (game.status && game.status.abstractGameState) || '';
    var pk = game.gamePk;
    if (status === 'Live') {
      state.nextDue[pk] = now + PLAY_MS;
      return true;
    }
    if (status === 'Final') {
      if (!state.finalSeen[pk]) state.finalSeen[pk] = now;
      var elapsed = now - state.finalSeen[pk];
      if (elapsed > FINAL_GRACE_MS) return false;
      var due = state.nextDue[pk] || 0;
      if (now < due) return false;
      state.nextDue[pk] = now + finalGraceDelay(state.finalSeen[pk], elapsed);
      return true;
    }
    return false;
  }

  function shouldPollState(game, now) {
    var status = (game.status && game.status.abstractGameState) || '';
    if (status !== 'Live') {
      /* One closing snapshot when a game ends (so the "after" state is
       * captured), and one opening snapshot for a game this page has never
       * seen — then this game leaves the state lane entirely. */
      if (status === 'Final' && !state.stateAttempted[game.gamePk]) {
        state.stateAttempted[game.gamePk] = true;
        state.nextStateAt[game.gamePk] = 0;
        return true;
      }
      if (status === 'Final' && state.stateSnapshots[game.gamePk] &&
          state.stateSnapshots[game.gamePk].status &&
          state.stateSnapshots[game.gamePk].status.abstract !== 'Final') {
        state.nextStateAt[game.gamePk] = 0;
        return true;
      }
      return false;
    }
    var due = state.nextStateAt[game.gamePk] || 0;
    if (now < due) return false;
    state.nextStateAt[game.gamePk] = now + STATE_MS * state.throttle;
    return true;
  }

  function fetchGame(game) {
    var prevCount = state.absFetchedRevCount[game.gamePk];
    var status = (game.status && game.status.abstractGameState) || '';
    var pbpPromise = MLB.playByPlay(game.gamePk, { fields: PLAYBYPLAY_FIELDS, retries: 0 });
    var countersPromise = (prevCount === undefined || status === 'Live')
      ? MLB.gameFeed(game.gamePk, { fields: COUNTERS_FIELDS, retries: 0 }).catch(function () { return null; })
      : Promise.resolve(null);
    return Promise.all([pbpPromise, countersPromise])
      .then(function (parts) {
        return { game: game, payload: parts[0], countersPayload: parts[1] };
      })
      .catch(function (err) {
        return { game: game, payload: null, countersPayload: null, error: err };
      });
  }

  function runLimited(items, limit, worker) {
    var index = 0;
    var active = 0;
    return new Promise(function (resolve) {
      if (!items.length) { resolve(); return; }
      function next() {
        if (index >= items.length && active === 0) { resolve(); return; }
        while (active < limit && index < items.length) {
          var item = items[index];
          index += 1;
          active += 1;
          worker(item).then(function () {
            active -= 1;
            next();
          });
        }
      }
      next();
    });
  }

  /* ---------------------------------------------------------------- latency */

  /**
   * Two different measurements, kept apart on purpose:
   *   dataAge   how old the payload already was when this page received it,
   *             measured against the feed's own metaData.timeStamp. Only
   *             sampled for LIVE games (a Final feed stops updating, so its
   *             age would grow without meaning).
   *   status    detection period of the status sweep: the gap between the
   *             sweep that last completed and the one that first saw the flip
   *             (the sweep interval plus one round trip). No finer client-side
   *             measurement is honest without a server clock.
   */
  function noteLatency(sample) {
    if (!sample || typeof sample.ms !== 'number' || !isFinite(sample.ms)) return;
    if (sample.ms < -60000 || sample.ms > 10 * 60 * 1000) return;  /* reject bogus clocks */
    state.latency.last = sample;
    var bucket = sample.lane === 'state' ? state.latency.dataAge : state.latency.statusReaction;
    bucket.push(sample.ms);
    if (bucket.length > 120) bucket.shift();
  }

  function percentile(list, p) {
    if (!list.length) return null;
    var sorted = list.slice().sort(function (a, b) { return a - b; });
    var idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
    return sorted[idx];
  }

  function latencySummary() {
    var age = state.latency.dataAge || [];
    var react = state.latency.statusReaction || [];
    return {
      last: state.latency.last,
      count: age.length,
      median: percentile(age, 50),
      p90: percentile(age, 90),
      statusMedian: percentile(react, 50),
      statusCount: react.length,
    };
  }

  /* Data age = how old the payload we just received already was, measured
   * against the feed's own `metaData.timeStamp` (the API's last update time).
   * Nothing is estimated: when the payload carries no timestamp, no number is
   * shown. MLB's own `metaData.wait` / `logicWait` (seconds) are reported
   * beside it as the server-side pipeline delay. */
  function measureAge(snapshot, observedAt) {
    if (!snapshot) return null;
    var stamp = MLB.timecodeToMs(snapshot.officialTimeStamp);
    if (stamp === null) {
      var iso = Date.parse(snapshot.officialTimeStamp || '');
      stamp = isNaN(iso) ? null : iso;
    }
    if (stamp === null) return null;
    var age = observedAt - stamp;
    return { ageMs: age, pipelineMs: ((snapshot.serverWait || 0) + (snapshot.serverLogicWait || 0)) * 1000 };
  }

  /* ------------------------------------------------------- state lane (500 ms) */

  function ingestState(result, expectedSeq, expectedDate) {
    if (expectedSeq !== undefined && expectedSeq !== state.dateSeq) return;
    if (expectedDate !== undefined && expectedDate !== state.date) return;
    if (!result || !result.payload) return;
    var game = result.game;
    var observedAt = result.observedAt || Date.now();
    var teams = teamsOf(game);
    var snap = GameState.capture({
      gamePk: game.gamePk,
      feed: result.payload,
      observedAt: observedAt,
      lane: 'state',
      url: result.url || '',
      officialDate: game.officialDate || state.date,
    });
    if (!snap || snap.gamePk === null) return;

    var age = measureAge(snap, observedAt);
    var isLive = snap.status && snap.status.abstract === 'Live';
    if (age && isLive) {
      noteLatency({ ms: age.ageMs, pk: snap.gamePk, at: observedAt, lane: 'state', pipelineMs: age.pipelineMs });
    }
    snap.dataAgeMs = age ? age.ageMs : null;
    snap.pipelineMs = age ? age.pipelineMs : null;

    var previous = state.stateSnapshots[snap.gamePk] || null;
    var changes = GameState.diffSnapshots(previous, snap);
    state.stateSnapshots[snap.gamePk] = snap;
    snap.final = (snap.status && snap.status.abstract === 'Final') === true;

    var matchup = UI.abbr(teams.away) + ' @ ' + UI.abbr(teams.home);

    /* Persist the capture (survives a refresh) and remember when it was seen. */
    try {
      state.journal = GameState.Journal.record(state.date, snap, { matchup: matchup });
    } catch (e) { /* a full localStorage must never break the live lane */ }

    changes.forEach(function (change) {
      addStateEntry({
        id: snap.gamePk + ':' + change.key + ':' + observedAt,
        kind: 'state',
        gamePk: snap.gamePk,
        matchupLabel: matchup,
        teams: teams,
        at: observedAt,
        atISO: GameState.isoToSec(observedAt),
        field: change.key,
        label: change.label,
        from: change.from,
        to: change.to,
        snapshot: snap,
      });
    });

    /* A new score, a new at-bat or a status flip is worth a play fetch right
     * away instead of waiting for the play lane. */
    var urgent = changes.some(function (c) {
      return c.key === 'status' || c.key === 'score' || c.key === 'atBat' || c.key === 'event' || c.key === 'pending';
    });
    if (urgent && !state.scanning) {
      fetchGame(game).then(function (playResult) {
        playResult.observedAt = Date.now();
        ingestGame(playResult, expectedSeq, expectedDate);
        persist(expectedSeq, expectedDate);
        renderIfChanged();
        updateChrome();
      });
    }
  }

  function stateCycle() {
    if (document.hidden || state.stateBusy) return;
    var seq = state.dateSeq;
    var date = state.date;
    var now = Date.now();
    var live = state.games.filter(function (g) { return shouldPollState(g, now); });
    if (!live.length) return;
    state.stateBusy = true;
    runLimited(live, FETCH_CONCURRENCY, function (game) {
      if (seq !== state.dateSeq || date !== state.date) return Promise.resolve();
      var url = MLB.API_ROOT + '/v1.1/game/' + game.gamePk + '/feed/live?fields=' + encodeURIComponent(GameState.STATE_FIELDS);
      return MLB.gameFeed(game.gamePk, { fields: GameState.STATE_FIELDS, retries: 0 })
        .then(function (payload) {
          ingestState({ game: game, payload: payload, observedAt: Date.now(), url: url }, seq, date);
        })
        .catch(function () { /* the play lane owns error reporting */ });
    }).then(function () {
      if (seq !== state.dateSeq || date !== state.date) return;
      state.stateBusy = false;
      state.lastStateAt = Date.now();
      renderIfChanged();
      updateChrome();
    });
  }

  /* --------------------------------------------------------- play lane (1 s) */

  function ingestGame(result, expectedSeq, expectedDate) {
    if (expectedSeq !== undefined && expectedSeq !== state.dateSeq) return;
    if (expectedDate !== undefined && expectedDate !== state.date) return;
    if (!result || !result.payload) {
      if (result && result.error && !(result.error && result.error.quiet)) {
        state.scanError = result.error;
      }
      return;
    }
    var game = result.game;
    var plays = Reviews.playsOf(result.payload);
    var teams = teamsOf(game);
    var meta = { gamePk: game.gamePk, teams: teams, feed: result.payload };
    var observedAt = Date.now();
    var observedFor = {
      observedAt: observedAt,
      observedISO: GameState.isoToSec(observedAt),
      matchupLabel: UI.abbr(teams.away) + ' @ ' + UI.abbr(teams.home),
      teams: teams,
    };

    /* ---- official scoring log (separate module, separate store) ---- */
    try {
      state.officialScoring = OfficialScoring.ingest({
        date: state.date,
        gamePk: game.gamePk,
        matchup: observedFor.matchupLabel,
        plays: plays,
        observedAt: observedAt,
        status: (game.status && game.status.detailedState) || '',
        url: 'https://statsapi.mlb.com/api/v1/game/' + game.gamePk + '/playByPlay',
      });
      state.officialScoringError = null;
    } catch (err) {
      /* Never allowed to disturb the alert path. */
      state.officialScoringError = err;
      noteIrregularity(game.gamePk, 'Official scoring log failed for this poll (' +
        (err && err.message ? err.message : 'error') + ') — alerts continue.');
    }

    /* ---- reviews ---- */
    var reviews = Reviews.extractReviews(plays, meta);
    reviews.forEach(function (review) {
      var existing = state.entries.find(function (e) { return e.id === review.id; });
      var before = existing && existing.scoreTracker && existing.scoreTracker.before ? existing.scoreTracker.before : null;

      var scoreTracker = {
        before: before,
        possible: null,
        actual: null,
      };

      if (review.inProgress) {
        scoreTracker.before = review.score || before;
      } else {
        scoreTracker.actual = review.scoreAfter || null;
        if (!scoreTracker.before) {
          noteIrregularity(game.gamePk, 'Before-review score was not observed for ' + review.id + ' (page opened after the ruling).');
        }
      }
      if (scoreTracker.before && review.runsAtRiskCount > 0) {
        scoreTracker.possible = {
          away: scoreTracker.before.away,
          home: scoreTracker.before.home,
        };
        scoreTracker.possible[review.battingSide] = Math.max(0, scoreTracker.possible[review.battingSide] - review.runsAtRiskCount);
      }

      var entry = Object.assign({}, observedFor, {
        id: review.id,
        kind: 'review',
        gamePk: game.gamePk,
        review: review,
        scoreTracker: scoreTracker,
        firstSeenLabel: MLB.formatGameTime(game.gameDate),
      });

      var isNew = upsertEntry(entry);
      entry = state.entries.find(function (e) { return e.id === entry.id; }) || entry;

      /* Routine ABS pitch challenges are silent unless the operator opted in
       * with the "chime ABS" control, so every event they care about sounds. */
      if (isNew && (!review.isABS || state.absChime)) chime(review.isABS ? 'abs' : 'review');
      if (review.runsAtRiskCount > 0 && !entry.warned) {
        entry.warned = true;
        chime('risk');
        notifyRunAtRisk(review, teams);
      }
    });

    /* ---- official-scorer pending rulings (alert row + separate log) ---- */
    var pending = Reviews.pendingRulings(plays, meta);
    pending.forEach(function (row) {
      var isNewPending = upsertEntry(Object.assign({}, observedFor, {
        id: row.id,
        kind: 'pending',
        gamePk: game.gamePk,
        pending: row,
        review: {
          typeLabel: 'Official Scorer Ruling Pending',
          reason: row.eventType === 'os_ruling_pending_primary' ? 'Primary event ruling pending' : 'Prior event ruling pending',
          inningLabel: row.inningLabel,
          description: row.description,
          batter: { name: row.batter },
          pitcher: { name: row.pitcher },
          outcome: 'Pending',
          isABS: false,
          isBoundary: false,
          runsAtRiskCount: 0,
          family: 'pending',
        },
      }));
      if (isNewPending) chime('pending');
    });

    /* ---- official scoring changes ---- */
    var snapshot = Reviews.snapshotPlays(plays);
    var previous = state.snapshots[game.gamePk];
    var diff = Reviews.diffSnapshots(previous, snapshot);
    state.snapshots[game.gamePk] = snapshot;

    diff.changes.forEach(function (change) {
      var isNewChange = upsertEntry(Object.assign({}, observedFor, {
        id: game.gamePk + ':' + change.atBatIndex + ':scoring-change',
        kind: 'scoring_change',
        gamePk: game.gamePk,
        change: change,
        review: {
          typeLabel: 'Official Scoring Change',
          reason: '',
          inningLabel: change.inningLabel,
          description: 'Initial call: ' + (change.from.description || '') + ' → Final: ' + (change.to.description || ''),
          batter: { name: change.batter },
          pitcher: { name: '' },
          outcome: 'Reclassified',
          isABS: false,
          isBoundary: false,
          runsAtRiskCount: 0,
          family: 'scoring',
        },
      }));
      if (isNewChange) chime('scoring');
      if (state.log) {
        state.log.grace = state.log.grace || {};
        state.log.grace[game.gamePk] = Date.now();
      }
    });

    diff.edits.forEach(function (edit) {
      noteIrregularity(game.gamePk, 'Play ' + edit.atBatIndex + ' edited without reclassification (' +
        edit.inningLabel + ') — flagged, not corrected.');
    });
    diff.vanished.forEach(function (gone) {
      noteIrregularity(game.gamePk, 'Play ' + gone.atBatIndex + ' (' + gone.inningLabel +
        ') disappeared from the payload after being observed — flagged, not corrected.');
    });

    /* ---- counter regressions & official MGR / ABS counters ---- */
    state.counterCache = state.counterCache || Object.create(null);
    var prevCached = state.counterCache[game.gamePk] || null;
    var gdCounters = (result.countersPayload && result.countersPayload.gameData) || null;
    var rawMgr = (gdCounters && gdCounters.review) || result.payload.review || (game.review || null);
    var rawAbs = (gdCounters && gdCounters.absChallenges) || result.payload.absChallenges || null;
    var reviewCounters = Reviews.managerCounters(rawMgr) || (prevCached && prevCached.manager) || null;
    var absCounters = Reviews.absCounters(rawAbs) || (prevCached && prevCached.abs) || null;
    state.absFetchedRevCount[game.gamePk] = reviews.length;

    var regression = Reviews.counterRegression(prevCached, {
      manager: reviewCounters, abs: absCounters,
    });
    if (regression) {
      regression.forEach(function (note) {
        noteIrregularity(game.gamePk, 'Official counter ' + note + ' — flagged, not corrected.');
      });
    }
    state.counterCache[game.gamePk] = {
      manager: reviewCounters,
      abs: absCounters,
      awayAbbr: UI.abbr(teams.away),
      homeAbbr: UI.abbr(teams.home),
    };
  }

  function scan() {
    if (state.scanning) return;
    if (document.hidden) { scheduleScan(1000); return; }
    var scanSeq = state.dateSeq;
    var scanDate = state.date;
    state.scanning = true;
    state.nextScanAt = Date.now() + PLAY_MS;

    /* The lean slate projection: the loop only needs to know what to fetch. */
    MLB.schedule(scanDate, { hydrate: '', fields: SCHEDULE_FIELDS, ttl: 0, retries: 0 })
      .then(function (payload) {
        if (scanSeq !== state.dateSeq || scanDate !== state.date) return null;
        state.games = flattenGames(payload);
        var now = Date.now();
        var due = state.games.filter(function (g) { return shouldFetch(g, now); });
        state.scanError = null;
        if (!due.length) {
          updateChrome();
          renderIfChanged();
          return null;
        }
        return runLimited(due, FETCH_CONCURRENCY, function (game) {
          if (scanSeq !== state.dateSeq || scanDate !== state.date) return Promise.resolve();
          return fetchGame(game).then(function (result) {
            ingestGame(result, scanSeq, scanDate);
          });
        }).then(function () {
          notesThrottle(null);
          if (scanSeq !== state.dateSeq || scanDate !== state.date) return;
          persist(scanSeq, scanDate);
          renderIfChanged();
          updateChrome();
        });
      })
      .catch(function (err) {
        if (scanSeq !== state.dateSeq || scanDate !== state.date) return;
        state.scanError = err;
        notesThrottle(err);
        updateChrome();
      })
      .then(function () {
        if (scanSeq !== state.dateSeq || scanDate !== state.date) return;
        state.scanning = false;
        state.lastScanAt = Date.now();
        scheduleScan(PLAY_MS * state.throttle);
      });
  }

  /**
   * Adaptive lane throttle. Three lanes polling every live game is a lot of
   * requests; if MLB answers 429 the lanes slow down (x2 per hit, up to x6)
   * instead of each request being silently dropped for the whole quiet window.
   * A clean cycle decays the factor back toward 1.
   */
  function notesThrottle(err) {
    if (err && (err.status === 429 || err.quiet)) {
      state.throttle = Math.min(6, Math.max(2, state.throttle * 2));
      return state.throttle;
    }
    if (!err && state.throttle > 1) {
      state.throttle = Math.max(1, state.throttle - 0.5);
    }
    return state.throttle;
  }

  function scheduleScan(delay) {
    clearTimeout(state.timers.scan);
    state.nextScanAt = Date.now() + delay;
    state.timers.scan = setTimeout(scan, delay);
  }

  /**
   * 125 ms official status sweep. One lean request covers the whole slate; it
   * catches a review the moment MLB flips `status.statusCode`, which happens
   * when the review is *called*, before any play text exists.
   */
  function sweep() {
    if (document.hidden) return;
    var sweepSeq = state.dateSeq;
    var sweepDate = state.date;
    if (!state.games.some(function (g) { return g.status && g.status.abstractGameState === 'Live'; })) return;
    /* Detection period = from the previous sweep to the one that saw the flip.
     * That is the real cost of this lane: the sweep interval plus one round
     * trip. Nothing shorter is measurable client-side without a server clock. */
    var sweepStartedAt = Date.now();
    MLB.slateStatus(sweepDate).then(function (payload) {
      if (sweepSeq !== state.dateSeq || sweepDate !== state.date) return;
      var games = flattenGames(payload);
      games.forEach(function (g) {
        var review = Reviews.statusReview(g.status);
        var prev = state.statusByPk[g.gamePk];
        var nextKey = review ? review.code + '|' + review.reason : '';
        if (prev === nextKey) return;
        state.statusByPk[g.gamePk] = nextKey;
        /* Refresh the slate entry so the play lane sees the new status too. */
        var known = state.games.filter(function (x) { return x.gamePk === g.gamePk; })[0];
        if (known && g.status) known.status = g.status;
        var target = known || g;
        var detectedAt = Date.now();
        noteLatency({
          ms: detectedAt - (state.lastSweepAt || detectedAt),
          pk: g.gamePk, at: detectedAt, lane: 'status',
        });
        /* Out-of-band state + play fetch: don't wait for either lane. */
        MLB.gameFeed(g.gamePk, { fields: GameState.STATE_FIELDS, retries: 0 })
          .then(function (statePayload) {
            if (sweepSeq !== state.dateSeq || sweepDate !== state.date) return null;
            ingestState({
              game: target, payload: statePayload, observedAt: Date.now(),
              url: MLB.API_ROOT + '/v1.1/game/' + g.gamePk + '/feed/live',
            }, sweepSeq, sweepDate);
            return null;
          })
          .catch(function () { return null; });
        fetchGame(target).then(function (result) {
          if (sweepSeq !== state.dateSeq || sweepDate !== state.date) return;
          result.observedAt = Date.now();
          ingestGame(result, sweepSeq, sweepDate);
          persist(sweepSeq, sweepDate);
          renderIfChanged();
          updateChrome();
        });
      });
    }).catch(function () { /* the scan owns error reporting */ })
      .then(function () {
        /* Only a completed sweep can anchor the next detection period. */
        if (sweepSeq === state.dateSeq && sweepDate === state.date) state.lastSweepAt = sweepStartedAt;
      });
  }

  /* ---------------------------------------------------------------- alerts */

  /**
   * chime(kind) — one alert sound for the whole page, rendered by alert-audio.js
   * (a three-second raindrop bloom). The cooldown is enforced here so a burst of
   * simultaneous events is one sound, and `lastChimeAt` is stamped whenever a
   * cue is requested so "did it alert?" is observable even in a browser that
   * blocks audio.
   */
  function chime(kind) {
    if (!state.soundOn) return false;
    var now = Date.now();
    if (now - state.lastChimeAt < AlertAudio.COOLDOWN_MS) return false;
    state.lastChimeAt = now;
    state.alertCount += 1;
    var label = null;
    try { label = AlertAudio.play(kind); } catch (e) { label = null; }
    state.lastAlert = { kind: kind, at: now, label: label, audible: !!label };
    return true;
  }

  function notifyRunAtRisk(review, teams) {
    if (!state.notifyOn) return;
    if (typeof global.Notification !== 'function') return;
    if (global.Notification.permission !== 'granted') return;
    try {
      var title = '⚠️ Run at risk — ' + UI.abbr(teams.away) + ' @ ' + UI.abbr(teams.home);
      var body = review.typeLabel + (review.reason ? ' (' + review.reason + ')' : '') +
        ' · ' + review.inningLabel + ' — ' + review.runsAtRiskCount + ' run(s) credited to the reviewed play.';
      new global.Notification(title, { body: body, tag: review.id });
    } catch (e) { /* ignore */ }
  }

  function loadPref(key, fallback) {
    try {
      var raw = global.localStorage.getItem('mlbp.pref.' + key);
      return raw === null ? fallback : raw === '1';
    } catch (e) { return fallback; }
  }

  function savePref(key, value) {
    try { global.localStorage.setItem('mlbp.pref.' + key, value ? '1' : '0'); } catch (e) { /* ignore */ }
  }

  function loadVolume() {
    try {
      var raw = global.localStorage.getItem('mlbp.pref.volume');
      var v = raw === null ? NaN : Number(raw);
      return isFinite(v) ? v : null;
    } catch (e) { return null; }
  }

  function saveVolume(value) {
    try { global.localStorage.setItem('mlbp.pref.volume', String(value)); } catch (e) { /* ignore */ }
  }

  /* ------------------------------------------------------------------ render */

  function entryMatches(entry, filter) {
    if (!entry) return false;
    if (filter === 'state') return entry.kind === 'state';
    if (filter === 'all') return (entry.kind === 'review' || entry.kind === 'pending' || entry.kind === 'scoring_change') && !(entry.review && entry.review.isABS);
    if (filter === 'abs') return entry.review && entry.review.isABS;
    if (filter === 'challenges') return entry.review && entry.review.family === 'manager';
    if (filter === 'reviews') return entry.review && (entry.review.family === 'umpire' || entry.review.family === 'replay');
    if (filter === 'boundary') return entry.review && entry.review.isBoundary;
    if (filter === 'under') return entry.review && entry.review.inProgress;
    if (filter === 'risk') return entry.review && entry.review.runsAtRiskCount > 0;
    if (filter === 'scoring') return entry.kind === 'scoring_change';
    return true;
  }

  function allRenderableEntries() {
    return state.entries.concat(state.stateEntries);
  }

  function visibleEntries() {
    return allRenderableEntries()
      .filter(function (e) { return entryMatches(e, state.filter); })
      .sort(function (a, b) {
        return ((b.at || b.lastSeen) || 0) - ((a.at || a.lastSeen) || 0);
      });
  }

  function statsFor() {
    var s = { total: 0, manager: 0, umpire: 0, abs: 0, boundary: 0, under: 0, risk: 0, scoring: 0, pending: 0, state: 0 };
    state.entries.forEach(function (e) {
      if (e.kind === 'scoring_change') { s.scoring += 1; return; }
      if (e.kind === 'pending') { s.pending += 1; return; }
      if (e.kind !== 'review') return;
      var r = e.review;
      if (!r) return;
      if (r.isABS) s.abs += 1; else s.total += 1;
      if (r.family === 'manager') s.manager += 1;
      if (r.family === 'umpire' || r.family === 'replay') s.umpire += 1;
      if (r.isBoundary) s.boundary += 1;
      if (r.inProgress) s.under += 1;
      if (r.runsAtRiskCount > 0) s.risk += 1;
    });
    s.state = state.stateEntries.length;
    return s;
  }

  function renderTabs() {
    var nav = $('feed-tabs');
    if (!nav) return;
    nav.innerHTML = FILTERS.map(function (f) {
      var count = allRenderableEntries().filter(function (e) { return entryMatches(e, f.id); }).length;
      return '<button class="tab-btn' + (state.filter === f.id ? ' tab-on' : '') + '" data-filter="' + f.id + '">' +
        UI.esc(f.label) + (count ? ' <span class="tab-badge">' + count + '</span>' : '') + '</button>';
    }).join('');
  }

  function renderStats() {
    var el = $('feed-stats');
    if (!el) return;
    var s = statsFor();
    var lag = latencySummary();
    var tiles = [
      { n: s.total, label: 'Reviews', cls: '' },
      { n: s.manager, label: 'Challenges', cls: '' },
      { n: s.umpire, label: 'Umpire reviews', cls: '' },
      { n: s.abs, label: 'ABS challenges', cls: '' },
      { n: s.boundary, label: 'Boundary calls', cls: '' },
      { n: s.under, label: 'Under review', cls: '' },
      { n: s.risk, label: 'Runs at risk', cls: 'is-risk' },
      { n: s.scoring, label: 'Scoring changes', cls: '' },
      { n: s.pending, label: 'Scorer pending', cls: s.pending ? 'is-live' : '' },
      { n: s.state, label: 'State changes', cls: '' },
      {
        n: lag.median === null ? '—' : (lag.median / 1000).toFixed(1) + 's',
        label: 'Median data age',
        cls: '',
      },
    ];
    el.innerHTML = tiles.map(function (t) {
      return '<div class="stat-tile ' + t.cls + '"><div class="stat-num">' + t.n + '</div>' +
        '<div class="stat-label">' + UI.esc(t.label) + '</div></div>';
    }).join('');
  }

  function renderBanner() {
    var el = $('banner');
    if (!el) return;
    var atRisk = state.entries.filter(function (e) {
      return e.review && e.review.inProgress && e.review.runsAtRiskCount > 0;
    });
    if (!atRisk.length) { el.innerHTML = ''; return; }
    el.innerHTML = atRisk.map(function (e) {
      var r = e.review;
      return '<div class="banner-item">' +
        '⚠️ <strong>' + UI.esc(r.runsAtRiskCount + ' run' + (r.runsAtRiskCount === 1 ? '' : 's') + ' at risk') + '</strong>' +
        ' — <a class="banner-link" href="game.html?gamePk=' + encodeURIComponent(e.gamePk) + '&date=' + encodeURIComponent(state.date) + '">' +
        UI.esc(e.matchupLabel || '') + '</a> · ' + UI.esc(r.typeLabel + (r.reason ? ': ' + r.reason : '')) +
        (r.inningLabel ? ' (' + UI.esc(r.inningLabel) + ')' : '') +
      '</div>';
    }).join('');
  }

  function renderActiveStrip() {
    var el = $('active-strip');
    if (!el) return;
    var active = state.entries.filter(function (e) { return e.review && e.review.inProgress; });
    if (!active.length) { el.innerHTML = ''; return; }
    el.innerHTML = '<div class="active-strip"><h3>Under review</h3><div class="active-items">' +
      active.map(function (e) {
        var r = e.review;
        var cached = state.counterCache && state.counterCache[e.gamePk];
        var bothSummary = cached ? Reviews.countersSummary(cached) : '';
        return '<div class="active-item">' +
          '<a href="game.html?gamePk=' + encodeURIComponent(e.gamePk) + '&date=' + encodeURIComponent(state.date) + '"><b>' + UI.esc(e.matchupLabel || '') + '</b></a>' +
          UI.chip(r.typeLabel + (r.reason ? ': ' + r.reason : ''), r.isABS ? 'chip-abs' : 'chip-review') +
          '<span>' + UI.esc(r.inningLabel || '') + '</span>' +
          (r.runsAtRiskCount ? UI.chip('⚠️ ' + r.runsAtRiskCount + ' run(s) at risk', 'chip-danger') : '') +
          (bothSummary ? '<span class="counter-note">' + UI.esc(bothSummary) + '</span>' : '') +
          '</div>';
      }).join('') + '</div></div>';
  }

  /* ---- live game state monitor: every game, captured to the second ---- */

  function stateCard(game, snap) {
    var teams = teamsOf(game);
    var pk = game.gamePk;
    var status = (snap && snap.status) || {
      detailedState: (game.status && game.status.detailedState) || '',
      code: (game.status && game.status.statusCode) || '',
    };
    var custom = (game.status && game.status.detailedState) || status.detailedState || '';
    var changes = state.stateEntries.filter(function (e) { return e.gamePk === pk; }).slice(0, 4);
    var counters = state.counterCache && state.counterCache[pk];
    var counterText = counters ? Reviews.countersSummary(counters) : '';

    var stateBits = [];
    if (snap) {
      if (snap.inningLabel) stateBits.push('<span>' + UI.esc(snap.inningLabel) + '</span>');
      if (snap.outs !== null && snap.outs !== undefined) stateBits.push('<span>' + snap.outs + ' out</span>');
      if (snap.count && snap.count.balls !== null && snap.count.strikes !== null) {
        stateBits.push('<span>' + snap.count.balls + '-' + snap.count.strikes + ' count</span>');
      }
      if (snap.batter && snap.batter.name) stateBits.push('<span>Batter <b>' + UI.esc(snap.batter.name) + '</b></span>');
      if (snap.pitcher && snap.pitcher.name) stateBits.push('<span>Pitcher <b>' + UI.esc(snap.pitcher.name) + '</b></span>');
      if (snap.pitch && snap.pitch.pitcherPitches !== null && snap.pitch.pitcherPitches !== undefined) {
        stateBits.push('<span>' + snap.pitch.pitcherPitches + ' pitches</span>');
      }
      if (snap.pitch && snap.pitch.paPitches !== null && snap.pitch.paPitches !== undefined) {
        stateBits.push('<span>' + snap.pitch.paPitches + ' in PA</span>');
      }
      var bases = ['first', 'second', 'third'].filter(function (b) { return snap.runners && snap.runners[b]; });
      stateBits.push('<span>Bases: ' + (bases.length ? UI.esc(bases.join(', ')) : 'empty') + '</span>');
    }

    return '<article class="state-card' + (snap && snap.status && snap.status.abstract === 'Live' ? ' is-live' : '') + '">' +
      '<div class="state-head">' +
        '<a href="game.html?gamePk=' + encodeURIComponent(pk) + '&date=' + encodeURIComponent(state.date) + '"><b>' +
          UI.esc(UI.abbr(teams.away) + ' @ ' + UI.abbr(teams.home)) + '</b></a>' +
        '<span class="state-status" title="Official detailedState / statusCode">' + UI.esc(custom || '—') +
          (status.code ? ' <code>' + UI.esc(status.code) + '</code>' : '') + '</span>' +
        '<span class="state-score">' + (snap && snap.score ? UI.esc(GameState.scoreText(snap.score)) : '—') + '</span>' +
        (snap ? '<span class="state-when" title="Observed at ' + UI.esc(snap.observedAtISO) + '">' + UI.esc(fmtSeconds(snap.observedAt)) + '</span>' : '') +
        (snap && snap.dataAgeMs !== null && snap.dataAgeMs !== undefined
          ? '<span class="state-lag" title="Payload age against the feed\'s own metaData.timeStamp' +
            (snap.pipelineMs ? ' · MLB pipeline wait ' + Math.round(snap.pipelineMs / 1000) + 's' : '') + '">' +
            ageText(snap.dataAgeMs) + '</span>' : '') +
      '</div>' +
      '<div class="state-body">' + (snap ? stateBits.join('') : '<span class="state-none">state not captured yet</span>') + '</div>' +
      (counterText ? '<div class="counter-note">' + UI.esc(counterText) + '</div>' : '') +
      (changes.length
        ? '<div class="state-changes">' + changes.map(function (c) {
            return '<div class="state-change"><span class="sc-time">' + UI.esc(fmtSeconds(c.at)) + '</span>' +
              '<span class="sc-field">' + UI.esc(c.label) + '</span>' +
              '<span class="sc-from">' + UI.esc(fmtValue(c.from)) + '</span>' +
              '<span class="sc-arrow">→</span>' +
              '<span class="sc-to">' + UI.esc(fmtValue(c.to)) + '</span></div>';
          }).join('') + '</div>'
        : '') +
      (snap && snap.pending && snap.pending.length
        ? '<div class="state-pending">📝 ' + snap.pending.length + ' official-scorer ruling pending in this game</div>' : '') +
    '</article>';
  }

  /* A payload older than ten minutes is not "old data", it is a feed that
   * stopped updating (or a stale clock): say so instead of counting up. */
  function ageText(ms) {
    if (typeof ms !== 'number' || !isFinite(ms)) return '—';
    if (ms < -5000) return 'clock skew';
    if (ms > 600000) return 'stale';
    return (ms / 1000).toFixed(1) + 's old';
  }

  function fmtValue(value) {
    if (value === null || value === undefined) return '—';
    if (typeof value === 'object') {
      if (value.away !== undefined && value.home !== undefined) return value.away + '–' + value.home;
      if (value.balls !== undefined && value.strikes !== undefined) return value.balls + '-' + value.strikes;
      if (value.name !== undefined) return value.name || '—';
      return JSON.stringify(value);
    }
    if (typeof value === 'boolean') return value ? 'yes' : 'no';
    return String(value);
  }

  function renderStateMonitor() {
    var el = $('state-monitor');
    if (!el) return;
    var games = state.games.slice().sort(function (a, b) {
      var rank = function (g) {
        var s = (g.status && g.status.abstractGameState) || '';
        return s === 'Live' ? 0 : s === 'Final' ? 1 : 2;
      };
      var diff = rank(a) - rank(b);
      if (diff) return diff;
      return String(a.gameDate || '').localeCompare(String(b.gameDate || ''));
    });
    if (!games.length) { el.innerHTML = ''; return; }
    var live = games.filter(function (g) { return g.status && g.status.abstractGameState === 'Live'; }).length;
    var captured = games.filter(function (g) { return state.stateSnapshots[g.gamePk]; }).length;
    var lag = latencySummary();
    el.innerHTML = '<div class="state-monitor">' +
      '<div class="state-monitor-head">' +
        '<h3>Live game state — every game, captured to the second</h3>' +
        '<div class="state-monitor-meta">' +
          '<span>' + games.length + ' game(s) · ' + live + ' live · ' + captured + ' captured</span>' +
          '<span>state lane ' + STATE_MS + ' ms · play lane ' + PLAY_MS + ' ms · status sweep ' + STATUS_SWEEP_MS + ' ms</span>' +
          (lag.median !== null ? '<span>median data age ' + (lag.median / 1000).toFixed(1) + 's' +
            (lag.p90 !== null ? ' · p90 ' + (lag.p90 / 1000).toFixed(1) + 's' : '') +
            ' (' + lag.count + ' samples)</span>' : '<span>data age — no live sample yet</span>') +
          (lag.statusMedian !== null ? '<span>sweep detection ' + (lag.statusMedian / 1000).toFixed(2) + 's</span>' : '') +
          '<span class="state-persist">' + (state.stateRestored.latest
            ? 'restored ' + UI.esc(fmtSeconds(state.stateRestored.latest))
            : 'capturing') + '</span>' +
        '</div>' +
      '</div>' +
      '<div class="state-grid">' + games.map(function (g) { return stateCard(g, state.stateSnapshots[g.gamePk]); }).join('') + '</div>' +
    '</div>';
  }

  /* ---- separate official-scoring section (own store, own render) ---- */

  function renderOfficialScoring() {
    var el = $('official-scoring');
    if (!el) return;
    try {
      OfficialScoring.render(el, state.date);
    } catch (err) {
      /* Isolated on purpose: this section can never break the alert feed. */
      el.innerHTML = '<div class="osc-error">Official scoring log could not be rendered (' +
        UI.esc(err && err.message ? err.message : 'error') +
        '). The alert feed above is unaffected.</div>';
    }
    var s = OfficialScoring.summary(state.date);
    state.scoringSummary = s;
    var badge = $('scoring-count');
    if (badge) {
      badge.textContent = String(s.pendingOpen + s.scoringChanges);
      badge.title = s.pendingOpen + ' pending now · ' + s.scoringChanges + ' scoring change(s) logged';
      badge.style.display = (s.pendingOpen + s.scoringChanges) ? '' : 'none';
    }
  }

  function scoreLine(label, score) {
    if (!score) return '';
    return '<dt>' + UI.esc(label) + '</dt><dd>' + UI.esc(score.away) + '–' + UI.esc(score.home) + '</dd>';
  }

  function renderStateRow(entry) {
    var when = fmtSeconds(entry.at);
    return '<div class="feed-row feed-row-state">' +
      '<div class="feed-avatar">🕒</div>' +
      '<div class="feed-body">' +
        '<div class="feed-top">' +
          '<a href="game.html?gamePk=' + encodeURIComponent(entry.gamePk) + '&date=' + encodeURIComponent(state.date) + '"><b>' +
            UI.esc(entry.matchupLabel || '') + '</b></a>' +
          '<span>' + UI.esc(when) + '</span>' +
          (entry.atISO ? '<span class="feed-iso">' + UI.esc(entry.atISO) + '</span>' : '') +
          '<a href="https://statsapi.mlb.com/api/v1.1/game/' + encodeURIComponent(entry.gamePk) +
            '/feed/live" target="_blank" rel="noopener" title="Official MLB StatsAPI live feed">MLB API ↗</a>' +
        '</div>' +
        '<div class="feed-title">' + UI.esc(entry.label || 'State change') + '</div>' +
        '<dl class="score-track">' +
          '<dt>Before</dt><dd>' + UI.esc(fmtValue(entry.from)) + '</dd>' +
          '<dt>After</dt><dd>' + UI.esc(fmtValue(entry.to)) + '</dd>' +
        '</dl>' +
        '<div class="feed-chips">' + UI.chip('Live state captured', 'chip-review') +
          UI.chip(entry.atISO || '', 'chip-abs') + '</div>' +
      '</div>' +
    '</div>';
  }

  function renderRow(entry) {
    if (entry.kind === 'state') return renderStateRow(entry);
    var r = entry.review || {};
    var tracker = entry.scoreTracker || {};
    var cls = 'feed-row';
    if (r.inProgress) cls += ' is-live';
    if (r.runsAtRiskCount) cls += ' is-at-risk';

    var avatar = r.isABS ? '🎯' : r.isBoundary ? '📏' : entry.kind === 'scoring_change' ? '✏️' : entry.kind === 'pending' ? '📝' : '🚨';

    var chips = [];
    chips.push(UI.chip(r.typeLabel || 'Review', r.isABS ? 'chip-abs' : 'chip-review'));
    if (r.reason) chips.push(UI.chip(r.reason, 'chip-review'));
    if (r.isBoundary) chips.push(UI.chip('Boundary call', 'chip-warn'));
    if (r.inProgress) chips.push(UI.chip('Under review', 'chip-warn'));
    else if (r.outcome) chips.push(UI.chip(r.outcome, r.outcome === 'Overturned' ? 'chip-ok' : ''));
    if (r.runsAtRiskCount) chips.push(UI.chip('⚠️ ' + r.runsAtRiskCount + ' run(s) at risk', 'chip-danger'));

    var trackerHtml = '';
    if (entry.kind === 'review' && (tracker.before || tracker.possible || tracker.actual)) {
      trackerHtml = '<dl class="score-track">' +
        (tracker.before ? scoreLine('Before review', tracker.before) : '<dt>Before review</dt><dd>— (not observed before ruling)</dd>') +
        (tracker.possible ? scoreLine('Possible after (conditional)', tracker.possible)
          : (r.isBoundary && !(r.runsAtRiskCount > 0)
            ? '<dt>Possible after (conditional)</dt><dd>score impact pending</dd>'
            : (r.runsAtRiskCount > 0
              ? '<dt>Possible after (conditional)</dt><dd>— (not observed before ruling)</dd>'
              : ''))) +
        scoreLine('Actual after (official)', tracker.actual) +
        '</dl>';
    }

    var absLine = '';
    if (r.isABS && r.absCountBefore) {
      absLine = '<div class="feed-sub">Pitch ' + UI.esc(r.absPitchNumber) +
        ' · count before ' + r.absCountBefore.balls + '-' + r.absCountBefore.strikes +
        (r.absCountAfter ? ' · after ' + r.absCountAfter.balls + '-' + r.absCountAfter.strikes : '') + '</div>';
    }

    var counterText = '';
    var counterSummaryTitle = '';
    var cached = state.counterCache && state.counterCache[entry.gamePk];
    var challengerLabel = (r.challengerSide && entry.teams && entry.teams[r.challengerSide])
      ? UI.abbr(entry.teams[r.challengerSide]) : '';
    if (cached) {
      counterSummaryTitle = Reviews.countersSummary(cached);
      if (r.family === 'manager' && r.challengerSide && cached.manager && cached.manager[r.challengerSide]) {
        counterText = Reviews.counterLine({ manager: cached.manager, side: r.challengerSide, label: challengerLabel });
      }
      if (r.isABS && r.challengerSide && cached.abs && cached.abs[r.challengerSide]) {
        counterText = Reviews.counterLine({ abs: cached.abs, side: r.challengerSide, label: challengerLabel });
      }
      if (!counterText && counterSummaryTitle) {
        counterText = counterSummaryTitle;
      }
    }

    var changeHtml = '';
    if (entry.kind === 'scoring_change' && entry.change) {
      changeHtml = '<div class="feed-sub">Initial call: ' + UI.esc(entry.change.from && entry.change.from.description ? entry.change.from.description : '') +
        '</div><div class="feed-sub">Final ruling: ' + UI.esc(entry.change.to && entry.change.to.description ? entry.change.to.description : '') + '</div>' +
        (entry.change.scoreAfter ? '<div class="feed-sub">Official score after the play: ' +
          UI.esc(entry.change.scoreAfter.away) + '–' + UI.esc(entry.change.scoreAfter.home) + '</div>' : '') +
        '<div class="feed-irregular">Attribution: ' + UI.esc(entry.change.attribution || '') + '</div>';
    }

    var pendingHtml = '';
    if (entry.kind === 'pending' && entry.pending) {
      pendingHtml = '<div class="feed-sub">' + UI.esc(entry.pending.description || '') + '</div>' +
        '<div class="feed-irregular">Source: ' + UI.esc(entry.pending.source || '') + '</div>';
    }

    var irregularity = '';
    (state.irregularities[entry.gamePk] || []).some(function (n) {
      if (entry.id && n.indexOf(entry.id) !== -1) { irregularity = n; return true; }
      return false;
    });

    var seenAt = (entry.lastSeen || entry.at) ? fmtSeconds(entry.lastSeen || entry.at) : '';
    return '<div class="' + cls + '">' +
      '<div class="feed-avatar">' + avatar + '</div>' +
      '<div class="feed-body">' +
        '<div class="feed-top">' +
          '<a href="game.html?gamePk=' + encodeURIComponent(entry.gamePk) + '&date=' + encodeURIComponent(state.date) + '"><b>' + UI.esc(entry.matchupLabel || '') + '</b></a>' +
          '<span>' + UI.esc(r.inningLabel || '') + '</span>' +
          (r.challengerSide && r.challengerSide !== 'unknown' && r.challenger
            ? '<span>Challenged by ' + UI.esc(r.challenger) + (r.challengerRole ? ' (' + UI.esc(r.challengerRole) + ')' : '') + '</span>' : '') +
          (seenAt ? '<span title="Observed at ' + UI.esc(entry.observedISO || '') + '">' + UI.esc(seenAt) + '</span>' : '') +
          (entry.observedISO ? '<span class="feed-iso">' + UI.esc(entry.observedISO) + '</span>' : '') +
          '<a href="https://statsapi.mlb.com/api/v1/game/' + encodeURIComponent(entry.gamePk) + '/playByPlay" target="_blank" rel="noopener" title="Official MLB StatsAPI play-by-play source">MLB API ↗</a>' +
        '</div>' +
        '<div class="feed-title">' + UI.esc((r.batter && r.batter.name) || '') +
          (r.pitcher && r.pitcher.name ? ' vs ' + UI.esc(r.pitcher.name) : '') + '</div>' +
        (r.description ? '<div class="feed-sub">' + UI.esc(r.description) + '</div>' : '') +
        absLine + changeHtml + pendingHtml +
        (trackerHtml ? trackerHtml : '') +
        (counterText ? '<div class="counter-note"' + (counterSummaryTitle ? ' title="' + UI.esc(counterSummaryTitle) + '"' : '') + '>' + UI.esc(counterText) + '</div>' : '') +
        (irregularity ? '<div class="feed-irregular">⚠️ ' + UI.esc(irregularity) + '</div>' : '') +
        '<div class="feed-chips">' + chips.join('') + '</div>' +
      '</div>' +
    '</div>';
  }

  function offerRecentDate() {
    if (state.lastGameDate !== undefined || state.lookingForRecent) return;
    state.lookingForRecent = true;
    var reqSeq = state.dateSeq;
    var reqDate = state.date;
    var from = MLB.shiftISODate(reqDate, -180);
    MLB.scheduleRange(from, reqDate)
      .then(function (payload) {
        if (reqSeq !== state.dateSeq || reqDate !== state.date) return;
        var dates = ((payload && payload.dates) || []).filter(function (d) {
          return d && d.totalGames > 0;
        });
        state.lastGameDate = dates.length ? dates[dates.length - 1].date : null;
      })
      .catch(function () {
        if (reqSeq === state.dateSeq && reqDate === state.date) state.lastGameDate = null;
      })
      .then(function () {
        if (reqSeq !== state.dateSeq || reqDate !== state.date) return;
        state.lookingForRecent = false;
        if (state.lastGameDate) render();
      });
  }

  function entriesSignature() {
    var lag = latencySummary();
    return state.filter + '|' + state.games.length + '|' + (state.lastGameDate || '') + '|' +
      (lag.median === null ? '' : Math.round(lag.median / 100)) + '|' +
      state.stateEntries.length + '|' + state.entries.map(function (e) {
        return [e.id, e.lastSeen, e.review && e.review.outcome, e.review && e.review.inProgress,
          e.scoreTracker && e.scoreTracker.actual ? e.scoreTracker.actual.away + '-' + e.scoreTracker.actual.home : '',
          e.scoreTracker && e.scoreTracker.before ? e.scoreTracker.before.away + '-' + e.scoreTracker.before.home : ''].join(':');
      }).join('|') + '|' + state.games.map(function (g) {
        var snap = state.stateSnapshots[g.gamePk];
        return g.gamePk + ':' + (snap ? snap.observedAt : '') + ':' + (snap ? GameState.signatureOf(snap) : '');
      }).join('|');
  }

  function renderIfChanged() {
    var sig = entriesSignature();
    if (sig === state.lastRenderSignature) return;
    state.lastRenderSignature = sig;
    render();
  }

  function flaggedRowHtml(entry, note) {
    return '<div class="feed-row flagged-row">' +
      '<div class="feed-avatar">🚩</div>' +
      '<div class="feed-body">' +
        '<div class="feed-top">' +
          '<a href="game.html?gamePk=' + encodeURIComponent(entry.gamePk) + '&date=' + encodeURIComponent(state.date) + '"><b>' + UI.esc(entry.matchupLabel || '') + '</b></a>' +
          '<span>Flagged for review</span>' +
          '<a href="https://statsapi.mlb.com/api/v1/game/' + encodeURIComponent(entry.gamePk) + '/playByPlay" target="_blank" rel="noopener" title="Official MLB StatsAPI play-by-play source">MLB API ↗</a>' +
        '</div>' +
        '<div class="feed-irregular">⚠️ ' + UI.esc(note) + '</div>' +
        '<div class="feed-chips">' + UI.chip('Irregularity', 'chip-warn') + UI.chip('Source data', 'chip-review') + '</div>' +
      '</div>' +
    '</div>';
  }

  function render() {
    renderBanner();
    renderTabs();
    renderStats();
    renderActiveStrip();
    try { renderStateMonitor(); } catch (e) { /* keep the feed alive */ }
    try { renderOfficialScoring(); } catch (e) { /* keep the feed alive */ }
    var list = $('feed-list');
    if (!list) return;
    var rows = visibleEntries();
    if (!rows.length) {
      var emptyNote = state.filter === 'state'
        ? 'No captured live-state changes for this date yet. The state lane samples every live game and logs each material change with its exact time.'
        : 'No tracked events for this date and filter yet. New challenges, reviews, boundary calls, ABS challenges, official-scorer pending rulings and official scoring changes appear here live.';
      if (!state.games.length && !state.entries.length) {
        list.innerHTML = '<div class="panel" style="text-align:center;color:var(--muted)">' +
          'No games scheduled for ' + UI.esc(MLB.formatDateLabel(state.date)) + '.' +
          '<div class="feed-empty">' + UI.esc(emptyNote) + '</div>' +
          (state.lastGameDate
            ? '<div style="margin-top:10px">Most recent date with games: ' +
              UI.esc(MLB.formatDateLabel(state.lastGameDate)) + ' ' +
              '<button class="btn" onclick="ReplayFeed.setDate(\'' + state.lastGameDate + '\')">Show it</button></div>'
            : '') +
          '</div>';
        offerRecentDate();
      } else {
        list.innerHTML = '<div class="feed-empty">' + UI.esc(emptyNote) + '</div>';
      }
      return;
    }
    var flagged = [];
    var seenGames = Object.create(null);
    rows.forEach(function (e) {
      if (!e || seenGames[e.gamePk] || e.kind === 'state') return;
      seenGames[e.gamePk] = true;
      (state.irregularities[e.gamePk] || []).forEach(function (n) {
        var namesEntry = state.entries.some(function (x) {
          return x && x.gamePk === e.gamePk && x.id && n.indexOf(x.id) !== -1;
        });
        if (!namesEntry) flagged.push(flaggedRowHtml(e, n));
      });
    });
    list.innerHTML = flagged.join('') + rows.map(renderRow).join('');
  }

  function updateChrome() {
    var label = $('countdown');
    if (label) {
      var left = Math.max(0, state.nextScanAt - Date.now());
      label.textContent = document.hidden ? 'paused' : (left / 1000).toFixed(1) + 's';
    }
    var dot = $('live-dot');
    if (dot) dot.style.opacity = state.scanError ? '0.3' : '1';
    var lag = latencySummary();
    var lagEl = $('latency-pill');
    if (lagEl) {
      if (lag.median === null) {
        lagEl.textContent = '⚡ age —';
        lagEl.title = 'Data age is measured against each response\'s own metaData.timeStamp and is only ' +
          'sampled while a game is live. No live sample yet.';
      } else {
        lagEl.textContent = '⚡ ' + (lag.median / 1000).toFixed(1) + 's age';
        lagEl.title = 'Median data age ' + (lag.median / 1000).toFixed(2) + 's over ' + lag.count +
          ' live sample(s)' + (lag.p90 !== null ? ' · p90 ' + (lag.p90 / 1000).toFixed(2) + 's' : '') +
          ' · measured against each response\'s metaData.timeStamp' +
          (lag.last && lag.last.pipelineMs ? ' · last MLB pipeline wait ' + Math.round(lag.last.pipelineMs / 1000) + 's' : '') +
          (lag.statusMedian !== null ? ' · status sweep detection period ' + (lag.statusMedian / 1000).toFixed(2) + 's' : '');
      }
    }
    if (state.scanError) {
      statusLine('Scan problem: ' + (state.scanError.message || 'network error') + ' — retrying.', true);
    } else {
      try {
      var live = state.games.filter(function (g) { return g.status && g.status.abstractGameState === 'Live'; }).length;
      var soc = state.scoringSummary || { pendingOpen: 0, scoringChanges: 0 };
      statusLine(state.games.length + ' game(s) on ' + MLB.formatDateLabel(state.date) +
        ' · ' + live + ' live · ' + state.entries.length + ' tracked alert' +
        (state.entries.length === 1 ? '' : 's') +
        ' · ' + state.stateEntries.length + ' state change(s) captured' +
        ' · scorer: ' + soc.pendingOpen + ' pending, ' + soc.scoringChanges + ' changed' +
        ' · state ' + STATE_MS + 'ms / play ' + PLAY_MS + 'ms / status ' + STATUS_SWEEP_MS + 'ms' +
        (state.throttle > 1 ? ' · throttled x' + state.throttle : '') +
        ' · scanned ' + fmtSeconds(state.lastScanAt || Date.now()) +
        (FeedLog.state.available ? ' · shared log connected' : ' · local log only'));
      } catch (e) {
        /* The status line is diagnostics: never let it blank or break the page. */
        statusLine(state.games.length + ' game(s) on ' + MLB.formatDateLabel(state.date) +
          ' · ' + state.entries.length + ' tracked alert(s) — status detail unavailable (' +
          (e && e.message ? e.message : 'error') + ')');
      }
    }
  }

  /* -------------------------------------------------------------------- nav */

  function restoreStateJournal(date, seq) {
    var journal = GameState.Journal.load(date);
    state.journal = journal;
    var latest = 0;
    var stale = [];
    Object.keys(journal.games || {}).forEach(function (pk) {
      var rec = journal.games[pk];
      if (!rec || !rec.latest) return;
      state.stateSnapshots[pk] = rec.latest;
      if (rec.latest.observedAt && rec.latest.observedAt > latest) latest = rec.latest.observedAt;
      var live = rec.latest.status && rec.latest.status.abstract === 'Live';
      if (live && Date.now() - rec.latest.observedAt > RESTORE_GAP_MS) {
        stale.push({ pk: pk, rec: rec });
      }
    });
    state.stateRestored = { latest: latest || null };
    /* A live game whose last capture is older than the gap threshold was not
     * observed while the page was closed: say so instead of implying a
     * continuous record. */
    stale.forEach(function (item) {
      try {
        OfficialScoring.noteGap(date, item.pk, item.rec.matchup || '', 'page was not open');
      } catch (e) { /* ignore */ }
    });
    if (seq !== state.dateSeq) return;
  }

  function restoreStateEntries(date) {
    /* State-change rows are derived from the journal so a refresh keeps the
     * history instead of starting blank. */
    var journal = state.journal || GameState.Journal.load(date);
    var rows = [];
    Object.keys(journal.games || {}).forEach(function (pk) {
      var rec = journal.games[pk] || {};
      var snaps = rec.snapshots || [];
      for (var i = 1; i < snaps.length; i += 1) {
        var changes = GameState.diffSnapshots(snaps[i - 1], snaps[i]);
        changes.forEach(function (change) {
          rows.push({
            id: pk + ':' + change.key + ':' + snaps[i].observedAt,
            kind: 'state',
            gamePk: Number(pk),
            matchupLabel: rec.matchup || '',
            at: snaps[i].observedAt,
            atISO: snaps[i].observedAtISO,
            field: change.key,
            label: change.label,
            from: change.from,
            to: change.to,
            restored: true,
          });
        });
      }
    });
    state.stateEntries = rows.sort(function (a, b) { return (b.at || 0) - (a.at || 0); }).slice(0, MAX_STATE_ENTRIES);
    /* Fill the matchup label from the slate once it arrives. */
    state.stateEntries.forEach(function (e) {
      if (e.matchupLabel) return;
      var game = state.games.filter(function (g) { return Number(g.gamePk) === Number(e.gamePk); })[0];
      if (game) {
        var teams = teamsOf(game);
        e.matchupLabel = UI.abbr(teams.away) + ' @ ' + UI.abbr(teams.home);
        e.teams = teams;
      }
    });
  }

  function setDate(date) {
    var clean = MLB.isValidISODate(date) ? date : MLB.todayISO();
    if (clean === state.date) return;
    state.dateSeq += 1;
    var seq = state.dateSeq;
    clearTimeout(state.timers.scan);
    state.scanning = false;
    state.date = clean;
    state.games = [];
    state.entries = [];
    state.stateEntries = [];
    state.snapshots = Object.create(null);
    state.irregularities = Object.create(null);
    state.finalSeen = Object.create(null);
    state.nextDue = Object.create(null);
    state.nextStateAt = Object.create(null);
    state.statusByPk = Object.create(null);
    state.lastSweepAt = 0;
    state.stateSnapshots = Object.create(null);
    state.stateRestored = Object.create(null);
    state.counterCache = Object.create(null);
    state.absFetchedRevCount = Object.create(null);
    state.lastGameDate = undefined;
    state.lookingForRecent = false;
    state.log = null;
    state.latency = { dataAge: [], statusReaction: [], last: null };
    state.lastSweepAt = 0;
    state.lastRenderSignature = '';
    syncNav();
    render();
    FeedLog.closeStream();
    restoreStateJournal(clean, seq);
    restoreStateEntries(clean);
    render();
    FeedLog.load(clean).then(function (log) {
      if (seq !== state.dateSeq || state.date !== clean) return;
      adoptLog(log);
      render();
      FeedLog.openStream(clean);
      scan();
    });
    OfficialScoring.load(clean).then(function () {
      if (seq !== state.dateSeq || state.date !== clean) return;
      renderIfChanged();
    }).catch(function () { /* the section reports its own state */ });
  }

  function setFilter(filter) { state.filter = filter; state.lastRenderSignature = ''; render(); }

  function syncSoundButton() {
    var btn = $('sound-toggle-btn');
    if (btn) {
      btn.textContent = state.soundOn ? '🔊 Sound On' : '🔇 Sound Off';
      btn.classList.toggle('btn-on', state.soundOn);
      btn.setAttribute('aria-pressed', state.soundOn ? 'true' : 'false');
      btn.title = state.soundOn
        ? 'Alert sound is ON — a 3-second raindrop bloom for new challenges, reviews, boundary calls, scorer-pending rulings, official scoring changes and runs at risk (not routine ABS). Click to mute.'
        : 'Alert sound is OFF. Click to enable, then press Test to hear the cue.';
    }
  }

  function syncVolumeControls() {
    var slider = $('volume-slider');
    if (slider) {
      slider.value = String(Math.round(AlertAudio.getVolume() * 100));
      slider.setAttribute('aria-valuetext', Math.round(AlertAudio.getVolume() * 100) + '%');
    }
    var label = $('volume-label');
    if (label) label.textContent = Math.round(AlertAudio.getVolume() * 100) + '%';
  }

  function toggleSound() {
    state.soundOn = !state.soundOn;
    savePref('sound', state.soundOn);
    syncSoundButton();
    var status = $('sound-status');
    if (status) status.textContent = state.soundOn ? 'on' : 'off';
    if (state.soundOn) {
      /* The click is the user gesture: create/resume the AudioContext and play
       * the cue so turning the sound on both proves the audio path and previews
       * exactly what an alert will sound like. */
      AlertAudio.init();
      chime('preview');
    }
  }

  /**
   * testAlert() — the Test button. Always audible on demand (it ignores both
   * the on/off toggle and the cooldown) so the audio path can be verified at
   * any time; while the sound is on it also runs the real event path, so the
   * status line proves the alert pipeline end to end.
   */
  function testAlert() {
    var label = null;
    try { label = AlertAudio.test(); } catch (e) { label = null; }
    state.lastChimeAt = Date.now();
    var ok = !!label;
    var el = $('sound-status');
    if (el) el.textContent = ok ? 'tested' : 'blocked';
    statusLine(ok
      ? '🔔 Alert sound test played (3-second raindrop bloom) · sound is ' + (state.soundOn ? 'ON' : 'OFF') +
        ' · volume ' + Math.round(AlertAudio.getVolume() * 100) + '% · ' + state.alertCount + ' alert(s) since load.'
      : '🔔 Alert sound could not play: this browser has no Web Audio (or blocked it before any interaction). ' +
        'Alerts still appear in the feed.', !ok);
    return ok;
  }

  function setVolume(value) {
    var v = AlertAudio.setVolume(Number(value) / 100);
    saveVolume(v);
    syncVolumeControls();
    return v;
  }

  function toggleNotify() {
    state.notifyOn = !state.notifyOn;
    savePref('notify', state.notifyOn);
    var btn = $('notify-toggle-btn');
    if (btn) {
      btn.textContent = state.notifyOn ? '🔴 Run Alerts On' : '⚪ Run Alerts Off';
      btn.classList.toggle('btn-on', state.notifyOn);
    }
    if (state.notifyOn && typeof global.Notification === 'function' &&
      global.Notification.permission === 'default') {
      global.Notification.requestPermission();
    }
  }

  function init() {
    state.date = urlDate() || parseDate();
    syncNav();
    state.soundOn = loadPref('sound', false);
    state.notifyOn = loadPref('notify', false);
    var vol = loadVolume();
    if (vol !== null) AlertAudio.setVolume(vol);

    FeedLog.onChange(function (pushed) {
      if (pushed && pushed.date === state.date) {
        adoptLog(FeedLog.mergePayloads(state.log, pushed, state.date));
        render();
      }
    });

    OfficialScoring.onChange(function () {
      /* New scorere log rows are recorded by ingestGame, which also raises the
       * alert; this listener only refreshes the separate section. */
      try { renderOfficialScoring(); } catch (e) { /* isolated */ }
      updateChrome();
    });

    syncSoundButton();
    var soundBtn = $('sound-toggle-btn');
    if (soundBtn) soundBtn.addEventListener('click', toggleSound);

    var testBtn = $('sound-test-btn');
    if (testBtn) testBtn.addEventListener('click', function () { testAlert(); });

    var volume = $('volume-slider');
    if (volume) {
      volume.addEventListener('input', function (evt) { setVolume(evt.target.value); });
      volume.addEventListener('change', function (evt) { setVolume(evt.target.value); });
    } else {
      syncVolumeControls();
    }

    state.absChime = loadPref('absChime', false);
    var absToggle = $('abs-chime-toggle');
    if (absToggle) {
      absToggle.checked = state.absChime;
      absToggle.addEventListener('change', function (evt) {
        state.absChime = !!evt.target.checked;
        savePref('absChime', state.absChime);
        if (state.absChime) { AlertAudio.init(); chime('abs'); }
      });
    }

    var notifyBtn = $('notify-toggle-btn');
    if (notifyBtn) {
      notifyBtn.textContent = state.notifyOn ? '🔴 Run Alerts On' : '⚪ Run Alerts Off';
      notifyBtn.classList.toggle('btn-on', state.notifyOn);
      notifyBtn.addEventListener('click', toggleNotify);
    }
    var refreshBtn = $('refresh-btn');
    if (refreshBtn) refreshBtn.addEventListener('click', function () { scan(); stateCycle(); });

    var tabs = $('feed-tabs');
    if (tabs) {
      tabs.addEventListener('click', function (evt) {
        var btn = evt.target.closest('[data-filter]');
        if (btn) setFilter(btn.getAttribute('data-filter'));
      });
    }

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) { scan(); stateCycle(); }
    });

    Reviews.loadRegistry();

    var initSeq = state.dateSeq;
    var initDate = state.date;
    restoreStateJournal(initDate, initSeq);
    restoreStateEntries(initDate);
    FeedLog.load(initDate).then(function (log) {
      if (initSeq !== state.dateSeq || state.date !== initDate) return;
      adoptLog(log);
      render();
      FeedLog.openStream(initDate);
      scan();
      stateCycle();
    });
    OfficialScoring.load(initDate).then(function () {
      if (initSeq !== state.dateSeq || state.date !== initDate) return;
      renderIfChanged();
    }).catch(function () { /* isolated */ });

    state.timers.sweep = setInterval(sweep, STATUS_SWEEP_MS);
    state.timers.state = setInterval(stateCycle, STATE_MS);
    state.timers.countdown = setInterval(updateChrome, 200);
  }

  global.ReplayFeed = {
    init: init,
    prevDay: function () { setDate(MLB.shiftISODate(state.date, -1)); },
    nextDay: function () { setDate(MLB.shiftISODate(state.date, 1)); },
    today: function () { setDate(MLB.todayISO()); },
    pickDate: function () {
      var input = $('date-picker');
      var value = input && input.value;
      setDate(MLB.isValidISODate(value) ? value : state.date);
    },
    setDate: setDate,
    setFilter: setFilter,
    toggleSound: toggleSound,
    testAlert: testAlert,
    setVolume: setVolume,
    toggleNotify: toggleNotify,
    setAbsChime: function (on) {
      state.absChime = !!on;
      savePref('absChime', state.absChime);
      var el = $('abs-chime-toggle');
      if (el) el.checked = state.absChime;
      return state.absChime;
    },
    scan: scan,
    stateCycle: stateCycle,
    latencySummary: latencySummary,
    sweep: sweep,
    notesThrottle: notesThrottle,
    state: state,
    PLAY_MS: PLAY_MS,
    STATE_MS: STATE_MS,
    STATUS_SWEEP_MS: STATUS_SWEEP_MS,
    SCAN_MS: PLAY_MS,
    FETCH_CONCURRENCY: FETCH_CONCURRENCY,
    MAX_STATE_ENTRIES: MAX_STATE_ENTRIES,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}(window));
