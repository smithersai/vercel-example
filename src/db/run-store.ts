import type { ClaimRunArgs, ClaimRunResult, RunClaimer } from "@/src/pipeline";
import type { Queryable } from "./types";

export const DEFAULT_QUEUE_LEASE_SECONDS = 15 * 60;
export const DEFAULT_QUEUE_MAX_ATTEMPTS = 3;
export const DEFAULT_QUEUE_BACKOFF_BASE_SECONDS = 60;
export const DEFAULT_QUEUE_BACKOFF_MAX_SECONDS = 60 * 60;

export interface ClaimedRunnableRun {
  runId: number;
  attemptCount: number;
  leaseOwner: string;
  leaseExpiresAt: Date;
}

export interface ClaimRunnableRunsArgs {
  limit?: number;
  leaseSeconds?: number;
  maxAttempts?: number;
  leaseOwner: string;
}

export interface MarkRunFailedArgs {
  runId: number;
  leaseOwner: string;
  error: unknown;
  maxAttempts?: number;
  backoffBaseSeconds?: number;
  backoffMaxSeconds?: number;
}

export interface MarkRunFailedResult {
  status: "failed" | "dead_lettered";
  attemptCount: number;
  nextAttemptAt: Date | null;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value != null && value > 0 ? value : fallback;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

export class PostgresRunClaimer implements RunClaimer {
  constructor(private readonly pool: Queryable) {}

  async claimRun({ chatId, windowStart, windowEnd, trigger }: ClaimRunArgs): Promise<ClaimRunResult> {
    const inserted = await this.pool.query<{ id: string }>(
      `INSERT INTO run (chat_id, window_start, window_end, status, trigger)
       VALUES ($1, $2, $3, 'pending', $4)
       ON CONFLICT (chat_id, window_start, window_end) DO NOTHING
       RETURNING id`,
      [chatId, windowStart, windowEnd, trigger],
    );

    if (inserted.rows.length > 0) {
      return { runId: Number(inserted.rows[0].id), claimed: true };
    }

    const existing = await this.pool.query<{ id: string }>(
      `SELECT id FROM run WHERE chat_id = $1 AND window_start = $2 AND window_end = $3`,
      [chatId, windowStart, windowEnd],
    );

    if (existing.rows.length === 0) {
      throw new Error("run claim conflict did not return an existing run");
    }

    return { runId: Number(existing.rows[0].id), claimed: false };
  }
}

export class PostgresRunQueueStore {
  constructor(private readonly pool: Queryable) {}

  async claimRunnableRuns(args: ClaimRunnableRunsArgs): Promise<ClaimedRunnableRun[]> {
    const limit = positiveInteger(args.limit, 1);
    const leaseSeconds = positiveInteger(args.leaseSeconds, DEFAULT_QUEUE_LEASE_SECONDS);
    const maxAttempts = positiveInteger(args.maxAttempts, DEFAULT_QUEUE_MAX_ATTEMPTS);

    const result = await this.pool.query<{
      id: string;
      attempt_count: number;
      lease_owner: string;
      lease_expires_at: Date;
    }>(
      `WITH candidate AS (
         SELECT id
         FROM run
         WHERE (
             status IN ('pending', 'failed')
             OR (status = 'running' AND lease_expires_at <= now())
           )
           AND attempt_count < $4
           AND (next_attempt_at IS NULL OR next_attempt_at <= now())
           AND (lease_expires_at IS NULL OR lease_expires_at <= now())
         ORDER BY COALESCE(next_attempt_at, created_at), created_at, id
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE run
       SET status = 'running',
           lease_owner = $2::uuid,
           lease_expires_at = now() + ($3::int * interval '1 second'),
           heartbeat_at = now()
       FROM candidate
       WHERE run.id = candidate.id
       RETURNING run.id, run.attempt_count, run.lease_owner::text, run.lease_expires_at`,
      [limit, args.leaseOwner, leaseSeconds, maxAttempts],
    );

    return result.rows.map((row) => ({
      runId: Number(row.id),
      attemptCount: Number(row.attempt_count),
      leaseOwner: row.lease_owner,
      leaseExpiresAt: new Date(row.lease_expires_at),
    }));
  }

  async markRunFailed(args: MarkRunFailedArgs): Promise<MarkRunFailedResult | null> {
    const maxAttempts = positiveInteger(args.maxAttempts, DEFAULT_QUEUE_MAX_ATTEMPTS);
    const backoffBaseSeconds = positiveInteger(args.backoffBaseSeconds, DEFAULT_QUEUE_BACKOFF_BASE_SECONDS);
    const backoffMaxSeconds = positiveInteger(args.backoffMaxSeconds, DEFAULT_QUEUE_BACKOFF_MAX_SECONDS);
    const message = errorMessage(args.error);

    const result = await this.pool.query<{
      status: "failed" | "dead_lettered";
      attempt_count: number;
      next_attempt_at: Date | null;
    }>(
      `UPDATE run
       SET attempt_count = attempt_count + 1,
           status = CASE
             WHEN attempt_count + 1 >= $4 THEN 'dead_lettered'
             ELSE 'failed'
           END,
           last_error = $3,
           failure_reason = CASE
             WHEN attempt_count + 1 >= $4 THEN $3
             ELSE failure_reason
           END,
           next_attempt_at = CASE
             WHEN attempt_count + 1 >= $4 THEN NULL
             ELSE now() + (
               LEAST($6::int, ($5::int * POWER(2, attempt_count))::int) * interval '1 second'
             )
           END,
           lease_owner = NULL,
           lease_expires_at = NULL,
           heartbeat_at = NULL,
           completed_at = CASE
             WHEN attempt_count + 1 >= $4 THEN now()
             ELSE completed_at
           END,
           dead_lettered_at = CASE
             WHEN attempt_count + 1 >= $4 THEN now()
             ELSE dead_lettered_at
           END
       WHERE id = $1 AND status = 'running' AND lease_owner = $2::uuid
       RETURNING status, attempt_count, next_attempt_at`,
      [args.runId, args.leaseOwner, message, maxAttempts, backoffBaseSeconds, backoffMaxSeconds],
    );

    if (result.rows.length === 0) {
      return null;
    }

    return {
      status: result.rows[0].status,
      attemptCount: Number(result.rows[0].attempt_count),
      nextAttemptAt: result.rows[0].next_attempt_at ? new Date(result.rows[0].next_attempt_at) : null,
    };
  }
}
