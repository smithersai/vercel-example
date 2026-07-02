import { describe, expect, it, vi } from "vitest";
import type { TelegramMessageResult, TelegramSendMessageArgs } from "smithers-orchestrator/telegram";
import { TelegramBotApiPort, type TelegramBotApiPortOptions } from "@/src/telegram";

describe("TelegramBotApiPort helper delegation", () => {
  it("uses the smithers-orchestrator Telegram client for real Bot API delivery", async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> => {
      return Response.json({ ok: true, result: { message_id: 999, chat: { id: 42 }, text: "ignored" } });
    }) as unknown as typeof fetch;
    const sleep = vi.fn(async (_ms: number): Promise<void> => undefined);
    const sendMessage = vi.fn(async (args: TelegramSendMessageArgs): Promise<TelegramMessageResult> => {
      return { message_id: 321, chat: { id: args.chatId }, text: args.text };
    });
    const createClient = vi.fn(() => ({ sendMessage })) as unknown as NonNullable<
      TelegramBotApiPortOptions["createClient"]
    >;

    const port = new TelegramBotApiPort({
      botToken: "123:abc",
      apiRoot: "https://telegram.example.test",
      fetch: fetchImpl,
      maxRetries: 1,
      retryBaseMs: 25,
      sleep,
      createClient,
    });

    await expect(port.sendMessage({ chatId: 42, text: "hello" })).resolves.toEqual({ messageId: 321 });

    expect(createClient).toHaveBeenCalledWith({
      botToken: "123:abc",
      apiRoot: "https://telegram.example.test",
      fetch: fetchImpl,
      maxRetries: 1,
      retryBaseMs: 25,
      sleep,
    });
    expect(sendMessage).toHaveBeenCalledWith({ chatId: 42, text: "hello" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
