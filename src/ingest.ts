import type { Queryable } from "./db/types";

export interface TelegramUpdate {
  update_id?: number;
  message?: {
    message_id: number;
    date: number;
    text?: string;
    from?: { is_bot?: boolean; username?: string; first_name?: string };
    chat: { id: number; title?: string };
  };
}

export interface IngestResult {
  chatId: number;
  inserted: boolean;
}

export async function ingestUpdate(pool: Queryable, update: TelegramUpdate): Promise<IngestResult> {
  const message = update.message;
  if (!message) {
    throw new Error("update has no message");
  }

  const chat = await pool.query<{ id: string }>(
    `INSERT INTO chat (telegram_chat_id, title)
     VALUES ($1, $2)
     ON CONFLICT (telegram_chat_id) DO UPDATE SET title = COALESCE(EXCLUDED.title, chat.title)
     RETURNING id`,
    [message.chat.id, message.chat.title ?? null],
  );
  const chatId = Number(chat.rows[0].id);
  const fromUser = message.from?.username ?? message.from?.first_name ?? null;
  const sentAt = new Date(message.date * 1000);

  const inserted = await pool.query(
    `INSERT INTO message (chat_id, telegram_message_id, from_user, text, sent_at, is_bot)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (chat_id, telegram_message_id) DO NOTHING`,
    [chatId, message.message_id, fromUser, message.text ?? null, sentAt, message.from?.is_bot ?? false],
  );

  return { chatId, inserted: (inserted.rowCount ?? 0) > 0 };
}
