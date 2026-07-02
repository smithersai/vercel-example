# Research: open-source implementations (eng-oss)

Scope: how real open-source codebases structure systems in the same shape as this
product's core mechanism — (1) a Postgres-backed job/run table claimed by concurrent
workers via an atomic insert/update, (2) a cron-tick-fans-out-to-worker architecture with
no long-lived process, (3) idempotent multi-step resumable task execution, and (4) a
Telegram (or similar chat-platform) bot with webhook ingestion and chunked message
delivery. Per docs/planning/02-design.md, the relevant decisions to cross-check against
precedent are D2 (DB-enforced window uniqueness as atomic claim), D21–D23 (cron-tick
scan-and-claim, Sandbox long-task, idempotent resume), D26–D27 (per-chunk delivery
ledger + bounded retry), and D28–D29 (mocked-integration e2e strategy, per-PR DB
isolation).

**Constraint on this artifact**: no WebFetch/WebSearch was available/used in this
research pass — findings below are drawn from architectural knowledge of these projects
as documented in their own READMEs/source layout conventions, not from freshly fetched
pages. Where a specific claim (e.g. an exact table/column name) could not be verified
against current upstream source in this pass, it is marked **unverified** and should be
spot-checked against the live repo before being treated as precedent to copy literally.
This mirrors the caveat convention design-art.md already established.

## 1. Postgres-as-queue / atomic-claim pattern

### 1.1 `graphile-worker` (Node/Postgres job queue)

- **Structure**: a single `graphile_worker.jobs` table plus a `SELECT ... FOR UPDATE SKIP
  LOCKED` claim query wrapped in a stored function (`get_job`), run by any number of
  worker processes polling or listening on `LISTEN/NOTIFY`. No separate broker.
- **Data flow**: enqueue = `INSERT INTO jobs`; claim = the `SKIP LOCKED` function marks a
  row `locked_at`/`locked_by` atomically; completion = `DELETE` (or move to a
  `job_queue_history`-style table in some deployments); failure = row is left with an
  incremented `attempts` and rescheduled `run_at`.
- **Relevance to this design**: validates D2's core idea — that the atomic claim should
  be a single DB statement, not app-level check-then-act — but `graphile-worker` claims
  *rows already in the queue*, whereas D2's claim *is* the `INSERT ... ON CONFLICT DO
  NOTHING`, i.e. the claim and the enqueue are the same statement. That's a stronger
  guarantee for this product's specific need (dedup on `(chat_id, window_start,
  window_end)`) than a generic job queue needs, because here the "job" only has one
  correct identity ever (a chat+window), not an arbitrary number of retriable
  enqueues of the same logical unit. D2 is closer to an idempotency-key pattern layered
  on top of a queue than to a generic worker-queue claim.
- **Testing strategy**: `graphile-worker`'s own test suite runs against a real
  Postgres instance (not mocked) with each test in a transaction rollback or a fresh
  schema — i.e., for the *queue mechanics themselves*, the project treats Postgres as
  a real dependency in tests, not a fake. That's consistent with D29 (isolated
  per-preview Postgres) for this product's e2e layer, though this product additionally
  mocks the *external* (Telegram) integration per D28 — the two decisions target
  different dependencies (DB = real everywhere per D29; Telegram = faked except D30's
  smoke lane) and don't conflict.

### 1.2 `pg-boss` (Node/Postgres job queue, similar shape to graphile-worker)

- **Structure**: schema-per-install (`pgboss` schema) with a `job` table using
  `INSERT ... ON CONFLICT` on a job's `singletonKey` for dedup/uniqueness — this is
  the closest direct precedent to D2's exact mechanism (`INSERT ... ON CONFLICT DO
  NOTHING` as the claim). `pg-boss` calls this "singleton jobs": a caller-supplied key
  makes a second enqueue for the same key a no-op, exactly matching D2's use of
  `(chat_id, window_start, window_end)` as that key.
- **Relevance**: confirms `ON CONFLICT DO NOTHING` on a natural key is an established,
  not novel, pattern for "at most once per logical unit" in a Postgres-backed job
  system — supports treating D2 as low-risk / well-trodden rather than a bespoke
  mechanism this project invented.

## 2. Cron-tick-fans-out / no-long-lived-worker architecture

### 2.1 Vercel's own `cron` + Function examples (vercel/examples repo, "cron" category)

- **Structure**: a single lightweight cron-triggered Function that does the scan/dispatch
  step, then hands off longer work to a separate Function or queue rather than doing the
  work inline within the cron invocation — the same "tick does not do the work, it fans
  it out" shape as D21. This is the standard pattern Vercel itself documents for anything
  that might exceed a cron invocation's own execution budget.
- **Relevance**: directly supports D21/D22's split between the always-short
  `/api/cron/tick` Function and the separate long-running Sandbox path — this is the
  platform-idiomatic shape, not an unusual choice for Vercel specifically.
- **Caveat**: **unverified** — this describes the general pattern documented across
  Vercel's cron guidance and example set; a specific example matching this project's
  claim-then-dispatch-to-sandbox shape was not individually re-confirmed in this pass.

### 2.2 GitHub Actions / CI schedulers as a loose analogy (cron-tick idempotent claim)

- **Structure**: scheduled workflow runs are themselves naturally idempotent-execution
  examples — GitHub's own scheduler skips a scheduled run if the repository has been
  inactive, and downstream jobs in CI systems commonly re-check "has this already been
  done" (e.g. skip-if-tag-exists) rather than trusting they're the only invocation.
- **Relevance**: weaker/looser precedent than 2.1, included mainly to note that
  "assume you might be invoked more than once, re-check state before acting" (D23's
  core idea) is a broadly established pattern in scheduler-adjacent systems generally,
  not unique to job-queue libraries.

## 3. Idempotent, resumable multi-step task execution (workflow-as-re-derivable-state)

### 3.1 Temporal (workflow engine; Node/Go/Java SDKs)

- **Structure**: Temporal's core model is "workflow code re-executes deterministically
  from an event history on every resume" — each step (`Activity`) is individually
  retried/re-invoked, and a workflow author writes code as if it runs once, with the
  engine replaying history to reconstruct state after a crash. This is the canonical
  "don't snapshot in-memory state, make every step re-derivable/idempotent" pattern.
- **Relevance to D23**: Temporal is the fullest-strength version of the pattern D23
  adopts in miniature — this product doesn't use a workflow-history-replay engine, it
  uses a much simpler mechanism (re-read a `run` row + `run_chunk` ledger from Postgres,
  check each step's completion marker, continue). D23's design is explicitly a smaller
  bespoke version of the same idea Temporal formalizes: "state lives outside the process,
  every step checks before acting." Worth noting as a design precedent, but the design
  doc is correct not to pull in a workflow-history-replay dependency for a system this
  size — the per-row/per-ledger idempotency checks D23/D26 describe are the "hand-rolled
  Temporal" version appropriate for a single Postgres table's worth of state.
- **Testing strategy note**: Temporal's own test framework provides a `TestWorkflowEnvironment`
  that fakes time and replays activities deterministically — the general principle
  (test the resume/replay path explicitly, don't just test the happy path) supports
  this project's AC-9.4 requirement having its own dedicated concurrency/crash-resume
  test, not just a happy-path e2e run.

### 3.2 Sidekiq / Resque-style "at-least-once, make handlers idempotent" convention (Ruby ecosystem)

- **Structure**: these background-job libraries do not guarantee exactly-once delivery
  and their documentation explicitly instructs job authors to make jobs idempotent
  (commonly via an app-level uniqueness check or upsert) rather than relying on the queue
  for exactly-once semantics.
- **Relevance**: reinforces that D23's approach (assume re-invocation *will* happen,
  design every step to be safe under it) is the standard advice across job-queue
  ecosystems generally, independent of which specific queue/broker is used — this
  product's Postgres-only version is a stricter, more auditable implementation of the
  same idea (state re-checked from durable SQL rows rather than an app-level
  "processed IDs" cache).

## 4. Telegram bot structure: webhook ingestion, chunked delivery, mocked integration in tests

### 4.1 `python-telegram-bot` (PTB) test suite structure

- **Structure**: PTB's own test suite runs against a real (test) Telegram Bot API server
  for integration coverage but isolates most logic behind its `Bot`/`ExtBot` client
  classes, allowing unit tests to substitute a fake transport. The project's docs
  explicitly recommend downstream bot authors depend on the `Bot` interface abstraction
  rather than raw HTTP calls, specifically so tests can substitute a fake.
- **Relevance to D28**: validates the "one interface, swap the implementation for
  tests" shape directly — D28's single internal Telegram interface (real HTTP client vs.
  in-memory fake, selected by environment) is exactly the abstraction boundary PTB's own
  authors recommend bot developers build for testability, applied here at the level of
  this project's own three-method interface (send message / send chat action /
  `setWebhook`) rather than adopting PTB's full client surface.
- **Caveat**: **unverified** — PTB's exact current test-suite mocking strategy (which
  parts use a live test server vs. pure fakes) was not re-confirmed against current
  upstream source in this pass; the "abstract behind a client interface for
  testability" recommendation is a long-standing, well-documented PTB convention
  though.

### 4.2 Telegram bot long-message-splitting utilities (`telegramify-markdown`, and the
    widely-copied "split on paragraph, fall back to sentence, never mid-entity" recipe)

- **Structure**: because Telegram enforces a ~4096-character message limit and rejects
  messages with unbalanced MarkdownV2 entity tokens, community libraries for splitting
  long bot output converge on the same priority order this design doc specifies in D8:
  try a semantic boundary (paragraph/section) first, fall back to sentence boundaries,
  and track open/unclosed markdown entities across the split so a chunk never opens a
  `*bold*` or `_italic_` token it doesn't close.
- **Relevance**: D8's chunking priority order (section → paragraph/bullet → sentence,
  entity-aware) matches the general shape of splitting utilities that have grown up
  around this exact Telegram API constraint — this is a well-known failure mode
  (mid-entity truncation breaking all subsequent formatting) rather than a hypothetical
  one, consistent with design-art's framing of it as an observed pattern.
- **Caveat**: **unverified** — cited from general familiarity with the Telegram-bot
  ecosystem's common recipes; no specific library's source was freshly read in this
  pass to confirm exact current implementation details.

## 5. Cross-cutting observations relevant to this project's architecture

- **Every precedent above that handles "may run more than once" does so by pushing the
  idempotency check down to the smallest safely-re-checkable unit** — a single DB row's
  status column (job queues), a single activity's completion marker (Temporal), a single
  chunk's `telegram_message_id IS NOT NULL` (this design's own D26). This project's
  layering — D2 at the run/window level, D26 at the chunk level — mirrors a two-tier
  idempotency structure ("has this whole unit of work happened" / "has this sub-step of
  it happened") that shows up consistently across the job-queue and workflow-engine
  examples above, not just as an isolated design choice for this repo.
- **Testing convention split**: DB-backed mechanics (queue claim/dedup logic) are
  consistently tested against a *real* database across the job-queue examples (§1); only
  the *external, non-owned* API (Telegram) gets faked (§4.1). This project's split — D29
  (real, isolated Postgres per Preview) vs. D28 (faked Telegram, real client only in
  D30's separate opt-in smoke lane) — matches that convention rather than diverging from
  it.
- **No example above uses a workflow-history-replay engine (Temporal-class) for a system
  this small** — the smaller, single-Postgres-table idempotency pattern this design doc
  uses is consistent with how much simpler single-integration bots and job-runners
  typically stay; pulling in a full workflow engine for a project of this scope would be
  precedent-inconsistent overkill, not an omission.

## 6. Unverified / not independently re-confirmed this pass

Per the operating rule against inventing evidence, flagging explicitly what in this
artifact rests on general architectural familiarity rather than a freshly-read source in
this session:

- Exact current `graphile-worker`/`pg-boss` schema/column names (§1.1, §1.2) — described
  at the level of well-established public documentation, not re-read from source this
  pass.
- The specific vercel/examples repository entry matching D21's shape (§2.1).
- Temporal's `TestWorkflowEnvironment` API surface and PTB's current test-suite
  structure (§3.1, §4.1) — described from established project conventions, not
  re-fetched.
- The specific current implementation of any named Telegram-splitting library (§4.2).

No WebFetch/WebSearch tool call was made in this research pass; if higher-confidence,
source-verified citations are required before implementation begins, a follow-up pass
with live fetches against each project's current README/source is recommended,
particularly for D2/D26/D28's specific mechanisms since those are the decisions most
directly informed by this artifact.
