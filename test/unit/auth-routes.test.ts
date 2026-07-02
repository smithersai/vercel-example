import { beforeEach, describe, expect, it } from "vitest";
import { createCronGet, createCronPost } from "@/src/routes/cron-summary";
import { createOutboxGet } from "@/src/routes/outbox";
import { createQueueDrainPost } from "@/src/routes/queue-drain";
import { createTelegramWebhookPost } from "@/src/routes/telegram-webhook";
import { createTriggerPost } from "@/src/routes/trigger";
import { requireBearer, requireTelegramSecret, tokensEqual, unavailableSecret } from "@/src/auth";
import { allowAllRateLimiter } from "@/src/rate-limit";
import { kickQueueDrain, noopQueueKick } from "@/src/routes/queue-kick";

const jsonHeaders = { "content-type": "application/json" };
const noopDrainer = () => ({
  drain: async () => ({ claimed: 0, executed: 0, failed: 0, deadLettered: 0 }),
});

function bearer(secret: string): HeadersInit {
  return { authorization: `Bearer ${secret}` };
}

describe("route auth gates", () => {
  beforeEach(() => {
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    delete process.env.OPERATOR_SECRET;
    delete process.env.CRON_SECRET;
    delete process.env.E2E_TEST_ROUTES;
    delete process.env.VERCEL_ENV;
  });

  it("rejects missing and wrong Telegram webhook secrets, then accepts the right secret", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = "telegram-secret";
    let ingestCalls = 0;
    const POST = createTelegramWebhookPost({
      buildContainer: () => ({ pool: {} }) as never,
      rateLimiter: allowAllRateLimiter,
      ingestUpdate: async () => {
        ingestCalls += 1;
        return { chatId: 42, inserted: true };
      },
    });
    const body = JSON.stringify({
      update_id: 1,
      message: {
        message_id: 10,
        date: 1_751_328_100,
        text: "ship it",
        from: { username: "alice" },
        chat: { id: 99, title: "example" },
      },
    });

    expect(
      await POST(new Request("https://example.test/api/telegram/webhook", { method: "POST", body })),
    ).toHaveProperty("status", 401);
    expect(
      await POST(
        new Request("https://example.test/api/telegram/webhook", {
          method: "POST",
          headers: { "x-telegram-bot-api-secret-token": "wrong" },
          body,
        }),
      ),
    ).toHaveProperty("status", 401);

    const accepted = await POST(
      new Request("https://example.test/api/telegram/webhook", {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": "telegram-secret", ...jsonHeaders },
        body,
      }),
    );

    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toMatchObject({ ok: true, chatId: 42 });
    expect(ingestCalls).toBe(1);

    const ignored = await POST(
      new Request("https://example.test/api/telegram/webhook", {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": "telegram-secret", ...jsonHeaders },
        body: JSON.stringify({ update_id: 2 }),
      }),
    );
    expect(ignored.status).toBe(200);
    await expect(ignored.json()).resolves.toMatchObject({ ok: true, ignored: true });

    const invalid = await POST(
      new Request("https://example.test/api/telegram/webhook", {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": "telegram-secret" },
        body: "{",
      }),
    );
    expect(invalid.status).toBe(400);
  });

  it("requires operator bearer auth for the manual trigger route", async () => {
    process.env.OPERATOR_SECRET = "operator-secret";
    let triggerCalls = 0;
    const POST = createTriggerPost({
      buildContainer: () => ({ pool: { query: async () => ({ rows: [{ id: "42" }], rowCount: 1 }) } }) as never,
      rateLimiter: allowAllRateLimiter,
      kickQueue: noopQueueKick,
      triggerSummary: async () => {
        triggerCalls += 1;
        return { runId: 77, claimed: true };
      },
    });
    const body = JSON.stringify({
      chatId: 42,
      windowStart: "2026-07-02T00:00:00.000Z",
      windowEnd: "2026-07-02T01:00:00.000Z",
    });

    expect(await POST(new Request("https://example.test/api/trigger", { method: "POST", body }))).toHaveProperty(
      "status",
      401,
    );
    expect(
      await POST(
        new Request("https://example.test/api/trigger", {
          method: "POST",
          headers: bearer("wrong"),
          body,
        }),
      ),
    ).toHaveProperty("status", 401);

    const accepted = await POST(
      new Request("https://example.test/api/trigger", {
        method: "POST",
        headers: { ...bearer("operator-secret"), ...jsonHeaders },
        body,
      }),
    );

    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toMatchObject({ ok: true, runId: 77, claimed: true });
    expect(triggerCalls).toBe(1);

    const missingWindow = await POST(
      new Request("https://example.test/api/trigger", {
        method: "POST",
        headers: { ...bearer("operator-secret"), ...jsonHeaders },
        body: JSON.stringify({ chatId: 42, windowStart: "2026-07-02T00:00:00.000Z" }),
      }),
    );
    expect(missingWindow.status).toBe(400);

    const unknownChat = createTriggerPost({
      buildContainer: () => ({ pool: { query: async () => ({ rows: [], rowCount: 0 }) } }) as never,
      rateLimiter: allowAllRateLimiter,
      kickQueue: noopQueueKick,
      triggerSummary: async () => ({ runId: 1, claimed: true }),
    });
    const unknown = await unknownChat(
      new Request("https://example.test/api/trigger", {
        method: "POST",
        headers: { ...bearer("operator-secret"), ...jsonHeaders },
        body: JSON.stringify({
          telegramChatId: 99,
          windowStart: "2026-07-02T00:00:00.000Z",
          windowEnd: "2026-07-02T01:00:00.000Z",
        }),
      }),
    );
    expect(unknown.status).toBe(404);

    const resolvedChat = createTriggerPost({
      buildContainer: () => ({ pool: { query: async () => ({ rows: [{ id: "88" }], rowCount: 1 }) } }) as never,
      rateLimiter: allowAllRateLimiter,
      kickQueue: noopQueueKick,
      triggerSummary: async (_container, args) => ({ runId: args.chatId, claimed: true }),
    });
    const resolved = await resolvedChat(
      new Request("https://example.test/api/trigger", {
        method: "POST",
        headers: { ...bearer("operator-secret"), ...jsonHeaders },
        body: JSON.stringify({
          telegramChatId: 99,
          windowStart: "2026-07-02T00:00:00.000Z",
          windowEnd: "2026-07-02T01:00:00.000Z",
        }),
      }),
    );
    expect(resolved.status).toBe(200);
    await expect(resolved.json()).resolves.toMatchObject({ runId: 88 });
  });

  it("returns 404 for a direct chatId that does not exist, without inserting a run", async () => {
    process.env.OPERATOR_SECRET = "operator-secret";
    let triggerCalls = 0;
    const unknownDirectChat = createTriggerPost({
      buildContainer: () => ({ pool: { query: async () => ({ rows: [], rowCount: 0 }) } }) as never,
      rateLimiter: allowAllRateLimiter,
      kickQueue: noopQueueKick,
      triggerSummary: async () => {
        triggerCalls += 1;
        return { runId: 1, claimed: true };
      },
    });

    const response = await unknownDirectChat(
      new Request("https://example.test/api/trigger", {
        method: "POST",
        headers: { ...bearer("operator-secret"), ...jsonHeaders },
        body: JSON.stringify({
          chatId: 424242,
          windowStart: "2026-07-02T00:00:00.000Z",
          windowEnd: "2026-07-02T01:00:00.000Z",
        }),
      }),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: "unknown chat" });
    expect(triggerCalls).toBe(0);
  });

  it("rejects invalid manual trigger windows before DB-backed route work", async () => {
    process.env.OPERATOR_SECRET = "operator-secret";
    let buildCalls = 0;
    let rateLimitCalls = 0;
    let triggerCalls = 0;
    const POST = createTriggerPost({
      buildContainer: () => {
        buildCalls += 1;
        return {
          pool: {
            query: async () => {
              throw new Error("DB work should not run for invalid windows");
            },
          },
        } as never;
      },
      rateLimiter: async () => {
        rateLimitCalls += 1;
        return null;
      },
      kickQueue: noopQueueKick,
      triggerSummary: async () => {
        triggerCalls += 1;
        return { runId: 1, claimed: true };
      },
    });

    for (const body of [
      { chatId: 42, windowStart: "not-a-date", windowEnd: "2026-07-02T01:00:00.000Z" },
      { chatId: 42, windowStart: "2026-07-02T00:00:00.000Z", windowEnd: "2026-13-02T01:00:00.000Z" },
      { chatId: 42, windowStart: "2026-07-02T01:00:00.000Z", windowEnd: "2026-07-02T01:00:00.000Z" },
      { chatId: 42, windowStart: "2026-07-02T02:00:00.000Z", windowEnd: "2026-07-02T01:00:00.000Z" },
    ]) {
      const response = await POST(
        new Request("https://example.test/api/trigger", {
          method: "POST",
          headers: { ...bearer("operator-secret"), ...jsonHeaders },
          body: JSON.stringify(body),
        }),
      );
      expect(response.status).toBe(400);
    }

    expect(buildCalls).toBe(0);
    expect(rateLimitCalls).toBe(0);
    expect(triggerCalls).toBe(0);
  });

  it("rejects non-number manual trigger identifiers before DB-backed route work", async () => {
    process.env.OPERATOR_SECRET = "operator-secret";
    let buildCalls = 0;
    const POST = createTriggerPost({
      buildContainer: () => {
        buildCalls += 1;
        return {
          pool: {
            query: async () => {
              throw new Error("DB work should not run for invalid identifiers");
            },
          },
        } as never;
      },
      rateLimiter: allowAllRateLimiter,
      kickQueue: noopQueueKick,
      triggerSummary: async () => ({ runId: 1, claimed: true }),
    });

    for (const body of [
      { chatId: "42", windowStart: "2026-07-02T00:00:00.000Z", windowEnd: "2026-07-02T01:00:00.000Z" },
      { chatId: 42.5, windowStart: "2026-07-02T00:00:00.000Z", windowEnd: "2026-07-02T01:00:00.000Z" },
      { telegramChatId: "99", windowStart: "2026-07-02T00:00:00.000Z", windowEnd: "2026-07-02T01:00:00.000Z" },
      { chatId: 42, telegramChatId: {}, windowStart: "2026-07-02T00:00:00.000Z", windowEnd: "2026-07-02T01:00:00.000Z" },
    ]) {
      const response = await POST(
        new Request("https://example.test/api/trigger", {
          method: "POST",
          headers: { ...bearer("operator-secret"), ...jsonHeaders },
          body: JSON.stringify(body),
        }),
      );
      expect(response.status).toBe(400);
    }

    expect(buildCalls).toBe(0);
  });

  it("requires cron bearer auth for the scheduled summary route", async () => {
    process.env.CRON_SECRET = "cron-secret";
    let cronTriggerCalls = 0;
    const GET = createCronGet({
      buildContainer: () =>
        ({
          pool: {
            query: async () => ({
              rows: [
                {
                  chat_id: "10",
                  window_start: new Date("2026-07-02T00:00:00.000Z"),
                  window_end: new Date("2026-07-02T01:00:00.000Z"),
                },
                {
                  chat_id: "11",
                  window_start: new Date("2026-07-02T00:00:00.000Z"),
                  window_end: new Date("2026-07-02T01:00:00.000Z"),
                },
              ],
              rowCount: 2,
            }),
          },
        }) as never,
      buildDrainer: noopDrainer as never,
      rateLimiter: allowAllRateLimiter,
      triggerSummary: async () => {
        cronTriggerCalls += 1;
        return { runId: cronTriggerCalls, claimed: cronTriggerCalls === 1 };
      },
    });

    expect(await GET(new Request("https://example.test/api/cron/summary"))).toHaveProperty("status", 401);
    expect(
      await GET(new Request("https://example.test/api/cron/summary", { headers: bearer("wrong") })),
    ).toHaveProperty("status", 401);

    const accepted = await GET(
      new Request("https://example.test/api/cron/summary", { headers: bearer("cron-secret") }),
    );

    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toMatchObject({ ok: true, triggered: 1 });
    expect(cronTriggerCalls).toBe(2);

    const POST = createCronPost({
      buildContainer: () => ({ pool: { query: async () => ({ rows: [], rowCount: 0 }) } }) as never,
      buildDrainer: noopDrainer as never,
      rateLimiter: allowAllRateLimiter,
      triggerSummary: async () => ({ runId: 1, claimed: true }),
    });
    const posted = await POST(new Request("https://example.test/api/cron/summary", { headers: bearer("cron-secret") }));
    expect(posted.status).toBe(200);
  });

  it("protects the queue drain route with cron bearer auth and runs the drainer", async () => {
    process.env.CRON_SECRET = "cron-secret";
    let drainCalls = 0;
    const POST = createQueueDrainPost({
      buildContainer: () => ({ pool: {} }) as never,
      buildDrainer: (() => ({
        drain: async () => {
          drainCalls += 1;
          return { claimed: 1, executed: 1, failed: 0, deadLettered: 0 };
        },
      })) as never,
    });

    expect(await POST(new Request("https://example.test/api/queue/drain", { method: "POST" }))).toHaveProperty(
      "status",
      401,
    );

    const accepted = await POST(
      new Request("https://example.test/api/queue/drain", {
        method: "POST",
        headers: bearer("cron-secret"),
      }),
    );

    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toMatchObject({ ok: true, claimed: 1, executed: 1 });
    expect(drainCalls).toBe(1);
  });

  it("kicks the queue after a newly enqueued manual trigger but not after a duplicate", async () => {
    process.env.OPERATOR_SECRET = "operator-secret";
    let kickCalls = 0;
    const POST = createTriggerPost({
      buildContainer: () => ({ pool: { query: async () => ({ rows: [{ id: "1" }], rowCount: 1 }) } }) as never,
      rateLimiter: allowAllRateLimiter,
      kickQueue: () => {
        kickCalls += 1;
      },
      triggerSummary: async (_container, args) => ({ runId: args.chatId, claimed: args.chatId === 42 }),
    });
    const body = (chatId: number) =>
      JSON.stringify({
        chatId,
        windowStart: "2026-07-02T00:00:00.000Z",
        windowEnd: "2026-07-02T01:00:00.000Z",
      });

    await POST(
      new Request("https://example.test/api/trigger", {
        method: "POST",
        headers: { ...bearer("operator-secret"), ...jsonHeaders },
        body: body(42),
      }),
    );
    await POST(
      new Request("https://example.test/api/trigger", {
        method: "POST",
        headers: { ...bearer("operator-secret"), ...jsonHeaders },
        body: body(43),
      }),
    );

    expect(kickCalls).toBe(1);
  });

  it("self-invokes the protected drain route when CRON_SECRET is configured", async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; auth: string | null }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        auth: new Headers(init?.headers).get("authorization"),
      });
      return new Response(null, { status: 202 });
    }) as typeof fetch;

    try {
      kickQueueDrain(new Request("https://example.test/api/trigger"));
      expect(calls).toHaveLength(0);

      process.env.CRON_SECRET = "cron-secret";
      kickQueueDrain(new Request("https://example.test/api/trigger"));
      await Promise.resolve();

      expect(calls).toEqual([{ url: "https://example.test/api/queue/drain", auth: "Bearer cron-secret" }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps the test outbox route gated by E2E_TEST_ROUTES, operator auth, and production", async () => {
    process.env.OPERATOR_SECRET = "operator-secret";
    const GET = createOutboxGet({
      buildContainer: () =>
        ({
          pool: {
            query: async () => ({
              rows: [{ id: "1", method: "sendMessage", chat_id: "42", payload: { text: "summary" } }],
              rowCount: 1,
            }),
          },
        }) as never,
    });

    expect(
      await GET(new Request("https://example.test/api/test/outbox", { headers: bearer("operator-secret") })),
    ).toHaveProperty("status", 404);

    process.env.E2E_TEST_ROUTES = "1";
    expect(await GET(new Request("https://example.test/api/test/outbox"))).toHaveProperty("status", 401);

    const accepted = await GET(
      new Request("https://example.test/api/test/outbox?chatId=42", { headers: bearer("operator-secret") }),
    );
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toMatchObject({ outbox: [{ method: "sendMessage" }] });

    process.env.VERCEL_ENV = "production";
    expect(
      await GET(new Request("https://example.test/api/test/outbox", { headers: bearer("operator-secret") })),
    ).toHaveProperty("status", 404);
  });

  it("serves the test outbox in Vercel Preview even though Next builds run with NODE_ENV=production", async () => {
    process.env.OPERATOR_SECRET = "operator-secret";
    process.env.E2E_TEST_ROUTES = "1";
    process.env.VERCEL_ENV = "preview";
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    const GET = createOutboxGet({
      buildContainer: () => ({ pool: { query: async () => ({ rows: [], rowCount: 0 }) } }) as never,
    });

    try {
      const preview = await GET(
        new Request("https://example.test/api/test/outbox", { headers: bearer("operator-secret") }),
      );
      expect(preview.status).toBe(200);

      delete process.env.VERCEL_ENV;
      const bareProduction = await GET(
        new Request("https://example.test/api/test/outbox", { headers: bearer("operator-secret") }),
      );
      expect(bareProduction.status).toBe(404);
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it("rejects missing and wrong cron bearer tokens on the POST handler", async () => {
    process.env.CRON_SECRET = "cron-secret";
    const POST = createCronPost({
      buildContainer: () => ({ pool: { query: async () => ({ rows: [], rowCount: 0 }) } }) as never,
      buildDrainer: noopDrainer as never,
      rateLimiter: allowAllRateLimiter,
      triggerSummary: async () => ({ runId: 1, claimed: true }),
    });

    expect(
      await POST(new Request("https://example.test/api/cron/summary", { method: "POST" })),
    ).toHaveProperty("status", 401);
    expect(
      await POST(new Request("https://example.test/api/cron/summary", { method: "POST", headers: bearer("wrong") })),
    ).toHaveProperty("status", 401);
  });

  it("covers direct auth helper edge cases", async () => {
    expect(tokensEqual(undefined, "secret")).toBe(false);
    expect(tokensEqual("short", "secret")).toBe(false);
    expect(tokensEqual("secres", "secret")).toBe(false);
    expect(tokensEqual("secret", "secret")).toBe(true);

    const missingSecret = requireBearer(new Request("https://example.test"), "OPERATOR_SECRET");
    expect(missingSecret?.status).toBe(503);

    const missingTelegram = requireTelegramSecret(new Request("https://example.test"));
    expect(missingTelegram?.status).toBe(503);
    expect(unavailableSecret("CRON_SECRET").status).toBe(503);
  });

  it("does not open the database before rejecting unauthenticated public routes", async () => {
    const buildContainer = () => {
      throw new Error("database should not be opened");
    };
    const webhook = createTelegramWebhookPost({ buildContainer: buildContainer as never });
    const trigger = createTriggerPost({ buildContainer: buildContainer as never });
    const cron = createCronPost({ buildContainer: buildContainer as never });

    process.env.TELEGRAM_WEBHOOK_SECRET = "telegram-secret";
    process.env.OPERATOR_SECRET = "operator-secret";
    process.env.CRON_SECRET = "cron-secret";

    await expect(webhook(new Request("https://example.test/api/telegram/webhook", { method: "POST" }))).resolves
      .toHaveProperty("status", 401);
    await expect(trigger(new Request("https://example.test/api/trigger", { method: "POST" }))).resolves.toHaveProperty(
      "status",
      401,
    );
    await expect(cron(new Request("https://example.test/api/cron/summary", { method: "POST" }))).resolves.toHaveProperty(
      "status",
      401,
    );
  });
});
