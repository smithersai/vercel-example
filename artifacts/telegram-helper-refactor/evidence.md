# Telegram Helper Refactor Evidence

## Decisions

- Kept the app-specific `TelegramPort` shape as `sendMessage({ chatId, text }) -> { messageId }`.
- Replaced the local duplicate Bot API request/retry/error implementation with `createTelegramClient` from `smithers-orchestrator/telegram`.
- Kept `TelegramBotApiPort` as the app adapter so existing container selection semantics continue to choose real delivery by constructing this port.
- Re-exported the Smithers Telegram helper's Bot API constants/errors/types from `src/telegram.ts` for focused tests and compatibility with existing imports.
- Preserved `FakeTelegramPort` and its Postgres `telegram_outbox` insert path unchanged for local, unit, integration, and preview e2e fake delivery.
- Updated README and the engineering spec to record that real Telegram delivery is helper-backed while fake delivery remains Postgres-backed.

## Red Before Green

- Red: `bunx vitest run test/unit/telegram-helper-delegation.test.ts` failed before the refactor with 1 failing test. The failure showed `{ messageId: 999 }` from the local injected `fetch` response instead of `{ messageId: 321 }` from the mocked `smithers-orchestrator/telegram` client, proving the existing adapter bypassed the first-class helper.

## Green Verification

- Focused Telegram/container: `bunx vitest run test/unit/telegram.test.ts test/unit/telegram-helper-delegation.test.ts test/unit/container-selection.test.ts` passed with 3 files and 12 tests.
- Typecheck: `bun run typecheck` passed.
- Unit suite: `bun run test:unit` passed with 10 files and 70 tests.
- Full Vitest suite: `bun run test` passed with 12 files passed, 2 skipped, 73 tests passed, 9 skipped.
- Integration suite: `bun run test:integration` passed with 1 file passed, 2 skipped, 2 tests passed, 9 skipped. Live Postgres tests were skipped because `TEST_DATABASE_URL` is not configured in this environment.
- E2E suite: `bun run test:e2e` passed with 1 file and 1 test.
- Coverage: `bun run test:coverage` passed thresholds: statements 94.17%, branches 91.05%, functions 93.69%, lines 94.01%.
- Production build: `bun run build` passed, including Next.js build's lint/type validity stage.
- Smithers workflow typecheck: `bunx tsc -p .smithers/tsconfig.json --noEmit` passed.
- Whitespace: `git diff --check` passed.

## Git Operations

- Attempted `git switch -c refactor/telegram-helper`; it failed because the ref namespace could not create `.git/refs/heads/refactor/telegram-helper`.
- Attempted `git switch -c telegram-helper-refactor`; it failed with `.git/refs/heads/telegram-helper-refactor.lock: Operation not permitted`.
- No commit was created because this sandbox exposes `.git` read-only; creating branches, locking refs, and updating the index are blocked.

## Notes

- `package.json` has no dedicated lint script. The available lint-related gate is the Next.js `bun run build` lint/type validity stage, which passed.
- The worktree had substantial pre-existing uncommitted changes before this refactor; this task did not revert or overwrite unrelated files.
