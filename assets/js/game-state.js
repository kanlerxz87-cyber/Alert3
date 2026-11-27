/* ============================================================================
 * game-state.js — official live game state, captured to the second
 *
 * Every field here is read from the official MLB StatsAPI payload; nothing is
 * inferred, and an absent value stays null (never zero-filled, never guessed).
 *
 *   GameState.capture(input)        -> one timestamped snapshot
 *   GameState.diffSnapshots(a, b)   -> material changes between two snapshots
 *   GameState.stateLine(snapshot)   -> exact official wording, one line
 *   GameState.latencyMs(snapshot)   -> observation lag behind the official
 *                                      event timestamp (null when unknown)
 *   GameState.Journal               -> per-date, refresh-proof snapshot store
 *
 * Snapshot fields (all optional in the payload, all null when absent):
 *   observedAt            local Date.now() of the response that produced it
 *   observedAtISO         ISO-8601 with seconds, local zone
 *   officialTimeStamp     feed/live metaData.timeStamp (server clock, when sent)
 *   status                { code, detailedState, abstract, reason }
 *   inning / half / inningState, outs, count { balls, strikes }
 *   score { away, home } and hits/errors when the linescore carries them
 *   batter / pitcher / runners / onDeck / inHole (id + name when published)
 *   pitch { paPitches, pitcherPitches, pitcherName } — official counters
 *   atBatIndex, lastPlay { index, eventType, description, endAt }
 *   reviews[] / pending[] — what the payload says is under review / pending
 * ==========================================================================*/
(function (global) {
  'use strict';

  var PENDING_RULING_TYPES = ['os_ruling_pending_primary', 'os_ruling_pending_prior'];

  /* Fields projection for the state lane: one `feed/live` request that carries
   * the whole official game state (status, linescore, current play, official
   * pitch counters, review + ABS counters) and none of the box-score bulk. */
  var STATE_FIELDS = [
    'gameData', 'game', 'pk', 'season', 'status', 'abstractGameState', 'codedGameState',
    'detailedState', 'statusCode', 'reason', 'abstractGameCode',
    'players', 'person', 'id', 'fullName', 'primaryPosition', 'abbreviation',
    'stats', 'pitching', 'numberOfPitches', 'pitchesThrown',
    'review', 'absChallenges', 'hasChallenges', 'away', 'home', 'used', 'remaining',
    'usedSuccessful', 'usedFailed', 'datetime', 'officialDate', 'dateTime',
    'liveData', 'linescore', 'currentInning', 'currentInningOrdinal', 'inningState',
    'isTopInning', 'scheduledInnings', 'balls', 'strikes', 'outs', 'teams', 'runs',
    'hits', 'errors', 'leftOnBase', 'offense', 'batter', 'pitcher', 'first', 'second',
    'third', 'onDeck', 'inHole', 'defense',
    'currentPlay', 'about', 'atBatIndex', 'isComplete', 'isScoringPlay', 'count',
    'result', 'eventType', 'description', 'awayScore', 'homeScore', 'matchup',
    'batSide', 'pitchHand', 'code', 'playEvents', 'index', 'isPitch', 'pitchNumber',
    'details', 'metaData', 'timeStamp', 'wait', 'logicWait',
  ].join(',');

  var MATERIAL_KEYS = [
    'status', 'score', 'outs', 'count', 'batter', 'pitcher', 'runners',
    'inning', 'atBat', 'pitch', 'pending', 'reviews', 'event',
  ];

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /* Local ISO-8601 down to the second, e.g. 2026-08-26T19:04:12-04:00. */
  function isoToSec(ms) {
    var d = new Date(typeof ms === 'number' ? ms : Date.now());
    if (isNaN(d.getTime())) return '';
    var offMin = -d.getTimezoneOffset();
    var sign = offMin >= 0 ? '+' : '-';
    var abs = Math.abs(offMin);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + 'T' +
      pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) +
      sign + pad2(Math.floor(abs / 60)) + ':' + pad2(abs % 60);
  }

  function numOrNull(value) {
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
    var n = Number(value);
    return isFinite(n) ? n : null;
  }

  function person(node) {
    if (!node) return null;
    if (node.person) return { id: numOrNull(node.person.id), name: node.person.fullName || '' };
    var id = numOrNull(node.id);
    var name = node.fullName || node.name || '';
    if (id === null && !name) return null;
    return { id: id, name: name };
  }

  function playsOf(input) {
    if (!input) return [];
    var feed = input.feed || null;
    var pbp = input.pbp || null;
    var out = [];
    if (feed && feed.liveData && feed.liveData.plays && Array.isArray(feed.liveData.plays.allPlays)) {
      out = feed.liveData.plays.allPlays;
    } else if (pbp && Array.isArray(pbp.allPlays)) {
      out = pbp.allPlays;
    } else if (Array.isArray(feed)) {
      out = feed;
    }
    return out;
  }

  function currentPlayOf(input) {
    var feed = input && input.feed;
    if (feed && feed.liveData && feed.liveData.plays && feed.liveData.plays.currentPlay) {
      return feed.liveData.plays.currentPlay;
    }
    var pbp = input && input.pbp;
    return (pbp && pbp.currentPlay) || null;
  }

  function linescoreOf(input) {
    var feed = input && input.feed;
    return (feed && feed.liveData && feed.liveData.linescore) || null;
  }

  function gameDataOf(input) {
    var feed = input && input.feed;
    if (feed && feed.gameData) return feed.gameData;
    var pbp = input && input.pbp;
    return (pbp && pbp.gameData) || null;
  }

  /* Official pitch counters. `numberOfPitches` / `pitchesThrown` are the only
   * per-pitcher totals the API publishes; when neither is present the value
   * stays null instead of being derived from a partial play list. */
  function pitcherPitchCount(gameData, pitcherId) {
    if (!gameData || !pitcherId || !gameData.players) return null;
    var node = gameData.players['ID' + pitcherId] || gameData.players[String(pitcherId)];
    if (!node) return null;
    var stats = node.stats || {};
    var pitching = stats.pitching || {};
    return numOrNull(pitching.numberOfPitches) !== null ? numOrNull(pitching.numberOfPitches)
      : (numOrNull(pitching.pitchesThrown) !== null ? numOrNull(pitching.pitchesThrown)
        : numOrNull(node.numberOfPitches));
  }

  function paPitchCount(play) {
    if (!play || !Array.isArray(play.playEvents)) return null;
    var n = 0;
    play.playEvents.forEach(function (ev) { if (ev && ev.isPitch === true) n += 1; });
    return n;
  }

  function officialStamp(play) {
    /* Play-level `about.endTime` (ISO) is the official moment the event was
     * recorded; the last playEvent's `endTime` is the fallback. */
    if (!play) return '';
    if (play.about && play.about.endTime) return play.about.endTime;
    var events = play.playEvents || [];
    for (var i = events.length - 1; i >= 0; i -= 1) {
      if (events[i] && events[i].endTime) return events[i].endTime;
    }
    return '';
  }

  function reviewIds(plays) {
    var out = [];
    plays.forEach(function (play) {
      if (!play) return;
      var about = play.about || {};
      function take(details) {
        if (!details || !details.reviewType) return;
        out.push({
          atBatIndex: numOrNull(about.atBatIndex),
          code: String(details.reviewType).toUpperCase(),
          inProgress: details.inProgress === true,
          isOverturned: typeof details.isOverturned === 'boolean' ? details.isOverturned : null,
        });
      };
      if (play.reviewDetails) take(play.reviewDetails);
      (play.playEvents || []).forEach(function (ev) { if (ev && ev.reviewDetails) take(ev.reviewDetails); });
    });
    return out;
  }

  /**
   * capture({ gamePk, feed, pbp, observedAt, lane, url, officialDate })
   * Any subset of `feed` (feed/live) and `pbp` (playByPlay) is accepted.
   */
  function capture(input) {
    input = input || {};
    var feed = input.feed || null;
    var pbp = input.pbp || null;
    var plays = playsOf(input);
    var cur = currentPlayOf(input);
    var ls = linescoreOf(input);
    var gd = gameDataOf(input);
    var observedAt = typeof input.observedAt === 'number' ? input.observedAt : Date.now();

    var status = (gd && gd.status) || (pbp && pbp.gameData && pbp.gameData.status) || null;
    var meta = (feed && feed.metaData) || (pbp && pbp.metaData) || null;

    var game = (gd && gd.game) || {};
    var gamePk = numOrNull(input.gamePk) !== null ? numOrNull(input.gamePk) : numOrNull(game.pk);

    /* Inning / half / outs / count: linescore is the authority while a game is
     * live, `currentPlay.count` the fallback when the linescore is absent. */
    var inningNumber = numOrNull(ls && ls.currentInning);
    var half = '';
    if (ls && typeof ls.isTopInning === 'boolean') half = ls.isTopInning ? 'top' : 'bottom';
    else if (cur && cur.about && typeof cur.about.isTopInning === 'boolean') half = cur.about.isTopInning ? 'top' : 'bottom';
    else if (cur && cur.about && cur.about.halfInning) half = String(cur.about.halfInning).toLowerCase().indexOf('top') === 0 ? 'top' : 'bottom';
    if (inningNumber === null && cur && cur.about) inningNumber = numOrNull(cur.about.inning);

    var outs = numOrNull(ls && ls.outs);
    if (outs === null) outs = numOrNull(cur && cur.count && cur.count.outs);

    var balls = numOrNull(ls && ls.balls);
    if (balls === null) balls = numOrNull(cur && cur.count && cur.count.balls);
    var strikes = numOrNull(ls && ls.strikes);
    if (strikes === null) strikes = numOrNull(cur && cur.count && cur.count.strikes);

    var score = null;
    var lsTeams = (ls && ls.teams) || null;
    if (lsTeams && lsTeams.away && lsTeams.home &&
      numOrNull(lsTeams.away.runs) !== null && numOrNull(lsTeams.home.runs) !== null) {
      score = { away: numOrNull(lsTeams.away.runs), home: numOrNull(lsTeams.home.runs) };
    } else if (cur && cur.result && numOrNull(cur.result.awayScore) !== null) {
      score = { away: numOrNull(cur.result.awayScore), home: numOrNull(cur.result.homeScore) };
    } else {
      for (var i = plays.length - 1; i >= 0; i -= 1) {
        var r = plays[i] && plays[i].result;
        if (r && numOrNull(r.awayScore) !== null && numOrNull(r.homeScore) !== null) {
          score = { away: numOrNull(r.awayScore), home: numOrNull(r.homeScore) };
          break;
        }
      }
    }

    var offense = (ls && ls.offense) || (cur && cur.matchup) || {};
    var defense = (ls && ls.defense) || (cur && cur.matchup) || {};
    var batter = person(offense.batter) || person(cur && cur.matchup && cur.matchup.batter);
    var pitcher = person(defense.pitcher) || person(cur && cur.matchup && cur.matchup.pitcher);
    var runner = function (side) { return person(offense[side]); };

    var lastPlay = null;
    for (var p = plays.length - 1; p >= 0; p -= 1) {
      var play = plays[p];
      if (!play || !play.result || !play.result.eventType) continue;
      lastPlay = {
        index: numOrNull(play.about && play.about.atBatIndex),
        eventType: play.result.eventType || '',
        description: play.result.description || '',
        endAt: officialStamp(play),
        isComplete: play.about ? play.about.isComplete === true : null,
      };
      break;
    }

    var pending = [];
    plays.forEach(function (pl) {
      var type = (pl && pl.result && pl.result.eventType) || '';
      if (PENDING_RULING_TYPES.indexOf(type) === -1) return;
      pending.push({
        atBatIndex: numOrNull(pl.about && pl.about.atBatIndex),
        eventType: type,
        description: (pl.result && pl.result.description) || '',
      });
    });

    var atBatIndex = numOrNull(cur && cur.about && cur.about.atBatIndex);
    if (atBatIndex === null) {
      atBatIndex = numOrNull(ls && ls.currentInning) !== null && lastPlay ? lastPlay.index : null;
    }

    var pitcherId = pitcher && pitcher.id;
    return {
      v: 1,
      gamePk: gamePk,
      officialDate: input.officialDate || (gd && gd.datetime && gd.datetime.officialDate) || '',
      observedAt: observedAt,
      observedAtISO: isoToSec(observedAt),
      lane: input.lane || '',
      source: input.url || '',
      officialTimeStamp: (meta && meta.timeStamp) || '',
      status: status ? {
        code: status.statusCode || '',
        detailedState: status.detailedState || '',
        abstract: status.abstractGameState || '',
        reason: status.reason || '',
      } : null,
      inning: inningNumber,
      half: half,
      inningLabel: inningNumber === null ? '' : ((half === 'bottom' ? 'Bot ' : 'Top ') + inningNumber),
      inningState: (ls && ls.inningState) || '',
      outs: outs,
      count: { balls: balls, strikes: strikes },
      score: score,
      hits: lsTeams && lsTeams.away && lsTeams.home
        ? { away: numOrNull(lsTeams.away.hits), home: numOrNull(lsTeams.home.hits) } : null,
      errors: lsTeams && lsTeams.away && lsTeams.home
        ? { away: numOrNull(lsTeams.away.errors), home: numOrNull(lsTeams.home.errors) } : null,
      batter: batter,
      pitcher: pitcher,
      runners: {
        first: runner('first'),
        second: runner('second'),
        third: runner('third'),
      },
      onDeck: person(offense.onDeck),
      inHole: person(offense.inHole),
      atBatIndex: atBatIndex,
      eventIndex: lastPlay ? lastPlay.index : null,
      lastPlay: lastPlay,
      pitch: {
        paPitches: paPitchCount(cur),
        pitcherPitches: pitcherPitchCount(gd, pitcherId),
        pitcherName: (pitcher && pitcher.name) || '',
      },
      reviews: reviewIds(plays),
      pending: pending,
      serverWait: numOrNull(meta && meta.wait),
      serverLogicWait: numOrNull(meta && meta.logicWait),
    };
  }

  /* ---------------------------------------------------------------- diffs */

  function same(a, b) { return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b); }

  function labelOf(snap) {
    if (!snap) return '';
    var bits = [];
    if (snap.inningLabel) bits.push(snap.inningLabel);
    if (snap.status && snap.status.code) bits.push(snap.status.code);
    return bits.join(' · ');
  }

  /**
   * diffSnapshots(prev, next) -> [{ key, label, from, to }]
   * Only material changes are reported. A first snapshot (prev == null)
   * reports nothing: there is no "before" to compare with and the page never
   * invents one.
   */
  function diffSnapshots(prev, next) {
    var out = [];
    if (!prev || !next) return out;
    function push(key, label, from, to) {
      if (same(from, to)) return;
      out.push({ key: key, label: label, from: from === undefined ? null : from, to: to === undefined ? null : to });
    }
    push('status', 'Official status', prev.status && prev.status.code, next.status && next.status.code);
    push('score', 'Score', prev.score, next.score);
    push('outs', 'Outs', prev.outs, next.outs);
    push('count', 'Count', prev.count, next.count);
    push('inning', 'Inning', prev.inningLabel, next.inningLabel);
    push('half', 'Half inning', prev.half, next.half);
    push('atBat', 'At bat', prev.atBatIndex, next.atBatIndex);
    push('batter', 'Batter', prev.batter && prev.batter.name, next.batter && next.batter.name);
    push('pitcher', 'Pitcher', prev.pitcher && prev.pitcher.name, next.pitcher && next.pitcher.name);
    push('runners', 'Runners on base', prev.runners, next.runners);
    push('pitch', 'Pitch count', prev.pitch, next.pitch);
    push('event', 'Play recorded', prev.lastPlay && prev.lastPlay.index, next.lastPlay && next.lastPlay.index);
    push('pending', 'Scorer ruling pending', prev.pending, next.pending);
    push('reviews', 'Reviews in payload', prev.reviews, next.reviews);
    return out;
  }

  function scoreText(score) {
    if (!score || score.away === null || score.home === null) return 'score not published';
    return score.away + '–' + score.home;
  }

  /** Exact official wording for one snapshot, used as the before/after line. */
  function stateLine(snap) {
    if (!snap) return '';
    var bits = [];
    var status = snap.status || {};
    if (status.detailedState) bits.push(status.detailedState);
    if (snap.inningLabel) bits.push(snap.inningLabel);
    if (snap.outs !== null && snap.outs !== undefined) bits.push(snap.outs + ' out' + (snap.outs === 1 ? '' : 's'));
    if (snap.count && snap.count.balls !== null && snap.count.strikes !== null) {
      bits.push(snap.count.balls + '-' + snap.count.strikes + ' count');
    }
    bits.push(scoreText(snap.score));
    if (snap.batter && snap.batter.name) bits.push('batter ' + snap.batter.name);
    if (snap.pitcher && snap.pitcher.name) bits.push('pitcher ' + snap.pitcher.name);
    if (snap.pitch && snap.pitch.pitcherPitches !== null && snap.pitch.pitcherPitches !== undefined) {
      bits.push(snap.pitch.pitcherPitches + ' pitches');
    }
    return bits.join(' · ');
  }

  /** One compact, timestamped line for the live-state strip. */
  function shortStateLine(snap) {
    if (!snap) return '';
    var bits = [];
    if (snap.inningLabel) bits.push(snap.inningLabel);
    if (snap.count && snap.count.balls !== null && snap.count.strikes !== null) {
      bits.push(snap.count.balls + '-' + snap.count.strikes);
    }
    if (snap.outs !== null && snap.outs !== undefined) bits.push(snap.outs + ' out');
    bits.push(scoreText(snap.score));
    if (snap.pitch && snap.pitch.pitcherPitches !== null && snap.pitch.pitcherPitches !== undefined) {
      bits.push('P ' + snap.pitch.pitcherPitches);
    }
    return bits.join(' · ');
  }

  /* Observation lag behind the official event timestamp, in ms (null when the
   * payload carries no timestamp). Positive = observed after MLB recorded it. */
  function latencyMs(snap, officialIso) {
    if (!snap) return null;
    var iso = officialIso || (snap.lastPlay && snap.lastPlay.endAt) || '';
    if (!iso) return null;
    var at = Date.parse(iso);
    if (isNaN(at)) return null;
    return snap.observedAt - at;
  }

  function signatureOf(snap) {
    if (!snap) return '';
    return [
      snap.inning, snap.half, snap.outs, snap.atBatIndex,
      snap.count && snap.count.balls, snap.count && snap.count.strikes,
      snap.score && snap.score.away, snap.score && snap.score.home,
      snap.pitch && snap.pitch.pitcherPitches, snap.pitch && snap.pitch.paPitches,
      snap.status && snap.status.code,
      snap.reviews && snap.reviews.length, snap.pending && snap.pending.length,
      snap.lastPlay && snap.lastPlay.index,
    ].join('|');
  }

  /* -------------------------------------------------------------- journal
   * One log per date in localStorage so a page refresh restores the captured
   * live state (latest snapshot per game + a bounded history of changes).
   * Bounded: 7 dates, 120 snapshots per game. Only observed payload data. */

  var Journal = (function () {
    var KEY_PREFIX = 'mlbp.state.';
    var INDEX_KEY = 'mlbp.state.index';
    var KEEP_DATES = 7;
    var MAX_SNAPSHOTS = 120;

    function storeGet(key) { try { return global.localStorage.getItem(key); } catch (e) { return null; } }
    function storeSet(key, value) { try { global.localStorage.setItem(key, value); return true; } catch (e) { return false; } }

    function empty(date) { return { v: 1, date: date, savedAt: Date.now(), games: {} }; }

    function normalize(payload, date) {
      if (!payload || typeof payload !== 'object' || payload.v !== 1) return empty(date);
      var games = {};
      if (payload.games && typeof payload.games === 'object') {
        Object.keys(payload.games).forEach(function (pk) {
          var rec = payload.games[pk] || {};
          games[pk] = {
            latest: rec.latest && rec.latest.v === 1 ? rec.latest : null,
            snapshots: Array.isArray(rec.snapshots) ? rec.snapshots.filter(function (s) { return s && s.v === 1; }).slice(-MAX_SNAPSHOTS) : [],
            matchup: typeof rec.matchup === 'string' ? rec.matchup : '',
          };
        });
      }
      return { v: 1, date: date, savedAt: Number(payload.savedAt) || Date.now(), games: games };
    }

    function load(date) {
      var raw = storeGet(KEY_PREFIX + date);
      if (!raw) return empty(date);
      try { return normalize(JSON.parse(raw), date); } catch (e) {
        global.console && global.console.warn && global.console.warn('[game-state] dropping malformed state journal for ' + date);
        return empty(date);
      }
    }

    function save(date, payload) {
      var ok = storeSet(KEY_PREFIX + date, JSON.stringify(payload));
      if (ok) {
        var index = [];
        try { index = JSON.parse(storeGet(INDEX_KEY) || '[]'); } catch (e) { index = []; }
        if (!Array.isArray(index)) index = [];
        if (index.indexOf(date) === -1) index.push(date);
        index.sort();
        while (index.length > KEEP_DATES) {
          var drop = index.shift();
          try { global.localStorage.removeItem(KEY_PREFIX + drop); } catch (e) { /* ignore */ }
        }
        storeSet(INDEX_KEY, JSON.stringify(index));
      }
      return ok;
    }

    /**
     * Record one snapshot; returns the stored record for that game.
     * opts.matchup  label ("SEA @ MIN") kept with the record
     * opts.append   false = only refresh `latest` (no history entry)
     * History entries are only appended when the baseball state actually
     * changed, so a 500 ms lane cannot fill the journal with duplicates.
     */
    function record(date, snapshot, options) {
      if (!snapshot || snapshot.gamePk === null || snapshot.gamePk === undefined) return null;
      var opts = options || {};
      var payload = load(date);
      var pk = String(snapshot.gamePk);
      var rec = payload.games[pk] || { latest: null, snapshots: [], matchup: '' };
      var previous = rec.latest;
      var changed = !previous || signatureOf(previous) !== signatureOf(snapshot);
      var append = opts.append === undefined ? changed : !!opts.append;
      if (append) {
        rec.snapshots.push(snapshot);
        if (rec.snapshots.length > MAX_SNAPSHOTS) rec.snapshots = rec.snapshots.slice(-MAX_SNAPSHOTS);
      }
      rec.latest = snapshot;
      if (opts.matchup) rec.matchup = opts.matchup;
      payload.games[pk] = rec;
      payload.savedAt = Date.now();
      save(date, payload);
      return rec;
    }

    return {
      load: load,
      save: save,
      record: record,
      normalize: normalize,
      empty: empty,
      MAX_SNAPSHOTS: MAX_SNAPSHOTS,
      KEEP_DATES: KEEP_DATES,
      KEY_PREFIX: KEY_PREFIX,
    };
  }());

  global.GameState = {
    STATE_FIELDS: STATE_FIELDS,
    PENDING_RULING_TYPES: PENDING_RULING_TYPES,
    MATERIAL_KEYS: MATERIAL_KEYS,
    capture: capture,
    diffSnapshots: diffSnapshots,
    stateLine: stateLine,
    shortStateLine: shortStateLine,
    scoreText: scoreText,
    latencyMs: latencyMs,
    signatureOf: signatureOf,
    pitcherPitchCount: pitcherPitchCount,
    paPitchCount: paPitchCount,
    officialStamp: officialStamp,
    isoToSec: isoToSec,
    Journal: Journal,
  };
}(window));
