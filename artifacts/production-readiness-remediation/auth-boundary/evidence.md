# Operator UI Auth Boundary Evidence

## Decisions

- Reused `OPERATOR_SECRET` for the operator UI shared-secret handoff because it is the repo's established operator secret and no stronger UI-specific env var exists in the current app surface.
- Enforced the boundary in `middleware.ts` so `/runs`, `/v1/rpc/*`, `/workflows/*`, `/health`, and `/smithers-ws` are rejected before the dashboard or Smithers Gateway rewrites run.
- Implemented first-visit handoff as `?token=<OPERATOR_SECRET>` on protected paths. A valid token creates an HttpOnly Secure SameSite=Lax `__Host-` cookie and redirects to the same URL with `token` removed.
- Stored a SHA-256 derived session value in the cookie instead of the raw operator secret. The cookie remains a bearer credential, but the raw token is not exposed to client JavaScript or persisted verbatim in the cookie.
- Failed closed with HTTP 503 when `OPERATOR_SECRET` is missing, matching existing `unavailableSecret` semantics.
- Hardened `/api/trigger` so provided `chatId` and `telegramChatId` values must be safe JSON integers before container construction, rate limiting, or database-backed work.

## Red Evidence

- `artifacts/production-readiness-remediation/auth-boundary/red/targeted-unit.log`
  - Command: `bunx vitest run test/unit/operator-auth-boundary.test.ts test/unit/auth-routes.test.ts`
  - Result: failed before implementation.
  - Expected failures: missing `@/src/operator-auth` module and non-number manual trigger identifier returned 200 instead of 400.

## Green Evidence

- `artifacts/production-readiness-remediation/auth-boundary/green/targeted-unit.log`
  - Command: `bunx vitest run test/unit/operator-auth-boundary.test.ts test/unit/auth-routes.test.ts`
  - Result: passed, 19 tests.
- `artifacts/production-readiness-remediation/auth-boundary/green/targeted-unit-with-middleware.log`
  - Command: `bunx vitest run test/unit/operator-auth-boundary.test.ts test/unit/auth-routes.test.ts`
  - Result: passed, 20 tests including Next middleware wiring.
- `artifacts/production-readiness-remediation/auth-boundary/green/typecheck.log`
  - Command: `bun run typecheck`
  - Result: passed.
- `artifacts/production-readiness-remediation/auth-boundary/green/build.log`
  - Command: `bun run build`
  - Result: passed; Next built the middleware.
- `artifacts/production-readiness-remediation/auth-boundary/green/test.log`
  - Command: `bun run test`
  - Result: passed, 60 tests passed and 9 skipped.
- `artifacts/production-readiness-remediation/auth-boundary/green/test-coverage.log`
  - Command: `bun run test:coverage`
  - Result: passed; coverage summary 94.58% statements, 90.17% branches, 93.33% functions, 94.42% lines.
- `artifacts/production-readiness-remediation/auth-boundary/green/test-e2e.log`
  - Command: `bun run test:e2e`
  - Result: passed, 1 test.
- `artifacts/production-readiness-remediation/auth-boundary/green/test-integration.log`
  - Command: `bun run test:integration`
  - Result: command passed; live database suites skipped because `TEST_DATABASE_URL` is not set.
- `artifacts/production-readiness-remediation/auth-boundary/green/smithers-tsconfig.log`
  - Command: `bunx tsc -p .smithers/tsconfig.json --noEmit`
  - Result: passed.
- `artifacts/production-readiness-remediation/auth-boundary/green/git-diff-check.log`
  - Command: `git diff --check`
  - Result: passed.

## Environment Blockers

- Could not create a branch or commit because `.git` is read-only in this execution environment.
  - `git switch -c fix/operator-ui-auth-boundary` failed while creating `.git/refs/heads/fix/operator-ui-auth-boundary`.
  - `git switch -c fix-operator-ui-auth-boundary` failed with `Operation not permitted` creating `.git/refs/heads/fix-operator-ui-auth-boundary.lock`.
  - Current branch remained `main`; no commit was created.
- Live Postgres integration coverage was skipped by the test suite because `TEST_DATABASE_URL` is unset. The requested `bun run test:integration` command still exited successfully with 1 file passed and 2 files skipped.
