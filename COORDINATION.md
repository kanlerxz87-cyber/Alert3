# Coordination

| Task | Status | Session | Scope |
| --- | --- | --- | --- |
| Import and integrate LIVPBP, verify operation, and deploy | in progress | arena-d0b46ba5 | All repository files (integration) |

Claimed 2026-11-25 UTC. This session uses the Arena-assigned branch rather than renaming it.

## Integration log
- Imported [upstream LIVPBP](https://github.com/snapquast73-boop/LIVPBP/tree/5c02527d3c7a56ea66c698cfabff80a407b6dfd3) at commit `5c02527d3c7a56ea66c698cfabff80a407b6dfd3`, retaining its MIT license and historical audit/flags (but not its unrelated coordination board).
- Checked the [official MLB schedule for 2026-08-26](https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-08-26&hydrate=review,probablePitcher,decisions,linescore): the response reports 15 games; the reference replay page also reports 15. This is a limited check, not line-by-line verification of all values.
- `node tools/restoration-check.mjs` and `npm ci && npm test` passed; the latter includes 64 offline fixture checks and local HTML asset links.
- Needs review: upstream historical verification claims were copied, not independently reverified line by line; live upcoming-game alerts and all possible runtime values remain unverified. These limitations are published on Flagged for Review. Official source links on replay and game-table rows are retained from upstream.
