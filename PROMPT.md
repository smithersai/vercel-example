# Smithers on Vercel — Example Project Brief

## Goal

Build a flagship **smithers example** in this repo (`vercel-example`) that runs smithers
workflows **entirely on Vercel's serverless infrastructure**, using **Postgres as the single
and only state store**. We are maintainers of smithers (`/Users/williamcory/smithers`), so
where smithers itself falls short, make focused, high-quality upstream changes (code + tests
+ docs) rather than local workarounds.

## The example application

A **Telegram summary bot**:

- Accepts a cron expression (GitHub Actions–style syntax) that defines a summary period.
- On schedule, reads a Telegram chat's messages for that period, produces a summary, and
  posts it back to the chat.
- Reading from and responding to Telegram is implemented as a **smithers plugin/service**
  (a smithers script), not ad-hoc glue code.
- Has a **custom smithers UI** (Gateway UI / custom workflow UI) for observing and driving
  the bot.

## Hard requirements

1. **Serverless only** — no long-running processes. Everything runs on Vercel primitives
   (Functions, Cron, Sandbox, etc.).
2. **Agent tasks must be able to run > 20 minutes** — longer than a single Vercel function
   invocation allows; use the smithers `<Sandbox>` component with a suitable provider
   (likely a new **Vercel Sandbox provider** upstream in smithers).
3. **Single data store** — Postgres only. Smithers tasks are stateless; all state lives in
   one Postgres database. Use whichever Postgres option is easiest / most popular for
   Vercel users (e.g. Neon via Vercel Marketplace).
4. **Scheduling** — cron-triggered runs without a persistent scheduler process (Vercel Cron
   hitting an HTTP endpoint that advances/starts runs).

## Process requirements

- **Use smithers to build this** — all coding goes through smithers workflows, and
  `CLAUDE.md` / `AGENTS.md` in this repo must instruct agents to always use smithers.
- **Spec-driven development**: review smithers' spec-driven workflow (`smithering`), fix
  any bugs in it upstream (it's rarely used and possibly broken), then set up a new,
  better, cleaner version in this repo after `smithers init`. Focus on the **spec** and
  its **validation** (backpressure: every success criterion maps to a verification gate).
- **Dogfood the documentation/spec-driven-development UI** — get the `smithering` custom
  UI working and use it to drive this project.
- Read https://smithers.sh docs; apply the **context engineering principles** documented
  there throughout.
- **Model policy**: Fable (`claude-fable-5`) for all planning, review, and final polish;
  Sonnet for all task execution.

## Quality bar

- **100% test coverage**, with emphasis on **e2e tests** that run both locally and in
  Vercel Preview deployments.
- CI/CD should be "buttery smooth" — prefer solutions that make the local ↔ preview ↔
  production pipeline seamless.

## Deliverables checklist

- [ ] Upstream smithers fixes: `smithering` workflow bugs, Vercel Sandbox provider,
      anything else needed for serverless/Postgres operation (with tests + docs + `pnpm docs:llms`).
- [ ] This repo: `smithers init`, cleaned-up spec-driven workflow, spec + validation gates.
- [ ] Telegram summary bot (cron-parameterized) with Telegram read/respond plugin service.
- [ ] Custom smithers UI for the bot.
- [ ] Vercel deployment (Functions + Cron + Sandbox + Postgres) with preview environments.
- [ ] Full test suite: unit + e2e, local and Vercel preview, 100% coverage, smooth CI/CD.
