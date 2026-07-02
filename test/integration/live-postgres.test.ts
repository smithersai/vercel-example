import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildContainer } from "@/src/container";
import { migrate } from "@/src/db/migrate";
import { PostgresRunClaimer } from "@/src/db/run-store";
import { ingestUpdate } from "@/src/ingest";
import { triggerSummary, type ClaimRunArgs } from "@/src/pipeline";

const databaseUrl = process.env.TEST_DATABASE_URL;

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
      expect.arrayContaining(["chat", "chat_config", "message", "run", "run_chunk", "telegram_outbox"]),
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

  it("sends exactly one summary to the outbox when the same window is triggered concurrently", async () => {
    const telegramChatId = 990003;
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

    const [first, second] = await Promise.all([triggerSummary(container, args), triggerSummary(container, args)]);

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
});
