# Final integration verification — 2026-11-25

Session `arena-84333e7f` (Arena-fixed branch `arena/84333e7f-alert3`). This report re-checks the combined, merged site after PRs [#1](https://github.com/kanlerxz87-cyber/Alert3/pull/1)–[#7](https://github.com/kanlerxz87-cyber/Alert3/pull/7). Every table row below links an official MLB, GitHub, or first-party GitHub Pages source. Values that could not be confirmed from an official source are **blank** and explicitly marked unverified/flagged; they were not inferred.

## Site copy and deployment provenance

| Check | Official value | Official source | Status |
| --- | --- | --- | --- |
| Copied source commit | `5c02527d3c7a56ea66c698cfabff80a407b6dfd3` | [upstream LIVPBP tree](https://github.com/snapquast73-boop/LIVPBP/tree/5c02527d3c7a56ea66c698cfabff80a407b6dfd3) · [GitHub tree API](https://api.github.com/repos/snapquast73-boop/LIVPBP/git/trees/5c02527d3c7a56ea66c698cfabff80a407b6dfd3?recursive=1) | Verified |
| Copied site's Pages source | `main`, `/ (root)`, `has_pages: true` | [Alert3 Pages API](https://api.github.com/repos/kanlerxz87-cyber/Alert3/pages) | Verified |
| Combined site revision used for final checks (before this PR) | `7b69a9a8e4a981cac249131a541fe148d80d7a15` | [PR #7](https://github.com/kanlerxz87-cyber/Alert3/pull/7) · [Pages builds API](https://api.github.com/repos/kanlerxz87-cyber/Alert3/pages/builds/latest) | Verified |
| PR #6 checks before merge | `test` and `dom-smoke` succeeded | [PR #6](https://github.com/kanlerxz87-cyber/Alert3/pull/6) · [Actions](https://github.com/kanlerxz87-cyber/Alert3/actions) | Verified |
| PR #7 checks before merge | `test` and `dom-smoke` succeeded | [PR #7](https://github.com/kanlerxz87-cyber/Alert3/pull/7) · [Actions](https://github.com/kanlerxz87-cyber/Alert3/actions) | Verified |

## Official 2026-08-26 slate — every game row

The following 15 rows were read from one official StatsAPI projection. The live copied replay feed reported 15 games for the same date; the local tracked-entry count is client state and is not an official MLB value.

| # | gamePk | Away (official score) | Home (official score) | Official status | Official source |
| --- | --- | --- | --- | --- | --- |
| 1 | `824234` | Tampa Bay Rays `3` | Detroit Tigers `0` | Final | [schedule 2026-08-26](https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-08-26&fields=totalGames,dates,date,totalGames,games,gamePk,teams,away,home,team,name,score,status,detailedState) |
| 2 | `825039` | Chicago Cubs `0` | Arizona Diamondbacks `2` | Final | [schedule 2026-08-26](https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-08-26&fields=totalGames,dates,date,totalGames,games,gamePk,teams,away,home,team,name,score,status,detailedState) |
| 3 | `823180` | Cincinnati Reds `10` | San Francisco Giants `9` | Final | [schedule 2026-08-26](https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-08-26&fields=totalGames,dates,date,totalGames,games,gamePk,teams,away,home,team,name,score,status,detailedState) |
| 4 | `823988` | Cleveland Guardians `4` | Los Angeles Angels `3` | Final | [schedule 2026-08-26](https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-08-26&fields=totalGames,dates,date,totalGames,games,gamePk,teams,away,home,team,name,score,status,detailedState) |
| 5 | `823255` | Pittsburgh Pirates `0` | San Diego Padres `3` | Final | [schedule 2026-08-26](https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-08-26&fields=totalGames,dates,date,totalGames,games,gamePk,teams,away,home,team,name,score,status,detailedState) |
| 6 | `823096` | Philadelphia Phillies `6` | Seattle Mariners `0` | Final | [schedule 2026-08-26](https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-08-26&fields=totalGames,dates,date,totalGames,games,gamePk,teams,away,home,team,name,score,status,detailedState) |
| 7 | `823825` | Boston Red Sox `0` | Miami Marlins `4` | Final | [schedule 2026-08-26](https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-08-26&fields=totalGames,dates,date,totalGames,games,gamePk,teams,away,home,team,name,score,status,detailedState) |
| 8 | `822692` | Colorado Rockies `13` | Washington Nationals `1` | Final | [schedule 2026-08-26](https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-08-26&fields=totalGames,dates,date,totalGames,games,gamePk,teams,away,home,team,name,score,status,detailedState) |
| 9 | `823506` | Houston Astros `3` | New York Yankees `9` | Final | [schedule 2026-08-26](https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-08-26&fields=totalGames,dates,date,totalGames,games,gamePk,teams,away,home,team,name,score,status,detailedState) |
| 10 | `822772` | Kansas City Royals `0` | Toronto Blue Jays `3` | Final | [schedule 2026-08-26](https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-08-26&fields=totalGames,dates,date,totalGames,games,gamePk,teams,away,home,team,name,score,status,detailedState) |
| 11 | `823584` | Milwaukee Brewers `8` | New York Mets `1` | Final | [schedule 2026-08-26](https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-08-26&fields=totalGames,dates,date,totalGames,games,gamePk,teams,away,home,team,name,score,status,detailedState) |
| 12 | `824878` | Los Angeles Dodgers `5` | Atlanta Braves `6` | Final | [schedule 2026-08-26](https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-08-26&fields=totalGames,dates,date,totalGames,games,gamePk,teams,away,home,team,name,score,status,detailedState) |
| 13 | `824555` | Texas Rangers `4` | Chicago White Sox `10` | Final | [schedule 2026-08-26](https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-08-26&fields=totalGames,dates,date,totalGames,games,gamePk,teams,away,home,team,name,score,status,detailedState) |
| 14 | `823015` | Baltimore Orioles `8` | St. Louis Cardinals `7` | Final | [schedule 2026-08-26](https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-08-26&fields=totalGames,dates,date,totalGames,games,gamePk,teams,away,home,team,name,score,status,detailedState) |
| 15 | `824963` | Minnesota Twins `4` | Athletics `7` | Final | [schedule 2026-08-26](https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-08-26&fields=totalGames,dates,date,totalGames,games,gamePk,teams,away,home,team,name,score,status,detailedState) |

## Review rows and registries re-read from official sources

| Check | Official value | Official source | Status |
| --- | --- | --- | --- |
| `823096`, at-bat `36` | `MF`; `challengeTeamId: 136`; `isOverturned: false`; score `6–0`; description begins “Mariners challenged (play at 1st)” | [playByPlay 823096](https://statsapi.mlb.com/api/v1/game/823096/playByPlay?fields=allPlays,about,atBatIndex,result,description,awayScore,homeScore,reviewDetails,reviewType,isOverturned,inProgress,challengeTeamId) | Verified |
| `823096` counters | manager away `used 0 / remaining 1`, home `used 1 / remaining 0`; ABS away `1 / 1 / 1`, home `2 / 2 / 0` (successful / failed / remaining) | [feed/live 823096 counters](https://statsapi.mlb.com/api/v1.1/game/823096/feed/live?fields=gameData,review,absChallenges,hasChallenges,away,home,used,remaining,usedSuccessful,usedFailed) | Verified |
| `823180`, at-bat `57` | `MA`; `challengeTeamId: 137`; `isOverturned: false`; score `3–6`; description says the Giants' tag-play challenge was upheld | [playByPlay 823180](https://statsapi.mlb.com/api/v1/game/823180/playByPlay?fields=allPlays,about,atBatIndex,result,description,awayScore,homeScore,reviewDetails,reviewType,isOverturned,inProgress,challengeTeamId,runners,isScoringEvent,playIndex) | Verified |
| `823180`, at-bat `84` | `NF`; `isOverturned: false`; score `10–9`; official text includes the play-at-1st and slide-interference review | [playByPlay 823180](https://statsapi.mlb.com/api/v1/game/823180/playByPlay?fields=allPlays,about,atBatIndex,result,description,awayScore,homeScore,reviewDetails,reviewType,isOverturned,inProgress,challengeTeamId,runners,isScoringEvent,playIndex) | Verified |
| `823180` counters | manager away `used 0 / remaining 1`, home `used 1 / remaining 0`; ABS away `4 / 0 / 2`, home `2 / 1 / 1` | [feed/live 823180 counters](https://statsapi.mlb.com/api/v1.1/game/823180/feed/live?fields=gameData,review,absChallenges,hasChallenges,away,home,used,remaining,usedSuccessful,usedFailed) | Verified |
| Review status codes | `MF` = “Manager challenge: Close play at 1st”; `MA` = “Manager challenge: Tag play”; `NF` = “Umpire review: Close play at 1st”; `NH` = “Umpire review: Home run”; `MJ` = “Player challenge: Pitch Result”; `NJ` = “Umpire Challenge: Pitch Result” | [gameStatus registry](https://statsapi.mlb.com/api/v1/gameStatus) | Verified |
| Official-scorer pending event types | `os_ruling_pending_prior` and `os_ruling_pending_primary`, both “Official Scorer Ruling Pending” | [eventTypes registry](https://statsapi.mlb.com/api/v1/eventTypes?fields=code,description) | Verified |

## Upcoming game days and published rendering

| Check | Official / published value | Official source | Status |
| --- | --- | --- | --- |
| 2026-11-25 offseason slate | `totalGames: 0`, `dates: []` | [schedule 2026-11-25](https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-11-25&fields=totalGames,dates,date,totalGames) · [published scoreboard](https://kanlerxz87-cyber.github.io/Alert3/?date=2026-11-25) | Verified |
| First upcoming date in the official forward range | `2027-02-19`, `17` games | [schedule range 2026-11-25..2027-04-30](https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=2026-11-25&endDate=2027-04-30&fields=dates,date,totalGames) · [scheduled date](https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2027-02-19&fields=totalGames,dates,date,totalGames,games,gamePk,status,abstractGameState,detailedState,statusCode) | Verified |
| Copied scoreboard for that upcoming date | 17 “Scheduled” game cards, including `gamePk=868573` | [published scoreboard](https://kanlerxz87-cyber.github.io/Alert3/?date=2027-02-19) · [official date schedule](https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2027-02-19&fields=totalGames,dates,date,totalGames,games,gamePk,status,abstractGameState,detailedState,statusCode) | Verified |
| 2027-03-25 slate | `totalGames: 14`; all 14 returned games are `Preview` / `Scheduled` | [schedule 2027-03-25](https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2027-03-25&fields=totalGames,dates,date,totalGames,games,gamePk,status,abstractGameState,detailedState,statusCode,review,hasChallenges,away,home,used,remaining) · [published scoreboard](https://kanlerxz87-cyber.github.io/Alert3/?date=2027-03-25) | Verified |
| Project-prefix 404 delivery | `404.html` loads and “Back to scoreboard” resolves to `/Alert3/index.html` | [published 404.html](https://kanlerxz87-cyber.github.io/Alert3/404.html) · [Pages API](https://api.github.com/repos/kanlerxz87-cyber/Alert3/pages) | Verified |
| Deep unmatched route byte delivery |  | [Pages-delivery workflow](https://github.com/kanlerxz87-cyber/Alert3/actions/workflows/pages-delivery.yml) · [delivery check source](https://github.com/kanlerxz87-cyber/Alert3/blob/main/tests/pages-delivery.mjs) | Unverified here — the fetch tool rejects HTTP 404 pages; the workflow's explicit 404 assertion is the authoritative check |

## Flagged and unverified values — deliberately blank

| Item | Confirmed official value | Status | Official source |
| --- | --- | --- | --- |
| Real-time alerts, sound cues, notifications and before-review score capture during an actual upcoming live game |  | Unverified — no live MLB game on 2026-11-25; flagged | [official schedule 2026-11-25](https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-11-25&fields=totalGames,dates,date,totalGames) · [upcoming 2027-02-19 slate](https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2027-02-19&fields=totalGames,dates,date,totalGames,games,gamePk,status,abstractGameState,detailedState,statusCode) |
| All possible runtime values for every future game |  | Unverified — cannot be enumerated from a current official response; flagged | [StatsAPI schedule endpoint](https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-11-25&fields=totalGames,dates,date,totalGames) |
| Before-review score when a page opens after a ruling |  | Unverified — the official play-by-play result publishes the resolved score, not the client-side pre-ruling snapshot; blank on the site | [playByPlay 823096](https://statsapi.mlb.com/api/v1/game/823096/playByPlay?fields=allPlays,about,atBatIndex,result,description,awayScore,homeScore,reviewDetails,reviewType,isOverturned,inProgress,challengeTeamId) |
| Client scan times and local tracked-entry counts |  | Unverified — browser/localStorage state, not an official MLB value; flagged | [published replay feed](https://kanlerxz87-cyber.github.io/Alert3/reviews.html?date=2026-08-26) · [official 2026-08-26 schedule](https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-08-26&fields=totalGames,dates,date,totalGames,games,gamePk,teams,away,home,team,name,score,status,detailedState) |
| Cause of the different historical replay-feed snapshots (reference 3 reviews / 27 ABS / 76 tracked vs copied 10 / 68 / 78) |  | Unverified — no official source states the cause; flagged | [reference replay feed](https://snapquast73-boop.github.io/LIVPBP/reviews.html?date=2026-08-26) · [copied replay feed](https://kanlerxz87-cyber.github.io/Alert3/reviews.html?date=2026-08-26) |
| Historical upstream “verified” status claims in sections 1–14 |  | Not independently re-verified in this report; source links retained for owner review | [upstream commit 5c02527](https://github.com/snapquast73-boop/LIVPBP/tree/5c02527d3c7a56ea66c698cfabff80a407b6dfd3) · [published Flagged page](https://kanlerxz87-cyber.github.io/Alert3/flagged.html) |

## Combined checks

- `npm ci && npm test`, `node tests/run-all.mjs`, `node tools/restoration-check.mjs`, `node tests/link-check.mjs`, `node tests/props-provenance-test.mjs`, `node tests/provenance-check.mjs` and the network-enabled `node tools/verify-official-sources.mjs` are the final integration checks. Results are recorded in [COORDINATION.md](../COORDINATION.md) and the [Actions log](https://github.com/kanlerxz87-cyber/Alert3/actions).
- The [Flagged for Review page](../flagged.html) and [companion verification page](../flagged-55cc1142.html) remain linked from the site; both preserve source links and blank unverified cells.

## Final PR, merge, checks and deployment result

| Result | Confirmed value | Official / first-party source | Status |
| --- | --- | --- | --- |
| Final integration PR | [#8](https://github.com/kanlerxz87-cyber/Alert3/pull/8) opened from `arena/84333e7f-alert3` to `main` | [PR #8](https://github.com/kanlerxz87-cyber/Alert3/pull/8) · [Arena branch](https://github.com/kanlerxz87-cyber/Alert3/tree/arena/84333e7f-alert3) | Verified |
| Merge result | MERGED at `2026-11-25T21:13:22Z` as `f344418067ef5655ac49185b33bfc12a1de3623b` | [merge commit](https://github.com/kanlerxz87-cyber/Alert3/commit/f344418067ef5655ac49185b33bfc12a1de3623b) · [PR #8](https://github.com/kanlerxz87-cyber/Alert3/pull/8) | Verified |
| PR checks | `test`, `dom-smoke`, and `official-sources` all concluded SUCCESS | [Site checks run](https://github.com/kanlerxz87-cyber/Alert3/actions/runs/45702138746) · [official-source job](https://github.com/kanlerxz87-cyber/Alert3/actions/runs/45702138746/job/139514702562) | Verified |
| Local combined checks | 66 app checks, 148 HTML + 276 Markdown provenance rows, 56 local refs, 50 jsdom checks, 8 bindings, restoration checks, and 5/5 props checks passed | [tests/README.md](https://github.com/kanlerxz87-cyber/Alert3/blob/main/tests/README.md) · [Site checks workflow](https://github.com/kanlerxz87-cyber/Alert3/actions/workflows/site-check.yml) | Verified |
| GitHub Pages build | Build `1403427967` for `f344418` reached `built` at `2026-11-25T21:13:43Z` | [Pages build API](https://api.github.com/repos/kanlerxz87-cyber/Alert3/pages/builds/1403427967) · [Pages API](https://api.github.com/repos/kanlerxz87-cyber/Alert3/pages) | Verified |
| Published Pages delivery | Workflow run `45702393774` for the merge SHA concluded `success` | [published delivery run](https://github.com/kanlerxz87-cyber/Alert3/actions/runs/45702393774) · [Pages-delivery workflow](https://github.com/kanlerxz87-cyber/Alert3/actions/workflows/pages-delivery.yml) | Verified |
| Live manual-review endpoints | Root, 2026-08-26 replay, both 2027 future scoreboards, both flagged pages, the final report, and 404 loaded after deployment | [live site](https://kanlerxz87-cyber.github.io/Alert3/) · [replay](https://kanlerxz87-cyber.github.io/Alert3/reviews.html?date=2026-08-26) · [Flagged for Review](https://kanlerxz87-cyber.github.io/Alert3/flagged.html) · [companion](https://kanlerxz87-cyber.github.io/Alert3/flagged-55cc1142.html) · [final report](https://kanlerxz87-cyber.github.io/Alert3/docs/final-integration-2026-11-25.md) · [404](https://kanlerxz87-cyber.github.io/Alert3/404.html) | Verified |
| Remaining flagged items | Offseason live-runtime behavior, all possible future runtime values, client scan/tracked counts, before-review snapshots, historical upstream verification claims, and snapshot-difference causes remain blank/flagged | [official schedule 2026-11-25](https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-11-25&fields=totalGames,dates,date,totalGames) · [Flagged for Review §16](https://kanlerxz87-cyber.github.io/Alert3/flagged.html#final-integration) | Needs review; does not block |

