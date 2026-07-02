# vercel-example — Smithers on Vercel

This repo is a flagship **smithers** example: a Telegram summary bot running smithers
workflows serverlessly on Vercel with Postgres as the only state store. See `PROMPT.md`
for the full brief and `docs/planning/` for the spec artifacts.

## Always use smithers

All non-trivial coding in this repo goes through smithers workflows — do not hand-edit
features directly. We are dogfooding the spec-driven development flow:

- Drive work through the `smithering` workflow (spec → validation gates → implementation):
  `smithers up .smithers/workflows/smithering.tsx --input '{"prompt":"..."}' --detach`
- Observe/drive runs in the custom UI: `bun .smithers/gateway.ts` →
  http://127.0.0.1:7331/workflows/smithering
- Useful commands: `smithers ps`, `smithers logs <runId>`, `smithers chat <runId> --follow`,
  `smithers inspect <runId>`.

## Model policy

- **Planning, review, polish**: `claude-fable-5` (fallback `claude-opus-4-8`).
- **Task execution**: Sonnet (`claude-sonnet-5`; `claude-sonnet-4-6` also works).
- `claude-sonnet-4-7` does NOT exist — never use it.

## We maintain smithers

Smithers lives at `/Users/williamcory/smithers`. Any friction here is a smithers bug:
fix it upstream (code + tests + docs, regenerate `pnpm docs:llms`), not with local
workarounds.

## Architecture constraints (hard requirements)

- Serverless only: Vercel Functions + Vercel Cron + Vercel Sandbox. No long-running
  processes in production.
- Single data store: Postgres (Neon via Vercel Marketplace). Smithers tasks are stateless.
- Agent tasks must be able to run > 20 minutes (via the `<Sandbox>` Vercel provider).
- E2E tests must run locally AND in Vercel Preview deployments; target 100% coverage.
