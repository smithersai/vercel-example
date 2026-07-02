# Slice 4 remediation evidence

## Scope
1. `.smithers/tsconfig.json` — TypeScript 6 no longer fails on deprecated `baseUrl`, adds Bun/Node
   types, excludes generated worktree/execution/node_modules output from the project.
2. `.smithers/workflows/smithering-impl.tsx` — replaced the stable cross-run
   `INTEGRATION_BRANCH = "smithering/integration"` constant with a run-scoped
   `integrationBranch(runId)` helper (`smithering/<runId>/integration`), threaded through every
   setup/render/land/tier2/report call site. Still never merges to `main`.
3. `runTier2Gates` — removed the `requiredWhenScaffolded: false` override on the `e2e-preview`
   gate so, once the tree is scaffolded (`package.json` exists), an absent preview URL/script goes
   RED via the existing `requiredWhenScaffolded` fail-closed behavior in `runGateSet`, instead of
   staying `unavailable`/green forever. Pre-scaffold behavior (no `package.json`) is unchanged —
   still recorded `unavailable`. `longtask-pr-variant` and `smoke-skip-behavior` already defaulted
   to required-when-scaffolded and needed no change.

## Red evidence (artifacts/remediation/slice-4/red/)
- `smithers-tsconfig.log` — `bunx tsc -p .smithers/tsconfig.json --noEmit --pretty false` failing
  with `TS5101: Option 'baseUrl' is deprecated...` (exit 2).
- `integration-branch.txt` — grep proving the stable
  `const INTEGRATION_BRANCH = "smithering/integration"` existed before the fix.

## Fixes applied
- `.smithers/tsconfig.json`: added `"ignoreDeprecations": "6.0"`, `"types": ["node", "bun-types"]`,
  and excluded `./worktrees/**/*`, `./node_modules/**/*`, `**/node_modules/**/*` (kept the existing
  `./executions/**/*` exclude).
- Installed `bun-types` as a devDependency (`bun add -d bun-types`) — required for the `types`
  field to resolve; it was not previously installed anywhere in the repo.
- `.smithers/workflows/smithering-impl.tsx`:
  - `const INTEGRATION_BRANCH = "smithering/integration"` → `function integrationBranch(runId: string) { return \`smithering/${runId}/integration\`; }`
  - `landedOnIntegration(ticketId)` → `landedOnIntegration(runId, ticketId)`
  - `integrationTip()` → `integrationTip(runId)`
  - All git branch refs (`git log`, `git rev-parse`, `git merge-base`, `git worktree add`,
    `git reset --hard`, `git branch`), the `<Worktree baseBranch>` prop, and every worker/verify/
    land/tier2/setup/report prompt or return value now call `integrationBranch(runId)` /
    `integrationBranch(ctx.runId)` instead of the removed constant.
  - `runTier2Gates`: dropped `requiredWhenScaffolded: false` from the `e2e-preview` gate entry;
    updated the surrounding comment to state the fail-closed-once-scaffolded invariant.

## Green evidence (artifacts/remediation/slice-4/green/)
- `smithers-tsconfig.log` — `bunx tsc -p .smithers/tsconfig.json --noEmit --pretty false` (exit 2).
  The `baseUrl` deprecation error is gone. One **pre-existing, out-of-scope** error remains:
  `.smithers/workflows/kanban.tsx(168,36): error TS7006: Parameter 'args' implicitly has an 'any' type.`
  This file was untouched by this slice; the error was previously masked because the `baseUrl`
  config error aborted the whole compilation before reaching this file. See Blockers below.
- `graph.log` — `bunx smithers-orchestrator graph .smithers/workflows/smithering-impl.tsx` exits 0
  and renders the full workflow graph, proving `smithering-impl.tsx` still parses/type-checks as a
  valid Smithers workflow after the `integrationBranch(runId)` refactor.
- `grep-checks.log`:
  - Confirms `INTEGRATION_BRANCH` no longer appears anywhere in `smithering-impl.tsx`.
  - Confirms `function integrationBranch(runId: string)` is defined.
  - Confirms `integrationBranch(runId)` / `integrationBranch(ctx.runId)` appears at every
    setup/render/land/tier2/report call site (setup gates at lines ~1061-1094, render at line
    910, land at lines 274/279/330/747/772/781/786, tier2 at line 807, report at line 1170).
  - Confirms the updated `runTier2Gates` body (no `requiredWhenScaffolded: false` on
    `e2e-preview`).

## filesChanged
- `.smithers/tsconfig.json`
- `.smithers/workflows/smithering-impl.tsx`
- `package.json` (added `bun-types` devDependency)
- `bun.lock` (lockfile update for `bun-types`)

## Blockers
- `.smithers/workflows/kanban.tsx(168,36)` has a pre-existing `TS7006` implicit-any error, unrelated
  to this slice's scope (tsconfig deprecation / integration-branch scoping / Tier-2 fail-closed
  gates). It was previously invisible because the `baseUrl` config error made `tsc` abort before
  type-checking any file. Not fixed here — flagging for a follow-up slice since fixing it requires
  touching `kanban.tsx`, which is out of scope for this remediation slice's stated goals.
