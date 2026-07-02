# PRD — Smithers-on-Vercel Telegram Summary Bot

Status: v1 (2026-07-01). Scope changes require amending this document.
Upstream inputs: `artifacts/smithering/brainstorm.md`,
`artifacts/smithering/research/domain.md`, `artifacts/smithering/research/prior-art.md`.
Binding human decisions incorporated: q4-threshold, q7-long-task, q9-coverage-gate.

## 1. Problem

Two customers, one product:

1. **Telegram group chats** drown in messages. Members who step away for hours or days
   have no practical way to catch up: scrolling is slow, existing "TL;DR bots" either
   require a server someone must babysit, post spammy "nothing happened" messages, give no
   indication of what time window a summary covers, or hallucinate content for quiet
   periods. Chats want a reliable, scheduled, well-shaped digest posted right into the
   chat — and silence when there is nothing worth summarizing.

2. **Smithers adopters** (the primary audience) have no proven way to run smithers
   workflows without a persistent process. Every existing smithers example assumes a
   long-lived local process and a SQLite file. Teams that deploy on Vercel and want
   scheduled agent workflows today must either cram the work into a single Function
   invocation (and hit its execution-time ceiling), or adopt a third-party durable-execution
   vendor whose state lives outside their own database. There is no public example anywhere
   of smithers — or any comparable agent orchestrator — running entirely on Vercel
   serverless primitives with the user's own Postgres as the only state store, including
   agent tasks that run longer than 20 minutes.

This project ships both: a genuinely useful summary bot, and the canonical, copyable
"smithers on Vercel" reference that adopters can clone as a template. The bot is the demo
payload; the pattern is the product. The build process itself (spec-driven development via
the `smithering` workflow) is part of the deliverable's credibility: every requirement
below must map to an executable validation gate.

## 2. Users

- **Chat members**: receive summaries in their Telegram chat; no interaction required.
- **Bot operator**: installs the bot in chats, configures schedules and thresholds, uses
  the web UI to observe runs and trigger summaries on demand.
- **Smithers adopter / template user**: clones the repo, follows the README, and has the
  same system running on their own Vercel account and Postgres database.

## 3. Requirements

Each requirement has measurable acceptance criteria: "done" means the listed checks pass.

### REQ-1 — Message ingestion from the moment of install
The bot captures every message sent in a chat after the bot is added, so future summaries
can cover them. Pre-install history is unavailable (Telegram platform constraint) and this
limitation is disclosed to users.

**Acceptance criteria**
- AC-1.1: A message sent in a configured chat after the bot joins appears in the system's
  stored message set and is included in the next summary whose window covers it.
- AC-1.2: When the bot is added to a chat (or first configured), it posts a one-time
  message stating it can only summarize messages sent after it joined.
- AC-1.3: Messages sent before the bot joined never appear in any summary.
- AC-1.4: Duplicate webhook deliveries of the same message do not produce duplicate
  content in a summary (each message counted once).

### REQ-2 — Cron-scheduled summaries per chat
Each chat has a GitHub-Actions-style cron expression defining its summary schedule. When a
scheduled boundary passes, the bot summarizes the messages in the elapsed window and posts
the summary to that chat.

**Acceptance criteria**
- AC-2.1: A chat configured with a valid 5-field cron expression receives a summary
  covering exactly the window since the previous scheduled boundary (or since enablement,
  for the first run), with no message gaps or overlaps between consecutive summaries.
- AC-2.2: Schedules evaluate in UTC by default; a chat with a configured IANA timezone has
  its cron expression evaluated in that timezone (e.g. `0 9 * * *` with
  `America/New_York` posts at 9am New York time, across a DST change).
- AC-2.3: An invalid cron expression is rejected at configuration time with a clear error;
  no partially-configured chat results.
- AC-2.4: Multiple chats with different schedules operate independently: each receives
  summaries on its own schedule only.
- AC-2.5: If the platform is temporarily unable to run at a scheduled boundary, the missed
  window is still summarized (late) rather than silently dropped.

### REQ-3 — Structured summary content
A summary is a structured digest, not a transcript: the covered time window (explicit
start/end), 3–7 main topics with participant attribution, decisions made, action items,
and notable links shared.

**Acceptance criteria**
- AC-3.1: Every posted summary states the exact time window it covers.
- AC-3.2: Given a fixture conversation containing identifiable topics, a decision, an
  action item, and a shared link, the posted summary contains a topics section attributing
  participants, the decision, the action item, and the link.
- AC-3.3: Summaries contain only content grounded in the window's messages: an evaluation
  over fixture windows finds no fabricated participants, decisions, or events.
- AC-3.4: Summaries render correctly in Telegram (no broken formatting/entities) for
  fixture conversations including emoji, code snippets, and non-Latin scripts.

### REQ-4 — Quiet-window skip (binding decision q4-threshold)
If a window contains fewer than a per-chat minimum of non-bot messages (default 3), the
bot posts nothing and records a skipped run noting the covered window.

**Acceptance criteria**
- AC-4.1: A window with fewer than the threshold of non-bot messages produces no post to
  the chat — not even a "nothing happened" message.
- AC-4.2: The skipped run is visible in the operator UI with its covered window and skip
  reason.
- AC-4.3: The threshold is configurable per chat; a chat set to threshold 1 receives a
  summary for a single-message window, while a chat at the default (3) skips it.
- AC-4.4: Bot-authored messages (including the bot's own summaries) never count toward the
  threshold and never appear as summarized content.
- AC-4.5: A skipped window's messages are not rolled into the next window (each window is
  independently evaluated).

### REQ-5 — Reliable delivery
Summaries arrive exactly once and intact, regardless of length or transient failures.

**Acceptance criteria**
- AC-5.1: A summary longer than one Telegram message (4096 chars) is delivered as ordered,
  readable chunks with no mid-word/mid-entity truncation.
- AC-5.2: Transient Telegram API failures (rate limits, 5xx) result in retries; the
  summary eventually posts without manual intervention.
- AC-5.3: No duplicate summary is ever posted for the same chat and window, including
  under concurrent/overlapping scheduler triggers and retried runs (verified by a
  concurrency test).
- AC-5.4: A run that fails permanently is recorded as failed with a reason visible in the
  operator UI; it does not block subsequent windows.

### REQ-6 — Multi-chat configuration
The system serves many chats, each with independent configuration: schedule, timezone,
minimum-message threshold, and enabled/paused state. Onboarding is operator-driven (no
self-serve subscription in v1).

**Acceptance criteria**
- AC-6.1: The operator can create, view, edit, pause, and re-enable a chat configuration
  through the operator UI.
- AC-6.2: A paused chat receives no summaries; messages continue to be ingested; on
  re-enable, the next summary covers only its own window (no flood of back-summaries).
- AC-6.3: Configuration changes (e.g. new cron, new threshold) take effect by the next
  scheduled evaluation without redeploying.

### REQ-7 — Operator UI: observe and drive
A web UI (custom smithers Gateway UI) lets the operator see what the bot is doing and act
on it.

**Acceptance criteria**
- AC-7.1: The UI lists all runs (completed, skipped, failed, in-progress) with chat,
  covered window, status, and timing; a run's detail view shows its outcome (posted
  summary text, skip reason, or failure reason).
- AC-7.2: The operator can trigger an on-demand "summarize now" for a chat over a chosen
  window; the resulting summary posts to the chat and appears as a run in the UI.
- AC-7.3: The operator can retry/replay a failed run from the UI.
- AC-7.4: The UI performs chat-config CRUD per REQ-6.
- AC-7.5: The UI is reachable only with a shared secret (or Vercel deployment protection);
  an unauthenticated request is rejected.
- AC-7.6: The UI is served from the same serverless deployment (no separate always-on
  server the operator must run).

### REQ-8 — Fully serverless, single Postgres store (template guarantee)
The deployed system runs entirely on Vercel serverless primitives with one Postgres
database as the only persistent state. This is a user-facing guarantee to the adopter
audience: nothing to operate, one place where all data lives.

**Acceptance criteria**
- AC-8.1: A production deployment runs with no long-lived process owned by the operator;
  killing/redeploying everything loses no data and in-flight summary runs resume or retry
  to completion.
- AC-8.2: All persistent state (messages, chat configs, runs, workflow state) resides in
  the single Postgres database: pointing a fresh deployment at the same database restores
  full system behavior and history; no SQLite file or second store exists in
  preview/production.
- AC-8.3: An adopter following the README can deploy the full system to their own Vercel
  account + Postgres and pass the repo's e2e suite against their deployment.

### REQ-9 — Long-running agent tasks (> 20 minutes) (binding decision q7-long-task)
Agent tasks can run longer than 20 minutes — beyond a single Function invocation — and
this capability is proven by explicit validation gates, not asserted.

**Acceptance criteria**
- AC-9.1: Summarization runs execute through the same long-task-capable execution path
  used for all agent tasks (the generic sandbox execution path, not a special short-task
  shortcut).
- AC-9.2: A dedicated long-task e2e fixture performs real incremental work continuously
  for more than 20 minutes, survives beyond any single Function invocation limit, and
  completes with verifiable output. This gate runs in a gated/nightly CI lane.
- AC-9.3: A scaled-down variant of the same fixture (same mechanism, shorter duration)
  runs and passes on every PR.
- AC-9.4: A long task interrupted mid-run (simulated crash) resumes or retries to a
  correct final result without duplicated side effects.
- AC-9.5: Smithering/dev-workflow runs using the same mechanism are recorded as
  supporting evidence only — they do not substitute for AC-9.2/9.3.

### REQ-10 — Quality gates: tests and coverage (binding decision q9-coverage-gate)
The repo demonstrates the quality bar it preaches: 100% coverage as a hard CI gate, and
e2e tests that run both locally and against Vercel Preview deployments.

**Acceptance criteria**
- AC-10.1: CI fails if line or branch coverage on app source is below 100%. Exclusions are
  limited to a small, explicit, reviewed list of framework boilerplate/generated files
  recorded in the repo; anything not on the list counts.
- AC-10.2: The e2e suite runs green locally against a local dev stack with Telegram fully
  mocked.
- AC-10.3: The same e2e suite runs green in CI against each PR's Vercel Preview deployment
  (with its own isolated per-preview database), and this is a required check for merge.
- AC-10.4: An optional live-Telegram smoke test (real bot token, dedicated test chat) runs
  when `TELEGRAM_BOT_TOKEN` is available and is skipped cleanly (not failed) when it is
  not.
- AC-10.5: The pipeline is push-button: PR → preview deploy + isolated DB → e2e → merge →
  production, with no manual steps in between.

### REQ-11 — Template-quality documentation
An adopter can go from clone to a working deployment using only the repo's docs.

**Acceptance criteria**
- AC-11.1: README covers local-first development (run and test everything locally) and
  ends with documented deploy steps to Vercel; a fresh-eyes walkthrough (person or agent
  following only the README) reaches a working local stack and a working deployment.
- AC-11.2: The pre-install-history limitation (REQ-1) and the quiet-window skip behavior
  (REQ-4) are documented where users will see them.
- AC-11.3: No secret (bot token, database URL, API keys, cron secret) appears anywhere in
  the repo, docs, or artifacts; all are supplied via environment variables, and the README
  lists every required variable.

## 4. Non-goals

Scope additions beyond this list require amending this PRD.

- **No pre-install chat history.** No MTProto user-account client, no chat-export import.
  Summaries cover only messages ingested after the bot joined.
- **No self-serve onboarding.** No `/subscribe` command, billing, or account management;
  chats are configured by the operator.
- **No chat platforms other than Telegram** (no Slack/Discord adapters in v1).
- **No end-user auth system.** UI protection is a shared secret / Vercel protection only;
  no user accounts, roles, or SSO.
- **No "no activity" posts.** Quiet windows are silent by design (REQ-4).
- **No sub-minute scheduling** and no guarantee of second-level precision; schedule
  granularity is bounded by Vercel Cron's minimum frequency.
- **No summarization of media content** (images, voice, video are at most counted/linked,
  not transcribed or described).
- **No hosted control plane.** The system is a template the adopter self-deploys; we do
  not run a multi-tenant service for third parties.
- **No local SQLite in preview/production.** Postgres is the only store (dev scaffolding
  files like `smithers.db` are removed).

## 5. Verification (PRD altitude — user-visible checks)

The build is accepted when all of the following user-visible checks pass. Each maps 1:1 to
acceptance criteria above and must be backed by an executable validation gate in the spec.

1. **Live digest**: In a real or fixture chat, messages sent after install are summarized
   at the configured schedule; the posted summary names its window, topics with
   participants, decisions, action items, and links (REQ-1, REQ-2, REQ-3).
2. **Silence on quiet windows**: A below-threshold window posts nothing and shows as a
   skipped run in the UI; a chat with threshold lowered to 1 does post (REQ-4).
3. **Exactly-once, intact delivery**: A long summary arrives chunked and readable; forced
   concurrent triggers and retries never produce a duplicate post (REQ-5).
4. **Operator drives from the UI**: Create/pause/edit a chat, trigger "summarize now",
   replay a failed run — all from the protected web UI, with every run and its outcome
   visible (REQ-6, REQ-7).
5. **Nothing to operate, one database**: Full redeploy loses nothing; wiping everything
   except Postgres and redeploying restores history and behavior (REQ-8).
6. **The 20-minute proof**: The nightly long-task gate shows a task doing real work for
   >20 minutes to a verified completion; the scaled-down variant is green on the PR
   (REQ-9).
7. **The quality bar is enforced, not aspirational**: A PR that drops coverage below 100%
   (outside the reviewed exclusion list) cannot merge; e2e is green both locally and
   against the PR's preview deployment (REQ-10).
8. **A stranger can clone it**: A fresh-eyes run of the README yields a working local
   stack and a working Vercel deployment with no secrets found in the repo (REQ-11).

## 6. Interface artifacts

- `artifacts/smithering/mockups/user-guide.md` — end-user/operator guide draft: what chat
  members see (sample summary post, skip behavior), operator configuration, environment
  variables. The docs are the service's user interface.
- `artifacts/smithering/mockups/gateway-ui.html` — self-contained HTML mockup (mock data)
  of the operator UI: run list, run detail, chat config, "summarize now".
