# A9 — Vitest v8 branch coverage on SQL-fence early-exit paths

**Assumption:** Vitest v8 coverage reports branch coverage correctly for
SQL-fence early-exit paths, and an intentionally uncovered fence branch fails
the 100% gate.

## Setup

`src/sqlFence.ts` implements `extractSqlFence()`, a representative SQL-fence
parser with 5 branches (A: missing opening fence, B: opening fence with no
newline, C: missing closing fence, D: empty sql body, E: happy path) — each
an early `return null` except the happy path.

`vitest.config.ts` configures v8 coverage with `thresholds: { lines: 100,
branches: 100, functions: 100, statements: 100 }` scoped to `sqlFence.ts`.

## Runs

1. `run-uncovered.log` — `src/sqlFence.test.ts` deliberately omits tests for
   branch B and branch D. Result: branch coverage 75% (6/8), exit code **1**,
   with explicit `ERROR: Coverage for branches (75%) does not meet global
   threshold (100%)`. The gate correctly fails.

2. `run-fullcoverage.log` — same test file extended to cover all 5 branches.
   Result: 100% statements/branches/functions/lines, exit code **0**. The
   gate correctly passes.

## Verdict

**PASSED.** Vitest v8 coverage thresholds correctly detect an uncovered
early-exit branch in SQL-fence-style parsing code and fail the build (exit
code 1) until all branches are exercised. No plan changes needed — the
100% coverage gate is enforceable as designed for this code shape.
