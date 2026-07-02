# A3 — Does Vercel Cron support 1-minute schedules reliably on the target plan?

## Question

Does a 1-minute cron on our plan fire at least 58 times in an hour?

## What was actually run

1. Fetched Vercel's official "Usage & Pricing for Cron Jobs" doc (2026-06-16 revision) —
   see `vercel-cron-docs-2026-06-16.md` for the verbatim evidence.
2. Wrote and ran `validate-cron-plan.mjs`, a small deploy-time validator that reproduces
   Vercel's own Hobby-plan rejection logic, and applied it to this project's actual
   design (`docs/planning/02-design.md` Decision D21: single `* * * * *` cron hitting
   `/api/cron/tick`). Output captured in `run-output.txt`.

## What was NOT run (and why)

Empirically measuring "does a live 1-minute cron fire ≥58/60 times in an hour" requires a
real, deployed Vercel project on a paid (Pro) plan, running for at least an hour, with a
function that logs each invocation. That is a real infrastructure deployment with billing
implications outside this repo's current scope (no live Vercel project/credentials are
configured here), so it was not attempted — fabricating that data would violate the "never
invent evidence" rule. This is recorded as an open gap, not silently assumed to pass.

## Findings

1. **The project has never specified which Vercel plan it targets.** Neither
   `PROMPT.md` nor `docs/planning/01-prd.md`/`02-design.md` mention Hobby vs Pro.
2. **On Hobby, the assumption is flatly false, not just imprecise.** A `* * * * *` cron
   (the exact expression Decision D21 specifies) fails at *deploy time* on Hobby — it
   never runs at all, let alone 58+/hour. Confirmed by both the docs and the validator
   script's reproduction of Vercel's rejection rule.
3. **On Pro/Enterprise, Vercel documents "once per minute" / "per-minute precision"** but
   publishes **no numeric reliability SLA** (no "≥58/hour" or similar figure). The
   specific number in the assumption (58/60) is not a value Vercel states anywhere in
   its docs; it would have to be measured empirically over a live deployment.
4. Design doc `02-design.md` §4 already anticipates missed ticks — it describes a
   watchdog and a "cron walk from last known boundary" (D4) specifically to catch up
   missed windows — which suggests the design was implicitly built to tolerate a
   non-100%-reliable cron, but this tolerance is not connected anywhere to a stated
   plan requirement.

## Verdict

**passed = false.** The assumption as stated ("Vercel Cron supports 1-minute schedules on
the target plan and fires reliably") cannot be confirmed:
- It is provably false on Hobby (deploy-time rejection).
- On Pro it is plausible but unverified — Vercel does not publish the specific "≥58/hour"
  guarantee, and no live measurement was performed (out of scope / would require a paid,
  running deployment).

## Plan impact

- `docs/planning/01-prd.md` / `02-design.md` must explicitly state **Vercel Pro (or
  higher) is a hard prerequisite** for this project — Hobby cannot run the `/api/cron/tick`
  design at all. This should become an explicit deployment precondition/README callout,
  not an implicit assumption.
- Because Vercel does not guarantee minute-level firing even on Pro, the existing
  catch-up/watchdog design (D4 cron-walk-from-last-boundary, D21 watchdog) should be
  treated as load-bearing correctness, not a nice-to-have — i.e. AC-2.5 (missed windows)
  needs a real e2e test that simulates one or more skipped ticks, since skipped ticks are
  an expected occurrence, not an edge case.
- If empirical firing-rate data is ever needed (e.g. to size the watchdog's catch-up
  window), it requires a live Pro-plan deployment instrumented to log invocation
  timestamps for ≥1 hour — a follow-up task, not something derivable from docs.
