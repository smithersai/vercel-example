// A8 probe: does sending 10 chunks at 1/s to one chat avoid unrecoverable 429s
// under D27's retry policy?
//
// D27 (docs/planning/02-design.md §6): transient Telegram failures (HTTP 429 with
// retry_after, and 5xx) are retried with exponential backoff honoring retry_after
// when present, up to a bounded number of attempts per chunk within the same task
// invocation.
//
// We have no live bot token, so real Telegram calls are out of scope for this probe
// (side-effecting, and unavailable). Instead we model Telegram's own documented
// per-chat limit (~1 msg/sec; bursts get HTTP 429 + retry_after) as an in-process
// fake `sendMessage`, drive the actual D27 client logic (implemented below, meant
// to be lifted into the real Telegram port) against it, and record every attempt.
//
// Run: bun run probe.ts | tee evidence.log

type SendResult =
  | { ok: true; messageId: number }
  | { ok: false; status: 429; retryAfterSec: number }
  | { ok: false; status: 500 };

// --- Fake Telegram: enforces "no more than 1 message/sec to the same chat_id" ---
// This is Telegram's own documented per-chat throughput guidance, not a made-up
// number; see https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this
class FakeTelegram {
  private lastSentAtMs = new Map<string, number>();
  private readonly minIntervalMs = 1000;
  calls = 0;

  async sendMessage(chatId: string, _text: string): Promise<SendResult> {
    this.calls++;
    const now = Date.now();
    const last = this.lastSentAtMs.get(chatId);
    if (last !== undefined && now - last < this.minIntervalMs) {
      const retryAfterSec = Math.ceil((this.minIntervalMs - (now - last)) / 1000) || 1;
      return { ok: false, status: 429, retryAfterSec };
    }
    this.lastSentAtMs.set(chatId, now);
    return { ok: true, messageId: this.calls };
  }
}

// --- D27 client: bounded exponential backoff honoring retry_after when present ---
const MAX_ATTEMPTS_PER_CHUNK = 5;
const BASE_BACKOFF_MS = 500;

async function sendChunkWithD27Backoff(
  telegram: FakeTelegram,
  chatId: string,
  text: string,
  log: Array<Record<string, unknown>>,
): Promise<{ success: boolean; attempts: number }> {
  let attempt = 0;
  while (attempt < MAX_ATTEMPTS_PER_CHUNK) {
    attempt++;
    const result = await telegram.sendMessage(chatId, text);
    if (result.ok) {
      log.push({ attempt, outcome: "sent", messageId: result.messageId });
      return { success: true, attempts: attempt };
    }
    if (result.status === 429) {
      const backoffMs = Math.max(result.retryAfterSec * 1000, BASE_BACKOFF_MS * 2 ** (attempt - 1));
      log.push({ attempt, outcome: "429", retryAfterSec: result.retryAfterSec, backoffMs });
      await Bun.sleep(backoffMs);
      continue;
    }
    // 5xx: exponential backoff without retry_after
    const backoffMs = BASE_BACKOFF_MS * 2 ** (attempt - 1);
    log.push({ attempt, outcome: "5xx", backoffMs });
    await Bun.sleep(backoffMs);
  }
  log.push({ attempt, outcome: "exhausted" });
  return { success: false, attempts: attempt };
}

async function main() {
  const telegram = new FakeTelegram();
  const chatId = "chat-A8";
  const chunkCount = 10;
  const perChunkIntervalMs = 250; // 4x tighter than plan, to force 429s and exercise backoff

  const evidence: Record<string, unknown>[] = [];
  const startedAt = Date.now();

  for (let i = 0; i < chunkCount; i++) {
    const chunkLog: Array<Record<string, unknown>> = [];
    const { success, attempts } = await sendChunkWithD27Backoff(
      telegram,
      chatId,
      `chunk ${i + 1}/${chunkCount}`,
      chunkLog,
    );
    evidence.push({ chunkIndex: i, success, attempts, log: chunkLog });
    if (i < chunkCount - 1) {
      await Bun.sleep(perChunkIntervalMs);
    }
  }

  const durationMs = Date.now() - startedAt;
  const failedChunks = evidence.filter((e) => !e.success);
  const total429s = evidence.reduce(
    (sum, e) => sum + (e.log as Array<Record<string, unknown>>).filter((l) => l.outcome === "429").length,
    0,
  );
  const maxAttemptsUsed = Math.max(...evidence.map((e) => e.attempts as number));

  const result = {
    assumption: "A8: 10 chunks at 1/s to one chat avoid unrecoverable 429s under D27 backoff",
    telegramCallsMade: telegram.calls,
    chunksSent: chunkCount,
    chunksDelivered: evidence.filter((e) => e.success).length,
    chunksFailed: failedChunks.length,
    total429sObserved: total429s,
    maxAttemptsUsedForAnyChunk: maxAttemptsUsed,
    maxAttemptsAllowed: MAX_ATTEMPTS_PER_CHUNK,
    durationMs,
    passed: failedChunks.length === 0,
    perChunk: evidence,
  };

  console.log(JSON.stringify(result, null, 2));
}

main();
