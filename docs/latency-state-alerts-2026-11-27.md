# Latency, alert sound, live game state and the official-scoring log — 2026-11-27

Session `arena-80d92e25` · branch `arena/80d92e25-alert3` (branched from `main` @
`8afbecc`) · live site: [`kanlerxz87-cyber.github.io/Alert3`](https://kanlerxz87-cyber.github.io/Alert3/)

Four pieces of work, each with the code that implements it, the check that proves it, and — where a
claim cannot be confirmed from an official source — an honest "unverified" flag on
[`flagged.html` §17](https://kanlerxz87-cyber.github.io/Alert3/flagged.html#latency-2026-11-27).

> **Offseason note.** MLB has no live games on 2026-11-27 (the 2026 season ended 2026-10-28; the
> first upcoming official date is 2027-02-19). Everything below is verified with **fixtures whose
> values are copied verbatim from official StatsAPI responses** and with **stubbed Web Audio**, not
> with a game on the field. This is the same limitation the repository already publishes as F-05 in
> §16, and it is re-stated in §17 rather than papered over.

## 1. Latency — three lanes instead of one loop

**Before.** One 250 ms loop fetched the *fully hydrated* schedule
(`hydrate=probablePitcher,linescore,decisions,review`) on every cycle and then a `playByPlay` plus a
counters request per due game. The slowest request in the loop set everyone's cadence: a review
visible in a 2 KB status field still waited for a play-by-play payload, and the hydrated schedule was
re-downloaded every 250 ms.

**Now** (`assets/js/reviews-feed.js`):

| Lane | Interval | Request | Why |
| --- | --- | --- | --- |
| status | 125 ms | [`/api/v1/schedule`](https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-08-28&fields=dates,games,gamePk,status,statusCode,detailedState) with `fields=…gamePk,status…`, no hydrations | MLB flips `statusCode` the instant a review is *called*, before any play text exists |
| state | 500 ms | [`/api/v1.1/game/{pk}/feed/live`](https://statsapi.mlb.com/api/v1.1/game/824638/feed/live?fields=gameData,status,liveData,linescore,plays,currentPlay,count,outs) with a linescore/currentPlay/counter projection | whole official game state in a few KB |
| play | 1000 ms | [`/api/v1/game/{pk}/playByPlay`](https://statsapi.mlb.com/api/v1/game/823096/playByPlay?fields=allPlays,about,atBatIndex,result,eventType,reviewDetails,playEvents) | `reviewDetails`, `os_ruling_pending_*`, classification diffs |

A status flip, a score change, a new at-bat, a new play or a pending ruling fires an **immediate**
out-of-band fetch on the other two lanes, so the play lane's 1 s is a worst case, not the norm.

Measures that keep the extra requests honest:

- **Lean projections.** The loop's routing call asks only for `gamePk` + `status` + teams/score; the
  old hydrated request is gone from the loop entirely (asserted by
  `G-7: the play lane asks for the lean schedule projection`).
- **Bounded concurrency** (8) and **one** shared audio/cooldown path.
- **Adaptive throttle.** HTTP 429 (or API quiet window) doubles the lane interval up to ×6 and decays
  back; the status line shows `throttled xN`. The API client's default quiet window was shortened
  from 60 s to 15 s (clamped 1 s–2 min) so a single rate-limit reply cannot black out alerts.
- **Pause when hidden**, unchanged.

**Measured, not claimed.** Each response's own `metaData.timeStamp` (documented by the StatsAPI's
`feed/live/diffPatch` as `MMDDYYYY_HHMMSS`) is converted to ms and compared with the receive time:

```text
data age = observedAt − timecodeToMs(metaData.timeStamp)      // live games only
pipeline = (metaData.wait + metaData.logicWait) × 1000        // MLB's own fields, reported as-is
```

The median/p90 data age and the status sweeps' **detection period** (the gap between the last completed
sweep and the one that first saw a flip — the sweep interval plus one round trip; nothing finer is
honest client-side without a server clock) are shown in the top bar and in the state monitor. When no timestamp exists the page shows `age —`; when a payload is older than ten minutes it
says `stale` instead of counting up (a Final feed stops updating, which is why only live samples are
counted at all). `docs/`-level sources: [`feed/live` metaData](https://statsapi.mlb.com/api/v1.1/game/764333/feed/live?fields=metaData,timeStamp,wait,logicWait) ·
[diffPatch endpoint documentation](https://statsapi.mlb.com/api/v1.1/game/531321/feed/live/diffPatch?startTimecode=20180823_193704&endTimecode=20180823_193711).

**Implemented but not switched on:** `MLB.gameFeedPatch()` and `MLB.playByPlaySince()` (timecode
incremental feeds, `MMDDYYYY_HHMMSS`, both directions of the conversion tested). The diffPatch
response can be either RFC-6902 operations *or* a whole feed object, and its paths address fields the
render path re-derives, so the lanes stay on whole payloads until that can be verified against a live
game. Flagged as §17 L-3.

## 2. Alert sound — one pleasant three-second cue

`assets/js/alert-audio.js` renders the cue that `reviews-feed.js` plays for every alert row:

- **Three seconds**, eight soft sine droplets (G5, C6, D6, E6, G6 → C5/E5/G5 settle), frequencies
  below 1.6 kHz so the timbre stays soft, a rising-resonance low-pass, a **0.31 s echo grid** whose
  repeats land on whole multiples (0.31 / 0.62 s) instead of smearing, a `tanh` saturation stage to
  round the peaks, and envelopes that decay to 1e-4 rather than 0 — no clicks.
- **2.5 s cooldown**: a burst of simultaneous events is one sound, never a machine-gun.
- Same cue for every category (review, pending, scoring, runs at risk) — one sound to learn, and no
  category is louder than another.
- **Test** button: always audible on demand, ignores the toggle and the cooldown, and reports its
  result in the status line. **Sound On/Off** (persisted; turning it on plays the cue once because
  the click is the user gesture an `AudioContext` requires) and a **volume slider** (persisted).
- Routine ABS pitch challenges stay silent by default (that behaviour is unchanged and still asserted),
  but the new **chime ABS** checkbox opts in so that *every* row that lands in the feed makes a sound.

Verified by `G-5: the cue schedules a soft sine bloom inside three seconds (audio graph inspected)` —
the test stubs `AudioContext`, records every scheduled parameter and asserts: ≥ 6 oscillators, all
oscillator types `sine`, max frequency ≤ 1600 Hz, last `stop` ≤ 3.0 s, every gain envelope ramping to
a non-zero floor. That proves **what is scheduled**, not how it sounds — flagged as §17 A-1.

## 3. Live game state, captured to the second

`assets/js/game-state.js`:

- `capture()` → one snapshot: official status (`statusCode`, `detailedState`, `reason`),
  inning/half/outs/count, score (with hits/errors when published), batter, pitcher, all three
  baserunners, on-deck/in-hole, official pitch counters (`stats.pitching.numberOfPitches` /
  `pitchesThrown` when the payload has them, otherwise `null` — never derived from a partial play
  list), the plate-appearance pitch count from `playEvents`, the last recorded play with its
  `about.endTime`, and the payload's own review/ABS/pending state.
- `observedAt` + `observedAtISO` (second precision, local offset) on every snapshot.
- `diffSnapshots(prev, next)` → the exact before → after pairs (status, score, outs, count, inning,
  at-bat, batter, pitcher, runners, pitch count, recorded play, pending rulings, reviews). A first
  snapshot reports nothing: there is no "before" to invent.
- `stateLine()` → the exact official wording, one line.
- `Journal` → per-date localStorage store (newest 7 dates, 120 snapshots per game) that appends
  **only when the state actually changed**, restores the last captured state and the change history
  after a refresh, and records an **observation gap** for a live game whose capture is older than
  15 s (the page was closed; it does not pretend it was watching).

Every game on the slate gets a state card in the new **Live game state** monitor: matchup, official
status + code, score, inning/outs/count, batter/pitcher, pitch counts, bases, when it was captured,
the payload's age, and the last four captured changes with their before → after values and wall-clock
time. The feed's new **🕒 Live State** tab lists the same changes as feed rows stamped to the second.

Tests: `G-4` (capture fields, absent values stay null, official pitch counter, diffs, wording, age
arithmetic, timecode conversion, journal append-on-change + reload), `G-7` (snapshot per live game,
monitor rendered, journal written).

## 4. Official-scorer pending rulings and scoring changes — separate and persistent

See README §"Official-scorer pending rulings and scoring changes — a separate section" for the
event table. The design point is **isolation**:

| Concern | Alerts (existing) | Official-scoring log (new) |
| --- | --- | --- |
| Module | `reviews-feed.js` + `feed-log.js` | `official-scoring-log.js` ([module](https://github.com/kanlerxz87-cyber/Alert3/blob/main/assets/js/official-scoring-log.js)) |
| Storage key | `mlbp.feedlog.<date>` | `mlbp.scoringlog.<date>` (30 dates, 500 events) ([store](https://github.com/kanlerxz87-cyber/Alert3/blob/main/assets/js/official-scoring-log.js)) |
| Server | `POST/GET /api/feed-log` | `POST/GET /api/scoring-log`, own files in `data/` ([server.mjs](https://github.com/kanlerxz87-cyber/Alert3/blob/main/server.mjs)) |
| Render | feed rows | its own section below the feed ([module](https://github.com/kanlerxz87-cyber/Alert3/blob/main/assets/js/official-scoring-log.js)) |
| Failure isolation | — | `ingest()` is wrapped: a throw is flagged on the feed and **alerts keep firing** ([test](https://github.com/kanlerxz87-cyber/Alert3/blob/main/tools/smoke-test.mjs)) |

Both stores are shipped repo files, i.e. the implementation itself is the first-party source:
[feed-log.js](https://github.com/kanlerxz87-cyber/Alert3/blob/main/assets/js/feed-log.js) ·
[official-scoring-log.js](https://github.com/kanlerxz87-cyber/Alert3/blob/main/assets/js/official-scoring-log.js) ·
[server.mjs](https://github.com/kanlerxz87-cyber/Alert3/blob/main/server.mjs).

The log is **append-only**: an event is keyed by id and never overwritten; a pending ruling's opening
row is *closed* (`status`, `closedAt`, `after`) when the decision lands, and the decision is a second
row with the official wording on both sides. A refresh restores it from `localStorage` (and merges the
server copy when `server.mjs` is running). Export is JSON and CSV.

Tests: `G-6` (open → decide → reclassify, exact before/after wording, append-only, survives a refresh
with a fresh page reading the same storage, export), `G-7: an alert still fires when the
official-scoring log throws (isolation)`, and the server contract in
`tools/restoration-check.mjs` (`POST /api/scoring-log`, round-trip, append-only, open map pruned).

## Commands run

| Command | Result | Source |
| --- | --- | --- |
| `node tools/smoke-test.mjs` | **89 passed, 0 failed** (66 existing + 23 new) | [smoke-test.mjs](https://github.com/kanlerxz87-cyber/Alert3/blob/main/tools/smoke-test.mjs) |
| `node tests/jsdom-render-test.mjs` | **56 checks passed** (50 existing + 6 new) | [jsdom-render-test.mjs](https://github.com/kanlerxz87-cyber/Alert3/blob/main/tests/jsdom-render-test.mjs) |
| `node tests/run-all.mjs` | syntax OK · 60 local references · provenance 148 HTML / 299 Markdown rows · 8 bindings · jsdom OK — all PASS | [run-all.mjs](https://github.com/kanlerxz87-cyber/Alert3/blob/main/tests/run-all.mjs) |
| `node tools/restoration-check.mjs` | **ALL CHECKS PASSED** (incl. the new scoring-log endpoints and the three new scripts served) | [restoration-check.mjs](https://github.com/kanlerxz87-cyber/Alert3/blob/main/tools/restoration-check.mjs) |
| `node tests/props-provenance-test.mjs` | **5 passed, 0 failed** | [props-provenance-test.mjs](https://github.com/kanlerxz87-cyber/Alert3/blob/main/tests/props-provenance-test.mjs) |

## Sources

- [MLB StatsAPI schedule projection](https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-08-28&fields=dates,games,gamePk,status,statusCode,detailedState)
- [MLB `feed/live`](https://statsapi.mlb.com/api/v1.1/game/824638/feed/live) ·
  [`metaData` projection](https://statsapi.mlb.com/api/v1.1/game/764333/feed/live?fields=metaData,timeStamp,wait,logicWait)
- [MLB `playByPlay` 824638](https://statsapi.mlb.com/api/v1/game/824638/playByPlay) ·
  [823096](https://statsapi.mlb.com/api/v1/game/823096/playByPlay) ·
  [823180](https://statsapi.mlb.com/api/v1/game/823180/playByPlay)
- [MLB `gameStatus` registry](https://statsapi.mlb.com/api/v1/gameStatus) ·
  [MLB `eventTypes` registry](https://statsapi.mlb.com/api/v1/eventTypes)
- [MLB official scoring changes](https://www.mlb.com/official-information/scoring-changes)
- [StatsAPI diffPatch swagger entry](https://statsapi.mlb.com/api/v1.1/game/531321/feed/live/diffPatch?startTimecode=20180823_193704&endTimecode=20180823_193711)
