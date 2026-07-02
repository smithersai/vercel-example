# Slice 3 remediation evidence

## Goal
Fix Next.js build/typecheck failures from slice 2: `app/api/**/route.ts` files exported
custom `create*` factory helpers (invalid Next Route export fields), and
`app/layout.tsx` typed `children` as `unknown` instead of `ReactNode`.

## Red (before changes)
- `bun run build` → exit 1. See `red/build.log`.
  - Failure: `Route "app/api/cron/summary/route.ts" does not match the required types of a
    Next.js Route.` — `"createCronGet" is not a valid Route export field.`
- `bun run typecheck` → exit 2. See `red/typecheck.log`.
  - Failures: factory exports (`createTriggerPost`, etc.) rejected as invalid route
    exports; `app/layout.tsx` `children: unknown` not assignable to `ReactNode`.

## Changes made
Moved the testable factory helpers out of the route files into new modules under
`src/routes/`, leaving each `app/api/**/route.ts` exporting only `GET`/`POST` handlers
(valid Next.js Route exports). Updated `app/layout.tsx` to type `children` as
`ReactNode` from `react`. Updated unit/e2e tests to import factories from the new
`src/routes/*` modules instead of the route files.

### Files changed
- `src/routes/trigger.ts` (new) — moved `createTriggerPost` and its deps from
  `app/api/trigger/route.ts`
- `src/routes/telegram-webhook.ts` (new) — moved `createTelegramWebhookPost` from
  `app/api/telegram/webhook/route.ts`
- `src/routes/cron-summary.ts` (new) — moved `createCronGet`/`createCronPost` and the
  shared `createCronRunner` from `app/api/cron/summary/route.ts`
- `src/routes/outbox.ts` (new) — moved `createOutboxGet` from
  `app/api/test/outbox/route.ts`
- `app/api/trigger/route.ts` — now only imports `createTriggerPost` from
  `@/src/routes/trigger` and exports `POST`
- `app/api/telegram/webhook/route.ts` — now only imports `createTelegramWebhookPost`
  from `@/src/routes/telegram-webhook` and exports `POST`
- `app/api/cron/summary/route.ts` — now only imports `createCronGet`/`createCronPost`
  from `@/src/routes/cron-summary` and exports `GET`/`POST`
- `app/api/test/outbox/route.ts` — now only imports `createOutboxGet` from
  `@/src/routes/outbox` and exports `GET`
- `app/layout.tsx` — `children` typed as `ReactNode` (imported from `react`) instead of
  `unknown`
- `test/e2e/route-smoke.test.ts` — imports `createTelegramWebhookPost` /
  `createTriggerPost` from `@/src/routes/telegram-webhook` and `@/src/routes/trigger`
- `test/unit/auth-routes.test.ts` — imports `createCronGet`/`createCronPost`,
  `createOutboxGet`, `createTelegramWebhookPost`, `createTriggerPost` from the new
  `@/src/routes/*` modules

No behavior was changed: auth checks (`requireBearer`, `requireTelegramSecret`),
request parsing, DB queries, and the manual/scheduled trigger race-claim logic are
byte-for-byte the same as before, just relocated.

## Green (after changes)
- `bun run build` → exit 0. See `green/build.log`.
- `bun run typecheck` → exit 0. See `green/typecheck.log`.
- `bun test` → exit 0. See `green/bun-test.log`.
- `bun run test` → exit 0. See `green/test.log`.
- `bun run test:coverage` → exit 0. See `green/test-coverage.log`.
- `bun run test:e2e` → exit 0. See `green/test-e2e.log`.

## Blockers
None.
