import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildContainer } from "@/src/container";
import { migrate } from "@/src/db/migrate";
import { PostgresRunClaimer } from "@/src/db/run-store";
import { ingestUpdate } from "@/src/ingest";
import { buildQueueDrainer } from "@/src/queue-drainer";
import { triggerSummary, type ClaimRunArgs } from "@/src/pipeline";
import { FixtureSummarizerPort, type SummarizerPort } from "@/src/summary";
import { createTriggerPost } from "@/src/routes/trigger";
import { noopQueueKick } from "@/src/routes/queue-kick";

const databaseUrl = process.env.TEST_DATABASE_URL;
const fixtureSummarizer = new FixtureSummarizerPort();

function delayedCountingSummarizer(counter: { count: number }, delayMs = 30): SummarizerPort {
  return {
    async summarize(input) {
      counter.count += 1;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return fixtureSummarizer.summarize(input);
    },
  };
}

describe.skipIf(!databaseUrl)("live postgres stack", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("applies migrations idempotently: a second run is a no-op and the schema stays intact", async () => {
    await migrate(pool);

    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    const names = tables.rows.map((row) => row.table_name);
    expect(names).toEqual(
      expect.arrayContaining([
        "chat",
        "chat_config",
        "message",
        "run",
        "run_chunk",
        "telegram_outbox",
        "rate_limit_counter",
      ]),
    );
  });

  it("lets exactly one concurrent claim win for a chat window", async () => {
    const chat = await pool.query<{ id: string }>(
      `INSERT INTO chat (telegram_chat_id, title) VALUES (990001, 'claim race chat') RETURNING id`,
    );
    const chatId = Number(chat.rows[0].id);
    const claimer = new PostgresRunClaimer(pool);
    const args: ClaimRunArgs = {
      chatId,
      windowStart: new Date("2026-07-02T00:00:00.000Z"),
      windowEnd: new Date("2026-07-02T01:00:00.000Z"),
      trigger: "manual",
    };

    const results = await Promise.all(Array.from({ length: 8 }, () => claimer.claimRun(args)));

    expect(results.filter((result) => result.claimed)).toHaveLength(1);
    expect(new Set(results.map((result) => result.runId)).size).toBe(1);
  });

  it("rejects message.assigned_run_id values that do not reference a run", async () => {
    const chat = await pool.query<{ id: string }>(
      `INSERT INTO chat (telegram_chat_id, title) VALUES (990002, 'fk chat') RETURNING id`,
    );

    await expect(
      pool.query(
        `INSERT INTO message (chat_id, telegram_message_id, text, sent_at, assigned_run_id)
         VALUES ($1, 1, 'orphan', now(), 999999)`,
        [Number(chat.rows[0].id)],
      ),
    ).rejects.toThrow(/violates foreign key constraint/);
  });

  it("concurrent drainers never double-execute a run because claims use SKIP LOCKED", async () => {
    const telegramChatId = 990003;
    const summaryCalls = { count: 0 };
    const container = buildContainer({ pool, summarizer: delayedCountingSummarizer(summaryCalls) });

    for (let index = 0; index < 3; index += 1) {
      await ingestUpdate(pool, {
        update_id: 100 + index,
        message: {
          message_id: index + 1,
          date: Math.floor(new Date("2026-07-02T02:10:00.000Z").getTime() / 1000) + index,
          text: `skip locked message ${index + 1}`,
          from: { username: `user${index + 1}` },
          chat: { id: telegramChatId, title: "skip locked chat" },
        },
      });
    }
    const chat = await pool.query<{ id: string }>(`SELECT id FROM chat WHERE telegram_chat_id = $1`, [telegramChatId]);
    const chatId = Number(chat.rows[0].id);
    const claimer = new PostgresRunClaimer(pool);
    await claimer.claimRun({
      chatId,
      windowStart: new Date("2026-07-02T02:00:00.000Z"),
      windowEnd: new Date("2026-07-02T03:00:00.000Z"),
      trigger: "manual",
    });

    const [first, second] = await Promise.all([
      buildQueueDrainer(container).drain({ limit: 1 }),
      buildQueueDrainer(container).drain({ limit: 1 }),
    ]);

    expect(first.claimed + second.claimed).toBe(1);
    expect(first.executed + second.executed).toBe(1);
    expect(summaryCalls.count).toBe(1);

    const outbox = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM telegram_outbox WHERE chat_id = $1`,
      [chatId],
    );
    expect(Number(outbox.rows[0].count)).toBe(1);
  });

  it("reclaims and posts a run whose lease expired during a killed invocation", async () => {
    const telegramChatId = 990004;
    const container = buildContainer({ pool });

    await ingestUpdate(pool, {
      update_id: 200,
      message: {
        message_id: 1,
        date: Math.floor(new Date("2026-07-02T03:10:00.000Z").getTime() / 1000),
        text: "lease reclaim message",
        from: { username: "lease-user" },
        chat: { id: telegramChatId, title: "lease reclaim chat" },
      },
    });
    const chat = await pool.query<{ id: string }>(`SELECT id FROM chat WHERE telegram_chat_id = $1`, [telegramChatId]);
    const chatId = Number(chat.rows[0].id);
    const run = await pool.query<{ id: string }>(
      `INSERT INTO run (chat_id, window_start, window_end, status, trigger, lease_owner, lease_expires_at)
       VALUES ($1, $2, $3, 'running', 'manual', '00000000-0000-4000-8000-000000000111', now() - interval '1 minute')
       RETURNING id`,
      [chatId, new Date("2026-07-02T03:00:00.000Z"), new Date("2026-07-02T04:00:00.000Z")],
    );

    const result = await buildQueueDrainer(container).drain({ limit: 1 });

    expect(result).toMatchObject({ claimed: 1, executed: 1, failed: 0 });
    const posted = await pool.query<{ status: string; lease_owner: string | null }>(
      `SELECT status, lease_owner FROM run WHERE id = $1`,
      [Number(run.rows[0].id)],
    );
    expect(posted.rows[0]).toMatchObject({ status: "posted", lease_owner: null });
  });

  it("sends exactly one summary to the outbox under concurrent trigger and drain", async () => {
    const telegramChatId = 990005;
    const container = buildContainer({ pool });

    for (let index = 0; index < 3; index += 1) {
      await ingestUpdate(pool, {
        update_id: index + 1,
        message: {
          message_id: index + 1,
          date: Math.floor(new Date("2026-07-02T02:10:00.000Z").getTime() / 1000) + index,
          text: `message ${index + 1}`,
          from: { username: `user${index + 1}` },
          chat: { id: telegramChatId, title: "outbox race chat" },
        },
      });
    }
    const chat = await pool.query<{ id: string }>(`SELECT id FROM chat WHERE telegram_chat_id = $1`, [telegramChatId]);
    const chatId = Number(chat.rows[0].id);
    const args: ClaimRunArgs = {
      chatId,
      windowStart: new Date("2026-07-02T02:00:00.000Z"),
      windowEnd: new Date("2026-07-02T03:00:00.000Z"),
      trigger: "manual",
    };

    const [first, second] = await Promise.all([
      triggerSummary(container, args),
      triggerSummary(container, args),
      buildQueueDrainer(container).drain({ limit: 1 }),
      buildQueueDrainer(container).drain({ limit: 1 }),
    ]);
    await buildQueueDrainer(container).drain({ limit: 1 });

    expect([first.claimed, second.claimed].sort()).toEqual([false, true]);
    expect(first.runId).toBe(second.runId);

    const outbox = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM telegram_outbox WHERE chat_id = $1`,
      [chatId],
    );
    expect(Number(outbox.rows[0].count)).toBe(1);

    const run = await pool.query<{ status: string; input_message_count: number }>(
      `SELECT status, input_message_count FROM run WHERE id = $1`,
      [first.runId],
    );
    expect(run.rows[0]).toMatchObject({ status: "posted", input_message_count: 3 });
  });

  it("rejects over-limit authenticated manual triggers before route work", async () => {
    process.env.OPERATOR_SECRET = "operator-secret";
    process.env.RATE_LIMIT_TRIGGER_MAX = "2";
    process.env.RATE_LIMIT_WINDOW_SECONDS = "60";
    let triggerCalls = 0;
    const POST = createTriggerPost({
      buildContainer: () => buildContainer({ pool }),
      kickQueue: noopQueueKick,
      triggerSummary: async () => {
        triggerCalls += 1;
        return { runId: triggerCalls, claimed: true };
      },
    });
    const request = () =>
      new Request("https://example.test/api/trigger", {
        method: "POST",
        headers: {
          authorization: "Bearer operator-secret",
          "content-type": "application/json",
          "x-forwarded-for": "203.0.113.77",
        },
        body: JSON.stringify({
          chatId: 1,
          windowStart: "2026-07-02T05:00:00.000Z",
          windowEnd: "2026-07-02T06:00:00.000Z",
        }),
      });

    expect((await POST(request())).status).toBe(200);
    expect((await POST(request())).status).toBe(200);
    const rejected = await POST(request());

    expect(rejected.status).toBe(429);
    expect(triggerCalls).toBe(2);
  });
});
