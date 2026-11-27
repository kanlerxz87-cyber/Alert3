/* ============================================================================
 * official-scoring-log.js — official-scorer pending rulings & scoring changes
 *
 * A SEPARATE, append-only log. It shares no state and no code path with the
 * alert system: the Replay Feed calls OfficialScoring.ingest() on every poll to
 * record what the official payload says, and alerts are emitted elsewhere. A
 * failure in this module can never stop an alert, and an alert can never
 * rewrite this log.
 *
 * The MLB StatsAPI publishes no "this play was re-scored" marker, so the log is
 * built from consecutive observations of the official classification:
 *
 *   pending_open    play.result.eventType is os_ruling_pending_primary/_prior
 *                   (the API's own registry: description "Official Scorer
 *                   Ruling Pending").  Logged the second it is first observed.
 *   pending_resolve the same play later carries a decided eventType. Logged
 *                   with the exact official wording before and after.
 *   scoring_change  a completed play's official classification changed
 *                   (hit<->error, out<->hit, single->double, RBI/run changes).
 *   edit            wording / RBI / score changed with no reclassification.
 *   gap             a previously logged play vanished, or observation stopped
 *                   (page refreshed / closed) and resumed inside a live game.
 *
 * Everything is timestamped to the second (observedAt / observedAtISO), and the
 * log survives a refresh: localStorage per date (newest 30 dates, 500 events
 * per date) plus an optional server mirror (POST/GET /api/scoring-log in
 * server.mjs). On static hosting the mirror is simply absent — the local log
 * keeps working, exactly like the review feed log.
 * ==========================================================================*/
(function (global) {
  'use strict';

  var UI = global.UI || null;

  var KEY_PREFIX = 'mlbp.scoringlog.';
  var INDEX_KEY = 'mlbp.scoringlog.index';
  var KEEP_DATES = 30;
  var MAX_EVENTS = 500;
  var WRITE_COALESCE_MS = 1000;
  var SERVER = '/api/scoring-log';

  var PENDING_TYPES = ['os_ruling_pending_primary', 'os_ruling_pending_prior'];
  var HIT_TYPES = ['single', 'double', 'triple', 'home_run'];

  var state = {
    date: '',
    doc: null,
    saveTimer: null,
    server: { checked: false, available: false },
    listeners: [],
  };

  function esc(value) { return UI ? UI.esc(value) : String(value === null || value === undefined ? '' : value); }
  function nowISO(ms) {
    var d = new Date(typeof ms === 'number' ? ms : Date.now());
    if (isNaN(d.getTime())) return '';
    function p(n) { return (n < 10 ? '0' : '') + n; }
    var off = -d.getTimezoneOffset();
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' +
      p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) +
      (off >= 0 ? '+' : '-') + p(Math.floor(Math.abs(off) / 60)) + ':' + p(Math.abs(off) % 60);
  }

  function emptyDoc(date) {
    return {
      v: 1,
      date: date,
      savedAt: Date.now(),
      events: [],
      open: {},     // "gamePk:atBatIndex" -> event id of the still-open pending ruling
      plays: {},    // gamePk -> { atBatIndex -> classification }
      games: {},    // gamePk -> { matchup, lastSeen, lastObservedISO }
      gaps: [],
    };
  }

  function normalize(input, date) {
    if (!input || typeof input !== 'object' || input.v !== 1) return emptyDoc(date);
    var events = Array.isArray(input.events) ? input.events.filter(function (e) {
      return e && e.id && e.kind && e.gamePk !== undefined && e.gamePk !== null;
    }) : [];
    return {
      v: 1,
      date: date,
      savedAt: Number(input.savedAt) || Date.now(),
      events: events.slice(0, MAX_EVENTS),
      open: (input.open && typeof input.open === 'object') ? input.open : {},
      plays: (input.plays && typeof input.plays === 'object') ? input.plays : {},
      games: (input.games && typeof input.games === 'object') ? input.games : {},
      gaps: Array.isArray(input.gaps) ? input.gaps.slice(-60) : [],
    };
  }

  /* --------------------------------------------------------------- storage */

  function get(key) { try { return global.localStorage.getItem(key); } catch (e) { return null; } }
  function set(key, value) { try { global.localStorage.setItem(key, value); return true; } catch (e) { return false; } }

  function readIndex() {
    try {
      var parsed = JSON.parse(get(INDEX_KEY) || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) { return []; }
  }

  function writeIndex(dates) {
    var sorted = dates.slice().sort();
    while (sorted.length > KEEP_DATES) {
      try { global.localStorage.removeItem(KEY_PREFIX + sorted.shift()); } catch (e) { /* ignore */ }
    }
    set(INDEX_KEY, JSON.stringify(sorted));
  }

  function loadLocal(date) {
    var raw = get(KEY_PREFIX + date);
    if (!raw) return null;
    try { return normalize(JSON.parse(raw), date); } catch (e) {
      global.console && global.console.warn && global.console.warn('[official-scoring] dropping malformed local log for ' + date);
      return null;
    }
  }

  function saveLocal(date, doc) {
    if (!set(KEY_PREFIX + date, JSON.stringify(doc))) return false;
    var index = readIndex();
    if (index.indexOf(date) === -1) { index.push(date); writeIndex(index); }
    return true;
  }

  function isStaticHost() {
    var host = (global.location && global.location.hostname) || '';
    return /\.github\.io$/i.test(host);
  }

  function serverGet(date) {
    if (isStaticHost() || typeof global.fetch !== 'function') {
      state.server.checked = true;
      state.server.available = false;
      return Promise.resolve(null);
    }
    return global.fetch(SERVER + '?date=' + encodeURIComponent(date), { cache: 'no-store', credentials: 'same-origin' })
      .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
      .then(function (data) { state.server.checked = true; state.server.available = true; return normalize(data, date); })
      .catch(function () { state.server.checked = true; state.server.available = false; return null; });
  }

  function serverPost(date) {
    if (isStaticHost() || typeof global.fetch !== 'function') return;
    if (state.server.checked && !state.server.available) return;
    var doc = state.doc && state.doc.date === date ? state.doc : loadLocal(date);
    if (!doc) return;
    global.fetch(SERVER, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(doc),
    }).then(function (res) {
      state.server.available = res.ok;
    }).catch(function () { state.server.available = false; });
  }

  function scheduleSave() {
    if (state.saveTimer) return;
    state.saveTimer = setTimeout(function () {
      state.saveTimer = null;
      if (state.doc) serverPost(state.doc.date);
    }, WRITE_COALESCE_MS);
  }

  /** Append-only merge: events are keyed by id, never overwritten in place. */
  function merge(a, b, date) {
    var left = normalize(a, date);
    var right = normalize(b, date);
    var seen = Object.create(null);
    var events = [];
    left.events.concat(right.events).forEach(function (e) {
      if (!e || !e.id) return;
      if (seen[e.id]) return;
      seen[e.id] = true;
      events.push(e);
    });
    events.sort(function (x, y) { return (Number(x.at) || 0) - (Number(y.at) || 0); });

    var open = Object.assign({}, left.open, right.open);
    Object.keys(open).forEach(function (key) {
      var id = open[key];
      var found = events.some(function (e) { return e.id === id && e.status !== 'closed' && e.kind === 'pending_open'; });
      if (!found) delete open[key];
    });

    var plays = Object.assign({}, left.plays);
    Object.keys(right.plays).forEach(function (pk) {
      plays[pk] = Object.assign({}, plays[pk] || {}, right.plays[pk] || {});
    });

    var games = Object.assign({}, left.games, right.games);

    var gaps = left.gaps.slice();
    right.gaps.forEach(function (g) {
      if (typeof g === 'string' && gaps.indexOf(g) === -1) gaps.push(g);
    });

    return {
      v: 1,
      date: date,
      savedAt: Date.now(),
      events: events.slice(-MAX_EVENTS),
      open: open,
      plays: plays,
      games: games,
      gaps: gaps.slice(-60),
    };
  }

  /** load(date) -> Promise<doc>  (local merged with the optional server mirror) */
  function load(date) {
    var local = loadLocal(date);
    state.date = date;
    return serverGet(date).then(function (remote) {
      var doc = local && remote ? merge(local, remote, date) : (local || remote || emptyDoc(date));
      state.doc = doc;
      saveLocal(date, doc);
      return doc;
    }).catch(function () {
      var doc = local || emptyDoc(date);
      state.doc = doc;
      return doc;
    });
  }

  /* ------------------------------------------------------------- classify */

  function classify(play) {
    var result = (play && play.result) || {};
    var about = (play && play.about) || {};
    var count = (play && play.count) || {};
    var errors = 0;
    ((play && play.runners) || []).forEach(function (r) {
      var d = r && r.details;
      if (d && /error/.test(String(d.eventType || ''))) errors += 1;
    });
    var half = about.halfInning || (about.isTopInning === false ? 'bottom' : 'top');
    var inning = Number(about.inning) || null;
    return {
      atBatIndex: Number(about.atBatIndex),
      inningLabel: inning ? ((String(half).toLowerCase().indexOf('top') === 0 ? 'Top ' : 'Bot ') + inning) : '',
      eventType: result.eventType || '',
      description: result.description || '',
      isOut: result.isOut === true,
      outs: typeof count.outs === 'number' ? count.outs : null,
      rbi: typeof result.rbi === 'number' ? result.rbi : null,
      awayScore: typeof result.awayScore === 'number' ? result.awayScore : null,
      homeScore: typeof result.homeScore === 'number' ? result.homeScore : null,
      isHit: HIT_TYPES.indexOf(result.eventType) !== -1,
      errors: errors,
      batter: (play && play.matchup && play.matchup.batter && play.matchup.batter.fullName) || '',
      pitcher: (play && play.matchup && play.matchup.pitcher && play.matchup.pitcher.fullName) || '',
      isPending: PENDING_TYPES.indexOf(result.eventType) !== -1,
      isComplete: about.isComplete === true,
    };
  }

  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

  function summarize(kind, before, after) {
    if (kind === 'pending_open') return 'Official scorer ruling pending: ' + (after.eventType || 'pending');
    if (kind === 'pending_resolve') {
      return 'Pending ruling decided: ' + (before.eventType || 'pending') + ' → ' + (after.eventType || '');
    }
    if (kind === 'scoring_change') {
      var bits = [(before.eventType || '—') + ' → ' + (after.eventType || '—')];
      if (before.isOut !== after.isOut) bits.push('out ' + before.isOut + ' → ' + after.isOut);
      if (before.rbi !== after.rbi) bits.push('RBI ' + before.rbi + ' → ' + after.rbi);
      if (before.awayScore !== after.awayScore || before.homeScore !== after.homeScore) {
        bits.push('score ' + before.awayScore + '–' + before.homeScore + ' → ' + after.awayScore + '–' + after.homeScore);
      }
      if (before.errors !== after.errors) bits.push(plural(before.errors, 'error') + ' → ' + plural(after.errors, 'error'));
      return bits.join(' · ');
    }
    if (kind === 'edit') return 'Official wording/details edited — no reclassification';
    return kind;
  }

  /* ---------------------------------------------------------------- ingest */

  function addEvent(doc, event) {
    if (!event || !event.id) return null;
    var existing = null;
    doc.events.forEach(function (e) { if (e.id === event.id) existing = e; });
    if (existing) {
      /* A pending ruling's closing event rewrites its own row's status only;
       * the opening observation itself is never overwritten. */
      if (existing.kind === 'pending_open' && event.status === 'closed') {
        existing.status = 'closed';
        existing.closedAt = event.at;
        existing.closedAtISO = event.atISO;
        existing.after = event.after || null;
        return null;
      }
      return null;
    }
    doc.events.push(event);
    if (doc.events.length > MAX_EVENTS) doc.events = doc.events.slice(-MAX_EVENTS);
    return event;
  }

  /**
   * ingest({ date, gamePk, matchup, plays, url })
   * Records pending openings/closings, scoring changes and edits.
   * Returns { added: [events], open: [open pending events] } for callers that
   * want to alert — this module itself never plays a sound.
   */
  function ingest(input) {
    var options = input || {};
    var date = options.date;
    if (!date) return { added: [], open: [] };
    if (!state.doc || state.doc.date !== date) state.doc = loadLocal(date) || emptyDoc(date);
    var doc = state.doc;
    var gamePk = String(options.gamePk);
    var at = typeof options.observedAt === 'number' ? options.observedAt : Date.now();
    var atISO = nowISO(at);
    var added = [];

    var previous = doc.plays[gamePk] || null;
    var next = {};
    var rows = [];

    (options.plays || []).forEach(function (play) {
      if (!play) return;
      var c = classify(play);
      if (c.atBatIndex === null || isNaN(c.atBatIndex)) return;
      if (!c.isComplete && !c.isPending) return;
      next[c.atBatIndex] = c;
      rows.push(c);
    });

    rows.forEach(function (after) {
      var before = previous ? previous[after.atBatIndex] : null;
      var key = gamePk + ':' + after.atBatIndex;
      if (!before && !after.isPending) return;

      /* A play observed for the first time that is already flagged pending. */
      if (after.isPending) {
        var openId = doc.open[key];
        if (!openId) {
          var openEvent = {
            id: gamePk + ':' + after.atBatIndex + ':pending:' + at,
            kind: 'pending_open',
            status: 'open',
            gamePk: Number(gamePk),
            matchup: options.matchup || '',
            atBatIndex: after.atBatIndex,
            inningLabel: after.inningLabel,
            batter: after.batter,
            pitcher: after.pitcher,
            at: at,
            atISO: atISO,
            official: { eventType: after.eventType, description: after.description, score: { away: after.awayScore, home: after.homeScore } },
            before: null,
            after: after,
            summary: summarize('pending_open', null, after),
            attribution: 'MLB StatsAPI eventTypes: os_ruling_pending_primary / os_ruling_pending_prior',
            source: options.url || '',
          };
          addEvent(doc, openEvent);
          doc.open[key] = openEvent.id;
          added.push(openEvent);
        }
        return;
      }

      if (before && before.isPending) {
        var closeId = doc.open[key];
        var target = closeId ? doc.events.filter(function (e) { return e.id === closeId; })[0] : null;
        var resolved = {
          id: (target ? target.id : key + ':pending') + ':resolved',
          kind: 'pending_resolve',
          status: 'closed',
          gamePk: Number(gamePk),
          matchup: options.matchup || '',
          atBatIndex: after.atBatIndex,
          inningLabel: after.inningLabel,
          batter: after.batter,
          pitcher: after.pitcher,
          at: at,
          atISO: atISO,
          official: { eventType: after.eventType, description: after.description, score: { away: after.awayScore, home: after.homeScore } },
          before: before,
          after: after,
          summary: summarize('pending_resolve', before, after),
          attribution: 'Official scorer ruling published in the live feed',
          source: options.url || '',
        };
        if (target) {
          target.status = 'closed';
          target.closedAt = at;
          target.closedAtISO = atISO;
          target.after = after;
          delete doc.open[key];
        }
        if (addEvent(doc, resolved)) added.push(resolved);
        return;
      }

      if (!before) return;

      var reclassified = before.eventType !== after.eventType ||
        before.isOut !== after.isOut ||
        (before.outs !== null && after.outs !== null && before.outs !== after.outs) ||
        before.rbi !== after.rbi ||
        before.awayScore !== after.awayScore || before.homeScore !== after.homeScore ||
        before.errors !== after.errors;

      if (reclassified) {
        var change = {
          id: gamePk + ':' + after.atBatIndex + ':change:' + before.eventType + '>' + after.eventType + ':' + at,
          kind: 'scoring_change',
          status: 'reclassified',
          gamePk: Number(gamePk),
          matchup: options.matchup || '',
          atBatIndex: after.atBatIndex,
          inningLabel: after.inningLabel,
          batter: after.batter,
          pitcher: after.pitcher,
          at: at,
          atISO: atISO,
          official: { eventType: after.eventType, description: after.description, score: { away: after.awayScore, home: after.homeScore } },
          before: before,
          after: after,
          summary: summarize('scoring_change', before, after),
          attribution: 'Official scorer / Elias / club review — see mlb.com/official-information/scoring-changes',
          source: options.url || '',
        };
        if (addEvent(doc, change)) added.push(change);
        return;
      }

      if (before.description !== after.description) {
        var edit = {
          id: gamePk + ':' + after.atBatIndex + ':edit:' + at,
          kind: 'edit',
          status: 'edited',
          gamePk: Number(gamePk),
          matchup: options.matchup || '',
          atBatIndex: after.atBatIndex,
          inningLabel: after.inningLabel,
          batter: after.batter,
          pitcher: after.pitcher,
          at: at,
          atISO: atISO,
          official: { eventType: after.eventType, description: after.description, score: { away: after.awayScore, home: after.homeScore } },
          before: before,
          after: after,
          summary: summarize('edit', before, after),
          attribution: 'Official wording changed without reclassification — logged, not corrected',
          source: options.url || '',
        };
        if (addEvent(doc, edit)) added.push(edit);
      }
    });

    /* A logged play that disappeared from the payload: flag it, never delete. */
    if (previous) {
      Object.keys(previous).forEach(function (index) {
        if (next[index]) return;
        var note = gamePk + ':' + index + ':vanished:' + at;
        if (doc.gaps.indexOf(note) === -1) doc.gaps.push(note);
      });
    }

    doc.plays[gamePk] = next;
    doc.games[gamePk] = {
      matchup: options.matchup || (doc.games[gamePk] && doc.games[gamePk].matchup) || '',
      lastSeen: at,
      lastObservedISO: atISO,
      status: options.status || '',
    };

    if (added.length) {
      doc.savedAt = at;
      saveLocal(date, doc);
      scheduleSave();
      state.listeners.forEach(function (fn) {
        try { fn(added.slice(), doc); } catch (e) {
          global.console && global.console.warn && global.console.warn('[official-scoring] listener failed', e);
        }
      });
    } else if (!doc.savedAt) {
      doc.savedAt = at;
      saveLocal(date, doc);
    }
    return { added: added, open: openPending(date) };
  }

  /** Flag a restart/observation gap for a live game (page refreshed or hidden). */
  function noteGap(date, gamePk, matchup, reason) {
    if (!date || !gamePk) return;
    if (!state.doc || state.doc.date !== date) state.doc = loadLocal(date) || emptyDoc(date);
    var text = gamePk + ': gap ' + nowISO() + (reason ? ' — ' + reason : '');
    if (state.doc.gaps.indexOf(text) !== -1) return;
    state.doc.gaps.push(text);
    state.doc.gaps = state.doc.gaps.slice(-60);
    saveLocal(date, state.doc);
  }

  /* ----------------------------------------------------------------- reads */

  function docFor(date) {
    if (state.doc && state.doc.date === date) return state.doc;
    return loadLocal(date) || emptyDoc(date);
  }

  function events(date) { return docFor(date).events.slice(); }

  function openPending(date) {
    var doc = docFor(date);
    return doc.events.filter(function (e) { return e.kind === 'pending_open' && e.status !== 'closed'; });
  }

  function summary(date) {
    var list = events(date);
    var open = list.filter(function (e) { return e.kind === 'pending_open' && e.status !== 'closed'; }).length;
    return {
      total: list.length,
      pendingOpen: open,
      pendingResolved: list.filter(function (e) { return e.kind === 'pending_resolve'; }).length,
      scoringChanges: list.filter(function (e) { return e.kind === 'scoring_change'; }).length,
      edits: list.filter(function (e) { return e.kind === 'edit'; }).length,
      games: Object.keys(docFor(date).games).length,
      gaps: docFor(date).gaps.length,
      savedAt: docFor(date).savedAt,
    };
  }

  function onChange(fn) { if (typeof fn === 'function') state.listeners.push(fn); }

  /* ----------------------------------------------------------------- render */

  function fmtTime(iso, at) {
    if (at) return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    if (!iso) return '';
    return iso.replace('T', ' ').slice(0, 19);
  }

  function officialLine(side, row) {
    if (!row) return '<div class="osc-none">not observed</div>';
    var bits = [];
    bits.push('<span class="osc-type">' + esc(row.eventType || '—') + '</span>');
    if (row.description) bits.push('<div class="osc-desc">' + esc(row.description) + '</div>');
    var meta = [];
    if (row.awayScore !== null && row.awayScore !== undefined) meta.push('score ' + row.awayScore + '–' + row.homeScore);
    if (row.rbi !== null && row.rbi !== undefined) meta.push('RBI ' + row.rbi);
    if (row.isOut !== null && row.isOut !== undefined) meta.push(row.isOut ? 'scored an out' : 'no out');
    if (row.errors) meta.push(plural(row.errors, 'error'));
    if (meta.length) bits.push('<div class="osc-meta">' + esc(meta.join(' · ')) + '</div>');
    return '<div class="osc-official"><span class="osc-side">' + esc(side) + '</span>' + bits.join('') + '</div>';
  }

  function rowHtml(event) {
    var cls = 'osc-row osc-' + esc(event.kind);
    if (event.status === 'open') cls += ' osc-open';
    var heading =
      event.kind === 'pending_open' ? '📝 Official scorer ruling pending' :
      event.kind === 'pending_resolve' ? '✅ Pending ruling decided' :
      event.kind === 'scoring_change' ? '✏️ Official scoring change' : '🖊️ Official wording edit';
    var title = '<div class="osc-head"><span class="osc-title">' + heading + '</span>' +
      (event.matchup ? '<a class="osc-game" href="game.html?gamePk=' + encodeURIComponent(event.gamePk) +
        '&date=' + encodeURIComponent(docFor(state.date).date) + '">' + esc(event.matchup) + '</a>' : '') +
      '<span class="osc-time" title="Observed at ' + esc(event.atISO || '') + '">' + esc(fmtTime(event.atISO, event.at)) + '</span>' +
      (event.inningLabel ? '<span class="osc-inning">' + esc(event.inningLabel) + '</span>' : '') +
      (event.status === 'open' ? '<span class="chip chip-warn">open</span>' : '') +
      '<span class="osc-src">' + (event.source
        ? '<a href="' + esc(event.source) + '" target="_blank" rel="noopener" title="Official MLB StatsAPI source">MLB API ↗</a>'
        : '') + '</span></div>';
    var players = (event.batter ? 'Batter ' + esc(event.batter) : '') +
      (event.pitcher ? ' · Pitcher ' + esc(event.pitcher) : '');
    var body = '<div class="osc-body">' +
      '<div class="osc-pair">' + officialLine('Before', event.before) + officialLine('After', event.after) + '</div>' +
      '<div class="osc-summary">' + esc(event.summary || '') + '</div>' +
      (players ? '<div class="osc-players">' + players + '</div>' : '') +
      '<div class="osc-attr">' + esc(event.attribution || '') + '</div>' +
      '</div>';
    return '<div class="' + cls + '">' + title + body + '</div>';
  }

  /**
   * render(container, date, opts)
   * opts.empty  text for the empty state
   * Never throws into the caller's poll loop: the Replay Feed wraps this call.
   */
  function render(container, date, opts) {
    if (!container) return;
    var options = opts || {};
    state.date = date;
    var doc = docFor(date);
    var s = summary(date);
    var list = doc.events.slice().sort(function (a, b) { return (Number(b.at) || 0) - (Number(a.at) || 0); });

    var head = '<div class="osc-head-bar">' +
      '<div class="osc-stats">' +
        '<span class="osc-stat"><b>' + s.pendingOpen + '</b> pending now</span>' +
        '<span class="osc-stat"><b>' + s.pendingResolved + '</b> decided</span>' +
        '<span class="osc-stat"><b>' + s.scoringChanges + '</b> scoring changes</span>' +
        '<span class="osc-stat"><b>' + s.edits + '</b> wording edits</span>' +
        '<span class="osc-stat"><b>' + s.games + '</b> games logged</span>' +
        (s.gaps ? '<span class="osc-stat osc-gap-count"><b>' + s.gaps + '</b> gaps</span>' : '') +
      '</div>' +
      '<div class="osc-actions">' +
        '<button class="btn btn-ghost" id="osc-export">Export JSON</button>' +
        '<span class="osc-persist">' + (state.server.available
          ? 'saved to this browser + shared server log'
          : 'saved to this browser (survives refresh)') +
          (s.savedAt ? ' · last write ' + esc(fmtTime('', s.savedAt)) : '') + '</span>' +
      '</div>' +
    '</div>';

    var openList = doc.events.filter(function (e) { return e.kind === 'pending_open' && e.status !== 'closed'; });
    var openBlock = openList.length
      ? '<div class="osc-open-block"><h4>Open right now — at-bats without a final scoring call</h4>' +
        openList.map(function (e) {
          return '<div class="osc-open-row"><a href="game.html?gamePk=' + encodeURIComponent(e.gamePk) +
            '&date=' + encodeURIComponent(date) + '"><b>' + esc(e.matchup || '') + '</b></a>' +
            '<span>' + esc(e.inningLabel || '') + '</span>' +
            '<span>' + esc((e.after && e.after.description) || e.summary || '') + '</span>' +
            '<span class="osc-time">since ' + esc(fmtTime(e.atISO, e.at)) + '</span></div>';
        }).join('') + '</div>'
      : '';

    var gapBlock = doc.gaps.length
      ? '<div class="osc-gaps"><h4>Observation gaps (flagged, not corrected)</h4>' +
        doc.gaps.slice(-8).map(function (g) { return '<div class="osc-gap">⚠️ ' + esc(g) + '</div>'; }).join('') +
        '</div>'
      : '';

    container.innerHTML = head + openBlock +
      (list.length ? '<div class="osc-list">' + list.map(rowHtml).join('') + '</div>'
        : '<div class="osc-empty">' + esc(options.empty ||
          'No official-scorer pending rulings or scoring changes observed for this date yet. ' +
          'A pending ruling is logged the second the API flags the play, with the official wording before and after.') + '</div>') +
      gapBlock;

    var exportBtn = container.querySelector('#osc-export');
    if (exportBtn) exportBtn.addEventListener('click', function () { download(date); });
  }

  /* ---------------------------------------------------------------- export */

  function toJSON(date) {
    var doc = docFor(date);
    return JSON.stringify({
      source: 'MLB StatsAPI (statsapi.mlb.com) — observed client-side',
      date: date,
      exportedAt: nowISO(),
      events: doc.events,
      open: doc.open,
      gaps: doc.gaps,
      games: doc.games,
    }, null, 2);
  }

  function toCSV(date) {
    var rows = [[
      'observed_at', 'observed_at_iso', 'kind', 'status', 'gamePk', 'matchup', 'inning', 'batter', 'pitcher',
      'before_eventType', 'before_description', 'before_score', 'before_rbi',
      'after_eventType', 'after_description', 'after_score', 'after_rbi', 'summary', 'attribution', 'source',
    ]];
    function q(v) {
      if (v === null || v === undefined) return '';
      var s = String(v).replace(/"/g, '""');
      return /[",\n]/.test(s) ? '"' + s + '"' : s;
    }
    events(date).forEach(function (e) {
      var b = e.before || {};
      var a = e.after || {};
      rows.push([
        e.at || '', e.atISO || '', e.kind, e.status, e.gamePk, e.matchup || '', e.inningLabel || '',
        e.batter || '', e.pitcher || '',
        b.eventType || '', b.description || '',
        (b.awayScore !== undefined && b.awayScore !== null ? b.awayScore + '–' + b.homeScore : ''),
        b.rbi === undefined || b.rbi === null ? '' : b.rbi,
        a.eventType || '', a.description || '',
        (a.awayScore !== undefined && a.awayScore !== null ? a.awayScore + '–' + a.homeScore : ''),
        a.rbi === undefined || a.rbi === null ? '' : a.rbi,
        e.summary || '', e.attribution || '', e.source || '',
      ].map(q).join(','));
    });
    return rows.join('\n');
  }

  function download(date) {
    try {
      var text = toJSON(date);
      var blob = new global.Blob([text], { type: 'application/json' });
      var url = global.URL.createObjectURL(blob);
      var a = global.document.createElement('a');
      a.href = url;
      a.download = 'official-scoring-log-' + date + '.json';
      global.document.body.appendChild(a);
      a.click();
      global.document.body.removeChild(a);
      setTimeout(function () { global.URL.revokeObjectURL(url); }, 2000);
      return text;
    } catch (e) {
      return null;
    }
  }

  global.OfficialScoring = {
    load: load,
    ingest: ingest,
    noteGap: noteGap,
    events: events,
    openPending: openPending,
    summary: summary,
    merge: merge,
    normalize: normalize,
    emptyDoc: emptyDoc,
    classify: classify,
    render: render,
    toJSON: toJSON,
    toCSV: toCSV,
    download: download,
    onChange: onChange,
    docFor: docFor,
    nowISO: nowISO,
    PENDING_TYPES: PENDING_TYPES,
    KEY_PREFIX: KEY_PREFIX,
    MAX_EVENTS: MAX_EVENTS,
    KEEP_DATES: KEEP_DATES,
    state: state,
  };
}(window));
