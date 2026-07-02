# Clarifying questions triage

Source: brainstorm.md open questions q1–q9, filtered against research/domain.md and
research/prior-art.md.

## Dropped — research already answered

- **q1 (message acquisition scope)**: Not a product choice — a hard Telegram Bot API
  platform constraint. Bots cannot backfill pre-join history; only live webhook ingestion
  → Postgres works. Adopted: webhook ingestion, summaries cover post-install messages only,
  documented in the bot's first-run message. (domain.md §Answers #1, prior-art.md §Unknowns)
- **q2 (multi-chat vs single-chat)**: Answered — design multi-chat schema (`chat_id`,
  `cron_expr`, `timezone`, `enabled`), ship single-chat-by-default; one fixed Vercel Cron
  tick fans out to due chats (per-chat Vercel Cron entries don't scale). (domain.md #2)
- **q3 (bot vs pattern as primary deliverable)**: Answered by the brief itself — the
  reusable smithers-on-Vercel pattern is primary, the bot is the demo payload. (domain.md #3)
- **q5 (UI scope)**: Answered — the brief explicitly requires "observing *and driving*",
  ruling out read-only. Drive surface: trigger run, edit/pause cron config, replay failed
  run, inspect ingested messages. (domain.md #5)
- **q6 (real Telegram vs fake in e2e)**: Answered — fake Bot API for deterministic CI/
  preview e2e; real-Telegram reserved for a gated smoke test. Matches industry practice and
  the preview-deployment constraints. (domain.md #6)
- **q8 (cron timezone semantics)**: Answered — the underlying tick is UTC regardless
  (Vercel Cron and GitHub Actions cron are UTC-only); store per-chat IANA timezone and
  convert at due-check. Recommendation is well-supported; not worth a human round-trip.
  (domain.md #8)

## Kept — need a human product decision

- **q4-threshold** — minimum-message threshold for skipping a summary. Research settled
  the shape (silent skip + record skipped run, structured digest with explicit window) but
  explicitly flagged the exact number as a human-tunable product default (~3–5 suggested).
- **q7-long-task** — what credibly exercises the >20-minute Sandbox requirement. Research
  found this a genuine unresolved tension: the bot's happy path is fast; options are a
  synthetic long-task e2e fixture vs. relying on the smithering workflow's own long runs.
  Materially changes the spec's validation gate for requirement #2.
- **q9-coverage-gate** — whether "100% coverage" is a hard CI gate with a reviewed
  exclusion list or an aspirational target. Research pinned the scope (app source
  line+branch, standard toolchain) but flagged hard-gate-vs-target as an explicit human
  call; it changes CI design and test-writing cost significantly.
