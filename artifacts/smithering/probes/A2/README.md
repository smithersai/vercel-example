# Probe A2 — Vercel Sandbox: >25 min incremental task from a Function

## Question
Does a Vercel Sandbox task, invoked from a Vercel Function, run 25 minutes of real
incremental loop work to completion?

## What's here
- `run-sandbox-loop.mjs` — real, runnable script using `@vercel/sandbox` (v2.3.0, the
  official SDK). Creates a Sandbox with `timeout` padded above the requested loop
  duration, runs a shell loop that ticks every 5s and writes progress, streams logs,
  waits for exit, and records `evidence/run-result.json`. This is the same client the
  smithers Sandbox provider would call from inside a Vercel Function handler.
- `evidence/console-output.txt`, `evidence/auth-failure.txt` — actual output from
  running the script in this environment.
- `package.json` / `node_modules` — real npm install of `@vercel/sandbox@2.3.0`.

## What we actually verified
- `@vercel/sandbox` is a real, currently-published SDK (`npm view` confirms 2.3.0,
  published by Vercel's GitHub Actions release bot) whose documented purpose is exactly
  this: running sandboxed processes from a Function, with a configurable `timeout` and
  detached/streamed command execution — the shape needed for a >20 min agent task.
- The probe script itself is syntactically and logically correct and reaches real SDK
  code (`Sandbox.create` → OIDC credential resolution) before failing.

## What we could NOT verify
- We could not actually execute a Sandbox in this environment. `Sandbox.create()`
  requires either a linked Vercel project (`vercel link` + `vercel env pull`, giving an
  OIDC token) or an explicit personal access token bound to a team/project. The only
  credential present, `VERCEL_API_TOKEN`, is **invalid** (`vercel whoami` and
  `vercel link` both reject it: "The token provided via `--token` argument is not
  valid."). There is no linked `.vercel` project directory and no `VERCEL_OIDC_TOKEN`.
- Result: `Sandbox.create()` throws `LocalOidcContextError` immediately — see
  `evidence/auth-failure.txt`. We never got to the point of running the 25-minute loop,
  so we have **no direct evidence** of Sandbox's actual max duration behavior, only
  documented limits (Vercel docs state Sandbox supports configurable timeouts up to 45
  minutes on Pro plans / 5 hours on Enterprise, as of Sandbox GA) which we did not
  independently confirm by running code.

## Verdict
**Not verified (blocked on credentials), not falsified.** The plumbing (SDK, API shape,
timeout config, detached command streaming) all exists and matches what's needed, but the
assumption that a live Sandbox actually sustains 25 minutes of incremental work end-to-end
was not exercised because no valid Vercel token/team/project was available in this
sandboxed environment.

## Plan impact
Before relying on this in the implementation, someone with real Vercel credentials must:
1. `vercel link` this project to a real Vercel project/team.
2. `vercel env pull` (or set `VERCEL_TOKEN`/`VERCEL_OIDC_TOKEN`) so `@vercel/sandbox` can
   authenticate.
3. Re-run `run-sandbox-loop.mjs 1500` (25 min) and confirm `evidence/run-result.json`
   shows `completed: true` with `elapsedMs` ≈ 1,500,000+ and no premature timeout/kill.
Until that run succeeds, treat "Sandbox can run >20 min" as an open risk, not a confirmed
capability — do not commit the architecture to Sandbox as the long-running-task provider
without this live confirmation.
