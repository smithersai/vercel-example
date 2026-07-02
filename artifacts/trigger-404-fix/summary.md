# /api/trigger — 404 for unknown direct chatId

## Problem
A direct numeric `chatId` that did not correspond to an existing `chat` row
fell through to `triggerSummary`, which attempted to claim a run and hit a
Postgres foreign-key violation instead of returning a clean 404. The
`telegramChatId` resolution path already guarded against this (SELECT +
404-if-empty); direct `chatId` did not.

## Fix
`src/routes/trigger.ts`: after all auth/window/type validation and rate
limiting, when the request supplies a direct `chatId` (no `telegramChatId`),
run `SELECT id FROM chat WHERE id = $1` and return 404 `{ error: "unknown chat" }`
if no row is found, before calling `triggerSummary`. `telegramChatId`
resolution behavior is unchanged (it already performs its own existence
check and derives `chatId` from a real row, so the new check is skipped
for that path).

Ordering preserved: auth -> body parse -> window validation -> chatId/telegramChatId
type validation (isTriggerIdentifier, safe integer) -> rate limiting ->
telegramChatId resolution (if given) -> **new: direct chatId existence check**
-> triggerSummary. No DB-backed work happens before auth/window/type checks.

## Tests
- Added `test/unit/auth-routes.test.ts`: "returns 404 for a direct chatId that
  does not exist, without inserting a run" — confirmed red (200 instead of 404)
  before the fix, green after.
- Updated `pool: {}` mocks at two existing call sites in
  `test/unit/auth-routes.test.ts` and one in `test/e2e/route-smoke.test.ts`
  that exercise the direct-chatId success path, so they now return a matching
  row from the new lookup query.
