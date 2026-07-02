# Engineering Doc — Smithers-on-Vercel Telegram Summary Bot

Status: v3 (2026-07-01). Supersedes the reviewed v2. This revision addresses the second
adversarial review's eight findings: the smithers-on-Vercel core is now engineered, not
assumed (§2, E10); late Telegram webhook delivery can no longer create summary gaps
(§7, E9); the high-volume path is non-lossy (§8, E5 revised); the sparse-window summary
shape is defined without fabrication (§8.1, E13); scheduled window lineage is isolated
from manual runs (§6.1, E14); the exactly-once residual is tightened, bounded, and
explicitly escalated for PRD acceptance (§5, E1 revised); machine-endpoint auth is
specified (§12, E11); and Telegram group-message access is a declared dependency with a
setup gate and automated check (§13, E12).

Upstream: `docs/planning/01-prd.md` (REQ/AC IDs), `docs/planning/02-design.md`
(D-numbered decisions), `artifacts/smithering/research/eng-deps.md`,
`artifacts/smithering/research/eng-oss.md`. Engineering decisions are numbered **E1…**
and recorded with rationale; HTML decision docs for significant judgment calls live
under `artifacts/smithering/decisions/`.

## 1. Architecture overview

Components (all serverless; Postgres is the only durable state, AC-8.2):

```
Telegram ──webhook──▶ /api/telegram/webhook   (Function: secret-token auth, ingest,
                                               disclosure claim)
Vercel Cron (1/min) ─▶ /api/cron/tick         (Function: CRON_SECRET auth, due-scan
                          │                    with ingest grace, claim, fan-out,
                          │ invoke(run.id)     watchdog, disclosure sweep)
                          ▼
                      Sandbox executor         (long task: lease → smithers workflow
                          │                     runtime (E10) → fetch → budget →
                          │                     summarize → chunk → deliver → finalize)
                          ▼
                      Postgres (Neon)
                        ├─ app schema: chat, chat_config, message, run, run_chunk
                        ├─ smithers schema: smithers workflow/run/step state (E10)
                        └─ test schema: telegram_outbox (E3), fault plans (§14.2)
                          ▲
                      Operator UI = custom smithers Gateway UI as Next.js serverless
                      routes over the same Postgres (E10.3); e2e assertion surface =
                      test-only authed API over the same DB
```

Data flow for one run: webhook ingests `message` rows → tick computes due scheduled
windows from the **scheduled cursor** (E14) once the **ingest grace** has elapsed (E9),
claims each via `INSERT ... ON CONFLICT DO NOTHING` on
`run(chat_id, window_start, window_end)` (D2), invokes the Sandbox executor with only
`run.id` (D22) → the executor acquires the run **lease** (E2), starts/resumes the
**smithers summarize workflow** for that run (E10), which re-reads all state from
Postgres, **assigns** the run's input messages (E9), applies the threshold check (D10),
builds a **non-lossy budgeted** prompt input (E5), calls the Summarizer port (E4),
persists the chunk split (D8/D26), delivers each chunk via the
**reserve→record→edit→confirm** protocol (E1), finalizes `status='posted'`. Every
durable write by the executor is fenced by its attempt token (E2).

Why this shape: it keeps the design doc's proven skeleton (single tick that only scans
and claims; one generic Sandbox path; Postgres-derived idempotent steps — D21–D23,
validated against graphile-worker/pg-boss/Temporal precedent in eng-oss §1–3), and the
skeleton is now explicitly the substrate on which the smithers runtime executes (§2) —
the bespoke tables are the app's domain model, and smithers' own workflow state shares
the same database, which is the REQ-8 template claim.

### Ports and adapters (key interfaces)

All external effects go through three narrow, constructor-injected ports. Each has
exactly two implementations selected by environment; application logic never branches
on environment.

| Port | Methods | Real impl | Test impl |
|---|---|---|---|
| `TelegramPort` | `sendMessage` | app adapter over `smithers-orchestrator/telegram`'s typed Bot API helper with D27 retry | **Postgres-backed fake** writing to `telegram_outbox` (E3) |
| `SummarizerPort` | `summarize(input: SummaryInput): SummarySchema` | Anthropic Messages API (`claude-sonnet-5`) | **fixture store** replaying recorded, schema-validated outputs (E4) |
| `Clock/Invoker` | `now()`, `invokeExecutor(runId)` | system clock / Sandbox invocation | controllable clock / inline invocation for local e2e |

Both Summarizer implementations validate output against the same JSON Schema
(`SummarySchema`: window, topics[**1–7**] with participants, decisions, actionItems,
links — see E13) before it reaches the renderer — grounding/shape bugs fail identically
in fixture and live modes (AC-3.2, AC-3.3).

## 2. Smithers serverless runtime (E10) — engineering REQ-8's actual point

The PRD's primary product is the pattern: smithers workflows running on Vercel
serverless primitives with the user's Postgres as the only store. v2 engineered a
bespoke state machine and left smithers itself unspecified; this section closes that.

**E10.1 — Summarization is a smithers workflow, executed per-run inside the Sandbox
executor.** The summarize pipeline (assign → threshold → budget → summarize → chunk →
deliver → finalize) is authored as a smithers workflow whose steps are exactly the
idempotent steps of D23/§5. The Sandbox executor's job is: acquire the lease (E2), then
run the smithers runtime **in-process** for that one workflow run to completion (or
until a step fails), and exit. There is no resident smithers daemon anywhere —
`smithers up`-equivalent execution happens inside the Sandbox invocation, satisfying
AC-8.1. The smithers step boundaries are the durability boundaries: a re-invoked
executor resumes the same smithers run, and completed steps are not re-executed
(smithers' step-result persistence subsumes the "check completion marker, continue"
logic of D23; the app-level fences of E1/E2 remain as the correctness backstop under
concurrent attempts).

**E10.2 — Smithers state lives in the same Postgres.** The smithers runtime is
configured with a **Postgres state driver** (its workflow/run/step/event tables in a
dedicated `smithers` schema in the same Neon database), replacing the SQLite file used
in local dev. AC-8.2's "all persistent state including workflow state in the single
Postgres database" is satisfied literally: `pg_dump` of one database captures app rows
and smithers run history together. The app's `run.smithers_run_id` column joins the two
worlds; the app `run` table remains the scheduling/claim/idempotency surface (D2 needs
a natural-key constraint smithers does not provide), while smithers' tables are the
step-level execution record. **Whether the current smithers runtime ships a
Postgres driver usable from a serverless/Sandbox context is unverified — probe A12,
blocking.** We maintain smithers; if the driver is missing or SQLite-coupled, the fix
is an upstream smithers deliverable (Postgres storage adapter + tests + docs), planned
as the first implementation milestone, not a local workaround.

**E10.3 — The operator UI is the custom smithers Gateway UI, served serverlessly.**
The dev-loop gateway (`bun .smithers/gateway.ts`) is a long-lived local process and is
**not** deployed. The production operator UI (REQ-7) is a Next.js app on the same
Vercel deployment (AC-7.6) whose routes read both the app schema (runs list, chat
config) and the smithers schema (per-step timeline on the run-detail page) directly
from Postgres — read-model only, no gateway process. Run detail shows the smithers step
timeline (step name, status, timing, error) beneath the D14 content, which is what
makes the template credibly a "smithers observability" example rather than a generic
CRUD admin.

**E10.4 — Replay/retry maps to smithers semantics.** UI "Replay" on a failed run (D14,
AC-7.3) = reset the run's lease/attempt state (fenced) and re-invoke the Sandbox
executor for the same `run.id`; the executor resumes the same smithers run, which
re-executes from the first non-completed step (smithers replay-from-failure semantics).
It never creates a new window or a new smithers run for the same window. The watchdog
(§6) re-invocation path is the identical mechanism triggered automatically — one resume
code path, exercised by both AC-7.3 and AC-9.4 tests.

Decision doc: `artifacts/smithering/decisions/smithers-serverless-runtime.html`.

## 3. Engineering decisions index

| ID | Section | Decision |
|---|---|---|
| E1 | §5 | Exactly-once delivery: per-chunk reserve→record→edit→confirm; bounded content-free placeholder residual, escalated for PRD acceptance |
| E2 | §6 | Run attempts with lease + heartbeat + fencing token; watchdog re-invokes only on lease expiry |
| E3 | §14.1 | Fake Telegram adapter is Postgres-backed (`telegram_outbox`), asserted via test-only authed API |
| E4 | §14.3 | SummarizerPort with fixture/replay default lane; live-Anthropic lane nightly |
| E5 | §8 | Non-lossy input budgeting: hierarchical map-reduce, paginated fetch, no truncation |
| E6 | §4 | Complete durable schema incl. cursor, assignment, lease, disclosure columns |
| E7 | §9 | Global tick backpressure: per-tick claim cap, fair cursor, stated scale envelope |
| E8 | §10 | Disclosure as a claimed state machine on `chat` with retry sweep |
| E9 | §7 | Ingest grace + unassigned-message repair: late webhook delivery cannot create gaps |
| E10 | §2 | Smithers runtime in Sandbox, Postgres state driver, serverless Gateway UI, replay mapping |
| E11 | §12 | Machine-endpoint auth: Telegram secret token, cron secret; D18 scoped to operator surface |
| E12 | §13 | Telegram group-message access: privacy-mode setup gate, `getMe` check, allowed_updates pinning, live smoke |
| E13 | §8.1 | Sparse-window summary shape: topics[1–7], honest short form; amends D7's 3–7 |
| E14 | §6.1 | Scheduled window lineage via `chat_config.sched_cursor`; manual runs never advance it |

## 4. Durable data model (E6 — complete; supersedes design §2's shape)

```sql
chat        (id, telegram_chat_id UNIQUE, title, created_at,
             disclosure_status   text NOT NULL DEFAULT 'pending'
                                 CHECK (disclosure_status IN ('pending','sending','sent')),
             disclosure_claimed_at timestamptz,      -- E8 claim timestamp (retry sweep)
             disclosure_message_id bigint,
             disclosure_sent_at  timestamptz)

chat_config (chat_id FK UNIQUE, cron_expr, timezone, min_messages int DEFAULT 3,
             enabled bool DEFAULT true,
             enabled_at timestamptz NOT NULL,        -- D5/AC-6.2 window anchor
             sched_cursor timestamptz,               -- E14 scheduled-lineage watermark
             last_claim_scan_at timestamptz,         -- E7 fair-scan cursor
             updated_at)

message     (id, chat_id FK, telegram_message_id, from_user, text, sent_at,
             ingested_at timestamptz NOT NULL DEFAULT now(),  -- E9 lateness detection
             is_bot bool DEFAULT false,
             assigned_run_id bigint FK NULL,         -- E9 assignment ledger
             UNIQUE (chat_id, telegram_message_id))  -- AC-1.4

run         (id, chat_id FK, window_start, window_end,
             status text CHECK (status IN ('pending','running','posted','skipped','failed')),
             trigger text CHECK (trigger IN ('scheduled','manual')),
             smithers_run_id text,                   -- E10.2 join to smithers schema
             summary_text text, skip_reason text, failure_reason text,
             attempt_count int NOT NULL DEFAULT 0,   -- D27/AC-5.4 outer retry bound
             last_error text,                        -- AC-5.4 UI visibility
             lease_owner uuid,                       -- E2 fencing token
             lease_expires_at timestamptz,
             heartbeat_at timestamptz,
             input_message_count int,
             late_message_count int DEFAULT 0,       -- E9 observability
             created_at, completed_at,
             UNIQUE (chat_id, window_start, window_end))  -- D2 atomic claim

run_chunk   (run_id FK, chunk_index, chunk_text,
             state text NOT NULL DEFAULT 'pending'
                   CHECK (state IN ('pending','reserving','reserved','edited','sent')),
             telegram_message_id bigint, reserved_at timestamptz, sent_at timestamptz,
             UNIQUE (run_id, chunk_index))           -- D26 ledger, E1 state machine

-- smithers schema: owned by the smithers Postgres state driver (E10.2); its DDL is a
-- smithers deliverable, not duplicated here. run.smithers_run_id is the join key.

telegram_outbox (id, method, chat_id, payload jsonb, message_id, created_at)
             -- E3: written ONLY by the fake TelegramPort; absent from production traffic
```

Every requirement-bearing field traces to durable Postgres state; there is no implicit
in-memory or in-invocation state anywhere in the run lifecycle.

## 5. Exactly-once delivery (E1) — engineering AC-5.3 / AC-9.4

Telegram's Bot API offers **no idempotency key on `sendMessage`** (assumption A1,
probed in §16). Exactly-once over a non-idempotent effect is built from two mechanisms:

**(a) Single writer.** Only the executor holding the run's current lease (E2) may touch
`run_chunk`. Every ledger write is fenced:
`UPDATE run_chunk ... WHERE run_id=$1 AND chunk_index=$2 AND <state guard> AND EXISTS
(SELECT 1 FROM run WHERE id=$1 AND lease_owner=$attempt)` — a stale attempt's writes
affect zero rows and it exits. Two executors can never both observe "unsent" and both
send: the loser's *reserve write* fails its fence before any Telegram call is made.

**(b) Two-phase send — reserve → record → edit → confirm.**

1. `reserving`: fenced write of `state='reserving', reserved_at=now()` (write-ahead
   intent).
2. Send a **placeholder** (`…`) via `sendMessage`; on success record its
   `telegram_message_id`, `state='reserved'` (fenced).
3. `editMessageText(telegram_message_id, chunk_text)` → `state='edited'`. Edits are
   idempotent: re-editing to identical content returns "message is not modified",
   treated as success.
4. `state='sent', sent_at=now()`.

Resume analysis by crash cut: before 1 → nothing sent, redo. Between 1 and 2's record →
the ambiguous case: a placeholder *may* exist in the chat with unknown id (Telegram
gives a bot no way to enumerate or find its own past messages, so the orphan is
undetectable and undeletable); the resumed attempt sends a fresh placeholder and
proceeds. After 2 → id is durable; resume edits idempotently. After 3/4 → no-ops.
**Duplicate summary content is impossible by construction.**

**Residual, bounded and escalated (review finding 6).** The irreducible residual is a
content-free `…` message per attempt that crashes exactly in the cut between step 2's
provider-ack and its record write. It is therefore bounded by `max_attempts` (5) per
run, not by 1 — the invariant tests assert **orphan placeholders ≤ attempt_count**, and
a run-detail UI note lists `attempt_count` so an operator can explain a stray `…`.
Strictly read, PRD REQ-5 ("exactly once and intact") and the no-spam stance do not
admit even a content-free stray, and no protocol can close this cut given A1 (recorded
with the rejected alternatives — send-then-record without placeholder, dedup-by-read
which the Bot API cannot do, MTProto session which the PRD forbids — in
`artifacts/smithering/decisions/exactly-once-delivery.html`). **This is a declared
deviation requiring PRD acceptance**: proposed amendment text — "AC-5.3 applies to
summary *content*; content-free placeholder messages caused by crash-during-send are
permitted, bounded by the per-run attempt limit." It is surfaced as a blocker-class
assumption (A13) in the structured output so the orchestrator's gate puts it in front
of the human; implementation of §5 does not start until accepted or a stricter protocol
is mandated.

**Named tests (must be able to fail):**
- Concurrency: two executor attempts driven concurrently against one run (fake
  TelegramPort, real Postgres); assert exactly one placeholder+edit pair per chunk and
  that the fenced loser wrote zero ledger rows.
- **Post-send/pre-record cut**: fault-injecting TelegramPort kills the process after
  provider-ack of step 2 and before the record write, for each chunk index; resume;
  assert delivered content set equals the chunk list exactly once and **orphan
  placeholders ≤ attempt_count**; run ends `posted`.
- Repeated ambiguous cut across N attempts of the same chunk: assert orphan count ≤ N
  and content still delivered exactly once (this is the revised invariant the review
  asked for).
- Cut injection at every other state transition (property-style loop over all cuts × a
  3-chunk run). Red-before-green: each cut test is committed failing against the
  no-lease/no-two-phase logic first.

## 6. Run attempts, leases, heartbeats, watchdog (E2) — AC-8.1, AC-9.2/9.4

- **Acquire**: executor start = `UPDATE run SET lease_owner=$newAttempt,
  lease_expires_at=now()+interval '5 min', heartbeat_at=now(),
  attempt_count=attempt_count+1, status='running' WHERE id=$runId AND
  (lease_owner IS NULL OR lease_expires_at < now()) AND status IN
  ('pending','running') RETURNING ...`. Zero rows → another attempt is live or the run
  is terminal; exit. Atomic: no two live leases coexist.
- **Heartbeat**: every 30 s the executor extends `lease_expires_at`/`heartbeat_at`
  (fenced; a failed heartbeat = lease lost → abort immediately). Lease TTL (5 min) is
  decoupled from task duration: a healthy 40-minute task heartbeats ~80 times and is
  never taken over — how REQ-9's >20-minute tasks coexist with fast recovery.
- **Watchdog** (inside `/api/cron/tick`): re-invokes the executor for runs
  `WHERE status='running' AND lease_expires_at < now() AND attempt_count <
  max_attempts` (5). At `max_attempts`, fenced-finalize `status='failed',
  failure_reason=last_error` (AC-5.4). Re-invocation resumes the smithers run (E10.4).
- **Fencing everywhere**: `lease_owner` is the fencing token on every durable write.

UI: `heartbeat_at` drives the D12 running-vs-stalled display (stalled = heartbeat older
than 2 min). Tests: lease mutual exclusion under concurrent acquire (property test,
real Postgres); simulated crash → single new attempt, correct final state; slow-but-
alive task not taken over; attempt exhaustion → `failed` with reason. Decision doc:
`artifacts/smithering/decisions/lease-watchdog.html`.

### 6.1 Scheduled window lineage vs. manual runs (E14) — review finding 5

Scheduled windows are **never** derived from "the prior run row" — they are derived
from `chat_config.sched_cursor`, a watermark advanced **only** by the scheduled path:

- Tick due-scan: walk D4's cron forward from `sched_cursor` (initialized to
  `enabled_at` per D5). For each elapsed boundary `b` (oldest first, D25 caps): claim
  window `[sched_cursor, b)` via D2's insert; **whether the insert claims a new row or
  conflicts with an existing row exactly matching `(chat_id, sched_cursor, b)`** (e.g.
  a manual run already summarized precisely that window), advance
  `sched_cursor := b` in the same transaction. Conflict with an identical-window manual
  run means the window is already handled — cursoring past it creates no gap and no
  duplicate.
- Manual runs (D17): claim whatever window the operator picked, `trigger='manual'`,
  and **do not touch `sched_cursor`**. A manual window that overlaps (without exactly
  matching) future scheduled windows is allowed and disclosed in the UI as an overlap
  badge on both runs — the scheduled lineage remains gapless/overlap-free among
  scheduled runs, which is what AC-2.1 governs; manual re-coverage is operator-chosen.
- Re-enable (AC-6.2): `sched_cursor := enabled_at` on the enable transition.

Tests: property test over random interleavings of scheduled boundaries and manual
windows asserting the scheduled lineage `[cursor_i, cursor_{i+1})` is contiguous with
no gaps/overlaps regardless of manual activity; exact-match manual-then-scheduled case
advances the cursor without a duplicate post. Decision doc:
`artifacts/smithering/decisions/scheduled-cursor.html`.

## 7. Ingestion watermark and late-webhook repair (E9) — review finding 2

Telegram retries webhook delivery with backoff for up to ~24 h; a message with
`sent_at` inside a window can be ingested after that window's run has posted. Two
mechanisms make this a delay, never a gap:

- **Ingest grace**: the tick treats a scheduled boundary `b` as due only when
  `now() >= b + INGEST_GRACE` (default 120 s). This absorbs ordinary jitter and
  in-flight retries cheaply; it shifts posting time, not window boundaries (the window
  is still `[cursor, b)`).
- **Assignment ledger + unassigned repair**: a run's input set is not "messages with
  `sent_at` in the window" but **"non-bot messages with `assigned_run_id IS NULL` and
  `sent_at < window_end`"**, assigned to the run (fenced, before summarization) as the
  workflow's first step. Skipped runs assign their messages too (preserving AC-4.5's
  per-window independence — a skipped window's *in-window* messages are consumed by the
  skipped run, never rolled forward). A message ingested *after* its covering window
  finalized is simply still unassigned, so the **next** run picks it up: it is counted
  in `run.late_message_count`, and rendered under a distinct final summary line —
  *"Earlier (delivered late): …"* — so content is never silently dropped and never
  silently misattributed to the wrong window. AC-1.1's "included in the next summary
  whose window covers it" is met in the delayed-delivery case by the amended reading
  "included in the next posted summary, flagged as late"; this reading is recorded
  here as the binding interpretation (the alternative — reopening posted runs — would
  violate AC-5.3's no-duplicate guarantee).
- Threshold (REQ-4) counts only in-window unassigned messages; late strays alone never
  trigger a summary but ride along when one posts. The webhook also stores
  `ingested_at`, making lateness (`ingested_at > window_end` of the covering window)
  observable in the UI and testable.

Tests: e2e — post window W's run, then deliver a webhook for a message with `sent_at`
inside W; assert it appears in the next posted summary under the late section with
`late_message_count=1` (red-before-green against the v2 window-query logic, where this
test provably fails); duplicate-delivery of the same late message (AC-1.4) stays
deduped; grace-boundary test at `b + INGEST_GRACE ± 1s`. Decision doc:
`artifacts/smithering/decisions/late-webhook-repair.html`.

## 8. Non-lossy large-window input strategy (E5, revised) — review finding 3

The v2 newest-N truncation dropped covered messages, contradicting AC-1.1/AC-2.1. The
revised strategy is **non-lossy at every scale**:

- `MAX_INPUT_TOKENS` = 80,000 estimated tokens (chars/4 heuristic, tolerance-tested
  against the Anthropic token-counting endpoint) per summarize call; `SEGMENT_TARGET` =
  60,000.
- Fits budget → single Summarizer call (the common case).
- Over budget → **hierarchical map-reduce with no level cap**: split chronologically
  into contiguous segments ≤ `SEGMENT_TARGET`; map each to an intermediate structured
  summary; if the intermediates exceed the budget, reduce them in groups, recursively,
  until one reduce call remains. Every message is read by exactly one map call —
  nothing is discarded at any volume. Cost/latency grow with volume; the lease/
  heartbeat model (E2) and the >20-minute Sandbox path (REQ-9) are precisely what make
  arbitrarily long summarize runs safe, so volume costs time and tokens, never
  coverage.
- Message fetch is paginated (`FETCH_PAGE` = 5,000 rows) — no `MAX_MESSAGES` cap
  exists anymore; `run.input_message_count` records the true total.
- Degraded-granularity disclosure: when depth ≥ 2 reduce levels, the summary opens
  with *"High-volume window (N messages): condensed digest."* — a visible mode change,
  not a lossy one.
- Grounding under map-reduce: intermediate summaries carry participant/link lists
  verbatim; the reduce prompt may only select from them (the AC-3.3 no-fabrication
  eval runs over map-reduce fixtures too).

Tests: boundary windows at exact budget and budget+1; 3-segment and 2-level (segment
count forcing recursive reduce) fixtures asserting planted topics from the *first and
last* segment both surface (coverage, AC-1.1 at volume); pagination fuzz (random
message counts around page boundaries); benchmark on the largest fixture (50k
messages) with an asserted wall/token ceiling. Decision doc:
`artifacts/smithering/decisions/window-budgeting.html`.

### 8.1 Sparse-window summary shape (E13) — review finding 4

D7's `topics: 3–7` conflicts with AC-4.3 (threshold-1 chat must get a summary for a
one-message window) and AC-3.3 (no fabrication). Amendment, recorded here as binding
over D7's count: **`SummarySchema.topics` is 1–7 entries**; the renderer emits however
many real topics exist. For sparse windows (< 3 substantive topics) the template
contracts honestly: window header, 1–2 topic lines, optional sections omitted per D7 —
a one-message window yields a one-topic, two-line summary quoting nothing that wasn't
said. REQ-3's "3–7 main topics" is read as the upper-shape for normal windows, not a
floor that forces invention; this interpretation is flagged to the design owner as a
one-line design-doc errata (D7'). Tests: fixture with a single message at threshold 1
→ posted one-topic summary, schema-valid, grounding eval clean; fixture with 2 topics
→ exactly 2 rendered.

## 9. Cron-tick scale envelope and backpressure (E7)

**Stated scale envelope (enforced by test):** up to **500 enabled chats**, up to **50
concurrently running runs**, tick completes in **< 10 s** at that scale. Beyond the
envelope degrades gracefully (backlog drains, never drops — AC-2.5).

- **Global per-tick claim cap**: at most `TICK_CLAIM_CAP` = 25 new runs claimed per
  tick (on top of D25's per-chat 20); unclaimed due windows stay due for later ticks —
  correctness never depends on a tick finishing its scan.
- **Fair cursoring**: due-scan orders chats by `chat_config.last_claim_scan_at ASC`
  and stamps as scanned — no starvation; a partial tick resumes where it left off.
- **Concurrency gate**: invocation deferred (rows still claimed) when
  `count(*) WHERE status='running' AND lease_expires_at > now()` ≥
  `MAX_CONCURRENT_RUNS` = 50; the watchdog also sweeps `pending` runs older than one
  tick, so deferred invocations are never stranded.
- **DB connections**: pooled Neon connection string everywhere; the tick uses
  set-based queries, not per-chat round trips.

Tests: backlog-drain e2e (200 chats × 10 windows behind, controlled clock: monotone
drain, no duplicate claims, bounded staleness, tick wall-time bound); connection-count
assertion under load. Decision doc:
`artifacts/smithering/decisions/tick-backpressure.html`.

## 10. First-contact disclosure (E8) — AC-1.2

1. Webhook upserts `chat`, then claims: `UPDATE chat SET
   disclosure_status='sending', disclosure_claimed_at=now() WHERE id=$1 AND
   (disclosure_status='pending' OR (disclosure_status='sending' AND
   disclosure_claimed_at < now()-interval '10 min')) RETURNING id`. Concurrent first
   webhooks: exactly one wins.
2. Winner sends the D9 plain-text message with D27 bounded retry; on success writes
   `disclosure_status='sent', disclosure_message_id, disclosure_sent_at`.
3. Failure/crash → row stays `sending` with stale claim; re-claimable after 10 min;
   the tick sweeps and re-attempts. Residual: a crash between provider-ack and the
   `sent` write can duplicate the greeting once per crashed attempt; accepted
   (harmless, same irreducible cut as §5, folded into the A13 PRD-acceptance ask).

Tests: concurrent first-webhook race (exactly one outbox disclosure); send-failure →
sweep → eventually sent; crash-cut test documenting the bounded residual.

## 11. Operator UI (REQ-7) — serverless Gateway UI

Layout/interaction per D11–D18; served per E10.3 (Next.js routes on the same
deployment, reading app + smithers schemas). Additions over the design doc: run detail
shows the smithers step timeline (E10.3), `heartbeat_at`-driven stalled state (§6),
overlap badges on manual runs (E14), `late_message_count` and high-volume mode on run
detail (E9/E5), and `attempt_count` with the placeholder-residual note (E1).

## 12. Auth boundaries (E11) — review finding 7

D18's "all server routes reject requests without the token/cookie" is scoped to the
**operator surface** only. Full boundary map:

| Surface | Caller | Auth |
|---|---|---|
| UI pages + operator API routes | human operator | D18 shared-secret bearer/cookie (+ optional Vercel Deployment Protection) |
| `/api/telegram/webhook` | Telegram servers | `secret_token` set at `setWebhook` registration; handler rejects any request whose `X-Telegram-Bot-Api-Secret-Token` header ≠ `TELEGRAM_WEBHOOK_SECRET` (constant-time compare). No cookie/UI token accepted here. |
| `/api/cron/tick` | Vercel Cron | `Authorization: Bearer ${CRON_SECRET}` (Vercel injects it for cron invocations); reject otherwise. Manual ops invocation uses the same secret. |
| `/api/test/outbox` + fault-plan routes | e2e suite | enabled only when `E2E_TEST_ROUTES=1` (never set in production env), and additionally require the D18 bearer secret |
| Sandbox executor → Postgres | executor | `DATABASE_URL` from Vercel env; no inbound HTTP surface at all |

All three secrets (`UI_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `CRON_SECRET`) are
independent, env-supplied, rotatable, README-listed (AC-11.3). Tests: each machine
endpoint returns 401/403 for missing/wrong credential and for the *other* surface's
credential (cross-credential rejection); webhook accepts only the correct header.
Design-doc errata filed against D18's wording. Decision doc:
`artifacts/smithering/decisions/machine-auth.html`.

## 13. Telegram group-message access (E12) — review finding 8

REQ-1 silently fails if the bot is in **privacy mode** (default: bots receive only
commands/replies, not ordinary group messages). Engineered as a declared dependency
with three gates:

- **Setup gate (README/D20 checklist, amended)**: BotFather `/setprivacy → Disable`
  before adding the bot to any chat (Telegram applies privacy changes only on
  re-add — the checklist orders steps accordingly), plus webhook registration with
  `allowed_updates: ["message", "my_chat_member"]` and the E11 `secret_token`.
- **Automated deploy check**: `pnpm check:telegram` (also run as a post-deploy step
  and surfaced as a red banner in the operator UI) calls `getMe` and fails unless
  `can_read_all_group_messages === true`, and calls `getWebhookInfo` and fails unless
  the URL matches the deployment, `allowed_updates` includes `message`, and
  `last_error_date` is not recent. This converts the silent failure mode into a loud,
  pre-traffic one.
- **Live smoke coverage (extends D30)**: the opt-in smoke lane asserts, in addition to
  the send round-trip, that a plain (non-command) group message in the dedicated test
  chat is ingested into `message` within 60 s. Because Telegram bots cannot see other
  bots' messages, this message must originate from a human/user account; the smoke
  test therefore runs in *prompted mode* (it prints "send any message in <chat> now"
  and polls) in local opt-in runs, and the nightly lane asserts the `getMe`/
  `getWebhookInfo` checks unconditionally. This human-in-the-loop residual is a
  Telegram platform constraint, recorded, not hidden.

Probe A11 (blocking) validates the whole chain once with a real bot before
implementation relies on it. Decision doc:
`artifacts/smithering/decisions/telegram-access.html`.

## 14. Test architecture (extends D28–D31)

### 14.1 Durable fake Telegram adapter (E3)

In Preview, webhook / tick / executor / UI run in separate serverless isolates; an
in-memory fake is invisible across them. The fake `TelegramPort` writes every call
(`method`, `chat_id`, full `payload`, generated monotonic `message_id`) to
`telegram_outbox` in the same Postgres — durable, shared across isolates,
branch-isolated per Preview (D29). The e2e suite asserts through `/api/test/outbox`
(E11-gated). The identical suite runs locally against the same route over local
Postgres — "same suite" stays literally true (AC-10.2/10.3). Decision doc:
`artifacts/smithering/decisions/preview-test-adapters.html`.

### 14.2 Fault injection

A `FaultInjectingTelegramPort` decorator (test builds only) reads a fault plan from the
test DB (`kill after ack of send #k`, `429 with retry_after`, `timeout after ack`) so
the §5/§6/§10 crash-cut tests run in-process locally **and** against Preview.

### 14.3 Deterministic LLM lanes (E4)

- `SUMMARIZER_MODE=fixture` (default in local dev, PR CI, Preview e2e): replays
  recorded outputs keyed by a stable hash of the canonicalized `SummaryInput`; unknown
  key → loud failure naming the missing fixture. Fixtures in `fixtures/summaries/`,
  schema-validated on load.
- `SUMMARIZER_MODE=anthropic`: real Messages API (`claude-sonnet-5`), structured
  output validated against `SummarySchema`, one repair retry.
- `pnpm fixtures:record` regenerates fixtures via the real API; reviewed in PR.
- Nightly live-LLM lane runs the e2e fixtures in `anthropic` mode plus the AC-3.3
  grounding eval; skips cleanly without the key.

### 14.4 Lane matrix

| Lane | Telegram | Summarizer | DB | When | Gates |
|---|---|---|---|---|---|
| unit/integration | fake (in-proc) | fixture | real local PG (transactional) | every PR | 100% coverage (D31) |
| e2e local | fake (outbox) | fixture | local PG | every PR | AC-10.2 |
| e2e Preview | fake (outbox) | fixture | Neon branch (D29) | every PR, required | AC-10.3 |
| long-task PR variant | fake | fixture | Neon branch | every PR | AC-9.3 |
| long-task nightly (>20 min real work) | fake | fixture | Neon branch | nightly | AC-9.2 |
| live LLM eval | fake | anthropic | Neon branch | nightly / opt-in | AC-3.3 |
| Telegram smoke (+ E12 ingestion check) | real | fixture | prod-like | opt-in (D30) | AC-10.4, REQ-1 live |

## 15. Dependencies (declared)

| Dependency | Purpose | Risk |
|---|---|---|
| Neon Postgres (Vercel Marketplace) | Single state store (app + smithers schemas); branch-per-Preview isolation (AC-8.2, AC-10.3) | Low-medium: plain SQL, dump/restore portable; branching Neon-specific; pooled-connection limits under fan-out unverified |
| Vercel Cron | 1-minute tick trigger (D21) | Medium: plan-tier gating of 1-minute crons unverified; trigger config Vercel-locked (endpoint portable) |
| Vercel Sandbox | Long-task executor >20 min hosting the smithers runtime (D22, E10, REQ-9) | High: newest primitive; runtime ceiling, invocation API, pricing unverified; no substitute within PRD constraints |
| Vercel Functions | Webhook, tick, UI, test routes | Low: GA; only tick wall-time (§9) is sensitive |
| smithers runtime (`smithers-orchestrator`) | Workflow execution, step durability, replay semantics (E10) | High: Postgres state driver in a serverless context unverified (A12); we maintain smithers, so gaps are upstream deliverables with their own tests/docs |
| Telegram Bot API | Ingestion + delivery | Medium: no idempotency key (drives E1); privacy mode gates REQ-1 (E12, A11); rate limits shape D27; webhook retry lag drives E9 |
| Anthropic API (`claude-sonnet-5`) | Summarization (E4) | Medium: cost/latency on big windows (bounded in time, not coverage, by E5); schema adherence needs repair retry; isolated to nightly lane for CI determinism |
| `croner` (fallback `cron-parser`) | DST-correct cron walking (D4) | Low: narrow, swappable utility behind one function |
| Raw typed Telegram HTTP client (no framework) | Full control of retry/idempotency per D26/D27/E1 | Low: small owned surface; frameworks rejected — their retry machinery conflicts with the ledger |
| Vitest + v8 coverage | Test runner and 100% line/branch gate (AC-10.1) | Low: standard; branch accuracy on fenced-SQL early exits confirmed by probe A9 |
| Neon branch automation in CI | Per-PR database provisioning (D29) | Medium: branch create/delete quotas and latency unverified |

## 16. Assumptions to probe

Each probe is one narrow question, answered by a throwaway spike in isolation before
implementation depends on it. Every §15 dependency maps to at least one probe.

| ID | Assumption | Probe (ONE question) | Blocking |
|---|---|---|---|
| A1 | Telegram `sendMessage` has no idempotency key, and `editMessageText` re-edit-to-identical-content is an idempotent success-equivalent | Against a real test bot: does edit-to-identical-content return the benign "message is not modified" E1 treats as success? | **yes** (E1) |
| A2 | Vercel Sandbox can run a single task >25 min of real incremental work, invocable from a Function | Does a spike Sandbox task run 25 min of loop work to completion when triggered by a Function? | **yes** (REQ-9) |
| A3 | Vercel Cron supports 1-minute schedules on the target plan and fires reliably | Does a 1-minute cron on our plan fire ≥58 times in an hour? | **yes** (D21) |
| A4 | Neon branch create/reset per PR completes < 60 s within plan quotas | Does `neon branches create` from CI return a usable connection string in < 60 s? | **yes** (AC-10.3) |
| A5 | The Neon pooled connection string sustains tick + 50 executors + UI concurrently | Do 60 concurrent pooled clients run the claim/heartbeat queries without connection errors? | **yes** (§9 envelope) |
| A6 | `croner` walks 5-field cron across a DST transition in `America/New_York` correctly | Does the library return the expected boundary sequence across the 2026 DST change? | **yes** (AC-2.2) |
| A7 | Anthropic structured output conforms to `SummarySchema` ≥95% first-try on fixtures; one repair retry closes the gap | What is the schema-pass rate over the 10 fixture conversations? | no (fixture lane decouples CI) |
| A8 | Telegram per-chat rate limits are survivable with D27 backoff at our chunk counts | Does sending 10 chunks at 1/s to one chat avoid unrecoverable 429s? | no (backoff + watchdog already handle failure) |
| A9 | Vitest v8 coverage reports branch coverage correctly for SQL-fence early-exit paths | Does an intentionally uncovered fence branch fail the 100% gate? | no (fallback: istanbul provider) |
| A10 | A Function (tick) can invoke a Sandbox task fire-and-forget without awaiting completion | Does the tick return in < 10 s while the invoked task keeps running? | **yes** (D21 fan-out) |
| A11 | With privacy mode disabled and `allowed_updates=["message"]`, the bot's webhook receives ordinary group messages, and `getMe.can_read_all_group_messages` reflects the setting | Does a plain human group message reach the webhook, and does `getMe` report `can_read_all_group_messages=true`, on a freshly configured real bot? | **yes** (REQ-1, E12) |
| A12 | The smithers runtime can persist workflow/run/step state to Postgres and resume a run from a fresh process (Sandbox re-invocation) with completed steps not re-executed | Does a 3-step spike smithers workflow, killed after step 2, resume in a new process against Postgres and execute only step 3? | **yes** (E10, REQ-8/AC-8.2). If it fails, the Postgres driver is built upstream in smithers first |
| A13 | The PRD owner accepts the bounded content-free placeholder residual (§5) as compatible with REQ-5, via the proposed AC-5.3 amendment | One human decision: accept the amendment text in §5, or mandate a stricter protocol (which, per the recorded alternatives, does not exist within Bot-API constraints)? | **yes** (E1 ships only after acceptance) |

Blocking probes run first as standalone spikes under `spikes/` with recorded
transcripts; a failed blocking probe stops implementation and reopens this doc. A13 is
a human gate, not a spike.

## 17. Requirements traceability

| Requirement | Engineering section(s) |
|---|---|
| REQ-1 / AC-1.1 | §7 (E9 assignment + repair), §8 non-lossy volume, §13 (E12 access), §4 `message` uniqueness |
| AC-1.2 | §10 disclosure ledger (E8) |
| AC-1.3 | §6.1: windows anchor to `enabled_at`; no pre-join fetch path exists |
| AC-1.4 | §4 `message` unique constraint; §7 late-duplicate test |
| REQ-2 / AC-2.1 | §6.1 (E14 scheduled cursor), §7 (E9 grace), D2/D25 |
| AC-2.2–2.4 | §4 `chat_config`, probe A6 (D4) |
| AC-2.5 | §9 backlog drain + D25 |
| REQ-3 / AC-3.1–3.4 | §1 SummarySchema boundary, §8 grounding, §8.1 (E13 sparse shape), §14.3 lanes, D6–D8 |
| REQ-4 / AC-4.1–4.5 | §7 threshold-over-assignment (incl. AC-4.5 via skip-assignment), §8.1 (AC-4.3), §4 skip fields, D10 |
| REQ-5 / AC-5.1 | §8 volume disclosure, D8 chunking, §5 ledger |
| AC-5.2 | §5 in-attempt retry, §6 watchdog outer loop, §10 sweep |
| AC-5.3 | **§5 (E1) + §6 fencing (E2)**, named crash-cut tests, A13 amendment gate |
| AC-5.4 | §4 `attempt_count`/`last_error`, §6 attempt exhaustion |
| REQ-6 / AC-6.1–6.3 | §4 `chat_config` (incl. `enabled_at`, `sched_cursor`), §6.1 re-enable, D16–D17 |
| REQ-7 / AC-7.1–7.6 | §11 (incl. smithers step timeline E10.3), §6 stall display, §12 auth (AC-7.5), E10.3 (AC-7.6), E10.4 (AC-7.3) |
| REQ-8 / AC-8.1–8.3 | **§2 (E10: smithers runtime, Postgres driver, no resident process)**, §4 (all state durable), §6 recovery, probe A12 |
| REQ-9 / AC-9.1–9.5 | §2 (E10.1 single generic path), §6 leases/heartbeats, probes A2/A10, §14.4 long-task lanes |
| REQ-10 / AC-10.1–10.5 | §14 lane matrix, E3/E4, D28–D31, probes A4/A9 |
| REQ-11 / AC-11.1–11.3 | D19–D20 + §13 setup gate + §12 secret inventory; §16 spike transcripts feed the README architecture section |

**Engineering-only tickets** (serve no single feature; called out explicitly):
smithers Postgres state driver upstream work if A12 fails (§2), `telegram_outbox` +
test-only routes (E3), `FaultInjectingTelegramPort` (§14.2), fixture recording script
(§14.3), `pnpm check:telegram` (§13), spike scripts under `spikes/` (§16), Neon branch
CI automation (D29), coverage exclusion file (D31), controllable-clock plumbing (§1
Clock port).

## 18. Verification

- **Every mechanism section names its tests inline** (§5–§10, §13) — crash-cut
  injection at every state transition, lease mutual-exclusion property tests, the
  scheduled-cursor interleaving property test, the late-webhook repair e2e
  (red-before-green against v2 logic), backlog-drain load test, boundary tests at
  exact budget limits, DST-crossing cron tests, cross-credential auth rejection tests,
  and concurrency races against real Postgres. All required CI, all deterministic
  (fixture LLM, fake Telegram, controlled clock).
- **Red-before-green** is mandatory for every review-driven mechanism (§5, §6.1, §7,
  §8, §12): each test is first committed failing against the naive implementation (or
  with the mechanism feature-flagged off) and the failing run linked in the PR.
- **e2e everywhere**: the same suite runs locally and against Preview (§14.1);
  long-task gates per §14.4; live-Telegram (incl. the E12 ingestion assertion) and
  live-LLM lanes are opt-in/nightly and skip cleanly.
- **Smithers-resume proof**: A12's spike graduates into a permanent e2e (kill executor
  mid-workflow → Sandbox re-invocation resumes the smithers run, completed steps not
  re-executed) — this is the REQ-8/AC-8.1 gate, distinct from the app-level lease
  tests.
- **Coverage**: 100% line+branch on app source (D31); probe A9 confirms the gate can
  fail on fence branches.
- **Fuzz/property**: chunker fuzzed with random MarkdownV2-entity-laden strings
  (chunks ≤4096, balanced entities, concatenation ≡ original modulo `(cont.)`);
  cron-walk property test (no gaps/overlaps over random schedules × timezones × 1-year
  walks); the §5 crash-cut loop; the §6.1 manual/scheduled interleaving property.
- **Benchmarks**: tick wall-time at the §9 envelope asserted < 10 s; chunker and
  budgeter benchmarked on the largest fixture (50k messages) with asserted ceilings.
- "The agent said it was done" is never evidence: every gate is an executable check
  wired into CI; the PR template requires linking the failing-first run for fixes.

## 19. Probe-synthesis amendments (2026-07-01)

Assumption probes (evidence: `artifacts/smithering/probes/A1..A13/`) forced the
following plan amendments. Blocking failures: A1, A2, A3, A10, A11, A13 (A7
non-blocking failed). A4–A6, A8, A9, A12 passed (A4/A5 provisionally — see caveats
in their READMEs).

1. **A10 (falsified) — tick must not rely on fire-and-forget promises.** Vercel
   Functions freeze after the response; un-awaited work does not survive, and
   `waitUntil()` is bounded by `maxDuration` (<< 20 min). Amend §2/§6: tick starts
   the Sandbox job via its async API, persists `{jobId, status:'running'}` to
   Postgres, and returns; completion is observed via webhook or a subsequent
   polling cron tick — never via in-process background promises.
2. **A3 (falsified on Hobby) — Vercel Pro is a hard deployment prerequisite.**
   Hobby rejects any cron firing more than once/day, so the `* * * * *`
   `/api/cron/tick` design (D21) cannot deploy on Hobby. Record Pro-or-higher as a
   prerequisite in 01-prd.md/02-design.md. Vercel gives no numeric firing SLA even
   on Pro, so the D4 catch-up walk + D21 watchdog are load-bearing correctness:
   add an explicit e2e for missed/skipped ticks (AC-2.5). Follow-up: instrument a
   live Pro deployment ≥1h to measure actual firing rate.
3. **A2 (unverified) — Sandbox >20min capability needs a live-credential re-run.**
   SDK shape confirmed, but `Sandbox.create()` could not run (invalid
   VERCEL_API_TOKEN, no project link/OIDC). Do not lock the architecture to Vercel
   Sandbox as the long-task provider until `vercel link` + `vercel env pull` are
   done and `artifacts/smithering/probes/A2/run-sandbox-loop.mjs` completes a full
   25-minute run (`evidence/run-result.json` shows `completed:true`).
4. **A13 (gate not passed) — E1 implementation is blocked on PRD-owner decision.**
   No record of acceptance of the AC-5.3 amendment ("applies to summary content;
   content-free placeholder messages from crash-during-send permitted, bounded by
   per-run attempt limit") exists in 01-prd.md; 04-backpressure.md BP-3 confirms
   it is outstanding. §5 (E1 exactly-once delivery) must not start until the owner
   accepts the amendment or relaxes REQ-5 — no stricter protocol exists within Bot
   API constraints. This is a human gate for the orchestrator.
5. **A1 (unverified) — do not treat `message is not modified` as a verified
   idempotency signal.** No Telegram credentials were available. Until
   `artifacts/smithering/probes/A1/probe.sh` runs against a real throwaway bot,
   the retry/dedup logic must not hard-code that error-string match as safe;
   prefer a content-hash short-circuit before calling `editMessageText`, keeping
   the string match as best-effort with a TODO to re-run the probe.
6. **A11 (unverified) — privacy-mode ingestion needs a manual live setup step.**
   Add to the AC-10.4 live-Telegram smoke test: human creates the bot, disables
   privacy mode via @BotFather *before* adding it to the group, confirms
   `getMe.can_read_all_group_messages == true` and that a plain human message
   reaches the webhook. Add a startup guard that warns if
   `can_read_all_group_messages` is false. Do not gate CI/merge on this.
7. **A7 (non-blocking, unverified) — schema pass-rate claim needs a real
   ANTHROPIC_API_KEY run.** Harness self-test passed; treat the fixture-lane
   SummarizerPort (E4) as unverified and keep the nightly live-LLM lane as the
   actual gate until `probes/A7/probe.mjs` produces real
   firstTryPassRate/postRepairPassRate numbers. The schema/fixtures/harness are
   reusable for `pnpm fixtures:record`.
8. **A12 operational notes (passed):** Postgres workflows must use the async
   `openSmithersBackend`/`createSmithersPostgres` factory (`createSmithers` is
   SQLite-only); no stray legacy `smithers.db` may sit next to the
   Postgres-configured deployment (SMITHERS_MIGRATION_REQUIRED hard-fail); decide
   whether Sandbox re-invocation waits out the RUN_HEARTBEAT_STALE_MS window or
   always resumes with `--force` (safe via claimRunForResume CAS).
9. **A4/A5 (provisionally passed):** re-run A4 with a Postgres client for a real
   SQL round-trip and under concurrent PR fan-out on the CI-scoped Neon quota;
   re-run A5 against a real Neon pooled connection string before production
   sign-off.
