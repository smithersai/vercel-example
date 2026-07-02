# Remediation slice 2 — package/build hygiene

## Changes

- `package.json`: `next` 15.5.4 → 15.5.9 (patched release, same 15.5.x line per Next.js
  security advisories). Added explicit devDependencies `@types/node@^22.10.2`,
  `@types/react@^19.2.14`, `@types/react-dom@^19.2.3` so Next's build no longer needs to
  auto-install them.
- `bun.lock`: regenerated via `bun install` after the package.json changes.
- `.gitignore`: added `.next/`, `.tmp/`, `.bun-cache/` (were missing; `coverage/` and
  `tsconfig.tsbuildinfo` were already present).
- Removed generated local artifacts from the working tree: `.next/`, `coverage/`,
  `tsconfig.tsbuildinfo`. `.tmp/` and `.bun-cache/` were not present, nothing to remove.

No application code was modified; behavior is unchanged.

## filesChanged

- package.json
- bun.lock
- .gitignore

Committed on branch `remediation/slice-2-package-hygiene` (repo `main` had zero commits;
this is the root commit on the new branch). Not merged to `main`, not pushed.

## Verification

Raw logs under `artifacts/remediation/slice-2/green/`:

- `bun-install.log` — `bun install` succeeded after fixing the initial `@types/react-dom`
  version constraint (`^19.2.7` doesn't exist upstream; corrected to `^19.2.3`, and
  `@types/react` to `^19.2.14` to match available versions). Final install: 8 packages,
  clean, no errors.
- `build.log` — `bun run build` (`next build`) **fails**, pre-existing/unrelated to this
  slice: `Route "app/api/cron/summary/route.ts" does not match the required types of a
  Next.js Route. "createCronGet" is not a valid Route export field.` This is an app-code
  issue (route export naming convention), not a dependency/config problem introduced here.
- `typecheck.log` — `bun run typecheck` (`tsc --noEmit`) **fails** with the same class of
  errors: several `app/api/**/route.ts` files export custom factory functions
  (`createCronGet`, `createTelegramWebhookPost`, `createOutboxGet`, `createTriggerPost`)
  that Next's generated route type-checking rejects, plus an unrelated `app/layout.tsx`
  `ReactNode`/`unknown` children type mismatch. Pre-existing app code; out of scope for
  this package-hygiene slice (task explicitly says "do not alter app behavior").
- `bun-test.log` — `bun test`: 26 pass, 0 fail.
- `test-vitest.log` — `bun run test` (`vitest run`): 5 files, 21 tests, all pass.
- `test-coverage.log` — `bun run test:coverage`: 5 files, 21 tests pass; overall coverage
  97.61% statements / 92.45% branches / 100% functions / 97.54% lines.
- `test-e2e.log` — `bun run test:e2e`: 1 file, 1 test, pass.

## Blockers

- `bun run build` and `bun run typecheck` fail due to pre-existing app-route typing
  issues in `app/api/**/route.ts` and `app/layout.tsx` that predate this slice and are
  unrelated to the dependency/lockfile/gitignore changes made here. Fixing them would
  require altering app route export shapes, which is out of scope ("do not alter app
  behavior") and belongs to a separate remediation slice.
- No network failures encountered; `bun install` succeeded once the `@types/*` version
  ranges were corrected to versions that actually exist on the registry.

After verification, generated artifacts (`.next/`, `coverage/`, `tsconfig.tsbuildinfo`)
were removed again from the working tree to keep it clean.
