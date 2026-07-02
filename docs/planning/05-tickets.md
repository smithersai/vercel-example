# Ticket Breakdown — v1 (2026-07-01)

Upstream: `docs/planning/01-prd.md`, `02-design.md`, `03-eng.md` (incl. §19 probe
amendments), `04-backpressure.md`. Machine copy (canonical, imported by the
implementation workflow): `artifacts/smithering/tickets.json` — instructions there are
the full, self-contained versions; this document is the human index.

## Ordering and gates

Ticket 1 (`walking-skeleton-summary-slice`) is deliberately the cheapest end-to-end
slice — webhook → manual summarize → fixture summary → fake-Telegram outbox — and
becomes the permanent smoke test. Everything else builds on it.

**Human/environment gates recorded from probe synthesis (eng §19):**

- **A13 (human, unresolved)** — `exactly-once-chunk-delivery` MUST NOT start until the
  PRD owner accepts the AC-5.3 amendment (content-free placeholder residual, bounded by
  attempt limit) and it is recorded in `01-prd.md`. Backpressure BP-3.
- **A2 (environment-blocked)** — `sandbox-async-executor-invocation` requires a live
  25-minute Sandbox run first: `vercel link` + `vercel env pull`, then
  `artifacts/smithering/probes/A2/run-sandbox-loop.mjs` → `completed:true`.
- **A3 (falsified on Hobby)** — Vercel Pro is a hard deployment prerequisite (1-minute
  cron). Recorded in `neon-preview-ci-pipeline` and the README ticket.
- **A10 (falsified)** — no fire-and-forget promises anywhere: tick persists `jobId`,
  observes completion via polling cron/webhook. Baked into
  `sandbox-async-executor-invocation`.
- **A1/A11/A7 (environment-blocked, not refuted)** — live-bot and live-LLM probe
  re-runs are folded into `live-telegram-smoke-lane` and `grounding-eval-nightly`;
  until then the affected mechanisms carry defensive designs (content-hash
  short-circuit; startup privacy-mode guard; nightly lane as the real schema gate).

## Ticket index

| # | id | title (short) | reqs | deps | complexity |
|---|---|---|---|---|---|
| 1 | `walking-skeleton-summary-slice` | End-to-end smoke slice: webhook → manual summarize → outbox | AC-1.1, 1.4, 3.1, 8.2 | — | large |
| 2 | `ci-coverage-and-secret-gates` | 100% coverage gate (provable-red), gitleaks, env-docs, docs-markers lint | AC-10.1, 11.2, 11.3 | 1 | small |
| 3 | `summarizer-fixture-and-live-lanes` | SummarySchema (topics 1–7, E13), fixture store, anthropic mode, fixtures:record | AC-3.2, 3.3, 4.3 | 1 | medium |
| 4 | `telegram-http-client-retries` | Raw typed Telegram client, D27 backoff, FaultInjectingTelegramPort | AC-5.2 | 1 | medium |
| 5 | `smithers-postgres-runtime` | Summarize pipeline as smithers workflow on Postgres driver; kill/resume proof (A12 graduated) | AC-8.1, 8.2, 9.1 | 1 | large |
| 6 | `run-lease-heartbeat-watchdog` | E2 lease/heartbeat/fencing, watchdog, attempt exhaustion | AC-5.4, 8.1, 9.4 | 1 | medium |
| 7 | `scheduled-cron-window-lineage` | E14 sched_cursor lineage, croner DST, ingest grace, missed-tick catch-up | AC-2.1–2.5, 6.2 | 1 | medium |
| 8 | `tick-backpressure-and-backlog` | E7 claim cap, fair cursor, concurrency gate, backlog-drain e2e | AC-2.5, eng-only | 7 | medium |
| 9 | `late-webhook-assignment-repair` | E9 assignment ledger, late-message section, pre-join anchor | AC-1.1, 1.3, 1.4, 4.5 | 7 | medium |
| 10 | `quiet-window-threshold-skip` | D10 threshold, bot exclusion, sparse-summary posting | AC-4.1, 4.3, 4.4, 4.5 | 9, 3 | small |
| 11 | `exactly-once-chunk-delivery` | E1 two-phase send + chunker + crash-cut battery — **A13 gate** | AC-3.4, 5.1, 5.3 | 6, 4, 5 | large |
| 12 | `first-contact-disclosure` | E8 claimed disclosure state machine + sweep | AC-1.2 | 4, 7 | small |
| 13 | `nonlossy-map-reduce-budgeting` | E5 hierarchical map-reduce, pagination, volume disclosure | AC-1.1, 3.3, 5.1 | 3 | medium |
| 14 | `sandbox-async-executor-invocation` | A10-amended async Sandbox invocation, jobId persistence, REQ-9.1 architecture test — **A2 gate** | AC-9.1, 8.1 | 5, 6, 8 | large |
| 15 | `machine-auth-boundaries` | E11 auth matrix (webhook secret, cron secret, UI token, test-route gating) | AC-7.5, 11.3 | 1 | small |
| 16 | `operator-ui-runs-and-config` | Run list/detail + smithers step timeline, config CRUD, pause/re-enable | AC-4.2, 5.4, 6.1–6.3, 7.1, 7.4, 7.6 | 6, 7, 5, 15 | large |
| 17 | `operator-ui-manual-trigger-and-replay` | Summarize-now (cursor-safe) + replay via lease reset/resume | AC-7.2, 7.3 | 16, 14 | medium |
| 18 | `neon-preview-ci-pipeline` | Neon branch per PR, Preview e2e required check, push-button pipeline — **Pro prerequisite** | AC-7.6, 8.2, 10.2, 10.3, 10.5 | 2, 15 | medium |
| 19 | `longtask-proof-lanes` | >20-min nightly proof, per-PR scaled variant, crash-resume | AC-9.2–9.5 | 14, 18 | medium |
| 20 | `grounding-eval-nightly` | AC-3.3 no-fabrication eval over live LLM, clean skip w/o key | AC-3.3, 10.4 | 13 | medium |
| 21 | `telegram-access-deploy-check` | E12 check:telegram, webhook registration, privacy-mode guard | AC-1.1, eng-only | 4 | small |
| 22 | `live-telegram-smoke-lane` | D30 opt-in smoke, prompted ingestion check, clean skip; A1/A11 graduation | AC-10.4, 1.1, 3.4 | 21, 18 | small |
| 23 | `template-readme-and-fresh-eyes` | README + env table + fresh-eyes clone→deploy walkthroughs | AC-8.3, 11.1–11.3 | 18, 22, 19, 17, 11, 10, 12, 20 | medium |

## Verification style

Every ticket mixes gate types per the backpressure matrix: executable `command`/`e2e`
checks lifted verbatim from `04-backpressure.md` rows (the named `pnpm test:* -t "…"`
suites, red-before-green where BP-5 requires it), plus `agent-review` entries for what
only judgment can check (fencing completeness, exclusion-list justification, reduce
prompt select-only constraint, mockup fidelity, fresh-eyes walkthroughs per BP-6,
"can this eval actually fail"). "The agent said it was done" is never evidence.

## Decisions recorded in this breakdown

1. **The skeleton posts via manual trigger only** — cron, leases, and smithers runtime
   land as separate tickets on top of it; this keeps ticket 1 the cheapest true
   end-to-end slice while still exercising ingest → summarize → deliver → durable rows.
2. **E1 (ticket 11) is sequenced but explicitly gated on A13** — the orchestrator's
   human gate must record acceptance in `01-prd.md` before it starts; all other
   delivery-adjacent work (chunk-free posting in the skeleton, retries in ticket 4)
   avoids the two-phase ledger so nothing pre-empts the human decision.
3. **A2's live re-run is a prerequisite inside ticket 14**, not a separate ticket: the
   probe script exists (`artifacts/smithering/probes/A2/`); running it is step zero of
   that ticket, and a failure stops the ticket and reopens eng §2/§15.
4. **UI is split** into read/CRUD (16) and actions (17) because replay depends on the
   Sandbox invocation path (14) while the read surface doesn't — this unblocks UI work
   earlier.
5. **Grounding eval (20) is a ticket, not a footnote**, because BP-2 makes it blocking
   for acceptance and it must be able to fail (planted-fabrication self-test required).
6. **Probe graduations are assigned owners**: A1/A11 → ticket 22, A7 → ticket 20,
   A4/A5 re-runs → tickets 18/8 respectively, A12 → ticket 5, A3 instrumentation →
   ticket 18. No probe re-run is left unowned.
