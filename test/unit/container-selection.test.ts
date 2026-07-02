import { describe, expect, it } from "vitest";
import { buildContainer } from "@/src/container";
import type { QueryResult, Queryable } from "@/src/db/types";
import { FakeTelegramPort, TelegramBotApiPort } from "@/src/telegram";

const noopPool: Queryable = {
  async query<T = unknown>(): Promise<QueryResult<T>> {
    return { rows: [], rowCount: 0 };
  },
};

describe("buildContainer Telegram delivery selection", () => {
  it("uses the real Bot API port when real mode and TELEGRAM_BOT_TOKEN are configured", () => {
    process.env.TELEGRAM_BOT_TOKEN = "123:abc";
    process.env.TELEGRAM_API_ROOT = "https://telegram.example.test";
    process.env.TELEGRAM_DELIVERY_MODE = "real";

    const container = buildContainer({ pool: noopPool });

    expect(container.telegram).toBeInstanceOf(TelegramBotApiPort);
  });

  it("keeps fake delivery available for tests and explicit fake mode", () => {
    process.env.TELEGRAM_BOT_TOKEN = "123:abc";
    process.env.TELEGRAM_DELIVERY_MODE = "fake";

    const explicitFake = buildContainer({ pool: noopPool });

    expect(explicitFake.telegram).toBeInstanceOf(FakeTelegramPort);

    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_DELIVERY_MODE;

    const defaultTestFake = buildContainer({ pool: noopPool });

    expect(defaultTestFake.telegram).toBeInstanceOf(FakeTelegramPort);
  });

  it("keeps preview e2e delivery fake even when a token is present", () => {
    process.env.VERCEL_ENV = "preview";
    process.env.E2E_TEST_ROUTES = "1";
    process.env.TELEGRAM_BOT_TOKEN = "123:abc";

    const container = buildContainer({ pool: noopPool });

    expect(container.telegram).toBeInstanceOf(FakeTelegramPort);
  });

  it("fails fast in production when neither a token nor explicit fake mode is configured", () => {
    process.env.VERCEL_ENV = "production";
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_DELIVERY_MODE;

    expect(() => buildContainer({ pool: noopPool })).toThrow(/TELEGRAM_BOT_TOKEN/);
  });

  it("allows explicit fake delivery in production-like e2e deployments", () => {
    process.env.VERCEL_ENV = "production";
    process.env.TELEGRAM_DELIVERY_MODE = "fake";
    delete process.env.TELEGRAM_BOT_TOKEN;

    const container = buildContainer({ pool: noopPool });

    expect(container.telegram).toBeInstanceOf(FakeTelegramPort);
  });
});
