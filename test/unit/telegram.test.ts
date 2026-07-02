import { describe, expect, it } from "vitest";
import type { QueryResult, Queryable } from "@/src/db/types";
import { FakeTelegramPort, TelegramBotApiError, TelegramBotApiPort } from "@/src/telegram";

type FetchCall = {
  url: string;
  init: RequestInit | undefined;
};

class ScriptedPool implements Queryable {
  readonly calls: Array<{ text: string; params?: readonly unknown[] }> = [];

  constructor(private readonly responses: QueryResult[]) {}

  async query<T = unknown>(text: string, params?: readonly unknown[]): Promise<QueryResult<T>> {
    this.calls.push({ text, params });
    const next = this.responses.shift();
    if (!next) {
      throw new Error(`unexpected query: ${text}`);
    }
    return next as QueryResult<T>;
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function scriptedFetch(responses: Array<Response | Error>): { calls: FetchCall[]; fetchImpl: typeof fetch } {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const next = responses.shift();
    if (!next) {
      throw new Error(`unexpected fetch: ${String(input)}`);
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  }) as typeof fetch;

  return { calls, fetchImpl };
}

describe("TelegramBotApiPort", () => {
  it("constructs a sendMessage Bot API request and returns a numeric message id", async () => {
    const { calls, fetchImpl } = scriptedFetch([
      jsonResponse(200, {
        ok: true,
        result: { message_id: 123, chat: { id: 42 }, text: "hello" },
      }),
    ]);
    const sleeps: number[] = [];
    const port = new TelegramBotApiPort({
      botToken: "123:abc",
      apiRoot: "https://telegram.example.test/root/",
      fetch: fetchImpl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await expect(port.sendMessage({ chatId: 42, text: "hello" })).resolves.toEqual({ messageId: 123 });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://telegram.example.test/root/bot123:abc/sendMessage");
    expect(calls[0].init?.method).toBe("POST");
    expect(new Headers(calls[0].init?.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ chat_id: 42, text: "hello" });
    expect(sleeps).toEqual([]);
  });

  it("retries 429 responses after the Telegram retry_after delay", async () => {
    const { calls, fetchImpl } = scriptedFetch([
      jsonResponse(429, {
        ok: false,
        description: "Too Many Requests",
        parameters: { retry_after: 2 },
      }),
      jsonResponse(200, {
        ok: true,
        result: { message_id: 124, chat: { id: 42 }, text: "hello" },
      }),
    ]);
    const sleeps: number[] = [];
    const port = new TelegramBotApiPort({
      botToken: "123:abc",
      apiRoot: "https://telegram.example.test",
      fetch: fetchImpl,
      maxRetries: 2,
      retryBaseMs: 25,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await expect(port.sendMessage({ chatId: 42, text: "hello" })).resolves.toEqual({ messageId: 124 });
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([2000]);
  });

  it("retries network and 5xx failures with exponential backoff", async () => {
    const { calls, fetchImpl } = scriptedFetch([
      new TypeError("socket reset"),
      jsonResponse(502, { ok: false, description: "Bad Gateway" }),
      jsonResponse(200, {
        ok: true,
        result: { message_id: 125, chat: { id: 42 }, text: "hello" },
      }),
    ]);
    const sleeps: number[] = [];
    const port = new TelegramBotApiPort({
      botToken: "123:abc",
      apiRoot: "https://telegram.example.test",
      fetch: fetchImpl,
      maxRetries: 2,
      retryBaseMs: 25,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await expect(port.sendMessage({ chatId: 42, text: "hello" })).resolves.toEqual({ messageId: 125 });
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([25, 50]);
  });

  it("does not retry permanent Telegram 4xx failures", async () => {
    const { calls, fetchImpl } = scriptedFetch([
      jsonResponse(400, { ok: false, description: "Bad Request: chat not found" }),
    ]);
    const sleeps: number[] = [];
    const port = new TelegramBotApiPort({
      botToken: "123:abc",
      apiRoot: "https://telegram.example.test",
      fetch: fetchImpl,
      maxRetries: 3,
      retryBaseMs: 25,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    let error: unknown;
    try {
      await port.sendMessage({ chatId: 42, text: "hello" });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(TelegramBotApiError);
    expect(error).toMatchObject({
      method: "sendMessage",
      status: 400,
      retryAfterSeconds: null,
    });
    expect(String(error)).toContain("Bad Request: chat not found");
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("stops retrying after the configured retry budget is exhausted", async () => {
    const { calls, fetchImpl } = scriptedFetch([
      jsonResponse(503, { ok: false, description: "first outage" }),
      jsonResponse(503, { ok: false, description: "second outage" }),
    ]);
    const sleeps: number[] = [];
    const port = new TelegramBotApiPort({
      botToken: "123:abc",
      apiRoot: "https://telegram.example.test",
      fetch: fetchImpl,
      maxRetries: 1,
      retryBaseMs: 25,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await expect(port.sendMessage({ chatId: 42, text: "hello" })).rejects.toMatchObject({
      method: "sendMessage",
      status: 503,
    });
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([25]);
  });
});

describe("FakeTelegramPort", () => {
  it("keeps recording deterministic outbox sends for local and e2e tests", async () => {
    const pool = new ScriptedPool([{ rows: [{ message_id: "778" }], rowCount: 1 }]);

    await expect(new FakeTelegramPort(pool).sendMessage({ chatId: 42, text: "summary" })).resolves.toEqual({
      messageId: 778,
    });

    expect(pool.calls[0].params).toEqual([42, JSON.stringify({ chat_id: 42, text: "summary" })]);
  });
});
