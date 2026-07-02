# A5 — pooled connection sustains tick + 50 executors + UI concurrently

**Assumption**: The Neon pooled connection string sustains tick + 50 executors + UI
concurrently.

**Probe**: `probe.mjs` opens a `pg.Pool` sized to 60 (tick=1 + executors=50 + UI≈9,
per the A5 wording) and runs 60 concurrent "workers," each doing 5 iterations of:

1. `claim` — `UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1)
   RETURNING id`, the same pattern the executor-claim path would use.
2. `heartbeat` — `UPDATE ... SET heartbeat_at = now() WHERE id = $1`.

Each iteration checks out and releases a pooled client, mirroring how the tick/UI/
executors would each grab a short-lived connection under fan-out.

## Caveat: DB used

No Neon connection string was available in this sandbox (no `NEON_*` / `DATABASE_URL`
env var or `.env` file present). The only real reachable Postgres was `TEVM_APP_DB`
(a Railway Postgres via Railway's TCP proxy, `autorack.proxy.rlwy.net`), which is
**not** Neon's pgbouncer-based pooled endpoint. This probe therefore validates "many
concurrent short-lived connections against a real remote managed Postgres over a TCP
proxy," not Neon's pooler specifically. Neon's pooler (pgbouncer, transaction mode)
has different connection-limit characteristics than a plain proxy and should be
re-verified once a real Neon connection string is provisioned (ties into A4 — Neon
branch provisioning).

## Result

Run output: `run-output.json`.

- 60 concurrent clients × 5 iterations = 300 claim+heartbeat operation pairs.
- 300/300 succeeded, 0 connection errors, elapsed ~3.0s.
- Pool reached `totalCount: 60` (all connections opened successfully) with no
  `waitingCount` backlog at the end.

## Verdict

**Passed** for the mechanism (claim/heartbeat query pattern under 60-way concurrency
against a real hosted Postgres, no connection errors) — but only as a proxy for the
Neon-specific case. Re-run against an actual Neon pooled connection string before
treating A5 as fully closed for production.
