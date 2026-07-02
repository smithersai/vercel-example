# Queue Drainer Evidence

## Decisions

- Triggers now only enqueue via the existing atomic `run` natural key. `triggerSummary` no longer invokes the executor inline.
- Queue state stays on the existing `run` table. `lease_owner`, `lease_expires_at`, `next_attempt_at`, `attempt_count`, and `dead_lettered_at` drive visibility timeout, retry backoff, and terminal dead-lettering.
- Drainers claim runnable rows with a single Postgres `UPDATE ... FROM (SELECT ... FOR UPDATE SKIP LOCKED)` statement so concurrent serverless invocations do not double-claim the same run.
- Failed execution is marked by the drainer, not `executeRun`, so retry/backoff/dead-letter policy has one owner.
- `executeRun` reserves `run_chunk` before sending to the outbox so concurrent or reclaimed execution paths do not double-send under the tested outbox adapter.
- Manual triggers self-invoke `/api/queue/drain` with `CRON_SECRET` after a new enqueue; cron also drains after scheduled enqueue work.
- Public route rate limiting is Postgres-backed and runs only after authentication, so unauthenticated requests are rejected before any database work.

## Verification

- RED: `bun run test:unit test/unit/trigger-summary.test.ts` failed before implementation because the old trigger path invoked run `501` inline. Log: `artifacts/queue-drainer/red/trigger-summary.log`.
- PASS: `bunx vitest run test/unit/auth-routes.test.ts test/unit/cron-runner.test.ts test/unit/pipeline-db.test.ts test/unit/trigger-summary.test.ts` passed, 37 tests. Log: `artifacts/queue-drainer/green/targeted-unit.log`.
- PASS: `bun run test:unit` passed, 42 tests. Log: `artifacts/queue-drainer/green/test-unit-rerun.log`.
- PASS: `bun run test` passed, 45 tests with 9 live-Postgres tests skipped because `TEST_DATABASE_URL` was unset. Log: `artifacts/queue-drainer/green/test-rerun.log`.
- PASS: `bun run test:e2e` passed, 1 test. Log: `artifacts/queue-drainer/green/test-e2e.log`.
- PASS: `bun run test:integration` passed migration-shape tests and skipped live-Postgres tests without `TEST_DATABASE_URL`. Log: `artifacts/queue-drainer/green/test-integration-no-db.log`.
- BLOCKED: live Postgres integration with `TEST_DATABASE_URL=postgres://smithers:smithers@localhost:5432/vercel_example` failed with `connect EPERM` to `::1:5432`/`127.0.0.1:5432`; Docker access also failed with permission denied on the local Docker socket. Logs: `artifacts/queue-drainer/green/live-postgres-attempt.log`, `artifacts/queue-drainer/green/docker-ps.log`.
- BLOCKED: `bun run typecheck` failed outside the queue work in untracked `app/runs/*` and linked `/Users/williamcory/smithers/packages/gateway-*` source imports ending in `.ts`. Logs: `artifacts/queue-drainer/green/typecheck-rerun.log`.
- BLOCKED: `bun run build` failed on the same linked Smithers `.ts` extension issue. Log: `artifacts/queue-drainer/green/build.log`.
- BLOCKED: `bun run test:coverage` executed tests but failed global thresholds because untracked `app/runs/*` is included in coverage at about 63% line coverage. Log: `artifacts/queue-drainer/green/test-coverage-rerun.log`.
- BLOCKED: branch creation failed before edits because `.git/refs/heads/...lock` could not be created under the sandbox's read-only `.git`; no commit could be made.
