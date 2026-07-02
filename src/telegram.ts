import {
  createTelegramClient,
  type TelegramBotApiClient,
  type TelegramClientOptions,
  type TelegramMessageResult,
} from "smithers-orchestrator/telegram";
import type { Queryable } from "./db/types";

export interface TelegramPort {
  sendMessage(args: { chatId: number; text: string }): Promise<{ messageId: number }>;
}

export type TelegramBotApiPortOptions = TelegramClientOptions;
export type { TelegramApiResponse, TelegramRequestInit } from "smithers-orchestrator/telegram";
export { TELEGRAM_API_ROOT, TelegramBotApiError, TelegramNetworkError } from "smithers-orchestrator/telegram";

export class TelegramBotApiPort implements TelegramPort {
  private readonly client: Pick<TelegramBotApiClient, "sendMessage">;

  constructor(options: TelegramBotApiPortOptions) {
    this.client = createTelegramClient(options);
  }

  async sendMessage({ chatId, text }: { chatId: number; text: string }): Promise<{ messageId: number }> {
    const result = await this.client.sendMessage<TelegramMessageResult>({ chatId, text });
    if (!result || typeof result.message_id !== "number") {
      throw new Error("Telegram sendMessage response did not include a numeric message_id");
    }
    return { messageId: result.message_id };
  }
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
