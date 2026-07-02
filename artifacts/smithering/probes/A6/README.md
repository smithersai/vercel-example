# A6 — croner across DST transitions (America/New_York, 2026)

Assumption: croner walks 5-field cron expressions across a DST transition in
`America/New_York` correctly.

## Method

`probe.mjs` schedules `30 * * * *` (every hour at :30) with
`timezone: 'America/New_York'` and walks 6-8 consecutive `nextRun()` calls
across:

- **Spring forward** — 2026-03-08, 01:59 EST -> 03:00 EDT (local 02:xx does
  not exist).
- **Fall back** — 2026-11-01, 01:59 EDT -> 01:00 EST (local 01:xx occurs
  twice).

Run: `node probe.mjs` (see `output.json` for the captured run).

## Result: PASSED

- **Spring forward**: the local-hour sequence jumps `01:30 -> 03:30`,
  correctly skipping the nonexistent `02:30`. No run lands in the
  02:00-02:59 NY-local gap.
- **Fall back**: croner fires once per distinct local-hour label
  (`00:30, 01:30, 02:30, 03:30, ...`) rather than firing twice during the
  repeated `01:xx` hour — i.e. it does not double-execute the job. This
  shows up as a single 2-hour UTC gap where the second occurrence of local
  `01:xx` is deduped, with all other gaps being a clean 1 hour.

This is the behavior we want for a job scheduler: no missed/duplicate runs
across DST boundaries, when croner is given an explicit IANA `timezone`
(not left to run in server-local/UTC time).

## Caveat / plan impact

None required — assumption holds as tested. One thing to carry into the
implementation: **always pass an explicit `timezone`** to `Cron(...)`
(e.g. `America/New_York`) rather than relying on the process's default
timezone, since Vercel serverless functions run in UTC by default and the
DST-safe behavior demonstrated here depends on croner knowing the target
IANA zone.
