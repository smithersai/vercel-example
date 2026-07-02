# Smithers on Vercel Example

A serverless Telegram summary bot: Vercel Functions ingest Telegram webhook updates into
Postgres, Vercel Cron (or an authenticated manual trigger) claims a summary run for a chat
window, and a Postgres-backed queue drainer renders a summary and sends it through the
Telegram Bot API. Local and test runs can opt into a deterministic fake Telegram outbox.
Postgres is the only state store; every function invocation is stateless.

Planning artifacts live in `docs/planning/` (PRD, design, engineering spec, tickets) and
`artifacts/smithering/` (research, decisions, probes). Smithers workflows that built this
repo live in `.smithers/`.

## Routes

| Route | Method | Auth | Purpose |
| --- | --- | --- | --- |
| `/api/telegram/webhook` | POST | `X-Telegram-Bot-Api-Secret-Token` must equal `TELEGRAM_WEBHOOK_SECRET` | Ingest Telegram updates (idempotent per `(chat, message)`) |
| `/api/cron/summary` | GET/POST | `Authorization: Bearer <CRON_SECRET>` | Scheduled trigger for all enabled chats, then drains runnable queued runs (wired via `vercel.json` crons) |
| `/api/trigger` | POST | `Authorization: Bearer <OPERATOR_SECRET>` | Manual operator trigger for one chat window; enqueues only and self-invokes the queue drainer |
| `/api/queue/drain` | POST | `Authorization: Bearer <CRON_SECRET>` | Serverless queue drainer for pending/manual/scheduled runs |
| `/api/test/outbox` | GET | `E2E_TEST_ROUTES=1` **and** operator bearer; always 404 in production | Test-only view of the fake Telegram outbox |

Concurrent triggers for the same `(chat, window)` are deduplicated by an atomic
`INSERT ... ON CONFLICT DO NOTHING` claim on the `run` table. Triggers do not summarize
inline; the drainer claims runnable rows with `SELECT ... FOR UPDATE SKIP LOCKED`, assigns
a lease/visibility timeout, and retries failed runs with Postgres backoff until they are
posted or dead-lettered.

## Environment

Copy `.env.example` to `.env.local` and fill in real values.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string (Neon in production, docker locally) |
| `TELEGRAM_WEBHOOK_SECRET` | Shared secret Telegram echoes in `X-Telegram-Bot-Api-Secret-Token` |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token used for production `sendMessage` delivery |
| `TELEGRAM_API_ROOT` | Optional Telegram Bot API root override (defaults to `https://api.telegram.org`) |
| `TELEGRAM_DELIVERY_MODE` | Optional `fake` for local/e2e outbox mode or `real` to force Bot API delivery outside production |
| `OPERATOR_SECRET` | Bearer token for the manual trigger and test-only routes |
| `CRON_SECRET` | Bearer token Vercel Cron sends to `/api/cron/summary` |
| `E2E_TEST_ROUTES` | Set to `1` to enable test-only routes (never in production) |
| `TEST_DATABASE_URL` | Enables the live-Postgres integration suite (tests only) |
| `POSTGRES_PORT` | Host port for the local docker Postgres (default 5432) |
| `RATE_LIMIT_WINDOW_SECONDS` | Fixed-window rate-limit size in seconds (default `60`) |
| `RATE_LIMIT_WEBHOOK_MAX` | Max authenticated Telegram webhook requests per window per requester (default `120`) |
| `RATE_LIMIT_TRIGGER_MAX` | Max authenticated manual trigger requests per window per requester (default `20`) |
| `RATE_LIMIT_CRON_MAX` | Max authenticated cron requests per window per requester (default `10`) |
| `QUEUE_DRAIN_LIMIT` | Max runnable runs a drainer invocation claims (default `5`) |
| `QUEUE_LEASE_SECONDS` | Queue visibility timeout for claimed runs (default `900`) |
| `QUEUE_MAX_ATTEMPTS` | Max failed attempts before a run is dead-lettered (default `3`) |
| `QUEUE_BACKOFF_BASE_SECONDS` | Initial retry backoff for failed runs (default `60`) |
| `QUEUE_BACKOFF_MAX_SECONDS` | Maximum retry backoff for failed runs (default `3600`) |

## Local development

1. `docker compose up -d` (set `POSTGRES_PORT` if 5432 is busy).
2. Copy `.env.example` to `.env.local` and replace the placeholder secrets.
3. `bun install && bun run migrate`
4. `bun run dev`

Real Telegram delivery goes through the first-class `smithers-orchestrator/telegram`
Bot API helper behind this app's narrow `TelegramPort`. If `TELEGRAM_BOT_TOKEN` is not
set outside production, delivery uses the fake Postgres outbox so local runs stay
deterministic. Test processes and deployments with `E2E_TEST_ROUTES=1` also use the
fake outbox unless `TELEGRAM_DELIVERY_MODE=real` is set explicitly for a live smoke run.
The checked-in `.env.example` leaves `TELEGRAM_BOT_TOKEN` blank for that local fake
default; production must set a real token.

## Frontend

The Next.js run dashboard lives at `/runs` and uses
`smithers-orchestrator/gateway-react` to read live Smithers Gateway data.

Run the Smithers gateway and the app in separate terminals:

1. `bun .smithers/gateway.ts`
2. `SMITHERS_GATEWAY_URL=http://127.0.0.1:7331 bun run dev`
3. Open `http://127.0.0.1:3000/runs?token=<OPERATOR_SECRET>` once. The server
   validates the token, sets an HttpOnly Secure SameSite=Lax cookie, and redirects
   to `/runs` so the token is not left in the dashboard URL or client JavaScript.

`next.config.mjs` rewrites `/v1/rpc/*`, `/workflows/*`, `/health`, and the
dashboard WebSocket path `/smithers-ws` to `SMITHERS_GATEWAY_URL`, defaulting to
`http://127.0.0.1:7331`. These proxy paths use the same operator cookie and fail
closed when `OPERATOR_SECRET` is missing. The dashboard waits until browser mount
to connect, so production builds do not fetch the gateway and render a disconnected
state when no gateway is reachable.

## Tests and gates

- `bun run typecheck` — strict TypeScript over app, src, and tests.
- `bun run build` — Next.js production build.
- `bun test` / `bun run test` — unit, integration, and e2e suites.
- `bun run test:coverage` — enforces coverage thresholds (fails under them).
- `TEST_DATABASE_URL=postgres://smithers:smithers@localhost:5432/vercel_example bun run test:integration`
  — live-Postgres suite: migration idempotency, atomic run claim under concurrency,
  queue drainer `SKIP LOCKED` claims, lease reclaim, FK enforcement, exactly-one outbox
  send under concurrent trigger+drain, and rate-limit rejection. Skipped when
  `TEST_DATABASE_URL` is unset.
- `bunx tsc -p .smithers/tsconfig.json --noEmit` — Smithers workflow typecheck.

CI (`.github/workflows/ci.yml`) runs typecheck, build, and the full coverage-gated test
suite against a Postgres 16 service, plus the Smithers workflow typecheck, on every PR
and push to `main`.

## Deploy

Deploy to Vercel with the environment variables above configured, including
`TELEGRAM_BOT_TOKEN` for real Telegram sends. Production startup fails fast when the token
is missing unless `TELEGRAM_DELIVERY_MODE=fake` is explicitly set for a non-delivery
environment. `vercel.json` schedules Vercel Cron to hit `/api/cron/summary` hourly; set
`CRON_SECRET` so Vercel authenticates those invocations. Do not set `E2E_TEST_ROUTES` in
production — the fake outbox route additionally hard-404s whenever `NODE_ENV` or
`VERCEL_ENV` is `production`.
