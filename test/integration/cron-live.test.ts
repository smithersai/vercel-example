import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildContainer } from "@/src/container";
import { migrate } from "@/src/db/migrate";
import { ingestUpdate } from "@/src/ingest";
import { createCronPost } from "@/src/routes/cron-summary";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("scheduled cron against live postgres", () => {
  let pool: Pool;
  let chatId: number;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(pool);

    const telegramChatId = 990010;
    const messageBase = Math.floor(Date.now() / 1000) - 150 * 60;
    for (let index = 0; index < 3; index += 1) {
      await ingestUpdate(pool, {
        update_id: index + 1,
        message: {
          message_id: index + 1,
          date: messageBase + index,
          text: `scheduled message ${index + 1}`,
          from: { username: `user${index + 1}` },
          chat: { id: telegramChatId, title: "cron chat" },
        },
      });
    }
    const chat = await pool.query<{ id: string }>(`SELECT id FROM chat WHERE telegram_chat_id = $1`, [
      telegramChatId,
    ]);
    chatId = Number(chat.rows[0].id);
    await pool.query(
      `INSERT INTO chat_config (chat_id, enabled, sched_cursor) VALUES ($1, true, now() - interval '3 hours')`,
      [chatId],
    );
  });

  afterAll(async () => {
    await pool?.end();
  });

  function cronRequest(): Request {
    return new Request("https://example.test/api/cron/summary", {
      method: "POST",
      headers: { authorization: "Bearer cron-secret" },
    });
  }

  it("sends exactly one summary when scheduler ticks fire concurrently", async () => {
    process.env.CRON_SECRET = "cron-secret";
    const POST = createCronPost({ buildContainer: () => buildContainer({ pool }) });

    const [first, second] = await Promise.all([POST(cronRequest()), POST(cronRequest())]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const outbox = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM telegram_outbox WHERE chat_id = $1`,
      [chatId],
    );
    expect(Number(outbox.rows[0].count)).toBe(1);

    const runs = await pool.query<{ count: string }>(`SELECT count(*) AS count FROM run WHERE chat_id = $1`, [
      chatId,
    ]);
    expect(Number(runs.rows[0].count)).toBe(1);

    const cursor = await pool.query<{ caught_up: boolean }>(
      `SELECT sched_cursor = date_trunc('hour', now()) AS caught_up FROM chat_config WHERE chat_id = $1`,
      [chatId],
    );
    expect(cursor.rows[0].caught_up).toBe(true);
  });

  it("does not resend on a repeat tick after the window is summarized", async () => {
    process.env.CRON_SECRET = "cron-secret";
    const POST = createCronPost({ buildContainer: () => buildContainer({ pool }) });

    const repeat = await POST(cronRequest());
    expect(repeat.status).toBe(200);
    await expect(repeat.json()).resolves.toMatchObject({ ok: true, triggered: 0 });

    const outbox = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM telegram_outbox WHERE chat_id = $1`,
      [chatId],
    );
    expect(Number(outbox.rows[0].count)).toBe(1);
  });
});
