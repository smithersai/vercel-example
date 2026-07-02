# A11 — Privacy mode disabled + allowed_updates=['message'] → webhook receives group messages

**Assumption:** With privacy mode disabled and `allowed_updates=['message']`, the bot's
webhook receives ordinary group messages, and `getMe.can_read_all_group_messages` reflects
the setting.

## What was actually tested

Network egress to `api.telegram.org` from this environment works (confirmed below), but
this environment has **no `TELEGRAM_BOT_TOKEN`** and no way to create a fresh bot via
@BotFather or have a human send a message from a real Telegram account into a real group.
That means the core of this assumption — "a plain human-sent group message reaches the
webhook on a freshly configured real bot" — **cannot be exercised end-to-end here**. This
probe does NOT fabricate a passing result; it records exactly what could and could not be
verified.

### Verified: network reachability

```
$ curl -s -m 5 -o /dev/null -w "%{http_code}\n" https://api.telegram.org/bot123:test/getMe
401
```
See `network-check.log`. A 401 (not a timeout/DNS failure) confirms outbound HTTPS to the
Telegram Bot API is reachable from wherever this workflow runs — necessary but nowhere
near sufficient for A11.

### Not verified (requires a real bot + a real human sender)

The following steps are the actual probe plan and were **not run**, because they require
secrets and a live human-in-the-loop action that this environment cannot provide:

1. Create a bot via @BotFather, disable privacy mode (`/setprivacy` → Disable) *before*
   adding it to any group (Telegram only applies privacy-mode changes to groups the bot
   joins after the change).
2. Call `getMe` and check `can_read_all_group_messages`.
3. Register a webhook with `setWebhook(url, allowed_updates=["message"])`.
4. Add the bot to a fresh test group as a non-admin member.
5. Have a human send a plain text message (not a command, not a reply/mention) in the
   group.
6. Observe whether the webhook receives an `update.message` for that message.

Per Telegram's own Bot API documentation (not independently re-verified live here,
cited as background only): privacy mode governs whether a bot *sees* all group messages
vs. only commands/mentions/replies; `can_read_all_group_messages` in `getMe` reflects the
bot's current privacy-mode setting; and `allowed_updates` is purely a webhook-side filter
on update *types* (message vs. edited_message vs. ...) — it does not itself grant or
restrict message visibility, so it cannot compensate for privacy mode being enabled.

## Verdict

**FAILED to verify (not disproven — untestable in this environment).** `passed=false`
because the assumption was not exercised against a real bot/webhook/human sender, and no
result should be reported as confirmed without that.

## Plan impact

The plan must not treat A11 as validated. Before implementation relies on receiving
ordinary (non-command) group messages via webhook:

- Add an explicit manual/live setup step (documented in the README, referenced by
  AC-10.4's "optional live-Telegram smoke test") where a human: creates the bot, disables
  privacy mode via @BotFather *before* joining any group, adds it to a real test group,
  and confirms both `getMe.can_read_all_group_messages == true` and that a plain human
  message reaches the configured webhook.
- Treat this as a deploy-time / onboarding prerequisite check, not something the app can
  self-verify at runtime beyond logging `can_read_all_group_messages` from `getMe` on
  startup and warning loudly if it is `false` (the app CAN check that one field live once
  a real token exists — that's a cheap runtime guard worth adding regardless of this
  probe's outcome).
- Do not gate merge/CI on this assumption; gate it on the documented manual bot setup
  step, since it depends on Telegram-side configuration outside the app's control.
