# telegram-http-client-retries Evidence

## Decisions

- Inspected upstream helper shape at `/Users/williamcory/smithers/packages/telegram/src/index.js` and `.d.ts`; kept this example self-contained to avoid an unpublished local `/Users/williamcory/smithers` dependency while it still depends on registry `smithers-orchestrator ^0.26.1`.
- Added a local `TelegramBotApiPort` with a `call` helper plus `sendMessage`, using `TELEGRAM_BOT_TOKEN`, optional `TELEGRAM_API_ROOT`, injectable `fetch` and `sleep`, and numeric `messageId` normalization.
- Retry policy is bounded by `maxRetries`: retry 429 using Telegram `parameters.retry_after`, retry 5xx and network/read failures with exponential backoff, and do not retry permanent 4xx failures other than 429.
- Container selection uses real Telegram delivery when a token is configured, explicit fake delivery when `TELEGRAM_DELIVERY_MODE=fake`, local/test fake delivery when no token is configured outside production, and production fail-fast without a token unless fake mode is explicit.
- Preserved `FakeTelegramPort` and its Postgres outbox behavior for deterministic local/e2e tests.

## Verification

- Red: `bunx vitest run test/unit/telegram.test.ts test/unit/container-selection.test.ts` failed before implementation with 6 failing tests because `TelegramBotApiPort` and production selection did not exist.
- Green targeted: `bunx vitest run test/unit/telegram.test.ts test/unit/container-selection.test.ts` passed with 2 files and 10 tests.
- Typecheck: `bun run typecheck` passed.
- Unit suite: `bun run test:unit` passed with 9 files and 68 tests.
- Full vitest suite: `bun run test` passed with 11 files passed, 2 skipped, 71 tests passed, 9 skipped.
- Integration suite: `bun run test:integration` passed with 1 file passed, 2 skipped, 2 tests passed, 9 skipped. Live Postgres tests were skipped because `TEST_DATABASE_URL` was not configured.
- E2E suite: `bun run test:e2e` passed with 1 file and 1 test.
- Coverage: `bun run test:coverage` passed thresholds: statements 93.02%, branches 88.31%, functions 92.56%, lines 93.04%.
- Build: `bun run build` passed.
- Whitespace: `git diff --check` passed.

## Git Operations

- Attempted branch creation with `git switch -c feat/telegram-http-client-retries`, then `git switch -c telegram-http-client-retries`; both failed because this sandbox cannot write under `.git`.
- Attempted scoped `git add .env.example README.md src/container.ts src/telegram.ts test/setup-env.ts test/unit/telegram.test.ts test/unit/container-selection.test.ts`; it failed with `.git/index.lock: Operation not permitted`.
- No commit was created because `.git` is read-only in this execution environment.

## Operator Follow-Up

- Tightened container selection after the workflow completed: `NODE_ENV=test` and preview/e2e deployments with `E2E_TEST_ROUTES=1` use `FakeTelegramPort` unless `TELEGRAM_DELIVERY_MODE=real` is explicitly set. Production still fails fast without `TELEGRAM_BOT_TOKEN` unless `TELEGRAM_DELIVERY_MODE=fake` is explicit.
- Changed `.env.example` so `TELEGRAM_BOT_TOKEN` is blank by default; copying it locally no longer attempts real Telegram delivery with a placeholder token.

## Post-Follow-Up Verification

- `bunx vitest run test/unit/telegram.test.ts test/unit/container-selection.test.ts` passed with 2 files and 11 tests.
- `bun run typecheck` passed.
- `bun run test` passed with 11 files passed, 2 skipped, 72 tests passed, 9 skipped.
- `bun run build` passed.
- `bun run test:e2e` passed with 1 file and 1 test.
- `bun run test:integration` passed with 1 file passed, 2 skipped, 2 tests passed, 9 skipped. Live Postgres tests were skipped because `TEST_DATABASE_URL` was not configured.
- `bun run test:coverage` passed thresholds: statements 92.82%, branches 88.24%, functions 92.62%, lines 92.84%.
- `bunx tsc -p .smithers/tsconfig.json --noEmit` passed.
- `git diff --check` passed.
