# User & Operator Guide (draft) — Telegram Summary Bot

> Draft interface artifact for the PRD (`docs/planning/01-prd.md`). All examples use mock
> data. This document IS the service's user interface: what chat members see, and how the
> operator runs it.

## For chat members

Add the bot to your group. It introduces itself once:

> 👋 I'm SummaryBot. I'll post periodic summaries of this chat. Note: I can only
> summarize messages sent **after** I joined — earlier history isn't available to bots.

Then, on the chat's schedule (e.g. daily at 9:00 in your configured timezone), it posts a
digest like this:

> **📋 Chat summary — Mon Jun 29 09:00 → Tue Jun 30 09:00 (UTC)**
>
> **Topics**
> 1. **Release planning** — @maria and @deniz agreed to cut v2.1 on Thursday; @sam raised
>    the flaky e2e suite as a blocker.
> 2. **Onboarding doc rewrite** — @lee shared a first draft and collected feedback from
>    @maria.
> 3. **Offsite logistics** — venue options discussed, no conclusion.
>
> **Decisions**
> - Cut release v2.1 on Thursday (maria, deniz).
>
> **Action items**
> - @sam: fix or quarantine the flaky e2e tests before Thursday.
> - @lee: incorporate feedback into the onboarding doc by Friday.
>
> **Links**
> - Onboarding draft: https://example.com/docs/onboarding-v2

If the window was quiet (fewer than the chat's minimum — default 3 non-bot messages), the
bot posts **nothing**. No "no activity" spam. The skipped window is still recorded and
visible to the operator.

Long summaries arrive as multiple ordered messages (Telegram's length limit), never
truncated mid-sentence. The same window is never summarized twice.

## For the operator

### Configure a chat

Each chat has an independent configuration, managed in the web UI:

| Field | Example | Meaning |
|---|---|---|
| Chat | `-1001234567890` | Telegram chat id |
| Schedule | `0 9 * * 1-5` | GitHub-Actions-style cron (5 fields) |
| Timezone | `America/New_York` | IANA tz; default UTC |
| Min messages | `3` | Skip threshold (non-bot messages per window) |
| Enabled | ✅ | Paused chats keep ingesting but don't post |

Invalid cron expressions are rejected with an error at save time. Config changes take
effect by the next scheduled evaluation — no redeploy.

### Observe and drive (web UI)

The operator UI (see `gateway-ui.html` mockup) shows every run — completed, skipped,
failed, in-progress — with its chat, covered window, status, and outcome (posted text,
skip reason, or failure reason). From the UI you can:

- Trigger **Summarize now** for a chat over a chosen window (posts to the chat, appears
  as a run).
- **Retry** a failed run.
- Create / edit / pause / re-enable chat configs.

Access requires the shared secret (`GATEWAY_SECRET`) or Vercel deployment protection.

### Environment variables (never committed)

| Variable | Purpose |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Bot API token (also gates the optional live smoke test) |
| `DATABASE_URL` | Postgres connection string — the single state store |
| `ANTHROPIC_API_KEY` | LLM access for summarization |
| `CRON_SECRET` | Authenticates scheduled tick requests |
| `GATEWAY_SECRET` | Protects the operator UI |

### Guarantees

- **Nothing to operate**: fully serverless; redeploying loses no data.
- **One database**: all state (messages, configs, runs) lives in your Postgres; point a
  fresh deployment at it and history/behavior are restored.
- **Long tasks**: agent tasks can run >20 minutes; proven by a dedicated nightly e2e gate
  plus a scaled-down per-PR variant.

### Known limitation

Bots cannot read pre-join history: summaries only ever cover messages sent after the bot
was added to the chat.
