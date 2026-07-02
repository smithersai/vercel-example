# Remediation — final evidence summary

Branch `main`, tip `38cda4f` (fast-forwarded from `remediation/slice-2-package-hygiene`).
Every finding from the rejected review has landed as tracked history in the root checkout;
nothing lives only in `.smithers/worktrees` anymore.

## What landed, by slice

- **Slice 1** (`1e97174` and predecessors) — deployable app surface: `app/` routes +
  page/layout, `src/` pipeline/auth/ingest/render/summary/telegram/container, `db/migrations`
  + `bun run migrate`, docker-compose Postgres (parametrized port), `vercel.json` hourly cron,
  `.env.example`, README, unit/integration/e2e suites. Red logs:
  `artifacts/remediation/slice-1/red/` (auth routes returned 200 without secrets; duplicate
  trigger invoked the executor twice).
- **Slice 2** (`f4b7228`) — package/build hygiene: next 15.5.9, pinned @types, gitignore.
- **Slice 3** (`d9c5656`) — route factories moved out of `app/api/**/route.ts` (valid Next
  route exports), layout children typed `ReactNode`. Red: `slice-3/red/{build,typecheck}.log`.
- **Slice 4** (`5ba8467`) — `.smithers/tsconfig.json` (TS6 `ignoreDeprecations`, bun-types,
  worktrees/node_modules excluded); `smithering-impl.tsx` per-run
  `smithering/<runId>/integration` branch (stale cross-run reuse removed); Tier-2
  `e2e-preview` gate fails closed once scaffolded. Red: `slice-4/red/`.
- **Slice 5** (`9429431`, `defb3cf`, `5d72bfd`) — kanban.tsx implicit-any fixed so
  `bunx tsc -p .smithers/tsconfig.json` exits 0 (red: `slice-5/red/smithers-tsc.log`, green:
  `slice-5/green/smithers-tsc.log`); CI with Postgres service; planning corpus committed.
- **Slice 6** (`38cda4f`) — closes every blocker from the 24-agent adversarial review:
  - **Cron duplicate-send**: window bounds are now `date_trunc('hour', now())`-deterministic,
    so concurrent/repeated scheduler ticks collide on the UNIQUE `(chat, window)` claim;
    `sched_cursor` advances durably after a won claim and holds on failure. Red (7 failing
    tests incl. live double-send repro): `slice-6/red/behavioral-red.log`; green:
    `slice-6/green/behavioral-green.log`.
  - **Preview e2e lane**: `/api/test/outbox` production gate keys on `VERCEL_ENV` (preview
    reachable, production 404, bare `NODE_ENV=production` still 404).
  - **Executor failure marking**: failed runs record `status='failed'`, `last_error`,
    `attempt_count`; one bad chat no longer starves the cron loop.
  - **Coverage visibility**: `coverage.include` measures all of `src/` + `app/`; oxc JSX
    override compiles Next's preserve-mode JSX; app-surface tests pin route exports to their
    auth gates. Red: `slice-6/red/coverage-include-red.log` (app files at 0%/parse-excluded).
  - **Clean-checkout smithers typecheck**: components compile against published
    smithers-orchestrator 0.26.1 (panelist normalization, moderator cast, unpublished task
    tuning via spread) — verified green on a fresh clone.
  - **Tier-2 preview gate**: preview URL rides `PREVIEW_BASE_URL` env through `runGate`
    instead of a `--base-url` flag test runners reject.

## Verification (all exit 0)

| Gate | Local | Fresh clone of main (CI simulation) |
| --- | --- | --- |
| `bun install --frozen-lockfile` | ✓ | ✓ |
| `bun run typecheck` | ✓ (`slice-6/green/typecheck.log`) | ✓ |
| `bun run build` | ✓ (`slice-6/green/build.log`) | ✓ |
| `bun test` | 41 pass (`slice-6/green/bun-test.log`) | — |
| `bun run test:coverage` + live pg | 36 pass; 96.41/97.32/95.55/96.31 (`slice-6/green/coverage-green.log`) | ✓ |
| `bun run test:coverage` no db | 94.35/92.85/91.11/94.21, live suite skipped (`slice-6/green/coverage-no-db.log`) | — |
| `.smithers` install + tsc | ✓ | ✓ |
| `smithers-orchestrator graph smithering-impl.tsx` | ✓ (`slice-6/green/smithers-graph.log`) | — |

Thresholds enforced at 90/85/90/90 across the full measured surface in both modes.
Live-Postgres suites (migration idempotency, 8-way concurrent claim, FK enforcement,
exactly-one-outbox-send under concurrent manual and scheduled triggers, repeat-tick no-resend)
ran against docker Postgres 16.

## Review process

A 24-agent workflow (6 dimensions × adversarial verification per finding) reviewed main;
16 findings survived verification, including 6 blocking-grade. All were fixed in slice 6 and
a second adversarial pass re-verified each blocker closed at `38cda4f` (see
`reverify-blockers` workflow output). Non-blocking accepted residuals, recorded deliberately:

- Ledger-less migration runner re-executes idempotent SQL each run — fine at current scale.
- Full lease/watchdog recovery (`lease_owner`, `heartbeat_at`) is deferred scope (planning
  ticket 7); failed runs are now visible (`status='failed'`) and cron retries via the held
  cursor + `assigned_run_id IS NULL` overlap safety.
- `min_messages` backpressure from chat_config is not yet consulted (planning scope).
- The slice-4 "green" smithers-tsc log recorded exit 2 (one residual error at the time);
  slice 5's log supersedes it with exit 0.
