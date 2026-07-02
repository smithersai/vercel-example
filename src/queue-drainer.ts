import { randomUUID } from "node:crypto";
import { PostgresRunQueueStore, type ClaimedRunnableRun } from "./db/run-store";
import { executeRun, type ExecutorContainer } from "./pipeline";

export const DEFAULT_QUEUE_DRAIN_LIMIT = 5;

export interface RunQueueStore {
  claimRunnableRuns(args: {
    limit?: number;
    leaseSeconds?: number;
    maxAttempts?: number;
    leaseOwner: string;
  }): Promise<ClaimedRunnableRun[]>;
  markRunFailed(args: {
    runId: number;
    leaseOwner: string;
    error: unknown;
    maxAttempts?: number;
    backoffBaseSeconds?: number;
    backoffMaxSeconds?: number;
  }): Promise<{ status: "failed" | "dead_lettered" } | null>;
}

export interface QueueDrainerOptions {
  limit?: number;
  leaseSeconds?: number;
  maxAttempts?: number;
  backoffBaseSeconds?: number;
  backoffMaxSeconds?: number;
  leaseOwner?: string;
}

export interface QueueDrainResult {
  claimed: number;
  executed: number;
  failed: number;
  deadLettered: number;
}

export class QueueDrainer {
  constructor(
    private readonly deps: {
      store: RunQueueStore;
      executeRun: (runId: number) => Promise<void>;
      createLeaseOwner?: () => string;
    },
  ) {}

  async drain(options: QueueDrainerOptions = {}): Promise<QueueDrainResult> {
    const leaseOwner = options.leaseOwner ?? this.deps.createLeaseOwner?.() ?? randomUUID();
    const claims = await this.deps.store.claimRunnableRuns({
      limit: options.limit ?? DEFAULT_QUEUE_DRAIN_LIMIT,
      leaseSeconds: options.leaseSeconds,
      maxAttempts: options.maxAttempts,
      leaseOwner,
    });
    const result: QueueDrainResult = { claimed: claims.length, executed: 0, failed: 0, deadLettered: 0 };

    for (const claim of claims) {
      try {
        await this.deps.executeRun(claim.runId);
        result.executed += 1;
      } catch (error) {
        const failure = await this.deps.store.markRunFailed({
          runId: claim.runId,
          leaseOwner: claim.leaseOwner,
          error,
          maxAttempts: options.maxAttempts,
          backoffBaseSeconds: options.backoffBaseSeconds,
          backoffMaxSeconds: options.backoffMaxSeconds,
        });
        if (failure?.status === "dead_lettered") {
          result.deadLettered += 1;
        } else {
          result.failed += 1;
        }
      }
    }

    return result;
  }
}

export function buildQueueDrainer(container: ExecutorContainer): QueueDrainer {
  return new QueueDrainer({
    store: new PostgresRunQueueStore(container.pool),
    executeRun: (runId) => executeRun(container, runId),
  });
}
