import { describe, expect, it } from "vitest";
import { createCronPost } from "@/src/routes/cron-summary";
import type { QueryResult, Queryable } from "@/src/db/types";
import { allowAllRateLimiter } from "@/src/rate-limit";

const windowStart = new Date("2026-07-02T00:00:00.000Z");
const windowEnd = new Date("2026-07-02T01:00:00.000Z");

function chatRows(rows: Array<{ chat_id: string; window_start: Date; window_end: Date }>): Queryable & {
  cursorUpdates: Array<readonly unknown[] | undefined>;
} {
  const pool = {
    cursorUpdates: [] as Array<readonly unknown[] | undefined>,
    async query<T = unknown>(text: string, params?: readonly unknown[]): Promise<QueryResult<T>> {
      if (text.includes("FROM chat_config")) {
        return { rows: rows as T[], rowCount: rows.length };
      }
      if (text.includes("SET sched_cursor")) {
        pool.cursorUpdates.push(params);
      }
      return { rows: [], rowCount: 1 };
    },
  };
  return pool;
}

function cronRequest(): Request {
  return new Request("https://example.test/api/cron/summary", {
    method: "POST",
    headers: { authorization: "Bearer cron-secret" },
  });
}

const noopDrainer = () => ({
  drain: async () => ({ claimed: 0, executed: 0, failed: 0, deadLettered: 0 }),
});

describe("cron runner windowing", () => {
  it("keeps triggering later chats and reports a failure when one chat's execution throws", async () => {
    process.env.CRON_SECRET = "cron-secret";
    const pool = chatRows([
      { chat_id: "10", window_start: windowStart, window_end: windowEnd },
      { chat_id: "11", window_start: windowStart, window_end: windowEnd },
    ]);
    const POST = createCronPost({
      buildContainer: () => ({ pool }) as never,
      buildDrainer: noopDrainer as never,
      rateLimiter: allowAllRateLimiter,
      triggerSummary: async (_container, args) => {
        if (args.chatId === 10) {
          throw new Error("executor blew up");
        }
        return { runId: 5, claimed: true };
      },
    });

    const response = await POST(cronRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, triggered: 1, failed: 1 });
    expect(pool.cursorUpdates).toHaveLength(1);
    expect(pool.cursorUpdates[0]?.[0]).toBe("11");
  });

  it("skips chats whose cursor has already reached the window end", async () => {
    process.env.CRON_SECRET = "cron-secret";
    const pool = chatRows([{ chat_id: "10", window_start: windowEnd, window_end: windowEnd }]);
    let calls = 0;
    const POST = createCronPost({
      buildContainer: () => ({ pool }) as never,
      buildDrainer: noopDrainer as never,
      rateLimiter: allowAllRateLimiter,
      triggerSummary: async () => {
        calls += 1;
        return { runId: 1, claimed: true };
      },
    });

    const response = await POST(cronRequest());

    await expect(response.json()).resolves.toMatchObject({ ok: true, triggered: 0, failed: 0 });
    expect(calls).toBe(0);
    expect(pool.cursorUpdates).toHaveLength(0);
  });

  it("advances the durable cursor only for claims it won", async () => {
    process.env.CRON_SECRET = "cron-secret";
    const pool = chatRows([
      { chat_id: "10", window_start: windowStart, window_end: windowEnd },
      { chat_id: "11", window_start: windowStart, window_end: windowEnd },
    ]);
    const POST = createCronPost({
      buildContainer: () => ({ pool }) as never,
      buildDrainer: noopDrainer as never,
      rateLimiter: allowAllRateLimiter,
      triggerSummary: async (_container, args) => ({ runId: args.chatId, claimed: args.chatId === 10 }),
    });

    const response = await POST(cronRequest());

    await expect(response.json()).resolves.toMatchObject({ ok: true, triggered: 1, failed: 0 });
    expect(pool.cursorUpdates).toHaveLength(1);
    expect(pool.cursorUpdates[0]?.[0]).toBe("10");
    expect(pool.cursorUpdates[0]?.[1]).toEqual(windowEnd);
  });
});
