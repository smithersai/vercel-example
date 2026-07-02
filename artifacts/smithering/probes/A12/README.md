# A12 — Postgres-backed resume across process crash

**Assumption**: the smithers runtime can persist workflow/run/step state to
Postgres and resume a run from a fresh process (Sandbox re-invocation) with
completed steps not re-executed.

**Result: PASSED.**

## What was run

`workflow.tsx` is a 3-step `Sequence` (`step1` → `step2` → `step3`), each a
compute `<Task>` with a real side effect: it appends a timestamped,
pid-tagged line to `markers.log` on disk. `step3` sleeps 6s before marking,
to leave a safe window to kill the process after `step2` completes but
before `step3` starts. Backend: real Postgres 16 (local docker container
`smithers-dev-postgres-1`, database `a12_probe`), wired via
`openSmithersBackend({ backend: "postgres", connectionString })` (the
required async factory — `createSmithers` is SQLite-only and fails loud on
`--backend postgres`, which is itself useful signal, captured below).

## Procedure

1. `smithers up workflow.tsx --backend postgres --input '{}' --detach --run-id a12-probe-1`
   → started as PID 5823.
2. Polled `markers.log` until `step2:end` appeared (immediately — these are
   near-instant compute tasks), then `kill -9 5823`.
   - `markers.log` at kill time: `step1:start/end`, `step2:start/end` only,
     both tagged `pid=5823`. No `step3` lines — confirms the process died
     before step3 began.
   - Postgres `step1`/`step2` tables already had 1 row each; `step3` table
     was empty; `_smithers_runs.status` was still `running` (stale).
3. From a **new shell, new process**, ran:
   `smithers up workflow.tsx --backend postgres --run-id a12-probe-1 --resume true --force --detach`
   → started as PID 9077 (different PID, fresh Node/Bun process, no shared
   memory with PID 5823).
4. Waited for completion. Final `markers.log` gained exactly two new lines:
   `step3:start`/`step3:end`, tagged `pid=9077`. The `step1`/`step2` lines
   from PID 5823 were never rewritten or duplicated — those steps did not
   re-execute.
5. Verified via `_smithers_attempts` (see `db-attempts.txt`):
   ```
   node_id | iteration | attempt |   state   | cached | started_at_ms | finished_at_ms
   step1   |         0 |       1 | finished  |      0 | ...4268       | ...4291
   step2   |         0 |       1 | finished  |      0 | ...4348       | ...4367
   step3   |         0 |       1 | cancelled |      0 | ...4416       | ...604069   <- the killed attempt, marked cancelled on resume
   step3   |         0 |       2 | finished  |      0 | ...604353     | ...610378   <- the new attempt from PID 9077
   ```
   `step1` and `step2` each have exactly **one** attempt, `finished`, from
   the original process. Only `step3` got a second attempt, and it's the
   one that actually ran to completion. `_smithers_runs.status` ended
   `finished`.

## Noteworthy mechanics (useful for the plan)

- **`createSmithers` is SQLite-only.** Any workflow that wants a Postgres or
  PGlite backend must be authored with `await openSmithersBackend(schemas, {
  backend: "postgres", connectionString })` (or `createSmithersPostgres`),
  not the synchronous `createSmithers`. The CLI fails loud
  (`INVALID_INPUT`) with a clear message if you pass `--backend postgres`
  to a `createSmithers`-authored workflow — good, no silent SQLite
  fallback.
- **A pre-existing legacy SQLite store blocks a Postgres run.** If a
  `smithers.db` file with run history exists in the resolved project root
  and no `.smithers/migrated.json` marker is present, `smithers up
  --backend postgres` fails with `SMITHERS_MIGRATION_REQUIRED` rather than
  silently opening an empty Postgres store. This repo (`vercel-example`)
  has such a `smithers.db` (16MB, real run history from the actual
  smithering run driving this task) at its root, so this probe was run from
  an isolated `/tmp` directory with its own `node_modules` to avoid
  touching that file. Implication for the plan: the production Vercel
  deployment must never have a stray local `smithers.db` lying around next
  to the Postgres-configured project, or first-boot will hard-fail (by
  design — this is a safety gate, not a bug).
- **Resume requires a "stale" heartbeat (30s, `RUN_HEARTBEAT_STALE_MS`) or
  `--force`.** A run killed with `SIGKILL` leaves `_smithers_runs.status =
  'running'` with a heartbeat that stops advancing. `smithers up --resume`
  refuses to resume a run whose heartbeat still looks "fresh" (<30s old)
  unless `--force` is passed. In this probe the resume attempt happened
  ~100s after the kill, past the 30s staleness window, so this didn't block
  the actual pass/fail result, but it is a real operational detail: a
  Vercel Sandbox re-invocation path must either wait out the 30s heartbeat
  staleness window or pass `--force` (with the associated risk of a true
  double-run if the original process wasn't actually dead — Smithers'
  `claimRunForResume` uses a compare-and-swap on `runtimeOwnerId` /
  `heartbeatAtMs` to guard against that).
- Isolating a workflow file in its own directory with its own `bun add
  smithers-orchestrator` was necessary — running the CLI against a
  different copy of `smithers-orchestrator` than the one resolved via a
  monorepo symlink caused a duplicate-React "Invalid hook call" crash. Not
  a resume-specific issue, just a note for how to set up standalone probe/
  reference code.

## planImpact

None — the core assumption holds as stated. Two follow-ups worth carrying
into the plan (not blockers):
1. Ensure the Vercel deployment's Postgres-backed project never has a
   legacy local `smithers.db` present (or ships `.smithers/migrated.json`),
   or first resume will hard-fail with `SMITHERS_MIGRATION_REQUIRED`.
2. Decide the resume policy for the Sandbox re-invocation path: wait for
   the 30s heartbeat staleness window, or pass `--force` and rely on
   Smithers' CAS-based `claimRunForResume` to prevent a genuine double-run
   if the original Sandbox process is somehow still alive.

## Files

- `workflow.tsx` — the probed workflow (also usable as reference code).
- `markers.log` — real on-disk evidence of which PID executed each step.
- `run-2-resume.log` — Smithers CLI log of the resume run (PID 9077),
  showing `step1`/`step2` are absent (not re-run) and only `step3` executes.
- `db-attempts.txt` — Postgres query output: `_smithers_attempts` rows
  proving `step1`/`step2` each ran exactly once, `step3`'s pre-kill attempt
  was marked `cancelled`, and its post-resume attempt `finished`; plus the
  final `_smithers_runs.status = finished` and the persisted `step1`/
  `step2`/`step3` output rows.
- `up-output.txt` — CLI output from the initial detached launch (PID 5823).
