import type { ClaimRunArgs, ClaimRunResult, RunClaimer } from "@/src/pipeline";
import type { Queryable } from "./types";

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
