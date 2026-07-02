import { describe, expect, it } from "vitest";
import { createTelegramWebhookPost } from "@/src/routes/telegram-webhook";
import { createTriggerPost } from "@/src/routes/trigger";
import { allowAllRateLimiter } from "@/src/rate-limit";
import { noopQueueKick } from "@/src/routes/queue-kick";

describe("route smoke e2e", () => {
  it("accepts an authenticated webhook and authenticated manual trigger through route handlers", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = "telegram-secret";
    process.env.OPERATOR_SECRET = "operator-secret";

    const webhook = createTelegramWebhookPost({
      buildContainer: () => ({ pool: {} }) as never,
      rateLimiter: allowAllRateLimiter,
      ingestUpdate: async () => ({ chatId: 42, inserted: true }),
    });
    const trigger = createTriggerPost({
      buildContainer: () => ({ pool: { query: async () => ({ rows: [{ id: "42" }], rowCount: 1 }) } }) as never,
      rateLimiter: allowAllRateLimiter,
      kickQueue: noopQueueKick,
      triggerSummary: async () => ({ runId: 7, claimed: true }),
    });

    const webhookResponse = await webhook(
      new Request("https://example.test/api/telegram/webhook", {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": "telegram-secret" },
        body: JSON.stringify({
          update_id: 1,
          message: {
            message_id: 1,
            date: 1_751_328_100,
            text: "hello",
            chat: { id: 99 },
          },
        }),
      }),
    );
    expect(webhookResponse.status).toBe(200);
    await expect(webhookResponse.json()).resolves.toMatchObject({ ok: true, inserted: true });

    const triggerResponse = await trigger(
      new Request("https://example.test/api/trigger", {
        method: "POST",
        headers: { authorization: "Bearer operator-secret" },
        body: JSON.stringify({
          chatId: 42,
          windowStart: "2026-07-02T00:00:00.000Z",
          windowEnd: "2026-07-02T01:00:00.000Z",
        }),
      }),
    );
    expect(triggerResponse.status).toBe(200);
    await expect(triggerResponse.json()).resolves.toMatchObject({ ok: true, runId: 7, claimed: true });
  });
});
