# A1 probe: editMessageText idempotency-equivalence

**Assumption:** Telegram `sendMessage` has no idempotency key, and
`editMessageText` re-edit-to-identical-content behaves as an idempotent
success-equivalent — i.e. it returns the documented benign error
`"Bad Request: message is not modified"` rather than a hard failure, so
retry logic can treat that specific error as "already applied, safe to
proceed."

**Probe:** `probe.sh` — calls the real Telegram Bot API against a test bot:
1. `sendMessage` to get a `message_id`.
2. `editMessageText` once (changes content).
3. `editMessageText` again with the exact same text (the case under test).
4. Checks whether step 3's response is `ok:false` with description
   containing `"message is not modified"`.

**Result: NOT RUN — no credentials available in this environment.**

No `TELEGRAM_BOT_TOKEN` or `TELEGRAM_CHAT_ID` is present in this sandbox
(checked env vars and repo for `.env*` files — none found). The script
correctly detects this and exits 2 with `{"status":"skipped",...}` — see
`result.json`. No network call to Telegram was made, so no message was sent
and nothing was mutated.

This is documented behavior on Telegram's public Bot API docs and widely
reported by third-party bot developers (the `ok:false` /
`"message is not modified"` response for edit-to-identical-content), but
that is second-hand knowledge, not something this probe verified
first-hand. The assumption should be re-probed for real the first time a
test bot token is available — this script is ready to run as-is:

```
export TELEGRAM_BOT_TOKEN=<test bot token from @BotFather>
export TELEGRAM_CHAT_ID=<a chat id the bot can post to>
./probe.sh
```
