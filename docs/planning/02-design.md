# Design Doc — Smithers-on-Vercel Telegram Summary Bot

Status: **final** (2026-07-01). Supersedes `docs/planning/02-design-draft.md` (draft v2,
approved in review). Builds on `docs/planning/01-prd.md` (requirements/AC IDs referenced
below) and `artifacts/smithering/research/design-art.md` (precedent survey).

This document covers layout/interaction for the operator UI, Telegram message formatting
rules, data-model naming, API/workflow ergonomics, the serverless execution architecture
(cron → claim → Sandbox long-task → resume), and the test/coverage architecture — the
granular detail the PRD intentionally leaves out.

Changes in this final pass (orchestrator polish; no substantive design changes):
sections renumbered contiguously (draft §3.5–3.7 → §4–6, §7.5 → §11); the draft's D24
placeholder stub retired by folding it into D26 (D24 is a retired ID, never reused);
grammar fix in D4; a consolidated Decisions index added (§12). All decision IDs from the
draft are otherwise stable so review comments remain traceable.

## 1. Naming vocabulary (binding across schema, workflow, UI, docs)

Per design-art §3, one noun per concept, used verbatim everywhere (Postgres columns,
workflow step I/O keys, UI labels, README):

| Concept | Canonical term | Never use |
|---|---|---|
| A configured Telegram group | `chat` | "group", "channel" |
| Per-chat settings (schedule, tz, threshold, enabled) | `chat_config` | "settings", "profile" |
| One execution of the summarize workflow for a chat+window | `run` | "job", "task", "execution" |
| The time span a run covers | `window` (`window_start`, `window_end`) | "period", "range" |
| The structured digest content | `summary` | "digest", "recap", "report" |
| A single ingested Telegram message | `message` | "event" |
| One delivered Telegram message chunk of a run's summary | `run_chunk` | "part", "segment" |

`run.status` is an enum: `pending`, `running`, `posted`, `skipped`, `failed`. These five
words are the only vocabulary for run outcome anywhere in the UI, DB, and logs.

**Decision D1**: adopt the table above as binding naming; any new field/table name must
reuse a term from it or extend the table via a PRD amendment (per PRD's own change-control
rule). Rationale: design-art §3 flags naming drift between DB/workflow/UI as a specific,
observed failure mode in prior smithers-based projects, and this repo's credibility claim
("every requirement maps to an executable gate") depends on the mapping staying legible.

## 2. Data model (shape only — types/migrations are an implementation task)

```
chat            (id, telegram_chat_id unique, title, created_at)
chat_config     (chat_id FK unique, cron_expr, timezone, min_messages default 3,
                 enabled default true, updated_at)
message         (id, chat_id FK, telegram_message_id, from_user, text, sent_at,
                 is_bot default false)
                unique(chat_id, telegram_message_id)  -- AC-1.4 dedup
run             (id, chat_id FK, window_start, window_end, status, trigger
                 ('scheduled'|'manual'), summary_text nullable, skip_reason nullable,
                 failure_reason nullable, created_at, completed_at)
                unique(chat_id, window_start, window_end)  -- AC-5.3 dedup, DB-enforced
run_chunk       (run_id FK, chunk_index, chunk_text, telegram_message_id nullable,
                 sent_at nullable)
                unique(run_id, chunk_index)  -- per-chunk delivery ledger, see D26
```

**Decision D2**: the `(chat_id, window_start, window_end)` unique constraint lives at the
database layer, not only checked in application code before insert. Rationale: design-art
§1 explicitly calls out that serverless concurrency lets two invocations race past an
app-level check; AC-5.3 requires a concurrency test, and a DB constraint is the only thing
that test can actually verify holds under a race — insert the `run` row (or use
`INSERT ... ON CONFLICT DO NOTHING`) as the atomic act that claims a window, before any
Telegram API call is made.

**Decision D3**: `message.is_bot` is set at ingestion time from the Telegram webhook
payload's `from.is_bot`, and bot-authored messages are still stored (not dropped) but
excluded from both the threshold count (AC-4.4) and the summarization prompt's input set.
Rationale: storing them (rather than discarding) preserves an accurate `message` audit
trail for debugging in the operator UI without special-casing ingestion; the exclusion
happens only at query time (`WHERE is_bot = false`), one filter reused by both the
threshold check and the summarizer's context builder — one code path, not two.

## 3. Cron/window computation

**Decision D4**: window boundaries are computed by walking the chat's cron expression
forward from `chat_config.updated_at` (or the prior run's `window_end` if one exists) in
the chat's configured timezone, using a standard cron-parsing library rather than
hand-rolled date math. Rationale: AC-2.2 requires correct DST-crossing behavior for
`America/New_York`-style timezones, which is exactly the class of bug hand-rolled
cron/date arithmetic gets wrong; a maintained library pushes the DST edge cases onto code
that's already tested for them.

**Decision D5**: a chat's first run after enablement (or re-enablement, AC-6.2) has
`window_start = enabled_at` (the timestamp `enabled = true` was last set), not the chat's
creation time and not "beginning of time." Rationale: AC-6.2 requires that re-enabling a
paused chat does not flood it with back-summaries; anchoring the first window to the
enable timestamp means a paused chat's elapsed time simply produces one no-op window
covering the pause, not a summary storm.

## 4. Execution architecture (REQ-8, REQ-9) — serverless, Postgres-only, long-task path

The system's core mechanism is how a "run" moves from a cron tick to a posted summary
using only Vercel Functions, Vercel Cron, the Sandbox long-task provider, and Postgres.
This section is the implementer's starting point for REQ-8/REQ-9; it is design-level
(shape of the pipeline and its state machine), not an implementation spec.

**Decision D21**: there is exactly one Vercel Cron entry, firing at the platform's
minimum granularity (one minute), hitting a single `/api/cron/tick` Function. That
Function does no summarization work itself — it only (1) queries `chat_config` for chats
whose next-due boundary (per D4's cron walk) is `<= now()`, (2) for each due chat,
attempts `INSERT INTO run (...) VALUES (...) ON CONFLICT (chat_id, window_start,
window_end) DO NOTHING` to atomically claim that window (reusing D2's constraint as the
scheduling lock, not just the dedup lock), and (3) for each row it successfully inserted,
invokes the long-task execution path (D22) and returns — it does not wait for
completion. Rationale: REQ-8/AC-8.1 requires no operator-owned long-lived process; a
one-minute Function is the only "always running" primitive Vercel Cron offers, and
keeping it to a scan-and-claim loop means its own execution time is bounded and
independent of how long any one chat's summarization takes (which may exceed 20 minutes,
REQ-9) — the tick Function fans work out, it doesn't do it.

**Decision D22**: summarization work (message fetch → summarize → format → post) runs on
the same Sandbox long-task execution path for every run, short or long — there is no
separate "fast path" Function that bypasses Sandbox for small windows (AC-9.1's "generic
sandbox execution path, not a special short-task shortcut"). The tick Function's Sandbox
invocation is handed only `run.id`; all durable state the task needs (window bounds,
chat config, ingested messages) is re-read from Postgres by the task itself rather than
passed through the invocation payload. Rationale: AC-9.1 explicitly forbids a
short-task shortcut — a fast path would be an untested, unproven second mechanism
undermining the "pattern is the product" claim; re-reading state from Postgres by `run.id`
(rather than trusting the invocation payload) is what makes D23's resume path possible,
since a resumed task has no access to the original invocation's arguments, only the DB.

**Decision D23**: crash-resume (AC-8.1, AC-9.4) works by treating every side-effecting
step of a run as individually idempotent and re-checkable from Postgres, not by
snapshotting in-memory state. Concretely, a run's task body is: (a) if `run.status` is
already `posted`, `skipped`, or `failed`, exit immediately (already terminal — covers a
retried/duplicated Sandbox invocation); (b) set `status = 'running'` if not already; (c)
fetch messages in `[window_start, window_end)`, apply the threshold check (REQ-4) — if
below threshold, write `status = 'skipped'` and exit; (d) generate the summary text if
`summary_text IS NULL` (idempotent: regenerating from the same message set is safe since
nothing has been sent yet); (e) deliver via D26's per-chunk delivery ledger; (f) set
`status = 'posted'`. A watchdog (part of the same `/api/cron/tick` Function, since it
already runs every minute) marks any `run` stuck in `running` for longer than a
configured timeout (e.g. 30 minutes) as eligible for re-invocation, re-triggering the
Sandbox path for that `run.id` — step (a)/(e)'s idempotency is what makes that safe to do
blindly. Rationale: AC-9.4 requires resume "without duplicated side effects"; because
Postgres is the only store (AC-8.2), the task has nothing to reconstruct from except what
it can read from the `run` row and D26's delivery ledger, so every step must be safe to
re-run from scratch — this is simpler to reason about than a checkpoint/snapshot scheme
and needs no extra state beyond columns already in D2's `run` table plus D26's ledger.

*(D24 is a retired ID: the draft used it as a forward-reference stub to the delivery
ledger, whose substance lives entirely in D26. Retired rather than renumbered so draft
review comments citing D25+ stay accurate; D24 is never reused.)*

## 5. Cron-tick → due-chat evaluation loop, including missed windows (AC-2.5)

**Decision D25**: "due" is computed per chat, not globally: for each enabled chat,
`/api/cron/tick` (D21) walks D4's cron forward from the chat's last known boundary
(`prior run.window_end`, or `chat_config.enabled_at` per D5 for a first run) and enqueues
**one claimed window per elapsed boundary it finds, oldest first, up to a cap** (e.g. 20
windows) in a single tick pass, rather than collapsing multiple missed boundaries into
one wide window. Each enqueued window still goes through D2's atomic claim, so a tick
that finds 3 missed boundaries inserts 3 `run` rows and triggers 3 Sandbox invocations
(processed independently, oldest first, no ordering guarantee enforced between them since
each window's message set is disjoint by construction). Rationale: AC-2.5 requires a
missed boundary be "summarized (late) rather than silently dropped," and AC-4.5 requires
each window be "independently evaluated" — collapsing three missed hourly windows into
one 3-hour summary would violate AC-4.5's per-window independence (a merged window could
cross the per-chat threshold differently than three separate ones would) and would break
the topic/decision structure design-art §1 calls for (a 3-hour merged digest reads as a
transcript-shaped block, not a scannable digest); processing multiple small backlogged
windows in one tick keeps D4's "no gaps or overlaps" invariant (AC-2.1) intact regardless
of how long the platform was unable to run. The cap exists so a chat re-enabled after a
very long outage doesn't fan out unboundedly in one tick; capped remainder windows are
simply picked up by the next minute's tick (they remain "due" until claimed).

## 6. Telegram delivery retry and per-chunk idempotency (AC-5.2, interaction with D2/D8)

**Decision D26**: delivery is tracked with a delivery ledger, `run_chunk (run_id FK,
chunk_index, chunk_text, telegram_message_id nullable, sent_at nullable)`, populated with
one row per chunk (per D8's split) at delivery time, before any chunk's Telegram API call
is attempted — `chunk_text` is written first (so the split itself is durable and never
recomputed differently on resume), then each chunk is sent in order. Sending a chunk
consists of: skip if `telegram_message_id IS NOT NULL` (already delivered — the resume
case), otherwise call the Telegram API with the platform's own retry semantics (D27) and,
on success, immediately record `telegram_message_id` and `sent_at` for that row before
moving to the next chunk. Rationale: this directly resolves the reviewer-flagged hazard —
a crash after chunk 1 of 3 resumes at chunk 2 (chunk 1's row already has a
`telegram_message_id`, so it's skipped) rather than re-posting chunk 1, satisfying AC-9.4
"no duplicated side effects" and AC-5.3 "no duplicates" for the multi-chunk case D2's
run-level uniqueness alone doesn't cover (D2 prevents two runs claiming the same window;
it says nothing about a single run's chunks being retried individually) — the ledger is
the finer-grained idempotency key D2 needs underneath it.

**Decision D27**: transient Telegram failures (HTTP 429 with `retry_after`, and 5xx) are
retried with exponential backoff honoring `retry_after` when present, up to a bounded
number of attempts per chunk within the same task invocation; if attempts are exhausted
without success, the task exits without marking the run `failed` yet, leaving
`run.status = 'running'` — D23's watchdog re-invocation then retries the remaining
unsent chunks on the next attempt (itself bounded by an overall per-run attempt counter,
after which the run is finally marked `failed` with `failure_reason` naming the last
Telegram error). Rationale: AC-5.2 requires "retries; the summary eventually posts
without manual intervention" — bounding retries within a single invocation (rather than
looping indefinitely inside one Function/Sandbox call) is what lets D23's existing
watchdog/resume mechanism serve double duty as the outer retry loop, so no second retry
mechanism needs to be built or tested separately from crash-resume.

## 7. Telegram message formatting

**Decision D6**: summaries are rendered in Telegram's `MarkdownV2` (not HTML), with a
fixed section order and a renderer that never emits `@handle` — participant attribution
uses first-name-or-display-name in prose ("Alice proposed switching to Postgres"), never
a literal `@username` token. Rationale: design-art §1 flags `@mention` spam as a concrete
failure mode (pings every participant on every summary); MarkdownV2 is chosen over HTML
because it fails loudly (rejected send) on malformed entities rather than silently
rendering broken markup, which surfaces formatting bugs in CI instead of production.

**Decision D7**: message template, fixed order, always present in this order:

```
📋 *Summary* — {window_start} to {window_end} ({timezone})

*Topics*
• {topic}: {one-line synthesis} — {participants}
  ... (3–7 entries)

*Decisions*
• {decision}
(omit whole section if empty)

*Action items*
• {item} — {owner if known}
(omit whole section if empty)

*Links*
• {url} — {one-line context}
(omit whole section if empty)
```

Rationale: design-art §1 identifies fixed section order + explicit window-at-the-top as
the strongest cross-product pattern for scannability on mobile (AC-3.1, AC-3.2); omitting
empty optional sections (decisions/action-items/links) rather than printing "None" keeps
the message shorter without violating AC-3.2's requirement (those sections are only
required "if present in fixture").

**Decision D8**: long-message chunking (AC-5.1) splits in this priority order: (1) at a
section boundary (`Topics`/`Decisions`/`Action items`/`Links`), (2) at a paragraph/bullet
boundary within a section, (3) at a sentence boundary — and never inside an open
MarkdownV2 entity (tracked by a running open/close-token counter during the split walk).
Each chunk after the first is prefixed `(cont.)` so readers know it's part of one summary.
Rationale: design-art §1 names naive fixed-character splitting as a known Telegram-bot
failure mode that corrupts formatting for the remainder of a message; splitting on
semantic boundaries first avoids that entirely, and only falls back to sentence-level
splitting for a single oversized section. The resulting chunk list is written verbatim
into D26's `run_chunk` ledger before delivery begins, so a crash mid-delivery resumes
against the same split rather than re-chunking (which could otherwise produce a
different split on resume and desynchronize the ledger from what was already sent).

**Decision D9**: the one-time capability-disclosure message (AC-1.2) is sent as its own
plain (non-MarkdownV2) message immediately on first webhook receipt for a chat, worded as:
"👋 I can only summarize messages sent from now on — I have no access to this chat's
history before I joined." Rationale: design-art §4 calls this message the strongest
onboarding copy opportunity in the whole system since chat members won't read the README;
keeping it plain text (not MarkdownV2) avoids any chance of a formatting bug in the one
message every chat member is guaranteed to see.

## 8. Quiet-window skip behavior

**Decision D10**: a skipped run is a first-class `run` row (`status = 'skipped'`,
`skip_reason = 'below_threshold: N < M'`), created synchronously before evaluating
whether to post — not merely "no run was created." Rationale: AC-4.2 requires skipped
runs be visible in the operator UI with their covered window and reason; a materialized
row is also what makes the window-continuity guarantee (AC-4.5, D5) simple to compute,
since the next window's start is always "prior run's window_end" regardless of that run's
status.

## 9. Operator UI — layout and interaction

### 9.1 Runs list (home view)

**Decision D11**: the runs list is the app's root route. Each row: colored status dot
(posted=green, skipped=gray, failed=red, running=amber pulsing, pending=gray outline) in
a fixed-width left column, chat title, relative timestamp ("12m ago"), window
("14:00–15:00 UTC"), and a one-line outcome (first ~80 chars of summary text, the skip
reason, or the failure reason). Row click opens run detail (no separate "view" link/icon).
Rationale: design-art §2 names Vercel's own deployments list as the directly-transferable
mental model for this operator audience (they already use Vercel); copying its exact
interaction (colored status column, relative time, click-row-not-button) means zero
learning curve for the target user.

**Decision D12**: the list header shows "as of {absolute timestamp}" and the list
re-polls every 10s, replacing "as of" on each successful poll; rows in `running` status
show a pulsing dot rather than a static one so a stalled run is visually distinguishable
from a merely-slow-to-refresh list. Rationale: design-art §2 explicitly flags "real-time
feeling UI backed by polling that lies about freshness" as a known failure mode in
serverless admin UIs (no persistent websocket by default here); an explicit "as of"
timestamp plus a distinct in-flight visual state is the minimum fix.

**Decision D13**: filters on the list are exactly three: chat (dropdown), status
(multi-select of the five enum values), and a date-range picker for `window_start` —
no free-text search in v1. Rationale: config-surface creep applies to UI affordances too
(design-art §3); a handful of chats and a bounded status enum don't justify search-index
complexity, and every added filter is additional surface the 100%-coverage gate (REQ-10)
must exercise.

### 9.2 Run detail

**Decision D14**: run detail shows, top to bottom: status + timing, window, the full
rendered summary (as it was actually posted, reconstructed from D26's `run_chunk` rows in
`chunk_index` order, with a visible divider at each chunk boundary if AC-5.1 split it) or
skip/failure reason, and a "Replay" button visible only when `status = 'failed'`.
Replay re-invokes the same workflow with the same `(chat_id, window_start, window_end)` —
it does not create a new window. Rationale: AC-7.3 requires retry/replay; keeping replay
scoped to the identical window (rather than "re-run from now") avoids ever needing a
second uniqueness key and keeps D2's constraint the single source of truth for "has this
window already been handled."

**Decision D15**: the "Replay" action also appears inline on failed rows in the list view
itself, not only in detail. Rationale: design-art §2 explicitly calls for retry as a
first-class action on both the list row and the detail view, matching CI-dashboard
convention (visible "Re-run" on the failure itself, not buried in a menu).

### 9.3 Chat config CRUD

**Decision D16**: chat config is a single form per chat (not a wizard): cron expression
(text input), timezone (searchable select of IANA names, default UTC), threshold (number
input, default 3), enabled (toggle). Next to the cron input, a read-only "next 3 runs"
preview computed client-side-equivalent from the same cron library as D4, updating live
as the operator types. Saving is a single action with no separate "deploy" step or
confirmation dialog; the form shows "Saved" inline and the list of upcoming runs updates.
Rationale: design-art §2's cron-UI guidance (human-readable preview next to raw string,
no novel cron-builder widget) and its explicit warning against implying a redeploy is
needed (AC-6.3 requires config to take effect without redeploy) — the UI must not imply
otherwise via a leftover "deploy" affordance.

**Decision D17**: "Summarize now" (AC-7.2) lives as a button on the chat's config page
(not the runs list), opening a small inline window-picker (defaults to "since last run,"
with an option to pick a custom start/end). Submitting creates a `run` with
`trigger = 'manual'` and navigates to that run's detail page. Rationale: manual trigger is
a config-adjacent, per-chat action; placing it on the config page (where the operator is
already looking at that one chat) avoids a separate global "trigger" surface that would
need its own chat-picker.

### 9.4 Auth

**Decision D18**: the UI is protected by a single shared-secret bearer token. On first
visit via a `?token=` link, the server route validates the token, sets it in an
`HttpOnly`, `Secure`, `SameSite=Lax` cookie, then immediately redirects to the same path
with the `token` query param stripped (a 302 to the clean URL) — the token never remains
visible in the address bar, browser history, or gets forwarded in a `Referer` header on
subsequent navigation. All server routes (UI pages and API routes alike) reject requests
without a valid token/cookie (AC-7.5), and the token is rotatable via an env-var change
with no data migration. Rationale: design-art §2 recommends handling the secret once
(link-with-token pattern) rather than a repeated login form, appropriate for a
single-operator internal tool; AC-11.3's no-secrets guarantee makes the redirect-and-strip
step worth the one extra hop, since a bare `?token=` left in the URL is exactly the kind
of casual secret exposure that guarantee is meant to prevent. This is in addition to (not
instead of) relying on Vercel Deployment Protection where available, since the PRD names
either as acceptable (AC-7.5: "shared secret (or Vercel deployment protection)").

## 10. README / onboarding structure

**Decision D19**: README section order, top to bottom: (1) one-paragraph pitch, (2)
"Quick start — deploy to Vercel" as a numbered checklist (provision Postgres, set env
vars, deploy, register Telegram webhook, add bot to a chat), (3) "Quick start — run
locally" (mocked Telegram), (4) "Operator guide" (configure a chat, read the runs list),
(5) "Architecture" (serverless model, smithers workflow shape, the 20-minute long-task
proof), (6) full environment-variable reference table. Rationale: design-art §4's
"deploy-time checklist over narrative docs" and "two-audience onboarding, kept separate" —
deploy steps precede conceptual explanation, and the adopter path (clone→deploy) is fully
separated from the operator path (configure a chat) so neither audience reads past what
they need.

**Decision D20**: the README's Telegram setup checklist spells out BotFather bot
creation, webhook URL registration (with the exact `setWebhook` call shape), and the
"add bot to group + grant read permission" step explicitly, rather than linking out to
Telegram's own docs as the only guidance. Rationale: design-art §4 names this specific
gap ("assuming Telegram-side setup is obvious") as a common first-run failure point for
Telegram bot templates, and the target adopter audience is smithers users, not
necessarily prior Telegram bot authors.

## 11. Test/coverage architecture (REQ-10)

**Decision D28**: Telegram is mocked behind a single internal interface (send message,
send chat action, `setWebhook`) implemented twice — a real HTTP client for
production/preview, and an in-memory fake for local/CI use that records every call
(chunk text, order, chat id) queryable by the e2e suite as its assertion surface. The
same e2e test suite runs against both: locally via the fake (`AC-10.2`), and in CI
against each PR's Vercel Preview deployment (`AC-10.3`) where the fake is still used
(Preview has no real Telegram credentials by default) — only the optional smoke lane
(D30) talks to real Telegram. Rationale: AC-10.2/10.3 require the *same* e2e suite to
pass both locally and against Preview; a single mocked interface with two
implementations, selected by environment rather than by a different test suite, is what
keeps "same suite" literally true rather than aspirationally true (two divergent suites
would silently drift).

**Decision D29**: each PR's Preview deployment gets its own isolated Postgres database,
provisioned by CI as part of the Preview build step (e.g. a branch/ephemeral database via
the Postgres provider's branching feature) and pointed at by that Preview's env vars; the
e2e suite run against a Preview always starts from a fresh/seeded database, never a
shared one. Rationale: AC-10.3's "own isolated per-preview database" is explicit, and
D2/D26's uniqueness constraints mean two PRs' e2e runs sharing a database could produce
cross-PR window/chunk conflicts that look like flaky failures rather than real bugs —
isolation removes that failure class entirely rather than requiring test-data
namespacing to work around it.

**Decision D30**: the optional live-Telegram smoke test (AC-10.4) is a separate,
explicitly-labeled test file (not mixed into the main e2e suite) that checks for
`TELEGRAM_BOT_TOKEN` at the top and skips (not fails, not errors) when absent; when
present, it runs a minimal real round trip (send + verify) against a dedicated test chat
named via env var. Rationale: AC-10.4 requires clean skip vs. fail distinction, which
most test runners implement as a first-class "skipped" status only when the skip
condition is checked before any assertion runs — isolating it in its own file keeps that
check unambiguous and keeps the 100%-coverage gate (D31) from ever needing real Telegram
credentials to reach 100%.

**Decision D31**: the coverage gate runs against app source only (workflow code, API
routes, UI components, the Telegram client interface and its two implementations); the
exclusion list is a single reviewed file (e.g. `coverage.exclude.json` or the coverage
tool's native ignore config) limited to generated code and framework boilerplate
(migration files, generated route manifests) — application logic added for any REQ above
is never on that list. Rationale: AC-10.1 requires the exclusion list be "small, explicit,
reviewed"; naming the file in this design doc (rather than leaving it implicit) is what
makes it reviewable as a design artifact instead of something that silently grows during
implementation.

## 12. Decisions (index)

All binding decisions in this document, in ID order. IDs are stable across draft →
final; D24 is retired (folded into D26), never reused.

| ID | Section | One-line summary |
|---|---|---|
| D1 | §1 | Naming table is binding across schema/workflow/UI/docs |
| D2 | §2 | Window uniqueness enforced by DB constraint; insert = atomic claim |
| D3 | §2 | Bot messages stored but excluded at query time (one filter, two consumers) |
| D4 | §3 | Cron walk via maintained library, in chat timezone (DST-safe) |
| D5 | §3 | First window after (re-)enable anchors to `enabled_at` |
| D6 | §7 | MarkdownV2, no `@handle` mentions, fail-loud formatting |
| D7 | §7 | Fixed template/section order; empty optional sections omitted |
| D8 | §7 | Semantic-boundary chunking, never inside an open entity; split persisted to ledger |
| D9 | §7 | Capability disclosure as plain-text first message |
| D10 | §8 | Skipped runs are materialized `run` rows with reasons |
| D11 | §9.1 | Runs list mirrors Vercel deployments-list interaction |
| D12 | §9.1 | Explicit "as of" freshness + pulsing in-flight state over fake realtime |
| D13 | §9.1 | Exactly three filters; no free-text search in v1 |
| D14 | §9.2 | Detail reconstructs posted summary from ledger; Replay only on `failed`, same window |
| D15 | §9.2 | Replay also inline on failed list rows |
| D16 | §9.3 | Single config form with live "next 3 runs" preview; no deploy affordance |
| D17 | §9.3 | "Summarize now" on chat config page with window-picker; `trigger='manual'` |
| D18 | §9.4 | Shared-secret token → cookie, 302-strip from URL; on top of deployment protection |
| D19 | §10 | README ordering: deploy checklist before architecture; two-audience split |
| D20 | §10 | Telegram-side setup spelled out step by step |
| D21 | §4 | Single one-minute cron tick that scans, claims, and fans out only |
| D22 | §4 | One generic Sandbox path for all runs; task re-reads state by `run.id` |
| D23 | §4 | Resume via idempotent re-runnable steps + tick-function watchdog |
| D24 | — | Retired ID (draft forward-reference stub; substance lives in D26) |
| D25 | §5 | Missed boundaries → one run per boundary, oldest first, capped per tick |
| D26 | §6 | Per-chunk delivery ledger (`run_chunk`) as the fine-grained idempotency key |
| D27 | §6 | Bounded in-invocation backoff; watchdog resume as the outer retry loop |
| D28 | §11 | One Telegram interface, two implementations; same e2e suite everywhere |
| D29 | §11 | Isolated per-Preview Postgres database per PR |
| D30 | §11 | Live smoke test in its own file; clean skip without credentials |
| D31 | §11 | Coverage exclusions in one reviewed file; app logic never excluded |

## 13. Open questions carried forward (not blocking implementation)

- Exact cron-parsing library choice and MarkdownV2-escaping library choice are
  implementation-phase decisions, not design decisions — any well-maintained option
  satisfying D4/D6 is acceptable.
- Whether the "next 3 runs" preview (D16) is computed via a small API call or a bundled
  client-side cron library is an implementation tradeoff; either satisfies the UX
  requirement as stated.

## 14. Explicit gaps / unverified claims

- This document is based entirely on the PRD and the design-art research artifact; no new
  live research (WebFetch/WebSearch against Telegram, Vercel, or competitor docs) was
  performed while writing it. Where design-art itself flagged claims as unverified
  (§5 of that document), this document treats them as accepted design precedent per that
  artifact's own framing, not as independently re-confirmed facts.
- The final pass made no substantive design changes beyond the draft approved in review;
  the structural edits are enumerated in the header.
