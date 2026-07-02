# Prior Art: Serverless smithers on Vercel — Telegram Summary Bot

Research for the smithering spec on running smithers (durable, long-running agent
orchestration) entirely serverlessly on Vercel (Functions + Cron + Sandbox) with
Postgres/Neon as the sole state store, demoed via a Telegram chat-summary bot.

## 1. Vercel-native building blocks (highest relevance — build on these directly)

- **Vercel Workflow Development Kit (WDK)** — https://vercel.com/blog/introducing-workflow ,
  discussion https://github.com/vercel/workflow/discussions/1649 . This is the single most
  relevant piece of prior art: an open-source TypeScript framework that makes durability a
  language-level concept for Vercel Functions. It ships a **Postgres World** reference
  implementation (self-hostable) alongside a "Local World" for dev, meaning Vercel has
  already solved "durable step execution backed by Postgres, no long-running worker
  process" for the exact same constraint smithers has (SQLite + persistent gateway →
  needs to become Postgres + stateless). Crons in WDK's Postgres World are powered by
  **graphile crontab** with a route that authenticates requests via a `CRON_SECRET` env
  var — this is a directly reusable pattern for the bot's scheduled summarization job.
  Decision: evaluate whether smithers' run/step/checkpoint model can be expressed as a thin
  layer on top of WDK's durable-step primitive rather than reinventing checkpoint replay;
  at minimum, copy the `CRON_SECRET`-authenticated cron route pattern.
- **Vercel Sandbox** — https://vercel.com/docs/sandbox , concepts:
  https://vercel.com/docs/sandbox/concepts , guide for Claude Agent SDK specifically:
  https://vercel.com/kb/guide/using-vercel-sandbox-claude-agent-sdk , GA announcement:
  https://vercel.com/blog/vercel-sandbox-is-now-generally-available . Sandboxes default to
  a 5-minute timeout but support custom timeouts for longer tasks, detached commands for
  long-running/background output, and **snapshotting** to checkpoint and resume long tasks
  or skip setup on reruns. This is the mechanism for the >20-minute agent task requirement:
  the Vercel Function that kicks off an agent task should be a thin dispatcher that starts
  (or resumes from a snapshot into) a Sandbox with an extended timeout and detached
  execution, then polls/streams status back into Postgres rather than blocking the
  invoking Function for the task's full duration. Vercel's own "Agent Stack" post
  (https://vercel.com/blog/agent-stack) explicitly frames Sandbox + Workflow SDK as the
  combination for durable, isolated-VM agent runs — validates the architecture choice.
- **Vercel Cron Jobs** — https://vercel.com/docs/cron-jobs ,
  quickstart: https://vercel.com/docs/cron-jobs/quickstart , template:
  https://vercel.com/templates/next.js/vercel-cron . Crons are declared in `vercel.json`
  and trigger a GET to a route on the production deployment. Standard pattern across every
  example found: cron route validates `Authorization: Bearer $CRON_SECRET`
  (or Vercel's automatic cron header) before doing anything, then enqueues/does work and
  returns fast — the actual work (fetching Telegram messages, invoking Sandbox for
  summarization) happens async, not inline in the cron handler, to stay under Function
  time limits.
- **grammY (Telegram bot framework) on Vercel** — hosting guide:
  https://grammy.dev/hosting/vercel , deployment-types guide (webhook vs long polling):
  https://grammy.dev/guide/deployment-types . Concrete open-source templates:
  - https://github.com/WingLim/vercel-telegram-bot — serverless grammY + Vercel reference.
  - https://github.com/PonomareVlad/Vercel-grammY — grammY helpers specifically for Vercel
    (edge-runtime adapters), also on CodeSandbox:
    https://codesandbox.io/p/github/PonomareVlad/grammYVercel .
  - https://github.com/connectshark/telegram-bot-vercel-serverless-template — beginner
    template, useful for minimal webhook wiring reference.
  - https://github.com/MarcL/telegram-test-bot and write-up
    https://www.marclittlemore.com/serverless-telegram-chatbot-vercel/ — end-to-end
    walkthrough of Telegram webhook registration + Vercel Function handler.
  Key findings for the plugin service: grammY's Edge-runtime `webhookCallback` has a
  25-second execution ceiling (Telegram itself allows up to 60s to ack), so any handler
  that needs to do real work (read chat history, trigger a summary) must ack immediately
  and do the actual summarization out-of-band (cron-triggered batch job, not inline in the
  webhook) — this matches the spec's "cron reads the period's messages" design rather than
  a reactive per-message webhook flow. Also: since Vercel Functions are stateless and
  horizontally scaled, bot session state must live in shared storage (Postgres here, not
  in-memory) — confirms the single-Postgres-state-store constraint is compatible with
  grammY's own scaling guidance.

## 2. Durable execution / agent orchestration systems (architecture patterns to borrow)

These aren't Vercel-specific but all attack the same problem smithers has — durable,
resumable multi-step agent execution without a persistent worker — and are useful for
comparing checkpoint/replay design choices:

- **DBOS** — https://www.dbos.dev/ , blog: "Durable Execution for Building Crashproof AI
  Agents" https://www.dbos.dev/blog/durable-execution-crashproof-ai-agents , HN discussion
  of the Java port (Postgres-backed) https://news.ycombinator.com/item?id=45920156 .
  Most architecturally similar prior art to what smithers needs: durable execution shipped
  as a **library**, not a hosted service — you `npm install` it and point it at a Postgres
  connection string, and it turns ordinary functions into durably-executed, crash-resumable
  workflows via per-step Postgres checkpoints, with durable queues for fault-tolerant
  concurrent task orchestration. This is the closest existing proof that "Postgres as the
  only state store, no persistent process" is viable for exactly this class of workload.
- **Restate** — https://www.restate.dev/ , blog: "AI Agents should be serverless and
  durable" https://www.restate.dev/blog/resilient-serverless-agents . Open-source durable
  execution where a Restate server sits in front of stateless serverless functions as a
  proxy/orchestrator; the SDK marks which steps are durable. Useful comparison point for
  how to draw the line between "orchestrator state" (which smithers currently keeps in
  SQLite) and "task execution" (which becomes a Vercel Sandbox invocation).
- **Temporal** — https://temporal.io/ . Long-lived worker processes + append-only Event
  History for exact-point recovery; can run against a Postgres-backed persistence store.
  Rejected as a direct model for this project because it requires long-lived workers
  (violates the "serverless only" constraint) and deterministic workflow code, which is a
  poor fit for LLM-driven, inherently non-deterministic agent steps — but its
  determinism-isolation pattern (wrap all non-deterministic/LLM calls in "Activities") is
  worth borrowing conceptually for how smithers separates orchestration logic from agent
  calls.
- **Inngest** — https://www.inngest.com/ , comparison to Temporal:
  https://www.inngest.com/compare-to-temporal . Durability lives in code, not
  infrastructure: functions are normal async functions with logic wrapped in `step.run()`;
  steps retry independently via HTTP invocation between steps, and no determinism
  requirement (steps are memoized by result, not replayed as code). This model — HTTP-callback-driven step resumption instead of a long-lived worker loop — maps well onto
  "Vercel Function invocation resumes a workflow step" and is a good reference for how
  smithers' step scheduler should be restructured for a stateless-function environment.
- **Trigger.dev** — https://trigger.dev/ . Positions itself as an easier-to-use,
  TypeScript-first alternative to Temporal for background jobs/agents on serverless-style
  infra; worth a look for its task-queue-plus-dashboard UX as a reference for the "custom
  Gateway UI" requirement (run list, live logs, replay), independent of its execution
  model.
- Comparative survey: "Durable Workflow Platforms for AI Agents and LLM Workloads"
  (Render) — https://render.com/articles/durable-workflow-platforms-ai-agents-llm-workloads
  and "Compare top 8 AI agent orchestration platforms" (Redis) —
  https://redis.io/blog/ai-agent-orchestration-platforms/ — both good background reading
  for the design-review stage, not load-bearing for implementation.

## 3. Patterns confirmed across sources (decisions to record)

1. **Cron handlers must be thin.** Every Vercel cron example (docs + templates) does
   auth-check-and-dispatch in the handler itself, not the actual long-running work. Decision:
   the Telegram summary cron route validates `CRON_SECRET`, writes a "run requested" row to
   Postgres, and hands off to a Sandbox invocation; it does not synchronously wait on the
   summarization.
2. **Webhooks ack fast, work happens async.** grammY's own docs and the 25s/60s ceiling
   findings confirm the Telegram plugin service should never do LLM/summarization work
   inline in a webhook handler — only inbound message ingestion (store to Postgres) belongs
   there; summarization is cron-triggered, not message-triggered, matching the spec.
3. **"Durable execution as a library over Postgres" is a proven pattern**, not a novel bet —
   DBOS and Vercel's own WDK Postgres World both demonstrate it in production-adjacent
   form. This de-risks the core architectural claim of the smithering spec (smithers can be
   made serverless with Postgres as sole state) — it is not unprecedented, and WDK in
   particular is a same-vendor reference implementation to compare API shapes against.
4. **Long-running agent work goes to an isolated VM (Sandbox), not a long Function
   invocation.** Confirmed by Vercel's own "Agent Stack" post and Sandbox docs
   (snapshotting + custom timeouts + detached commands exist specifically for this). This
   is the mechanism, not just the naming, for the >20-minute agent task requirement.
5. **No prior art found for "Telegram summary bot on serverless smithers" specifically** —
   this combination (smithers + Vercel Sandbox + Telegram cron summarization) does not
   appear to exist yet in public repos searched; the closest analogues are generic
   serverless Telegram bot templates (webhook-only, no durable multi-step agent workflow)
   and generic durable-execution-on-Postgres libraries (no Telegram/bot integration). This
   supports the framing of this build as a genuinely new flagship example, not a port of an
   existing OSS project.

## Unknowns / not verified

- Whether WDK's Postgres World is stable/GA enough to depend on directly, or should only be
  used as a design reference — not verified from search results; needs a follow-up read of
  the WDK repo/docs before committing to reuse vs. reimplement.
- No direct evidence was found of any team combining Vercel Sandbox + Vercel Cron +
  Postgres for a durable *multi-step agent* workflow (as opposed to single-shot Sandbox
  invocations); the "Agent Stack" post asserts this combination is the intended use case
  but does not show a concrete multi-run example.
- Telegram Bot API rate limits / getUpdates-vs-webhook message history retrieval semantics
  for the "read a chat's messages for the period" step were not researched in this pass —
  needs a dedicated look at the Bot API docs (chat history is not directly queryable via
  the Bot API for a bot that wasn't present when messages were sent; this is a real
  implementation risk to flag to the spec, not just a research gap).
