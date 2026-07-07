import { describe, expect, it } from "vitest";
import { buildContainer, SystemClock } from "@/src/container";
import { getPool, closePool } from "@/src/db/pool";
import { PostgresRunClaimer, PostgresRunQueueStore } from "@/src/db/run-store";
import type { QueryResult, Queryable } from "@/src/db/types";
import { ingestUpdate } from "@/src/ingest";
import { executeRun, type ClaimRunArgs } from "@/src/pipeline";
import { QueueDrainer } from "@/src/queue-drainer";
import { defaultRateLimiter, enforcePostgresRateLimit, policyForScope } from "@/src/rate-limit";
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

describe("PostgresRunQueueStore", () => {
  it("claims runnable runs with row locks and a visibility lease", async () => {
    const leaseExpiresAt = new Date("2026-07-02T00:15:00.000Z");
    const pool = new ScriptedPool([
      {
        rows: [
          {
            id: "301",
            attempt_count: 1,
            lease_owner: "00000000-0000-4000-8000-000000000001",
            lease_expires_at: leaseExpiresAt,
          },
        ],
        rowCount: 1,
      },
    ]);

    await expect(
      new PostgresRunQueueStore(pool).claimRunnableRuns({
        limit: 2,
        leaseSeconds: 30,
        maxAttempts: 4,
        leaseOwner: "00000000-0000-4000-8000-000000000001",
      }),
    ).resolves.toEqual([
      {
        runId: 301,
        attemptCount: 1,
        leaseOwner: "00000000-0000-4000-8000-000000000001",
        leaseExpiresAt,
      },
    ]);

    expect(pool.calls[0].text).toContain("FOR UPDATE SKIP LOCKED");
    expect(pool.calls[0].text).toContain("lease_expires_at");
    expect(pool.calls[0].params).toEqual([2, "00000000-0000-4000-8000-000000000001", 30, 4]);
  });

  it("marks failures with backoff and then dead-letters after max attempts", async () => {
    const nextAttemptAt = new Date("2026-07-02T00:01:00.000Z");
    const pool = new ScriptedPool([
      { rows: [{ status: "failed", attempt_count: 2, next_attempt_at: nextAttemptAt }], rowCount: 1 },
      { rows: [{ status: "dead_lettered", attempt_count: 3, next_attempt_at: null }], rowCount: 1 },
    ]);
    const store = new PostgresRunQueueStore(pool);

    await expect(
      store.markRunFailed({
        runId: 301,
        leaseOwner: "00000000-0000-4000-8000-000000000001",
        error: new Error("temporary"),
        maxAttempts: 3,
        backoffBaseSeconds: 10,
        backoffMaxSeconds: 60,
      }),
    ).resolves.toEqual({ status: "failed", attemptCount: 2, nextAttemptAt });
    await expect(
      store.markRunFailed({
        runId: 301,
        leaseOwner: "00000000-0000-4000-8000-000000000001",
        error: "permanent",
        maxAttempts: 3,
      }),
    ).resolves.toEqual({ status: "dead_lettered", attemptCount: 3, nextAttemptAt: null });

    expect(pool.calls[0].text).toContain("next_attempt_at");
    expect(pool.calls[0].text).toContain("'dead_lettered'");
    expect(pool.calls[1].params?.[2]).toBe("permanent");
  });

  it("returns null when a failure mark no longer owns the lease", async () => {
    const pool = new ScriptedPool([{ rows: [], rowCount: 0 }]);

    await expect(
      new PostgresRunQueueStore(pool).markRunFailed({
        runId: 301,
        leaseOwner: "00000000-0000-4000-8000-000000000001",
        error: new Error("lost lease"),
      }),
    ).resolves.toBeNull();
  });
});

describe("QueueDrainer", () => {
  it("claims, executes, and marks retryable and dead-letter failures", async () => {
    const failures: Array<{ runId: number; error: unknown }> = [];
    const drainer = new QueueDrainer({
      createLeaseOwner: () => "00000000-0000-4000-8000-000000000010",
      store: {
        claimRunnableRuns: async ({ leaseOwner }) => [
          {
            runId: 1,
            attemptCount: 0,
            leaseOwner,
            leaseExpiresAt: new Date("2026-07-02T00:15:00.000Z"),
          },
          {
            runId: 2,
            attemptCount: 1,
            leaseOwner,
            leaseExpiresAt: new Date("2026-07-02T00:15:00.000Z"),
          },
          {
            runId: 3,
            attemptCount: 2,
            leaseOwner,
            leaseExpiresAt: new Date("2026-07-02T00:15:00.000Z"),
          },
        ],
        markRunFailed: async ({ runId, error }) => {
          failures.push({ runId, error });
          return { status: runId === 3 ? "dead_lettered" : "failed" };
        },
      },
      executeRun: async (runId) => {
        if (runId !== 1) {
          throw new Error(`run ${runId} failed`);
        }
      },
    });

    await expect(drainer.drain({ limit: 3, maxAttempts: 3 })).resolves.toEqual({
      claimed: 3,
      executed: 1,
      failed: 1,
      deadLettered: 1,
    });
    expect(failures.map((failure) => failure.runId)).toEqual([2, 3]);
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
      { rows: [{ chunk_text: "Summary for 2026-07-02T00:00:00.000Z\n\n- ship\n- verify" }], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 }, // best-effort UPDATE run SET summary_agent
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
    expect(pool.calls).toHaveLength(9); // +1: best-effort summary_agent UPDATE, separate from run completion
  });

  it("still completes the run when summary_agent column is missing (deploy-before-migrate)", async () => {
    // The run is marked 'posted' BEFORE the best-effort summary_agent write, and a
    // Postgres undefined_column (42703) on that write is swallowed -- so deploying
    // the code before migration 003 does not wedge the run in 'running' (which
    // would make every drainer retry re-summarize, a paid model call).
    const undefinedColumn = Object.assign(new Error('column "summary_agent" of relation "run" does not exist'), {
      code: "42703",
    });
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
        rows: [{ from_user: "alice", text: "ship", sent_at: new Date("2026-07-02T00:10:00.000Z") }],
        rowCount: 1,
      },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [{ chunk_text: "Summary\n\n- ship" }], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 }, // UPDATE run status='posted' (run completes here)
      undefinedColumn, // best-effort UPDATE run SET summary_agent -> 42703, must be swallowed
    ]);
    const sentTexts: string[] = [];

    await expect(
      executeRun(
        {
          pool,
          telegram: {
            async sendMessage({ text }) {
              sentTexts.push(text);
              return { messageId: 444 };
            },
          },
          summarizer: new FixtureSummarizerPort(),
        },
        902,
      ),
    ).resolves.toBeUndefined();

    // The Telegram message was delivered and the run reached the completion UPDATE
    // before the swallowed 42703 -- exactly one summary_agent write was attempted.
    expect(sentTexts[0]).toContain("- ship");
    expect(pool.calls).toHaveLength(9);
    expect(pool.calls[8].text).toContain("summary_agent");
  });

  it("rethrows when execution blows up mid-run so the drainer can mark retry state", async () => {
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
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
    ]);

    await expect(
      executeRun(
        {
          pool,
          telegram: { sendMessage: async () => ({ messageId: 1 }) },
          summarizer: {
            summarize: async () => {
              throw new Error("summarizer unavailable");
            },
          },
        },
        902,
      ),
    ).rejects.toThrow("summarizer unavailable");
    expect(pool.calls).toHaveLength(4);
  });

  it("includes messages already assigned to the same run when retrying after a failed attempt", async () => {
    const calls: Array<{ text: string; params?: readonly unknown[] }> = [];
    let insertedSummary = "";
    const sentTexts: string[] = [];
    const pool: Queryable = {
      async query<T = unknown>(text: string, params?: readonly unknown[]): Promise<QueryResult<T>> {
        calls.push({ text, params });
        if (text.includes("SELECT chat_id, window_start, window_end, status FROM run")) {
          return {
            rows: [
              {
                chat_id: "42",
                window_start: new Date("2026-07-02T00:00:00.000Z"),
                window_end: new Date("2026-07-02T01:00:00.000Z"),
                status: "failed",
              } as T,
            ],
            rowCount: 1,
          };
        }
        if (text.includes("UPDATE run SET status = 'running'")) {
          return { rows: [], rowCount: 1 };
        }
        if (text.includes("SELECT from_user, text, sent_at")) {
          const includesSameRunMessages = text.includes("assigned_run_id = $4") && params?.[3] === 904;
          return {
            rows: includesSameRunMessages
              ? ([
                  { from_user: "alice", text: "retry survives", sent_at: new Date("2026-07-02T00:10:00.000Z") },
                  { from_user: "bob", text: "new message", sent_at: new Date("2026-07-02T00:11:00.000Z") },
                ] as T[])
              : [],
            rowCount: includesSameRunMessages ? 2 : 0,
          };
        }
        if (text.includes("UPDATE message SET assigned_run_id")) {
          return { rows: [], rowCount: 1 };
        }
        if (text.includes("INSERT INTO run_chunk")) {
          insertedSummary = String(params?.[1]);
          return { rows: [], rowCount: 1 };
        }
        if (text.includes("UPDATE run_chunk") && text.includes("RETURNING chunk_text")) {
          return { rows: [{ chunk_text: insertedSummary } as T], rowCount: 1 };
        }
        if (text.includes("UPDATE run_chunk SET state = 'sent'")) {
          return { rows: [], rowCount: 1 };
        }
        if (text.includes("UPDATE run") && text.includes("summary_text")) {
          return { rows: [], rowCount: 1 };
        }
        if (text.includes("UPDATE run SET summary_agent")) {
          return { rows: [], rowCount: 1 };
        }
        throw new Error(`unexpected query: ${text}`);
      },
    };

    await executeRun(
      {
        pool,
        telegram: {
          async sendMessage({ text }) {
            sentTexts.push(text);
            return { messageId: 904 };
          },
        },
        summarizer: new FixtureSummarizerPort(),
      },
      904,
    );

    const messageSelect = calls.find((call) => call.text.includes("SELECT from_user, text, sent_at"));
    expect(messageSelect?.text).toContain("assigned_run_id IS NULL");
    expect(messageSelect?.text).toContain("assigned_run_id = $4");
    expect(messageSelect?.params).toEqual([
      42,
      new Date("2026-07-02T00:00:00.000Z"),
      new Date("2026-07-02T01:00:00.000Z"),
      904,
    ]);
    expect(sentTexts[0]).toContain("- retry survives");
    expect(sentTexts[0]).toContain("- new message");
  });

  it("returns without sending if another executor already reserved the run chunk", async () => {
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
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 0 },
    ]);
    let sends = 0;

    await executeRun(
      {
        pool,
        telegram: {
          sendMessage: async () => {
            sends += 1;
            return { messageId: 1 };
          },
        },
        summarizer: new FixtureSummarizerPort(),
      },
      903,
    );

    expect(sends).toBe(0);
  });
});

describe("rate limiting", () => {
  it("increments a fixed Postgres window and returns 429 over the limit", async () => {
    const resetAt = new Date(Date.now() + 60_000);
    const pool = new ScriptedPool([
      { rows: [{ count: 1, reset_at: resetAt }], rowCount: 1 },
      { rows: [{ count: 2, reset_at: resetAt }], rowCount: 1 },
    ]);
    const request = new Request("https://example.test/api/trigger", {
      headers: { "x-forwarded-for": "203.0.113.10, 198.51.100.1" },
    });
    const policy = { scope: "operator:trigger" as const, limit: 1, windowSeconds: 60 };

    await expect(enforcePostgresRateLimit(pool, request, policy)).resolves.toBeNull();
    const rejected = await enforcePostgresRateLimit(pool, request, policy);

    expect(rejected?.status).toBe(429);
    expect(rejected?.headers.get("x-ratelimit-limit")).toBe("1");
    expect(pool.calls[0].params).toEqual(["operator:trigger", "203.0.113.10", 60]);
  });

  it("falls back to documented defaults for invalid rate-limit env values", () => {
    process.env.RATE_LIMIT_WINDOW_SECONDS = "nope";
    process.env.RATE_LIMIT_TRIGGER_MAX = "-1";

    expect(policyForScope("operator:trigger")).toEqual({
      scope: "operator:trigger",
      limit: 20,
      windowSeconds: 60,
    });
  });

  it("uses the default route limiter policy for a scope", async () => {
    const pool = new ScriptedPool([{ rows: [{ count: 1, reset_at: new Date(Date.now() + 60_000) }], rowCount: 1 }]);

    await expect(
      defaultRateLimiter({
        pool,
        request: new Request("https://example.test/api/cron/summary"),
        scope: "cron:summary",
      }),
    ).resolves.toBeNull();
    expect(pool.calls[0].params?.[0]).toBe("cron:summary");
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

  it("wires a default no-op invoker because execution is owned by the queue drainer", async () => {
    const pool = new ScriptedPool([{ rows: [], rowCount: 0 }]);
    const container = buildContainer({
      pool,
      runClaimer: { claimRun: async () => ({ runId: 1, claimed: true }) },
      telegram: { sendMessage: async () => ({ messageId: 1 }) },
      summarizer: new FixtureSummarizerPort(),
      clock: { now: () => new Date("2026-07-02T00:00:00.000Z") },
    });

    await expect(container.invoker.invokeExecutor(1)).resolves.toBeUndefined();
    expect(pool.calls).toHaveLength(0);
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
