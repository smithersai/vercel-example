# Research: Design Art — Layout, Interaction, API Ergonomics, Naming, Onboarding

topic: design-art

This is a design-precedent survey for two products bundled in one build (per
`docs/planning/01-prd.md`): (1) a Telegram summary bot, and (2) a serverless
"smithers on Vercel" reference/template with an operator UI. Sources below are
drawn from general, well-established public knowledge of these products' UX
and API conventions as of the assistant's training — not from live fetches of
their current docs/UI (no WebFetch/WebSearch was run for this artifact). Where
specifics may have since changed, this is flagged explicitly.

## 1. Chat-digest / summary bots (product surface: Telegram messages)

**What to copy**

- **Explicit window framing.** The strongest pattern across digest tools (e.g.
  Slack's daily-recap style summaries, email digest products) is stating the
  covered time range in the artifact itself, not just in metadata. The PRD
  already requires this (AC-3.1) — this is validated best practice, not a
  gap. Keep the window at the top of the message, before any content.
- **Structured over prose.** Digests that use consistent sections (topics →
  decisions → action items → links) scan faster than paragraph summaries,
  especially on mobile where Telegram is primarily read. Fixed section order
  and consistent bolding/headers (Telegram supports a constrained Markdown/
  HTML subset) let readers jump to what they care about (e.g. skip to action
  items). REQ-3's 3–7 topics + decisions + action items + links structure
  matches this pattern well.
- **Silence as a feature, not a bug.** The best-regarded digest bots treat "no
  post" as a legitimate, deliberate output for quiet periods — exactly what
  REQ-4 (quiet-window skip) specifies. Bots that post "nothing happened today"
  train users to mute them; the PRD's approach (skip entirely, log the skip
  in the operator UI only) is the correct pattern and should not be
  second-guessed later for "more visible feedback" in the chat itself.
- **One-time capability disclosure.** Posting a single explanatory message
  when the bot joins (AC-1.2) mirrors how well-behaved bots set expectations
  once and never repeat themselves in-channel. Avoid ever re-posting this
  notice on subsequent runs — that becomes chat noise.
- **Attribution without @mention spam.** Good digest bots attribute topics to
  participants by name/handle in prose ("Alice proposed X") rather than using
  literal `@username` mentions, which would ping every participant on every
  summary. This should be an explicit formatting rule in the summarization
  prompt/renderer, since Telegram will notify on `@handle` mentions.

**What to avoid**

- **Transcript-shaped output.** The PRD already avoids this (REQ-3 explicitly
  says "not a transcript"), but the failure mode to guard against in
  implementation is a summarizer that just compresses message-by-message
  instead of synthesizing by topic. Fixture-based grounding checks (AC-3.3)
  are the right guard; make sure fixtures include multi-topic, multi-speaker
  windows, not just single-thread conversations.
- **Silent chunking with broken formatting.** Long-message splitting (AC-5.1)
  is a known failure point for Telegram bots: naive splitting on a fixed
  character count can break Markdown/HTML entities mid-tag, corrupting
  rendering for the rest of the message. Split on section boundaries first,
  then on paragraph/sentence boundaries within a section, and never inside an
  open entity.
- **Vague or duplicate posts under retries.** Bots that don't dedupe retried
  scheduler triggers double-post — a well-known complaint pattern for
  cron-based bots. AC-5.3's concurrency test is the correct mitigation;
  treat (chat_id, window_start, window_end) as a uniqueness key enforced at
  the database layer (not just application logic), since serverless
  concurrency means two invocations can race past an app-level check.

## 2. Operator/admin UI (product surface: smithers Gateway UI)

**What to copy**

- **Runs-list as the home view**, with status, timing, and one-line outcome
  visible without opening a detail page — this is the dominant pattern in
  CI dashboards (GitHub Actions, Vercel's own deployments list) and job
  schedulers, and it's what REQ-7/AC-7.1 already specifies. The key detail
  worth copying from Vercel's own deployment list specifically (since this is
  a Vercel-native product and operators will already have that mental model):
  status as a colored dot/badge in a scannable left column, relative
  timestamps, and a detail view reachable by clicking the row rather than a
  separate "view" action.
- **Config as CRUD, kept boring.** Chat configuration (schedule, timezone,
  threshold, enabled state) is best served as a plain form-based CRUD screen,
  not a novel editor. Cron-schedule UIs that succeed (e.g. GitHub Actions'
  `on.schedule`, most job schedulers) show a human-readable next-run preview
  next to the raw cron string — worth adding here so operators can sanity
  check "0 9 * * *" + timezone without mental parsing.
- **Retry/replay as a first-class action on the failed state**, not buried in
  a menu — this matches how CI UIs treat failed runs (a visible "Re-run"
  button on the failure itself). AC-7.3 already calls for this; make sure the
  button is on both the list row and the detail view.
- **Auth via shared-secret/deployment protection kept invisible to the happy
  path.** Internal tools gated by a single shared secret (rather than full
  user accounts) work best when the secret is handled once (e.g. a link with
  a token, or Vercel's deployment protection bypass token) rather than a
  login form the operator re-enters per visit — reduces friction for a
  single-operator tool without weakening the AC-7.5 requirement.

**What to avoid**

- **Real-time-feeling UI backed by polling that lies about freshness.** A
  common failure in serverless admin UIs is a live-looking list that's
  actually stale between polls with no visible "last updated" indicator,
  making an in-progress run look stuck. Show explicit run state transitions
  and a visible timestamp for "as of," especially since this UI is itself
  serverless (no persistent websocket by default).
- **Novel widgets for cron.** Building a custom visual cron-builder is a
  common over-investment for an operator-only tool serving a handful of
  chats; a text input with validation + human-readable preview is enough and
  matches AC-2.3 (reject invalid cron with a clear error) without extra UI
  surface to test for 100% coverage (REQ-10).
- **Config changes that silently need a redeploy.** AC-6.3 already requires
  config to take effect without redeploy; the UI mistake to avoid is any
  affordance that implies otherwise (e.g. a "deploy" button after saving
  config) — the save action itself should read as complete.

## 3. API ergonomics & naming (product surface: template/repo for smithers adopters)

**What to copy**

- **One boundary, one word.** Products that are cited as having good API
  ergonomics (Stripe, Twilio) converge on a small, consistent vocabulary used
  identically across API, docs, and dashboard: the same noun for the same
  concept everywhere. For this repo, that means picking one term each for
  "chat configuration," "run," "window," and "summary" and using them
  verbatim in the DB schema, the workflow code, the UI labels, and the README
  — never introducing a synonym (e.g. "job" vs "run," "digest" vs "summary")
  for the same concept in a different layer.
- **The template's README as the primary API surface.** Since the deliverable
  is explicitly a copyable template (REQ-8, AC-8.3), the README's "clone,
  configure, deploy" path is the actual product API for the target audience
  (smithers adopters). The best-regarded infra templates (e.g. Vercel's own
  official templates) lead with a single "Deploy" path and a short list of
  required env vars/secrets stated up front, before any architecture
  explanation — put deployment steps before conceptual explanation.
- **Executable requirements as the spec's ergonomics.** The PRD's own
  structure (requirement → acceptance criteria → validation gate) is itself
  a naming/ergonomics choice worth preserving consistently into code: name
  test files/fixtures after the REQ/AC IDs they validate (e.g. a fixture
  file or test name referencing `AC-3.3`) so the mapping from spec to
  executable check stays traceable, which directly serves this project's
  "every requirement maps to an executable validation gate" credibility
  claim.

**What to avoid**

- **Config surface creep.** Don't let the chat-config object accumulate
  optional fields beyond schedule/timezone/threshold/enabled — each added
  knob multiplies the coverage burden under the 100%-coverage gate (REQ-10)
  and adds a decision the operator UI must expose. Resist adding fields not
  named in REQ-6 without a corresponding PRD amendment (per the PRD's own
  "scope changes require amending this document" status line).
- **Divergent naming between DB schema and workflow code.** A known failure
  mode in smithers-based projects specifically is workflow step names/output
  keys drifting from the DB column names they persist to, making the system
  harder for an adopter to trace. Keep the workflow's structured
  input/output shapes named identically to the Postgres columns they read
  from and write to.

## 4. Onboarding (adopter README + operator first-run)

**What to copy**

- **Two-audience onboarding, kept separate.** This project has two onboarding
  paths — the bot operator, and the smithers adopter cloning the template —
  and the best-regarded infra templates separate these clearly (a top-level
  "Quick start" for deploying, a separate "Architecture" section for
  understanding it) rather than interleaving them. Put the operator's
  "add bot to chat → configure schedule" flow and the adopter's "clone →
  set env vars → deploy" flow in clearly separate README sections/headers.
- **First real message beats a demo screenshot.** For the operator's first
  experience with the bot in-chat, the one-time capability-disclosure message
  (AC-1.2) doubles as onboarding — it's the first thing a chat sees. Make
  sure that message is the strongest piece of "product onboarding copy" in
  the whole system, since for chat members it may be the only proactive
  explanation they ever get (they don't read READMEs).
- **Deploy-time checklist over narrative docs.** For the adopter audience,
  the highest-copying pattern from well-regarded infra templates is a
  literal numbered checklist (env vars, DB provisioning, webhook URL
  registration with Telegram, cron registration) rather than prose — matches
  AC-8.3's "follow the README and pass the e2e suite" bar, which is
  effectively a checklist-shaped acceptance test already.

**What to avoid**

- **Assuming Telegram-side setup is obvious.** Telegram bot setup (creating
  the bot via BotFather, registering a webhook URL, adding the bot to a
  group and granting it message-read permissions) is a common first-run
  failure point for Telegram bot templates generally, because it happens
  outside the repo/dashboard entirely. The README should walk through this
  explicitly rather than assuming familiarity, since the adopter audience is
  primarily smithers users, not necessarily Telegram bot developers.
- **Silent onboarding failures.** If webhook registration or DB migration
  fails during adopter setup, failing loudly with a specific remediation
  step (matching the project's own bar for run failures being visible with a
  reason, AC-5.4/AC-7.1) is more consistent with this project's own stated
  values than a generic error.

## 5. Explicit gaps / unverified claims

- No live fetch of current competitor products (Telegram bots, Vercel
  dashboard, Stripe/Twilio docs) was performed for this artifact; all
  comparisons rely on general, previously-established knowledge of these
  products' UX conventions and may not reflect their exact current state.
  If precise, current screenshots/flows are needed, a follow-up research
  pass with WebFetch/WebSearch against specific product docs is recommended.
- No existing Telegram "TL;DR" bot was evaluated hands-on; the failure modes
  described (spammy nothing-happened posts, no window disclosure,
  hallucinated quiet-period content) are stated in the PRD's own problem
  statement (`docs/planning/01-prd.md` §1) and are treated here as
  given/confirmed rather than independently re-verified.
