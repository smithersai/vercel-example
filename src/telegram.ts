import type { Queryable } from "./db/types";

export interface TelegramPort {
  sendMessage(args: { chatId: number; text: string }): Promise<{ messageId: number }>;
}

export class FakeTelegramPort implements TelegramPort {
  constructor(private readonly pool: Queryable) {}

  async sendMessage({ chatId, text }: { chatId: number; text: string }): Promise<{ messageId: number }> {
    const result = await this.pool.query<{ message_id: string }>(
      `INSERT INTO telegram_outbox (method, chat_id, payload, message_id)
       VALUES ('sendMessage', $1, $2, nextval('telegram_outbox_id_seq'))
       RETURNING message_id`,
      [chatId, JSON.stringify({ chat_id: chatId, text })],
    );

    return { messageId: Number(result.rows[0].message_id) };
  }
}
