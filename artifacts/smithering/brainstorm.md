# Brainstorm — Smithers-on-Vercel Telegram Summary Bot

## Problem statement

Smithers today assumes a local, long-running environment (local SQLite `smithers.db`, a
persistent gateway process). There is no proven, documented path for running smithers
workflows on serverless infrastructure. This project builds that proof: a flagship example
repo where a Telegram summary bot — cron-scheduled (GitHub-Actions-style expression), reads
a chat's messages for the period, summarizes them with an LLM, posts the summary back —
runs **entirely on Vercel** (Functions + Cron + Sandbox) with **Postgres as the only state
store**, agent tasks that can exceed 20 minutes, a Telegram plugin implemented as a
smithers service, and a custom Gateway UI. The build process itself is the second product:
spec-driven development through the `smithering` workflow (fixing its upstream bugs),
dogfooded via its custom UI, with every success criterion backed by a validation gate,
100% coverage, and e2e tests that run both locally and in Vercel Preview deployments.

Two customers:
1. **Bot users** — a Telegram chat that wants periodic AI summaries.
2. **Smithers adopters** — developers reading this repo as the canonical "smithers on
   Vercel / serverless / Postgres" reference. The second audience is the real one; the bot
   is the vehicle.

## Core capabilities (10/10 version)

1. **Postgres state backend for smithers** — smithers runs with `DATABASE_URL` (Neon via
   Vercel Marketplace) instead of local SQLite; tasks fully stateless; upstream support if
   missing (code + tests + docs + regenerated llms bundles).
2. **Vercel Sandbox provider for `<Sandbox>`** — upstream smithers provider enabling agent
   tasks > 20 min (Vercel Sandbox supports up to ~45 min runtimes, detached from the
   invoking Function). Contributed with tests and docs.
3. **Serverless run-advancement model** — Vercel Cron hits an HTTP endpoint that
   starts/advances smithers runs; each Function invocation does a bounded step and persists
   state to Postgres; no scheduler daemon. Idempotent tick handler with overlap protection
   (Postgres advisory lock or run-state guard).
4. **Telegram plugin/service** — a smithers script/service exposing read-messages-in-window
   and post-message capabilities; handles Bot API constraints (bots can't fetch history via
   `getUpdates` retroactively — needs a webhook/ingest path persisting messages to Postgres
   as they arrive); message chunking (4096-char limit), rate limits, retries.
5. **Cron-expression-parameterized summary periods** — user supplies a GitHub-Actions-style
   cron string per chat; the tick endpoint computes due windows from it (cron parser +
   last-run watermark in Postgres), decoupled from Vercel Cron's fixed firing frequency
   (Vercel Cron fires frequently; app-level scheduling decides what's due).
6. **Summarization workflow** — smithers workflow that pulls the window's messages,
   produces a high-quality summary (Sonnet execution, Fable review/polish per model
   policy), posts it back, records the run.
7. **Custom smithers Gateway UI** — observe runs, trigger ad-hoc summaries, manage chat
   configs; deployed serverlessly on Vercel too.
8. **Repaired + improved `smithering` workflow** — bugs fixed upstream; a cleaner
   spec-driven workflow installed in this repo post-`smithers init`; spec success criteria
   mapped 1:1 to executable validation gates.
9. **Test suite** — unit + e2e, 100% coverage; e2e runs against a local dev stack (local
   Postgres or Neon branch, mocked Telegram + real-token option) AND against Vercel Preview
   deployments (CI hits the preview URL); Neon branch-per-preview for isolated DB state.
10. **Buttery CI/CD** — GitHub Actions + Vercel Git integration: PR → preview deploy +
    Neon branch → e2e against preview → merge → production. Secrets only via env vars.
11. **Docs/DX** — README that makes the repo a copyable template; CLAUDE.md/AGENTS.md
    enforcing "always use smithers"; upstream docs updated.

## Real risks

- **Telegram history access**: Bot API cannot read arbitrary past messages; `getUpdates`
  only surfaces messages while polling and conflicts with webhooks. Must ingest messages
  continuously via webhook → Postgres, meaning summaries cover only messages received
  after install. (Alternative — MTProto user client — is heavy and off-brand for an
  example.) This is the biggest product-shape constraint.
- **Serverless smithers is likely greenfield upstream**: Postgres store, Vercel Sandbox
  provider, and step-wise run advancement may all be missing/immature; scope in the
  smithers repo could dwarf this repo. Needs early spike to size it.
- **`smithering` workflow is "rarely used and possibly broken"** — unknown repair cost
  before real work can even start, and process requires using it.
- **>20-min tasks on Vercel**: Vercel Sandbox has its own runtime ceiling (~45 min) and
  cost profile; orchestration of resume/retry across sandbox death must be crash-safe via
  Postgres.
- **Vercel Cron granularity/limits** (plan-dependent minimum frequency, no sub-minute)
  constrains achievable cron expressions; app-level watermark scheduling mitigates.
- **100% coverage is expensive and can distort design**; e2e-on-preview requires careful
  secret handling (Telegram token in preview envs) and test-chat isolation.
- **Concurrency/idempotency**: overlapping cron ticks, Telegram webhook retries, duplicate
  summary posts — all need Postgres-level guards.
- **Cost/quotas**: Sandbox minutes, Neon limits, LLM tokens for frequent summaries.
- **Secret hygiene**: bot token, DATABASE_URL, Anthropic key — env vars only, never in
  artifacts/commits; preview envs need scoped test credentials.

## Open questions (product-level)

### q1 — Message acquisition scope
**Q:** Should summaries cover only messages ingested after the bot is added (webhook
ingestion), accepting that pre-install history is unavailable?
**Recommended:** Yes — webhook → Postgres ingestion; document the limitation.
**Why:** Bot API cannot fetch retroactive history; the alternative (MTProto user account)
adds auth complexity and ToS risk unfit for a flagship example. This decision shapes the
entire data model.

### q2 — Multi-chat or single-chat product
**Q:** Support many chats each with their own cron expression, or one configured chat?
**Recommended:** Multi-chat with per-chat config rows in Postgres (chat_id, cron, enabled),
but keep onboarding manual (insert via UI/SQL), no self-serve `/subscribe` flow in v1.
**Why:** Multi-chat exercises the Postgres data model properly and makes the example
realistic without building account management.

### q3 — What does "success" look like for the example audience
**Q:** Is the primary deliverable the working bot, or the reusable smithers-on-Vercel
pattern (Postgres store, Sandbox provider, cron-tick pattern)?
**Recommended:** The pattern; the bot is the demo payload. Prioritize upstream smithers
work and template clarity over bot features.
**Why:** PROMPT.md frames this as a flagship example by smithers maintainers; downstream
scoping decisions (e.g., cut bot niceties before cutting docs/tests) hinge on this.

### q4 — Summary quality bar and shape
**Q:** What should a summary contain — plain digest, or structured (topics, decisions,
action items, links) with thread attribution?
**Recommended:** Structured digest: topics with participant attribution, decisions, action
items, notable links; skip-and-note when the window is empty or near-empty (< ~5 messages:
post nothing, record a skipped run).
**Why:** Defines the summarization workflow's spec and its validation gates; "empty
window" behavior is a user-visible product decision.

### q5 — UI scope
**Q:** How much should the custom Gateway UI do — read-only observability, or full drive
(trigger summaries, edit chat configs, replay runs)?
**Recommended:** Observe + drive: run list/detail, live status, manual "summarize now",
chat config CRUD. No auth beyond a shared secret/Vercel protection in v1.
**Why:** "Observing and driving" is explicitly required; auth scope is the cost lever.

### q6 — E2E against real Telegram or a fake
**Q:** Should preview/CI e2e hit real Telegram (dedicated test bot + test group) or a
Bot-API fake?
**Recommended:** Both layers: fake Bot API server for deterministic local/CI e2e (100%
coverage path), plus a small real-Telegram smoke test against previews using a dedicated
test bot/group, gated on secret availability.
**Why:** Real-API-only is flaky and rate-limited; fake-only doesn't validate the
integration. This determines CI architecture and secret provisioning.

### q7 — Long-task demonstration
**Q:** The summary itself won't take 20 minutes — what exercises the >20-min Sandbox
requirement credibly?
**Recommended:** The requirement is about capability, not the happy path: build the
Sandbox provider so summarization (and the smithering dev-workflow agents) run in Vercel
Sandbox, and include an e2e/eval that proves a long-running task survives past a single
Function's limit (e.g., a deliberate long agent task or the spec-driven coding workflow
itself running in Sandbox).
**Why:** Prevents shipping a provider that only works for short tasks; defines what the
validation gate for requirement #2 actually tests.

### q8 — Timezone semantics for cron
**Q:** What timezone do per-chat cron expressions evaluate in?
**Recommended:** UTC default with optional per-chat IANA timezone column.
**Why:** "Daily 9am summary" is the flagship use case; wrong-timezone summaries are the
most likely user-facing bug.

### q9 — Definition of "100% coverage"
**Q:** 100% of what — this repo's app code lines/branches, including the UI and generated
config, or app logic with explicit measured exclusions?
**Recommended:** 100% line+branch on app source (bot, plugin, API routes, scheduling
logic) with a small, explicit, reviewed exclusion list (framework boilerplate, generated
files); upstream smithers changes meet that repo's own coverage standards.
**Why:** Literal 100% including UI glue drives test theater; the exclusion list must be a
recorded, gated decision, not silent.

## Recorded decisions (auto-adopted recommendations unless overridden)

All recommended answers above (q1–q9) are adopted as working decisions for downstream
steps. Additional recorded decisions:

- **D1:** Local `smithers.db` (SQLite) in this repo is a scaffold artifact to be removed;
  production/preview state is Postgres-only per the hard requirement. Local dev may use a
  local Postgres or a Neon branch — never SQLite.
- **D2:** Neon via Vercel Marketplace is the Postgres choice (most popular Vercel path,
  branch-per-preview enables e2e isolation).
- **D3:** All friction found in smithers (smithering workflow, Postgres store, Sandbox
  provider, docs) is fixed upstream in `/Users/williamcory/smithers` with tests + docs +
  `pnpm docs:llms`, per standing directive.
- **D4:** Model policy is enforced in workflow definitions: `claude-fable-5` for
  planning/review/polish, `claude-sonnet-5` for execution; `claude-sonnet-4-7` does not
  exist and must never appear.
- **D5:** No secrets in artifacts, commits, or specs — env vars only (TELEGRAM_BOT_TOKEN,
  DATABASE_URL, ANTHROPIC_API_KEY, cron-endpoint shared secret).

## Suggested sequencing (for the planner, not binding)

1. Spike: audit smithers for Postgres-store, Vercel Sandbox provider, serverless
   advancement, and smithering-workflow health — size the upstream work.
2. Fix/build upstream (smithering repairs first, since process depends on it).
3. `smithers init` + clean spec-driven workflow + spec with validation gates in this repo.
4. Data model + Telegram webhook ingestion + cron-tick endpoint.
5. Summarization workflow + Sandbox provider integration.
6. Gateway UI.
7. Test suite (fake Telegram, local + preview e2e), CI/CD, docs polish.
