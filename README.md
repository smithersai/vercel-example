# Smithers on Vercel Example

A serverless Telegram summary bot: Vercel Functions ingest Telegram webhook updates into
Postgres, Vercel Cron (or an authenticated manual trigger) claims a summary run for a chat
window, and the pipeline renders a summary and records the send in a Postgres outbox.
Postgres is the only state store; every function invocation is stateless.

Planning artifacts live in `docs/planning/` (PRD, design, engineering spec, tickets) and
`artifacts/smithering/` (research, decisions, probes). Smithers workflows that built this
repo live in `.smithers/`.

## Routes

| Route | Method | Auth | Purpose |
| --- | --- | --- | --- |
| `/api/telegram/webhook` | POST | `X-Telegram-Bot-Api-Secret-Token` must equal `TELEGRAM_WEBHOOK_SECRET` | Ingest Telegram updates (idempotent per `(chat, message)`) |
| `/api/cron/summary` | GET/POST | `Authorization: Bearer <CRON_SECRET>` | Scheduled trigger for all enabled chats (wired via `vercel.json` crons) |
| `/api/trigger` | POST | `Authorization: Bearer <OPERATOR_SECRET>` | Manual operator trigger for one chat window |
| `/api/test/outbox` | GET | `E2E_TEST_ROUTES=1` **and** operator bearer; always 404 in production | Test-only view of the Telegram outbox |

Concurrent triggers for the same `(chat, window)` are deduplicated by an atomic
`INSERT ... ON CONFLICT DO NOTHING` claim on the `run` table — only the claiming caller
invokes the executor, so a summary is sent at most once per window.

## Environment

Copy `.env.example` to `.env.local` and fill in real values.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string (Neon in production, docker locally) |
| `TELEGRAM_WEBHOOK_SECRET` | Shared secret Telegram echoes in `X-Telegram-Bot-Api-Secret-Token` |
| `OPERATOR_SECRET` | Bearer token for the manual trigger and test-only routes |
| `CRON_SECRET` | Bearer token Vercel Cron sends to `/api/cron/summary` |
| `E2E_TEST_ROUTES` | Set to `1` to enable test-only routes (never in production) |
| `TEST_DATABASE_URL` | Enables the live-Postgres integration suite (tests only) |
| `POSTGRES_PORT` | Host port for the local docker Postgres (default 5432) |

## Local development

1. `docker compose up -d` (set `POSTGRES_PORT` if 5432 is busy).
2. Copy `.env.example` to `.env.local` and replace the placeholder secrets.
3. `bun install && bun run migrate`
4. `bun run dev`

## Tests and gates

- `bun run typecheck` — strict TypeScript over app, src, and tests.
- `bun run build` — Next.js production build.
- `bun test` / `bun run test` — unit, integration, and e2e suites.
- `bun run test:coverage` — enforces coverage thresholds (fails under them).
- `TEST_DATABASE_URL=postgres://smithers:smithers@localhost:5432/vercel_example bun run test:integration`
  — live-Postgres suite: migration idempotency, atomic run claim under concurrency,
  FK enforcement, and exactly-one-outbox-send under concurrent triggers. Skipped when
  `TEST_DATABASE_URL` is unset.
- `bunx tsc -p .smithers/tsconfig.json --noEmit` — Smithers workflow typecheck.

CI (`.github/workflows/ci.yml`) runs typecheck, build, and the full coverage-gated test
suite against a Postgres 16 service, plus the Smithers workflow typecheck, on every PR
and push to `main`.

## Deploy

Deploy to Vercel with the environment variables above configured. `vercel.json` schedules
Vercel Cron to hit `/api/cron/summary` hourly; set `CRON_SECRET` so Vercel authenticates
those invocations. Do not set `E2E_TEST_ROUTES` in production — the test outbox route
additionally hard-404s whenever `NODE_ENV` or `VERCEL_ENV` is `production`.
