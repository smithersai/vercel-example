# Research — Infra & Dependency Options (eng-deps)

Inputs: `docs/planning/01-prd.md`, `docs/planning/02-design.md`.
Scope: candidate infrastructure and 3rd-party dependencies implied by the design's
serverless/Postgres-only architecture (D21–D27) and quality gates (REQ-10). For each:
what it does for us, maturity, lock-in risk, leading alternative. Decisions recorded
where the design doc already binds a choice; otherwise flagged as open for the
implementation task.

## 1. Postgres hosting — Neon (via Vercel Marketplace)

**What it does for us**: the single state store (AC-8.2) — chat, chat_config, message,
run, run_chunk tables, plus workflow/smithers state. Neon's branch-per-preview model
directly satisfies AC-10.3 ("isolated per-preview database").

**Maturity**: Neon is a established managed Postgres provider, GA, first-party Vercel
Marketplace integration (Vercel Postgres was migrated to be Neon-backed). Widely used in
production.

**Lock-in risk**: Low-medium. Data model is plain Postgres (no Neon-proprietary SQL
features required by the design); a dump/restore to any Postgres host works. The
branch-per-preview workflow is a Neon-specific convenience that would need
reimplementing (e.g. a manual schema-reset script) if swapped for vanilla
Vercel Postgres/Supabase/RDS.

**Leading alternative**: Supabase (Postgres + branching also available) or plain
Vercel Postgres (same underlying Neon, less direct branch control). Self-hosted RDS
would lose the per-preview branching convenience AC-10.3 relies on.

**Decision**: use Neon via Vercel Marketplace, as implied by the PRD's explicit mention
("Neon via Vercel Marketplace") — not re-litigated here; recorded as the binding choice
for the implementation task.

## 2. Vercel Cron

**What it does for us**: fires `/api/cron/tick` (D21) at 1-minute granularity — the only
"always on" mechanism in a fully serverless deployment, satisfying REQ-8/AC-8.1.

**Maturity**: GA Vercel platform primitive, stable.

**Lock-in risk**: High for the trigger mechanism itself (Vercel-specific config in
`vercel.json`), but the Function it invokes is a plain HTTP endpoint — porting to
another platform means swapping the cron trigger (e.g. GitHub Actions schedule, a
third-party cron-to-webhook service) while keeping `/api/cron/tick` unchanged. Low
lock-in risk for the business logic.

**Constraint noted in design**: minimum granularity is 1 minute (per-plan cron
frequency limits also apply — Hobby plan allows only 1 cron/day; this design assumes a
Pro-tier or higher plan where 1-minute cron is available). This should be verified
against current Vercel plan limits before implementation; not independently re-verified
here (no live web access performed in this research pass — flagged as unverified).

**Leading alternative**: none within "fully serverless on Vercel" scope — this is a
platform-mandated choice, not an open decision.

## 3. Vercel Sandbox (long-task execution path)

**What it does for us**: the D22 execution path for summarization work — the mechanism
that lets a "run" exceed a single Function's execution-time ceiling (REQ-9, >20 minutes).

**Maturity**: Newer Vercel primitive relative to Functions/Cron. Its exact execution-time
ceiling, pricing model, and GA status should be confirmed directly against current
Vercel docs before implementation — this research pass did not perform a live fetch to
verify current limits/pricing, and that gap is called out explicitly rather than
guessed at.

**Lock-in risk**: High. This is a Vercel-proprietary mechanism; there is no
drop-in equivalent on other platforms (closest analogues are AWS Fargate/Cloud Run
Jobs, but the invocation/resume contract in D22/D23 is bespoke to how this design reads
state back from Postgres by `run.id`). Because D22 deliberately avoids passing task
state through the invocation payload and instead re-reads everything from Postgres,
the *design* is more portable than the *primitive* — swapping Sandbox for Fargate/Cloud
Run later would mainly require reimplementing the invocation trigger, not the task
logic.

**Leading alternative**: AWS Fargate / Cloud Run Jobs / Trigger.dev / Inngest (durable
execution vendors). The PRD's problem statement (REQ-1 item 2) explicitly rejects
third-party durable-execution vendors as the point of this template ("state lives
outside the user's own database"), so these are ruled out by design intent, not
technical necessity — recorded here as the alternative that was consciously not chosen.

**Decision**: Vercel Sandbox is binding per D22; alternatives are excluded by the
PRD's own problem statement, not re-evaluated.

## 4. Cron-expression parsing library (D4)

**What it does for us**: walks a chat's 5-field cron expression forward in the chat's
IANA timezone, handling DST transitions correctly (AC-2.2) — explicitly required to be
a "standard cron-parsing library rather than hand-rolled date math."

**Maturity / candidates** (general knowledge, not independently verified via web
fetch in this pass):
- `cron-parser` (npm) — widely used, supports iterator-based "next N occurrences,"
  has timezone support via `tz` option (commonly paired with a tz database library).
- `croner` — newer, TypeScript-native, built-in timezone support, actively maintained.
- `cronstrue` — human-readable descriptions only, not a scheduler; not a fit alone.

**Lock-in risk**: Low. This is a narrow, swappable utility — window-computation logic
(D4/D5/D25) depends only on "give me the next N boundaries after timestamp X in
timezone Y," a shape every candidate library implements. Swapping libraries later is a
contained change behind one function.

**Leading alternative**: hand-rolled date math using `Intl.DateTimeFormat`/`Temporal` —
explicitly rejected by D4's own rationale (DST edge cases are exactly what a
maintained library is for).

**Open decision for implementation**: exact library pick (`cron-parser` vs `croner`) is
not bound by the design doc and should be resolved during implementation; recommend
`croner` for native TypeScript types and explicit timezone handling, but this is a
judgment call not independently verified here (no live library comparison performed).

## 5. Telegram Bot API client

**What it does for us**: webhook ingestion (REQ-1), MarkdownV2 message delivery with
retry semantics (D6, D27), chunked sends tracked per D26.

**Maturity**: The Telegram Bot API itself is mature and stable. Client library choice
(e.g. `grammy`, `telegraf`, or raw `fetch` against the HTTP API) is unbound by the
design doc.

**Lock-in risk**: Low if a thin client is used — the design's retry/idempotency logic
(D26/D27) is implemented at the application layer regardless of client library, so the
library is doing little more than typed request/response shapes.

**Leading alternative / recommendation**: given the design requires bespoke retry
control (honoring `retry_after`, bounded attempts, D27) and exact control over
MarkdownV2 payloads, a thin/raw HTTP client (or a minimal typed wrapper like `grammy`'s
core `Bot` API surface without its middleware framework) is likely a better fit than a
full framework (`telegraf`) whose built-in retry/session machinery could conflict with
D23/D26's Postgres-driven idempotency model. Not independently verified via web
fetch — flagged as a recommendation for the implementation task to confirm.

## 6. Coverage tooling (REQ-10 / AC-10.1)

**What it does for us**: enforces the 100%-line/branch CI gate.

**Maturity**: standard tooling for the stack in use (e.g. `vitest --coverage` via
`v8`/`istanbul` provider, or Node's built-in coverage) — no dependency-specific research
performed since the design doc does not name a test runner and none was found evaluated
in the read planning docs. This is an open implementation-task decision, not a design
decision recorded here.

**Lock-in risk**: N/A — standard, swappable dev-time tooling.

## 7. Summary of decisions vs. open items

| Item | Status | Source |
|---|---|---|
| Postgres = Neon via Vercel Marketplace | **Decided** (binding) | PRD problem statement |
| Cron trigger = Vercel Cron | **Decided** (platform-mandated) | D21 |
| Long-task execution = Vercel Sandbox | **Decided** (binding, alternatives ruled out by PRD intent) | D22 |
| Cron-parsing library | **Open** — recommend `croner`, unverified | D4 |
| Telegram client library | **Open** — recommend thin/raw client, unverified | D6, D26, D27 |
| Coverage tooling | **Open** — not addressed by design doc | REQ-10 |

## Caveats

- No live web fetch was performed in this research pass; library maturity/version
  claims above reflect general knowledge as of this writing and should be spot-checked
  (npm download counts, latest release dates, current Vercel Sandbox docs/pricing)
  before the implementation task locks in package versions.
- Vercel Sandbox's exact execution-time ceiling and plan-tier availability (referenced
  in REQ-9) is asserted by the PRD/design but was not independently re-verified here.
