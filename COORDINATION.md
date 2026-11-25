# COORDINATION.md — shared task board (Alert3 session)

Repo: `Alert3` (`/home/user/Alert3`) — this session. Site: https://snapquast73-boop.github.io/LIVPBP/
Site source (cloned here): `LIVPBP/` (repo `snapquast73-boop/LIVPBP`).
Session: `arena-c6b0c0af` — branched `arena/c6b0c0af-alert3` on `Alert3`.

## Task board (this session)

| Task | Status | Session | File scope | Notes |
|---|---|---|---|---|
| T1 Clone site `snapquast73-boop/LIVPBP` into `LIVPBP/` | done | `arena-c6b0c0af` | `LIVPBP/` | |
| T2 Install deps + run site test suite | done | `arena-c6b0c0af` | `LIVPBP/package.json`, `LIVPBP/package-lock.json`, `LIVPBP/node_modules/` | `npm test`: **64 passed, 0 failed** |
| T3 Verify date 2026-08-26 vs reference site line-by-line | done (partial) | `arena-c6b0c0af` | `LIVPBP/audit/verify/` | See Verification log + Flagged below |
| T4 Commit copied site in `LIVPBP/` repo | done | `arena-c6b0c0af` | `LIVPBP/` | commit `5c02527`-era (audit stubs) |
| T5 Commit `COORDINATION.md` + `LIVPBP/` into `Alert3`, push branch | done | `arena-c6b0c0af` | `Alert3/COORDINATION.md`, `Alert3/LIVPBP/` | — |

## Verification log (official sources)

Line-by-line verification of reference page rows (`https://snapquast73-boop.github.io/LIVPBP/reviews.html?date=2026-08-26`) against **MLB StatsAPI** (official): https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-08-26

- Schedule fetch: `totalGames: 15` — matches reference line: "15 game(s) on Wed Aug 26, 2026". (All 15 rows carry official schedule source links via the site.)
- Game `823096` (PHI@SEA): schedule status `Final`, PHI score `6`, SEA score `0` — matches reference row: `Actual after (official) 6–0` [MLB API ↗](https://statsapi.mlb.com/api/v1/game/823096/playByPBP)
- Game `823180` (CIN@SF): schedule status `Final`, CIN score `10`, SF score `9` — matches reference row: `Actual after (official) 10–9` [MLB API ↗](https://statsapi.mlb.com/api/v1/game/823180/playByPBP)
- Site test suite: `npm test` → `64 passed, 0 failed` (smoke test + parity/provenance + jsdom render incl. "reviews.html?date= opens that date in the replay feed").

## Flagged for Review

- F-1 (unverified, partial): Per-row play-by-play detail of the three reference review rows (game 823096 "J.P. Crawin… Luzardo" row, game 823180 "Sal Stewart vs Ryan Walker", game 823180 "Héctor Rodríguez vs Reiver Sanmartin") could not be re-fetched line-by-line — the very large StatsAPI play-by-play endpoints returned errors from the sandbox fetch tool during this session. All game/score/status values above were verified from the official schedule endpoint; row-level play strings on the reference page match the official API contract, but the strings themselves are not re-verified against a fresh fetch.
- F-2: Reference page shows a "scanned 3:38:34 PM / local log only" footer — this is the site's local tracking metric; behavior against StatsAPI cannot be confirmed live during this session.
- F-3: `LIVPBP/docs/` (statsapi-field-map.md, verification-report.md) in the clone predates the Alert3 copy — new verification (this session) covered schedule + both games above.
- F-4: Reference page footer mentions "0 live" for Aug 26, 2026 — date is in the past (today is 2026-11-25), so a live count is not expected on this date.
