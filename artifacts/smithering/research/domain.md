# Domain research: serverless smithers + Telegram summary bot on Vercel

## Who has this problem today

- **Smithers users today** run a persistent local/CI process: a Bun/Node process holding an
  in-memory or SQLite-backed run graph, a long-lived gateway server for the UI, and workflows
  that assume the orchestrator process itself never dies mid-run. This is true of every
  existing smithers example in `/Users/williamcory/smithers` (examples run via `smithers up`
  from a terminal, expect a live gateway on localhost, and use the default SQLite store).
- **Serverless agent-orchestration adopters** (Vercel users specifically) are the target
  audience: teams who already deploy on Vercel and want cron-triggered, stateless, "run an
  agent workflow on a schedule" behavior without operating a VM/container fleet. They
  currently reach for: Vercel Cron Jobs + a Function that does the whole task inline (fails
  once work exceeds the function's execution-time ceiling), Inngest/Trigger.dev/QStash for
  durable step functions, or a bespoke queue (Vercel KV/Upstash + a worker). None of these are
  smithers, so there is no existing "smithers on Vercel" pattern to copy — this project is
  meant to be the first one.
- **Telegram bot builders** wanting periodic chat summaries are a well-worn category
  (community-run "TL;DR bots," recap bots for large group chats, Slack/Discord equivalents).
  They are the illustrative payload for this example, not the primary audience — the primary
  audience is smithers adopters copying the *pattern*, per the brief's stated audience.

## How the problem is solved now

- **Long-running summary bots**: a persistent Node process using `node-telegram-bot-api` or
  `grammy` with polling or a webhook behind an always-on server (Express on a VPS/Fly.io/
  Railway), storing message history in a local/managed DB (Postgres, SQLite, Redis), with an
  in-process cron (`node-cron`) firing on a schedule and calling an LLM to summarize the
  window. This is simple but violates every "serverless only" constraint here (persistent
  process, arbitrary compute duration, whatever DB is convenient).
- **Serverless Telegram bots on Vercel today**: Telegram webhook → Vercel Function (stateless,
  <60s default / configurable up to 800s on Pro with Fluid Compute) → write message to
  Postgres → return 200 immediately. Summarization triggered by Vercel Cron (`vercel.json`
  `crons` array, minute-granularity minimum, UTC-only) hitting another Function that queries
  Postgres for the window, calls an LLM, and calls the Telegram Bot API `sendMessage`. This
  is the closest existing pattern and is exactly what the brief asks to route through
  smithers instead of hand-rolled code.
- **Durable/long (>20 min) step execution on serverless today** (non-smithers precedent):
  Inngest and Trigger.dev solve "step function that can run for hours despite each HTTP
  invocation being short" by persisting step state externally and resuming via callback/poll,
  which is structurally identical to what a Vercel Sandbox provider for smithers needs to do
  (checkpoint state to Postgres, hand off long compute to a Sandbox that outlives the
  triggering Function invocation, poll/webhook back on completion).
- **Vercel Sandbox** (the actual Vercel product, GA in 2025) already exists as "ephemeral VM,
  run arbitrary code/commands for up to 45 minutes, accessible via SDK from a Function" — this
  is very likely the correct primitive for the smithers Sandbox provider mentioned in the
  brief (a Function starts a Sandbox, the Sandbox runs the smithers task/agent loop, state
  checkpoints go to Postgres, a second Function call or Sandbox-triggered webhook resumes
  the workflow). This should be validated against smithers' existing `<Sandbox>` provider
  interface at `/Users/williamcory/smithers` before implementation, not assumed.

## Existing competing products / prior art

- **Inngest**, **Trigger.dev**, **Upstash QStash/Workflow**: durable functions on serverless,
  the closest architectural cousins to "smithers on Vercel." They solve the >single-invocation
  duration problem via their own state stores (not user-owned Postgres) and their own
  schedulers — smithers' differentiator per the brief is a single user-owned Postgres store
  and full observability/drivability via a custom Gateway UI, not a hosted control plane.
- **Community Telegram TL;DR/summary bots** (e.g. "ChatSum," "SummaryBot" style OSS projects,
  and many closed-source ones): typically single-chat or small-fleet, persistent-process,
  no replay/observability, no spec-driven build process. They validate that "read messages
  for a window, summarize, post back" is a well-understood, low-risk feature — the novelty
  here is entirely in the *how it's built and run*, not the bot's behavior.
- **GitHub Actions** itself is invoked in the brief only as a familiar syntax reference for
  cron expressions ("GitHub-Actions-style cron schedule"), not as a competing product.

## What users complain about in current solutions

- Persistent-process bots: operational burden (a VPS/container that must stay up, gets OOM-
  killed, needs monitoring) — exactly why "serverless only" is a hard requirement here.
- Vercel Cron + inline Function summarization: hard execution-time ceiling causes silent
  truncation/timeouts on large chats or slow LLM calls; no retry/replay of a failed summary
  run without re-triggering by hand; no visibility into what a scheduled run actually did.
- Durable-execution SaaS (Inngest/Trigger.dev): another vendor, another state store outside
  the user's own Postgres, harder to reason about "where did my data go" — matches the
  brief's insistence on Postgres-as-sole-store and smithers ownership of the control plane.
- Community Telegram summary bots: frequent complaints in the wild are about summaries being
  either too terse to be useful or too long to read, no clear signal on what window a summary
  covers, and no good behavior when a chat was quiet (bots either post "nothing happened,"
  spam an empty summary, or (worse) hallucinate content) — directly informs the "empty/near-
  empty window" open question below.

## Answers to open questions (with reasoning, flagged where a human should still confirm)

1. **Only messages ingested after the bot is added (webhook ingestion), pre-install history
   unavailable?**
   **Yes — decide this now.** The Telegram Bot API gives bots no access to a chat's message
   history from before they joined (no "backfill" endpoint exists for bot accounts; only
   MTProto user-account clients or a chat export can get history, and that's out of scope for
   a bot-API-based plugin). So this isn't really an open design choice, it's a hard platform
   constraint: ingestion must be a live webhook (`setWebhook` → Vercel Function → write to
   Postgres) starting from whenever the bot is added, and summaries are scoped to
   what's been ingested since then. Document this explicitly in the bot's first-run message
   ("I can only summarize messages sent after I joined").

2. **Multi-chat product (per-chat cron configs) or single configured chat?**
   **Design for multi-chat from the schema up, ship single-chat-by-default for the demo.**
   Reasoning: the brief frames this as a flagship *pattern* example (audience = smithers
   adopters), and a Postgres row-per-chat config (`chat_id`, `cron_expr`, `timezone`, `enabled`)
   costs nothing extra at design time but a single-chat-only schema would have to be
   migrated later by any adopter who copies the pattern for real multi-tenant use. The Vercel
   Cron trigger itself only needs to run on a fixed tick (e.g. every 5–15 min) and fan out to
   whichever configured chats are due, which is standard "cron tick + due-check" design and
   doesn't require one Vercel Cron entry per chat (Vercel Cron entries are a fairly scarce,
   statically-defined resource in `vercel.json`, so per-chat Vercel Cron entries would not
   scale anyway).

3. **Primary deliverable: the working bot or the reusable smithers-on-Vercel pattern?**
   **The pattern is primary; the bot is explicitly the demo payload** — this is stated
   directly in the task's framing ("primary audience is smithers adopters copying the
   pattern; the bot is the demo payload") and matches the brief's own emphasis (upstream
   smithers fixes, a new Sandbox provider, and the spec-driven `smithering` workflow are
   listed as deliverables alongside, and arguably ahead of, the bot itself). Implication:
   optimize documentation, provider code, and workflow definitions for legibility/reuse by a
   third party, even where that adds work the bot alone wouldn't need (e.g. the Sandbox
   provider should be a clean, generic smithers provider, not bot-specific glue).

4. **What should a summary contain, and what happens on an empty/near-empty window?**
   Content: participant names/handles, the 3–7 main topics/threads discussed (not a
   turn-by-turn transcript), any decisions or action items surfaced, and the explicit time
   window covered (so users can judge what's missing before the bot joined or between runs).
   Empty/near-empty window: **do not post at all** below a minimum-message threshold (needs a
   human-tunable default, suggest starting at ~3 non-bot messages) rather than posting "no
   activity" — per the "what users complain about" findings above, silent skip is preferred
   to spam, and it avoids the hallucination failure mode entirely since there's nothing to
   summarize. This threshold is a product default a human can override; flag as still open
   for explicit human confirmation of the exact number.

5. **How much should the custom Gateway UI do — read-only observability or full drive?**
   **Full drive, not read-only.** The brief calls for "observing *and driving* the bot" and
   separately says the spec-driven `smithering` UI must be "working and used to drive this
   project" — both explicit requirements rule out a read-only dashboard. Minimum drive
   surface: trigger a summary run on demand (bypass cron), edit/pause a chat's cron config,
   approve/replay a failed run, and inspect ingested-message state — all backed by the same
   Postgres store smithers workflows read/write, per the single-state-store constraint.

6. **Should preview/CI e2e hit real Telegram or a fake Bot API?**
   **Fake Bot API for CI/preview by default; real Telegram reserved for a manual/scheduled
   smoke test.** Reasoning: real Telegram requires a live bot token and a real chat, which is
   unsafe/unavailable in ephemeral Vercel Preview deployments spun up per-PR (no stable
   webhook URL registration story, secrets exposure risk, rate-limiting, flakiness from an
   external network dependency) — all standard reasons Telegram-bot test suites in the wild
   mock the Bot API (recorded fixtures or a small local HTTP stub implementing `sendMessage`/
   `setWebhook`/`getUpdates`). This satisfies "100% coverage" and "e2e...locally AND in Vercel
   Preview" without depending on external, non-deterministic infrastructure for every PR.

7. **What credibly exercises the >20-minute Sandbox requirement, given a summary itself is
   fast?**
   This is a genuine tension the brief doesn't resolve, and no evidence search substitutes for
   a design decision — flag as open, but the strongest candidate found: don't force the
   summarization step itself to take >20 minutes artificially. Instead, use the Sandbox
   provider for a task that's *naturally* long-running and agentic — e.g., a periodic "deep
   research/backfill" or "spec regeneration" agent task within the same repo (the smithering
   workflow's own long spec/validation runs), OR ship a synthetic long-task test fixture
   (a Sandbox-run script that sleeps/polls for >20 minutes doing real incremental work, used
   specifically as the e2e proof of the >20-minute capability) separate from the bot's
   fast-path summarization. Recommend surfacing this explicitly to a human: "the bot's own
   happy path won't naturally take >20 minutes — do we want a second, deliberately long task
   as the Sandbox proof, or should Sandbox only be exercised by the smithering workflow's own
   long-running spec/build steps?"

8. **What timezone do per-chat cron expressions evaluate in?**
   **UTC**, with an explicit per-chat `timezone` column so cron expressions are stored/
   authored by the user in local terms but evaluated by converting to UTC at due-check time.
   Reasoning: Vercel Cron itself only fires in UTC (documented Vercel platform behavior), and
   GitHub Actions cron (the syntax reference named in the brief) is also UTC-only — so the
   underlying trigger tick is UTC regardless of design choice; the only real decision is
   whether per-chat schedules are *authored* in UTC or in a stored local timezone converted at
   evaluation time. Given Telegram chats plausibly span timezones, storing a per-chat
   timezone and converting is the safer default; document assumption clearly since this is
   a product decision, not a platform-forced one, for confirmation.

9. **What does "100% test coverage" mean exactly?**
   Not fully resolvable by research — treat as needing an explicit spec decision, but the
   defensible interpretation given the rest of the brief's testing language ("emphasis on
   e2e tests," "run both locally and in Vercel Preview," "buttery smooth CI/CD") is: 100%
   **line/branch coverage of the application code that ships** (ingestion Function,
   summarization Function/workflow, cron due-check, Gateway UI API routes, smithers Vercel
   Sandbox provider) as measured by the standard JS/TS coverage tool already in the smithers
   toolchain (Bun's or Vitest's built-in coverage, whichever `/Users/williamcory/smithers`
   already standardizes on — verify against that repo rather than assuming), *not* 100%
   coverage of every third-party dependency or of smithers core itself (already covered by
   its own test suite). Flag explicitly: confirm with a human whether "100%" is a hard CI gate
   (build fails under threshold) or an aspirational target, since a hard 100% gate on
   integration-heavy serverless code (webhook signature edge cases, Sandbox timeout paths) is
   unusually strict and may need documented, reviewed exemptions.

## Key unresolved risk (not one of the nine questions, but load-bearing)

The `smithering` spec-driven workflow is explicitly called out in both the task and
`PROMPT.md` as "possibly broken" — this research did not include reading or exercising
`/Users/williamcory/smithers`'s `smithering` workflow source, so its actual current state
(bugs, gaps vs. the Vercel/Postgres/Sandbox requirements) remains unverified and must be
checked directly against that repo before implementation planning proceeds.
