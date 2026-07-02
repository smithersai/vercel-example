# A8 probe — Telegram per-chat rate limits vs D27 backoff at 10-chunk counts

**Assumption**: Telegram per-chat rate limits are survivable with D27 backoff at our chunk counts.
**Question**: does sending 10 chunks at 1/s to one chat avoid unrecoverable 429s?

## What this probe does

No live Telegram bot token is available in this environment, and sending real
messages would be a side effect we can't safely repeat/undo, so this probe does not
call the real Telegram API. Instead it:

1. Implements `FakeTelegram.sendMessage` (`probe.ts`) enforcing Telegram's own
   documented per-chat guidance — no more than ~1 message/second to the same
   `chat_id`, else HTTP 429 with a `retry_after` field
   (https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this).
2. Implements `sendChunkWithD27Backoff`, a direct reading of D27
   (`docs/planning/02-design.md` §6, lines 189-200): bounded exponential backoff that
   honors `retry_after` when present, up to `MAX_ATTEMPTS_PER_CHUNK` (5) per chunk.
   This function is written to be liftable into the real Telegram port implementation.
3. Drives 10 chunks through it, first at the plan's stated 1/s pace (`probe.ts`),
   then at an intentionally tighter 250ms pace (`probe_burst.ts`) to force 429s and
   confirm the backoff path actually engages and still converges.

## Results

- `probe.ts` @ 1/s (evidence.log): 10/10 chunks delivered, 0 429s observed, every
  chunk sent on attempt 1. At the exact planned cadence, the assumption holds with
  margin — no backoff was even needed.
- `probe_burst.ts` @ 250ms (evidence_burst.log): 10/10 chunks delivered, 9 429s
  observed (one per chunk after the first), every chunk recovered by attempt 2 of the
  5 allowed. Even at 4x the planned send rate, D27's bounded backoff fully recovers
  without exhausting attempts.

Run yourself: `bun run probe.ts` / `bun run probe_burst.ts` (from this directory).

## Verdict

**Passed.** At the plan's actual chunk count and pacing (10 chunks, 1/s), zero 429s
occur. Even under artificially tighter pacing, D27's backoff — honoring
`retry_after`, bounded at 5 attempts/chunk — recovers every chunk well inside its
attempt budget, so no chunk would exhaust into `run.status` staying `running` for the
watchdog to pick up.

## Caveats / what's not verified

- This models Telegram's *documented* per-chat limit, not a live-verified one — no
  network calls to `api.telegram.org` were made (no bot token; would be a real side
  effect). If Telegram's actual enforcement differs from docs (e.g., stricter bursts,
  additional global-bot-wide limits, or per-message-size throttling), this probe
  would not catch that.
- Does not model global (cross-chat) rate limits Telegram also documents (~30
  msg/sec across all chats) — irrelevant at our single-chat, 10-chunk scale, but
  worth a separate probe if the bot serves many chats concurrently.
- Does not model network-level failures (timeouts, connection resets) — D27 also
  covers 5xx, which this probe's backoff path handles identically to 429 minus the
  `retry_after` hint, but no 5xx case was exercised end-to-end here.
