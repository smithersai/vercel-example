#!/usr/bin/env bash
# A1 probe: does Telegram's editMessageText, when called twice with identical
# content, return the documented benign error ("message is not modified")
# rather than a hard failure — i.e. is edit-to-identical-content a safe
# idempotent no-op we can treat as success-equivalent?
#
# Requires a real test bot token + chat id (never commit these):
#   export TELEGRAM_BOT_TOKEN=...   # from @BotFather, a throwaway test bot
#   export TELEGRAM_CHAT_ID=...     # a chat the bot can post to (e.g. your own DM with the bot)
#
# Usage: ./probe.sh
set -euo pipefail
cd "$(dirname "$0")"

OUT=result.json
: > "$OUT"

if [[ -z "${TELEGRAM_BOT_TOKEN:-}" || -z "${TELEGRAM_CHAT_ID:-}" ]]; then
  echo '{"status":"skipped","reason":"TELEGRAM_BOT_TOKEN and/or TELEGRAM_CHAT_ID not set in environment"}' | tee "$OUT"
  exit 2
fi

API="https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}"
TEXT="A1 probe $(date -u +%Y%m%dT%H%M%SZ)"

echo "-> sendMessage"
SEND_RESP=$(curl -sS -X POST "${API}/sendMessage" \
  -d "chat_id=${TELEGRAM_CHAT_ID}" \
  --data-urlencode "text=${TEXT}")
echo "$SEND_RESP" > send_response.json
cat send_response.json

MSG_ID=$(echo "$SEND_RESP" | grep -o '"message_id":[0-9]*' | head -1 | grep -o '[0-9]*')
if [[ -z "$MSG_ID" ]]; then
  echo '{"status":"error","reason":"sendMessage did not return message_id"}' | tee "$OUT"
  exit 1
fi

echo "-> editMessageText (first edit, changes content)"
EDIT1_RESP=$(curl -sS -X POST "${API}/editMessageText" \
  -d "chat_id=${TELEGRAM_CHAT_ID}" \
  -d "message_id=${MSG_ID}" \
  --data-urlencode "text=${TEXT} (edited)")
echo "$EDIT1_RESP" > edit1_response.json
cat edit1_response.json

echo "-> editMessageText (second edit, IDENTICAL content — this is the probed case)"
EDIT2_RESP=$(curl -sS -X POST "${API}/editMessageText" \
  -d "chat_id=${TELEGRAM_CHAT_ID}" \
  -d "message_id=${MSG_ID}" \
  --data-urlencode "text=${TEXT} (edited)")
echo "$EDIT2_RESP" > edit2_response.json
cat edit2_response.json

OK2=$(echo "$EDIT2_RESP" | grep -o '"ok":[a-z]*' | head -1)
DESC2=$(echo "$EDIT2_RESP" | grep -o '"description":"[^"]*"' | head -1)

if [[ "$OK2" == '"ok":false' && "$DESC2" == *"message is not modified"* ]]; then
  echo "{\"status\":\"pass\",\"assumption_holds\":true,\"detail\":${DESC2#*:}}" > "$OUT"
elif [[ "$OK2" == '"ok":true' ]]; then
  echo '{"status":"unexpected","assumption_holds":false,"detail":"second identical edit returned ok:true instead of the expected benign error"}' > "$OUT"
else
  echo "{\"status\":\"fail\",\"assumption_holds\":false,\"detail\":\"unexpected response: ${EDIT2_RESP}\"}" > "$OUT"
fi

cat "$OUT"
