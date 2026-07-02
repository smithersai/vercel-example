import { renderSummary } from "./render";
import type { Queryable } from "./db/types";
import type { SummarizerPort, SummaryMessage } from "./summary";
import type { TelegramPort } from "./telegram";

export interface ClaimRunArgs {
  chatId: number;
  windowStart: Date;
  windowEnd: Date;
  trigger: "scheduled" | "manual";
}

export interface ClaimRunResult {
  runId: number;
  claimed: boolean;
}

export interface RunClaimer {
  claimRun(args: ClaimRunArgs): Promise<ClaimRunResult>;
}

export interface Invoker {
  invokeExecutor(runId: number): Promise<void>;
}

export interface TriggerContainer {
  runClaimer: RunClaimer;
  invoker: Invoker;
}

export interface ExecutorContainer {
  pool: Queryable;
  telegram: TelegramPort;
  summarizer: SummarizerPort;
}

export async function triggerSummary(container: TriggerContainer, args: ClaimRunArgs): Promise<ClaimRunResult> {
  return container.runClaimer.claimRun(args);
}

export async function executeRun(container: ExecutorContainer, runId: number): Promise<void> {
  const runResult = await container.pool.query<{
    chat_id: string;
    window_start: Date;
    window_end: Date;
    status: string;
  }>(`SELECT chat_id, window_start, window_end, status FROM run WHERE id = $1`, [runId]);

  if (runResult.rows.length === 0) {
    throw new Error(`run ${runId} not found`);
  }

  const run = runResult.rows[0];
  if (run.status === "posted") {
    return;
  }

  const chatId = Number(run.chat_id);
  const windowStart = new Date(run.window_start);
  const windowEnd = new Date(run.window_end);

  await container.pool.query(`UPDATE run SET status = 'running' WHERE id = $1 AND status <> 'posted'`, [runId]);

  // Retry the same run with its previously assigned messages, but never steal messages
  // from another run when recovery windows overlap.
  const messageResult = await container.pool.query<{
    from_user: string | null;
    text: string | null;
    sent_at: Date;
  }>(
    `SELECT from_user, text, sent_at
     FROM message
     WHERE chat_id = $1 AND is_bot = false
       AND (assigned_run_id IS NULL OR assigned_run_id = $4)
       AND sent_at >= $2 AND sent_at < $3
     ORDER BY sent_at, id`,
    [chatId, windowStart, windowEnd, runId],
  );

  await container.pool.query(
    `UPDATE message SET assigned_run_id = $1
     WHERE chat_id = $2 AND is_bot = false AND assigned_run_id IS NULL
       AND sent_at >= $3 AND sent_at < $4`,
    [runId, chatId, windowStart, windowEnd],
  );

  const messages: SummaryMessage[] = messageResult.rows.map((message) => ({
    fromUser: message.from_user,
    text: message.text,
    sentAt: new Date(message.sent_at),
  }));
  const text = renderSummary(await container.summarizer.summarize({ windowStart, windowEnd, messages }));

  await container.pool.query(
    `INSERT INTO run_chunk (run_id, chunk_index, chunk_text, state)
     VALUES ($1, 0, $2, 'pending')
     ON CONFLICT (run_id, chunk_index) DO NOTHING`,
    [runId, text],
  );

  const reservation = await container.pool.query<{ chunk_text: string }>(
    `UPDATE run_chunk
     SET state = 'reserved', reserved_at = now()
     WHERE run_id = $1 AND chunk_index = 0
       AND (
         state = 'pending'
         OR (state IN ('reserving', 'reserved') AND reserved_at < now() - interval '10 minutes')
       )
     RETURNING chunk_text`,
    [runId],
  );

  if (reservation.rows.length === 0) {
    return;
  }

  const chunkText = reservation.rows[0].chunk_text;
  const sent = await container.telegram.sendMessage({ chatId, text: chunkText });

  await container.pool.query(
    `UPDATE run_chunk SET state = 'sent', telegram_message_id = $2, sent_at = now()
     WHERE run_id = $1 AND chunk_index = 0 AND state = 'reserved'`,
    [runId, sent.messageId],
  );
  await container.pool.query(
    `UPDATE run
     SET status = 'posted',
         summary_text = $2,
         input_message_count = $3,
         completed_at = now(),
         lease_owner = NULL,
         lease_expires_at = NULL,
         heartbeat_at = NULL,
         next_attempt_at = NULL
     WHERE id = $1`,
    [runId, chunkText, messages.length],
  );
}
