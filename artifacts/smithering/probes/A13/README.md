# A13 — PRD acceptance of bounded content-free placeholder residual

## Assumption
The PRD owner accepts the bounded content-free placeholder residual (orphans ≤
attempt_count) as compatible with REQ-5, via the proposed AC-5.3 amendment text:

> "AC-5.3 applies to summary *content*; content-free placeholder messages caused by
> crash-during-send are permitted, bounded by the per-run attempt limit."

## Why this is not a technical probe
Per `docs/planning/03-eng.md` §5/§16, A13 is explicitly marked a **human gate**, not a
spike: "A13 is a human gate, not a spike." There is no code, API, or system to exercise
that determines whether this assumption holds — the only open variable is a product
decision by the PRD owner. The engineering doc (§5) already establishes, and this probe
independently re-derives below, that no protocol closes the residual within Bot API
constraints; so the only real "probe" left is checking whether a decision record exists
and, if not, surfacing the exact binary choice to the human.

## What was checked (read-only verification of the technical claim)
1. Checked A1 (`artifacts/smithering/probes/A1/result.json`): that probe was skipped
   (`TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` not set), so it did not itself confirm the
   no-idempotency-key claim by live API call. The claim is instead documented directly
   in `docs/planning/03-eng.md` §5 and the decision doc as a known Bot API property.
2. Read `artifacts/smithering/decisions/exactly-once-delivery.html` — confirms the
   rejected alternatives (send-then-record without placeholder; dedup-by-read, which the
   Bot API cannot do; MTProto session, which the PRD forbids) and that the reserve →
   record → edit → confirm protocol in §5 is the only remaining design, with residual
   orphans bounded by `max_attempts` (5).
3. Searched the entire `artifacts/smithering/decisions/` tree and `docs/planning/` for
   any recorded PRD-owner sign-off on the AC-5.3 amendment text. See `search.log`.
4. Checked `docs/planning/01-prd.md` directly: AC-5.3 there still reads "No duplicate
   summary is ever posted..." unamended — the proposed amendment text has not been
   merged into the PRD itself.

## Result
No acceptance record was found anywhere in `docs/`/`artifacts/`. The amendment is
proposed (in the eng doc and decision doc) but **not yet accepted by the PRD owner, and
not yet reflected in the PRD**. `docs/planning/04-backpressure.md` (BP-3) independently
confirms this is a blocking gate: "human approval of A13 amendment" is required before
§5 implementation starts, and the recorded acceptance must land "in
`docs/planning/01-prd.md` amendment" — which has not happened. This is exactly the
state §16 anticipates ("E1 ships only after acceptance").

## Verdict
passed=false — not because the engineering reasoning is wrong (it appears sound and
internally consistent: A1 already demonstrates no idempotency key exists, and the
decision doc enumerates why no alternative protocol removes the residual), but because
the actual precondition of A13 — **PRD owner acceptance** — has not happened. This
probe cannot manufacture that acceptance; it can only confirm it is still outstanding
and hand the exact binary choice to the human gate.

## Plan impact
Do not begin implementation of engineering §5 (E1 exactly-once delivery) until one of:
- The PRD owner accepts the AC-5.3 amendment text quoted above (then A13 flips to
  passed=true and §5/E1 work can start as specced), or
- The PRD owner mandates a stricter protocol — in which case, per the recorded
  alternatives, no such protocol exists within Bot API + PRD constraints (no MTProto),
  so REQ-5 itself would need to be relaxed (e.g., accept an out-of-band reconciliation
  step, or drop the "no content-free stray" requirement to "no duplicate *content*"
  formally in the PRD, which is what the proposed amendment already does).

This is a blocker-class human decision, not an engineering task; it should be raised to
the human via the orchestrator's gate (not via this probe, per operating rules).
