# A10 — Fire-and-forget Sandbox invocation from a Vercel Function

## Assumption
A Vercel Function (`tick`) can invoke a Sandbox task fire-and-forget without awaiting
completion, returning in <10s while the invoked task keeps running.

## What the probe actually shows
`probe.mjs` / `output.log` demonstrate plain Node.js semantics: an un-awaited async call
lets the caller (`tick`) return in ~1ms while the "sandbox task" continues running in the
background and finishes ~5s later, in the *same OS process*.

This confirms the JS-language-level part of the assumption (not awaiting a promise lets
the caller return early) but that part was never in doubt. It does **not** confirm the
assumption in its actual target environment — a Vercel Function — because this script
runs as a plain long-lived Node process, not inside the Vercel Lambda/Fluid runtime.

## Why the assumption fails on real Vercel Functions
This is documented, well-known Vercel behavior, not something a local script can
reproduce:

1. A standard Vercel Function's execution environment is frozen/torn down once the
   response is sent. Any pending, un-awaited promise is not guaranteed to keep running —
   it can simply stop when the container freezes. This is exactly the failure mode A10
   is trying to detect, and it is real.
2. Vercel's documented fix is `waitUntil()` (from `@vercel/functions` / the Fluid compute
   request context), which explicitly keeps the invocation alive until the passed promise
   settles. But that means:
   - The invocation is *not* fire-and-forget in the sense of "returns and the platform
     truly detaches" — the function instance stays alive and billed until the background
     promise resolves.
   - It is still bounded by the function's `maxDuration` (platform max is well under the
     ">20 minutes" requirement in this project's CLAUDE.md architecture constraints).
3. Therefore a single Vercel Function invocation cannot itself host a >20-minute Sandbox
   task via simple "don't await it" fire-and-forget, with or without `waitUntil`.

No network access / Vercel deployment was available in this session to exercise the real
Lambda-freeze behavior directly (no `vercel` CLI login, no `@vercel/functions` installed,
no deploy target) — the above is based on documented, well-established Vercel platform
behavior rather than a fresh empirical deploy in this probe. Flagging this explicitly
rather than inventing a live-deployment result.

## Conclusion
passed = false, as literally stated. The mechanism needs to change: `tick` should call
the Sandbox provider's own async job-start API (which itself returns immediately at the
HTTP layer, independent of the Function's process lifecycle) and persist the job
reference to Postgres, then a *separate* cron tick polls/receives a webhook for
completion. This matches the existing architecture constraint that agent tasks run via
`<Sandbox>` as a first-class async job, not via un-awaited promises inside a Function.

## Plan impact
`tick` must not rely on fire-and-forget promises inside the Function process for
long-running Sandbox tasks. Instead: (1) `tick` starts the Sandbox job via its API and
immediately persists `{jobId, status: 'running'}` to Postgres, returning fast; (2) a
separate mechanism (webhook endpoint, or a subsequent cron tick that polls the Sandbox
job status) observes completion and updates Postgres — no in-process background promise
survives past the response in a standard Vercel Function.
