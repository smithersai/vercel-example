import { getPool } from "./db/pool";
import type { Queryable } from "./db/types";
import { PostgresRunClaimer } from "./db/run-store";
import type { Invoker, RunClaimer } from "./pipeline";
import { FixtureSummarizerPort, type SummarizerPort } from "./summary";
import { FakeTelegramPort, TelegramBotApiPort, type TelegramPort } from "./telegram";

export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export interface Container {
  pool: Queryable;
  runClaimer: RunClaimer;
  invoker: Invoker;
  telegram: TelegramPort;
  summarizer: SummarizerPort;
  clock: Clock;
}

function compact(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function productionEnv(): boolean {
  return process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production";
}

function automaticFakeEnv(): boolean {
  return process.env.NODE_ENV === "test" || process.env.E2E_TEST_ROUTES === "1";
}

function buildTelegramPort(pool: Queryable): TelegramPort {
  const deliveryMode = compact(process.env.TELEGRAM_DELIVERY_MODE);
  if (deliveryMode != null && deliveryMode !== "fake" && deliveryMode !== "real") {
    throw new Error("TELEGRAM_DELIVERY_MODE must be either 'real' or 'fake'");
  }

  if (deliveryMode === "fake" || (deliveryMode !== "real" && !productionEnv() && automaticFakeEnv())) {
    return new FakeTelegramPort(pool);
  }

  const botToken = compact(process.env.TELEGRAM_BOT_TOKEN);
  if (botToken) {
    return new TelegramBotApiPort({
      botToken,
      apiRoot: process.env.TELEGRAM_API_ROOT,
    });
  }

  if (deliveryMode === "real" || productionEnv()) {
    throw new Error("TELEGRAM_BOT_TOKEN is required for real Telegram delivery; set TELEGRAM_DELIVERY_MODE=fake only for local or test outbox mode");
  }

  return new FakeTelegramPort(pool);
}

export function buildContainer(overrides: Partial<Container> = {}): Container {
  const pool = overrides.pool ?? getPool();
  const container = {
    pool,
    runClaimer: overrides.runClaimer ?? new PostgresRunClaimer(pool),
    telegram: overrides.telegram ?? buildTelegramPort(pool),
    summarizer: overrides.summarizer ?? new FixtureSummarizerPort(),
    clock: overrides.clock ?? new SystemClock(),
    invoker: overrides.invoker,
  } as Container;

  container.invoker ??= {
    invokeExecutor: async () => undefined,
  };

  return container;
}
