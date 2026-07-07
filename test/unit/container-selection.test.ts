import { describe, expect, it } from "vitest";
import { buildContainer } from "@/src/container";
import type { QueryResult, Queryable } from "@/src/db/types";
import { FixtureSummarizerPort } from "@/src/summary";
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

describe("buildContainer summarizer selection", () => {
  it("uses the deterministic fixture summarizer when no provider keys are configured", () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;

    const container = buildContainer({ pool: noopPool });

    expect(container.summarizer).toBeInstanceOf(FixtureSummarizerPort);
  });

  it("keeps the fixture summarizer in the automatic-fake test env even when keys are present, so unit tests never hit the network", () => {
    // NODE_ENV=test → automatic-fake env. Real agent-pool summarization only engages in
    // production/preview deployments; here we must stay on the offline fixture.
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.OPENAI_API_KEY = "sk-openai-test";

    const container = buildContainer({ pool: noopPool });

    expect(container.summarizer).toBeInstanceOf(FixtureSummarizerPort);
  });

  it("honors an explicit summarizer override", () => {
    const override = { summarize: async () => ({ window: { start: "", end: "" }, topics: [] }) };
    const container = buildContainer({ pool: noopPool, summarizer: override });

    expect(container.summarizer).toBe(override);
  });
});
