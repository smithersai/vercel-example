# Remediation Slice 1 Evidence

## Decisions Recorded

- Telegram webhook authentication is enforced with `X-Telegram-Bot-Api-Secret-Token` against `TELEGRAM_WEBHOOK_SECRET`; missing or wrong tokens return 401.
- Manual trigger authentication is enforced with `Authorization: Bearer <OPERATOR_SECRET>`.
- Cron trigger authentication is enforced with `Authorization: Bearer <CRON_SECRET>`.
- The test-only outbox route returns 404 unless `E2E_TEST_ROUTES=1`, returns 404 in production (`NODE_ENV=production` or `VERCEL_ENV=production`), and requires operator bearer auth before returning rows.
- `triggerSummary` now invokes the executor only when the durable run claim returns `claimed: true`; duplicate claim callers return the existing run id without invoking.
- Route modules expose small dependency-injected factory functions for fast unit/e2e tests while preserving the production `GET`/`POST` exports.
- Postgres remains the single durable state store; the fake Telegram adapter writes to `telegram_outbox` in Postgres for e2e assertions.

## Red Evidence

- `bun run test:unit` before root app modules existed failed as expected.
  - Output: `artifacts/remediation/slice-1/red/initial-unit-red.txt`
  - Result: failed with missing `app/api/...` route modules and missing `src/pipeline`.
- `bun run test:unit` against the intentionally blocker-equivalent scaffold failed behaviorally.
  - Output: `artifacts/remediation/slice-1/red/behavioral-blockers-red.txt`
  - Result: webhook/manual/cron/outbox auth tests expected 401 but received 200; duplicate trigger test expected one executor invocation but received two.

## Green Evidence

- `bun run typecheck`
  - Output: `artifacts/remediation/slice-1/green/typecheck.txt`
  - Result: passed.
- `bun test`
  - Output: `artifacts/remediation/slice-1/green/bun-test.txt`
  - Result: passed, 26 tests across 6 files including the preserved artifact probe tests.
- `bun run test`
  - Output: `artifacts/remediation/slice-1/green/test.txt`
  - Result: passed, 21 tests across 5 files.
- `bun run test:unit`
  - Output: `artifacts/remediation/slice-1/green/test-unit.txt`
  - Result: passed, 19 unit tests.
- `bun run test:integration`
  - Output: `artifacts/remediation/slice-1/green/test-integration.txt`
  - Result: passed, 1 integration migration-shape test.
- `bun run test:e2e`
  - Output: `artifacts/remediation/slice-1/green/test-e2e.txt`
  - Result: passed, 1 route smoke e2e test.
- `bun run test:coverage`
  - Output: `artifacts/remediation/slice-1/green/test-coverage.txt`
  - Result: passed thresholds with statements 97.61%, branches 92.45%, functions 100%, lines 97.54%.

## Blocked Evidence

- `git switch -c remediation/slice-1`
  - Output: `artifacts/remediation/slice-1/blocked/git-branch.txt`
  - Result: blocked by filesystem permissions on `.git/HEAD.lock`; this environment only permits reading `.git`, so branch creation and commits could not be completed.
- `bun install`
  - Output: `artifacts/remediation/slice-1/blocked/bun-install.txt`
  - Result: blocked by restricted network while resolving package manifests for `next`, `react`, `react-dom`, and `typescript`.
- `bun run build`
  - Output: `artifacts/remediation/slice-1/blocked/build.txt`
  - Result: blocked because `next` is not installed in the root `node_modules` and `bun install` could not complete.
