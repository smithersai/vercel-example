import { getPool } from "./db/pool";
import type { Queryable } from "./db/types";
import { PostgresRunClaimer } from "./db/run-store";
import { executeRun, type Invoker, type RunClaimer } from "./pipeline";
import { FixtureSummarizerPort, type SummarizerPort } from "./summary";
import { FakeTelegramPort, type TelegramPort } from "./telegram";

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

export function buildContainer(overrides: Partial<Container> = {}): Container {
  const pool = overrides.pool ?? getPool();
  const container = {
    pool,
    runClaimer: overrides.runClaimer ?? new PostgresRunClaimer(pool),
    telegram: overrides.telegram ?? new FakeTelegramPort(pool),
    summarizer: overrides.summarizer ?? new FixtureSummarizerPort(),
    clock: overrides.clock ?? new SystemClock(),
    invoker: overrides.invoker,
  } as Container;

  container.invoker ??= {
    invokeExecutor: (runId: number) => executeRun(container, runId),
  };

  return container;
}
