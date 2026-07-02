import { describe, expect, it } from "vitest";
import { buildContainer, SystemClock } from "@/src/container";
import { getPool, closePool } from "@/src/db/pool";
import { PostgresRunClaimer } from "@/src/db/run-store";
import type { QueryResult, Queryable } from "@/src/db/types";
import { ingestUpdate } from "@/src/ingest";
import { executeRun, type ClaimRunArgs } from "@/src/pipeline";
import { renderSummary } from "@/src/render";
import { FixtureSummarizerPort } from "@/src/summary";
import { FakeTelegramPort } from "@/src/telegram";

class ScriptedPool implements Queryable {
  readonly calls: Array<{ text: string; params?: readonly unknown[] }> = [];

  constructor(private readonly responses: Array<QueryResult | Error>) {}

  async query<T = unknown>(text: string, params?: readonly unknown[]): Promise<QueryResult<T>> {
    this.calls.push({ text, params });
    const next = this.responses.shift();
    if (!next) {
      throw new Error(`unexpected query: ${text}`);
    }
    if (next instanceof Error) {
      throw next;
    }
    return next as QueryResult<T>;
  }
}

const claimArgs: ClaimRunArgs = {
  chatId: 42,
  windowStart: new Date("2026-07-02T00:00:00.000Z"),
  windowEnd: new Date("2026-07-02T01:00:00.000Z"),
  trigger: "manual",
};

describe("PostgresRunClaimer", () => {
  it("returns claimed when insert wins the natural-key race", async () => {
    const pool = new ScriptedPool([{ rows: [{ id: "101" }], rowCount: 1 }]);
    await expect(new PostgresRunClaimer(pool).claimRun(claimArgs)).resolves.toEqual({ runId: 101, claimed: true });
    expect(pool.calls).toHaveLength(1);
  });

  it("returns the existing run id when insert loses the natural-key race", async () => {
    const pool = new ScriptedPool([
      { rows: [], rowCount: 0 },
      { rows: [{ id: "102" }], rowCount: 1 },
    ]);
    await expect(new PostgresRunClaimer(pool).claimRun(claimArgs)).resolves.toEqual({ runId: 102, claimed: false });
    expect(pool.calls).toHaveLength(2);
  });

  it("fails closed if a conflict cannot be resolved to an existing run", async () => {
    const pool = new ScriptedPool([
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
    ]);
    let error: unknown;
    try {
      await new PostgresRunClaimer(pool).claimRun(claimArgs);
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toContain("run claim conflict");
  });
});

describe("ingestUpdate", () => {
  it("requires message updates", async () => {
    let error: unknown;
    try {
      await ingestUpdate(new ScriptedPool([]), { update_id: 1 });
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toContain("update has no message");
  });

  it("upserts chat and deduplicates messages through Postgres", async () => {
    const pool = new ScriptedPool([
      { rows: [{ id: "12" }], rowCount: 1 },
      { rows: [], rowCount: 1 },
    ]);

    await expect(
      ingestUpdate(pool, {
        update_id: 1,
        message: {
          message_id: 99,
          date: 1_751_328_100,
          text: "hello",
          from: { first_name: "Alice", is_bot: false },
          chat: { id: 123, title: "Launch" },
        },
      }),
    ).resolves.toEqual({ chatId: 12, inserted: true });

    expect(pool.calls[1].params).toContain("Alice");

    const fallbackPool = new ScriptedPool([
      { rows: [{ id: "13" }], rowCount: 1 },
      { rows: [], rowCount: null },
    ]);
    await expect(
      ingestUpdate(fallbackPool, {
        message: {
          message_id: 100,
          date: 1_751_328_101,
          chat: { id: 124 },
        },
      }),
    ).resolves.toEqual({ chatId: 13, inserted: false });
    expect(fallbackPool.calls[0].params).toEqual([124, null]);
    expect(fallbackPool.calls[1].params?.[2]).toBeNull();
    expect(fallbackPool.calls[1].params?.[3]).toBeNull();
    expect(fallbackPool.calls[1].params?.[5]).toBe(false);
  });
});

describe("summary rendering and adapters", () => {
  it("summarizes, validates, and renders grounded message content", async () => {
    const summary = await new FixtureSummarizerPort().summarize({
      windowStart: new Date("2026-07-02T00:00:00.000Z"),
      windowEnd: new Date("2026-07-02T01:00:00.000Z"),
      messages: [
        { fromUser: "alice", text: "one", sentAt: new Date("2026-07-02T00:05:00.000Z") },
        { fromUser: "alice", text: "two", sentAt: new Date("2026-07-02T00:06:00.000Z") },
        { fromUser: null, text: null, sentAt: new Date("2026-07-02T00:07:00.000Z") },
      ],
    });

    const rendered = renderSummary(summary);
    expect(summary.topics[0].participants).toEqual(["alice"]);
    expect(rendered).toContain("Summary for 2026-07-02T00:00:00.000Z");
    expect(rendered).toContain("- one");
    expect(rendered).toContain("- two");

    expect(
      renderSummary({
        window: { start: "2026-07-02T00:00:00.000Z", end: "2026-07-02T01:00:00.000Z" },
        topics: [{ title: "Empty", points: [], participants: [] }],
      }),
    ).not.toContain("participants:");
  });

  it("records fake Telegram sends in the Postgres outbox", async () => {
    const pool = new ScriptedPool([{ rows: [{ message_id: "778" }], rowCount: 1 }]);
    await expect(new FakeTelegramPort(pool).sendMessage({ chatId: 42, text: "summary" })).resolves.toEqual({
      messageId: 778,
    });
    expect(pool.calls[0].params).toEqual([42, JSON.stringify({ chat_id: 42, text: "summary" })]);
  });
});

describe("executeRun", () => {
  it("throws when the run row is missing", async () => {
    let error: unknown;
    try {
      await executeRun(
        {
          pool: new ScriptedPool([{ rows: [], rowCount: 0 }]),
          telegram: { sendMessage: async () => ({ messageId: 1 }) },
          summarizer: new FixtureSummarizerPort(),
        },
        1,
      );
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toContain("run 1 not found");
  });

  it("does nothing for already posted runs", async () => {
    const pool = new ScriptedPool([
      {
        rows: [
          {
            chat_id: "42",
            window_start: new Date("2026-07-02T00:00:00.000Z"),
            window_end: new Date("2026-07-02T01:00:00.000Z"),
            status: "posted",
          },
        ],
        rowCount: 1,
      },
    ]);

    await executeRun(
      {
        pool,
        telegram: { sendMessage: async () => ({ messageId: 1 }) },
        summarizer: new FixtureSummarizerPort(),
      },
      1,
    );

    expect(pool.calls).toHaveLength(1);
  });

  it("executes a claimed pending run through summary persistence and delivery", async () => {
    const pool = new ScriptedPool([
      {
        rows: [
          {
            chat_id: "42",
            window_start: new Date("2026-07-02T00:00:00.000Z"),
            window_end: new Date("2026-07-02T01:00:00.000Z"),
            status: "pending",
          },
        ],
        rowCount: 1,
      },
      { rows: [], rowCount: 1 },
      {
        rows: [
          { from_user: "alice", text: "ship", sent_at: new Date("2026-07-02T00:10:00.000Z") },
          { from_user: "bob", text: "verify", sent_at: new Date("2026-07-02T00:11:00.000Z") },
        ],
        rowCount: 2,
      },
      { rows: [], rowCount: 2 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
    ]);
    const sentTexts: string[] = [];

    await executeRun(
      {
        pool,
        telegram: {
          async sendMessage({ text }) {
            sentTexts.push(text);
            return { messageId: 333 };
          },
        },
        summarizer: new FixtureSummarizerPort(),
      },
      901,
    );

    expect(sentTexts[0]).toContain("- ship");
    expect(sentTexts[0]).toContain("- verify");
    expect(pool.calls).toHaveLength(7);
  });
});

describe("container and pool wiring", () => {
  it("uses supplied overrides without opening a default database connection", () => {
    const overrides = {
      pool: new ScriptedPool([]),
      runClaimer: { claimRun: async () => ({ runId: 1, claimed: true }) },
      invoker: { invokeExecutor: async () => undefined },
      telegram: { sendMessage: async () => ({ messageId: 1 }) },
      summarizer: new FixtureSummarizerPort(),
      clock: { now: () => new Date("2026-07-02T00:00:00.000Z") },
    };

    const container = buildContainer(overrides);

    expect(container.pool).toBe(overrides.pool);
    expect(container.clock.now().toISOString()).toBe("2026-07-02T00:00:00.000Z");
    expect(new SystemClock().now()).toBeInstanceOf(Date);
  });

  it("wires a default inline invoker when no invoker override is supplied", async () => {
    const pool = new ScriptedPool([{ rows: [], rowCount: 0 }]);
    const container = buildContainer({
      pool,
      runClaimer: { claimRun: async () => ({ runId: 1, claimed: true }) },
      telegram: { sendMessage: async () => ({ messageId: 1 }) },
      summarizer: new FixtureSummarizerPort(),
      clock: { now: () => new Date("2026-07-02T00:00:00.000Z") },
    });

    let error: unknown;
    try {
      await container.invoker.invokeExecutor(1);
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toContain("run 1 not found");
  });

  it("fails fast when DATABASE_URL is missing, and can close an unopened pg pool", async () => {
    delete process.env.DATABASE_URL;
    expect(() => getPool()).toThrow("DATABASE_URL is not set");

    process.env.DATABASE_URL = "postgres://smithers:smithers@localhost:5432/vercel_example";
    const pool = getPool();
    expect(getPool()).toBe(pool);
    expect(pool).toBeTruthy();
    await closePool();
    await closePool();
    delete process.env.DATABASE_URL;
  });
});
