# Implementation Orchestration — v1 (2026-07-01)

Upstream: `docs/planning/03-eng.md` (E-decisions, §19 probe amendments),
`docs/planning/04-backpressure.md` (gate matrix, BP-1…BP-6),
`docs/planning/05-tickets.md` / `artifacts/smithering/tickets.json` (23 tickets, dep
graph). Every field below is a **recorded decision** (O-numbered), not a
consideration. HTML decision docs for the significant judgment calls live under
`artifacts/smithering/decisions/` (orchestration-merge-policy.html,
orchestration-model-assignment.html, orchestration-worktrees-concurrency.html).

## O1 — worktreeLayout (DECISION)

**One jj/git worktree per ticket, created lazily when the ticket is dispatched,
destroyed after its work lands or the ticket is abandoned.**

- Target repo: `.` (this repo). Base branch: `main`.
- Path: `.smithers/worktrees/<runId>/<ticketId>` (gitignored). Branch name:
  `smithering/<runId>/<ticketId>`, always forked from the `main` head at dispatch
  time.
- One ticket = one worktree = one worker = one branch. No shared worktrees, no
  worker ever edits the primary checkout; the orchestrator alone touches `main`.
- Parallelization follows the ticket dep graph in `tickets.json`: a ticket is
  dispatchable when all its `deps` have **landed on `main`** (not merely "worker
  finished"), so every worktree forks from a base that already contains its
  dependencies. Known consequence: ticket 1 (`walking-skeleton-summary-slice`)
  serializes the start of the run — accepted, it is the walking skeleton by design.
- On resume after a crash, a worktree is reused only if its branch still rebases
  cleanly onto current `main`; smithers worktree runs auto-rebase on resume **even
  if the rebase fails** (known behavior), so the resume prompt requires the worker
  to run `jj st`/conflict check as step zero and re-resolve before doing anything
  else.

## O2 — mergePolicy (DECISION)

**Serialized merge lane. We do NOT build optimistic merging with postsubmit
eviction.** (Full alternatives analysis:
`artifacts/smithering/decisions/orchestration-merge-policy.html`.)

- The Smithers `MergeQueue` component is used **as what it actually is — a
  concurrency limiter — with limit 1** on the land step. Workers develop in
  parallel (O5); landing is one at a time.
- Land protocol per ticket (executed by the worker inside its worktree, gated by
  the queue slot): (1) rebase branch onto current `main`; (2) rerun the ticket's
  full pre-merge tier (O3) on the rebased tree; (3) fast-forward/squash-merge into
  `main`; (4) release the slot. A failure at any step returns the ticket to its
  worker with the failure output; `main` is never left red by construction.
- **Rejected: optimistic merge + postsubmit eviction.** It would require custom
  CheckSuite + Saga + `jj revert` machinery (the eviction logic does not exist in
  Smithers today), and its payoff scales with merge-lane contention. With ≤4
  workers (O5), per-ticket pre-merge tiers of minutes (fixture LLM, fake Telegram,
  local PG), and a dep graph whose width rarely exceeds 4–5 tickets, the lane is
  contended for minutes per day. Building revert-saga infrastructure to save that
  is negative-ROI and adds a new class of bug (bad eviction) to a repo whose whole
  point is demonstrating correctness gates. If the run stalls on the lane in
  practice, the recorded escalation is to raise the queue limit to 2 with a
  required post-land `main` re-run — still no eviction saga.
- The auto-rebase-on-resume hazard above (O1) is the other reason serialization
  wins: optimistic merging multiplies rebases, and rebases that "succeed" past a
  failed state are exactly where silent breakage enters.

## O3 — testTiers (DECISION)

Gates are taken verbatim from `04-backpressure.md`; this decision only assigns
**where** each tier runs. An implementing agent MAY iterate on an optimistic subset
while developing, **only because** the land step (pre-merge, O2) and postsubmit run
everything below — a ticket cannot land on a subset.

- **Tier 0 — inner loop (worker-chosen, non-authoritative):** the ticket's own
  named `pnpm test:unit/-integration/-e2e -t "…"` selections. Purely for iteration
  speed; carries no gate weight.
- **Tier 1 — pre-merge, per ticket (blocking, runs in the merge lane on the
  rebased tree):** full unit + integration with the 100% line+branch coverage gate
  (REQ-10.1), full local e2e lane (fake outbox Telegram, fixture Summarizer, local
  PG — REQ-10.2), gitleaks + env-docs + docs-markers lints (REQ-11.2/11.3),
  red-before-green evidence for every BP-5-marked gate the ticket claims, and the
  ticket's own `agent-review` checks. This is everything that is deterministic and
  runs in minutes.
- **Tier 2 — postsubmit on `main` after every land (blocking for the run, not for
  the land that already happened):** Preview-deployment e2e on a Neon branch
  (REQ-10.3), the long-task PR variant (REQ-9.3), smoke skip-behavior leg
  (REQ-10.4). These need a Vercel deploy and are too slow for the lane; a Tier-2
  failure halts further dispatch/landing and opens a fix ticket assigned back to
  the landing worker with the failure evidence. (Before ticket 18
  `neon-preview-ci-pipeline` lands, Tier 2 is necessarily inactive; the first
  Tier-2 run after ticket 18 covers all prior landings — recorded gap, accepted.)
- **Tier 3 — nightly / acceptance (blocking for release, never for merge):**
  grounding eval (REQ-3.3, BP-2), >20-minute long-task proof (REQ-9.2), live
  Telegram smoke (opt-in), fresh-eyes walkthroughs (BP-6) and the REQ-10.5
  pipeline recording at the end of the run.
- Human gates ride the tiers, not the code: **A13** blocks ticket 11 from
  *dispatch* (not merge) until acceptance is recorded in `01-prd.md`; **A2**'s live
  25-minute Sandbox run is step zero of ticket 14 and blocks its Tier-1 entry.

## O4 — modelAssignment (DECISION)

**Hard rule enforced by the workflow: the reviewing model family ≠ the implementing
model family.** Anthropic (Claude) implements and verifies; OpenAI (Codex / GPT-5.4
via the `codex` CLI) reviews. This satisfies the family rule for every ticket with
one static pairing instead of per-ticket juggling. (Alternatives:
`artifacts/smithering/decisions/orchestration-model-assignment.html`.)

| Ticket complexity (from tickets.json) | Implementer | Reviewer | Verifier |
|---|---|---|---|
| small | `claude-sonnet-5` | GPT-5.4 (codex) | `claude-sonnet-5` |
| medium | `claude-sonnet-5` | GPT-5.4 (codex) | `claude-fable-5` (fallback `claude-opus-4-8`) |
| large (tickets 1, 5, 11, 14, 16) | `claude-fable-5` (fallback `claude-opus-4-8`) | GPT-5.4 (codex) | `claude-fable-5` (fallback `claude-opus-4-8`) |

- Roles: the **implementer** writes code+tests in the worktree; the **reviewer**
  does an adversarial code review against the ticket's instructions and the
  backpressure rows (must produce findings or an explicit "no findings" verdict
  with reasons); the **verifier** independently executes the ticket's named gates
  from a fresh context and checks the red-before-green evidence is real (reruns
  the failing-first commit where BP-5 applies). Reviewer and verifier verdicts are
  both required for the land step.
- `claude-sonnet-4-7` does not exist and must never be requested (recorded model
  policy). If the codex CLI is unavailable at run time, the run **pauses** the
  review stage and surfaces a blocker — a same-family (Claude-reviews-Claude)
  fallback is explicitly forbidden.

## O5 — concurrency (DECISION)

**Maximum 3 parallel implementation workers**, plus the single merge-lane slot
(O2); review/verify agents attach to their ticket's slot and do not add parallel
tickets.

Why 3: (a) the dep graph's usable width — after ticket 1 lands, the widest
dispatchable frontier is 4–6 tickets, but the serialized merge lane means workers
beyond ~3 mostly queue and then pay rebase churn; (b) local Postgres and Vitest
suites per worktree — 3 concurrent full suites is what a dev machine sustains
without flaky timeouts corrupting gate evidence (deterministic gates are the
product here; flakiness from oversubscription is a direct threat to it); (c) Neon
CI quotas for Tier-2 branches were only provisionally probed (A4/A5) — low
parallelism keeps us inside the provisional envelope. Raising to 4–5 is a recorded
tunable if the lane proves idle and suites prove stable; it requires no design
change. (Details: `orchestration-worktrees-concurrency.html`.)

## O6 — observability (DECISION)

**Evidence is run-scoped by construction; a prior run's verdicts can never satisfy
a fresh run.**

- Every ticket persists its evidence under
  `artifacts/smithering/build/<runId>/<ticketId>/` — REQUIRED files:
  `plan.md` (implementer's plan), `diff.patch` (final landed diff),
  `test-output/` (raw output of every Tier-1 gate run at land time, one file per
  gate, named by backpressure criterionId), `rbg/` (red-before-green pairs: the
  failing run log + the passing run log for each BP-5 gate), `review.json`
  (reviewer verdict, model id, findings), `verify.json` (verifier verdict, model
  id, gates re-executed, evidence checked), and `decisions/*.html` — a
  self-contained HTML decision log for every judgment call the worker made
  (deviation from ticket instructions, ambiguous spec reading, non-obvious
  design choice), same format as `artifacts/smithering/decisions/`.
- **Both belts:** the path embeds `<runId>` (a stale run can never collide), AND
  the workflow additionally deletes `artifacts/smithering/build/<runId>/<ticketId>/`
  before dispatching (or re-dispatching) that ticket, so a resumed/retried ticket
  cannot inherit its own earlier attempt's verdicts either. Done-checks for a
  ticket read **only** under the current `<runId>/<ticketId>` path and fail loudly
  if any REQUIRED file is missing — absence of evidence is a gate failure, never a
  pass.
- The orchestrator maintains `artifacts/smithering/build/<runId>/index.md`: one
  row per ticket (status, worker model, land commit, evidence links), updated at
  every state transition — the human-facing run ledger.

## O7 — contextManagement (DECISION)

**Every worker (implementer, reviewer, verifier) starts with a fresh context
window. Nothing is inherited; everything load-bearing is in the prompt or on
disk.**

Every worker prompt MUST carry:
- The full ticket JSON object from `artifacts/smithering/tickets.json` (verbatim —
  instructions there are self-contained by design; the prompt never paraphrases
  them).
- Exact paths to read before writing code: `docs/planning/01-prd.md`,
  `02-design.md`, `03-eng.md` (including §19 amendments), `04-backpressure.md`
  (the worker's gate rows), and the relevant
  `artifacts/smithering/decisions/*.html` named by its eng sections.
- Its worktree path, branch name, base commit hash, `<runId>`, and its evidence
  path under `artifacts/smithering/build/<runId>/<ticketId>/`.
- The model policy line (`claude-sonnet-4-7` does not exist) and the O6 REQUIRED
  evidence-file list.
- For reviewer/verifier: the implementer's `plan.md` + `diff.patch` paths — never
  the implementer's transcript.

Every worker prompt MUST state what may NOT be assumed:
- No memory of any other ticket, prior attempt, or planning conversation — if it
  isn't in the prompt or in a file the prompt names, it doesn't exist.
- No repo state beyond `main`-at-fork plus the ticket's own declared deps (which
  are guaranteed landed, O1); undeclared cross-ticket coupling is a bug to report,
  not code around.
- No prior run's artifacts as evidence (O6), no live credentials unless the ticket
  names the env var, and no inventing test results — unknown/unverified must be
  written as such in the evidence files.
- Never raise human gates itself (no ask-human): blockers (A13, A2, missing codex
  CLI, etc.) are surfaced in structured output for the orchestrator's gates.
