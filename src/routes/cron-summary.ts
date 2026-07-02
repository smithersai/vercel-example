import { requireBearer } from "@/src/auth";
import { buildContainer as defaultBuildContainer } from "@/src/container";
import { triggerSummary as defaultTriggerSummary } from "@/src/pipeline";

interface CronChatRow {
  chat_id: string;
  window_start: Date;
  window_end: Date;
}

interface CronDeps {
  buildContainer?: typeof defaultBuildContainer;
  triggerSummary?: typeof defaultTriggerSummary;
}

function createCronRunner({
  buildContainer = defaultBuildContainer,
  triggerSummary = defaultTriggerSummary,
}: CronDeps = {}) {
  return async function runCron(): Promise<Response> {
    const container = buildContainer();
    // Window bounds must be deterministic, not per-request now(): every tick inside the
    // same hour computes the identical (chat, window_start, window_end) claim key, so the
    // UNIQUE run constraint dedupes concurrent and repeated scheduler invocations.
    // sched_cursor is the durable low-water mark; it only advances past a window once a
    // run row for that window durably exists, so missed ticks widen the next window
    // instead of dropping messages.
    const result = await container.pool.query<CronChatRow>(
      `SELECT chat.id AS chat_id,
              COALESCE(chat_config.sched_cursor, date_trunc('hour', now()) - interval '1 hour') AS window_start,
              date_trunc('hour', now()) AS window_end
       FROM chat_config
       JOIN chat ON chat.id = chat_config.chat_id
       WHERE chat_config.enabled = true`,
    );

    let triggered = 0;
    let failed = 0;
    for (const row of result.rows) {
      const windowStart = new Date(row.window_start);
      const windowEnd = new Date(row.window_end);
      if (windowStart.getTime() >= windowEnd.getTime()) {
        continue;
      }
      try {
        const claim = await triggerSummary(container, {
          chatId: Number(row.chat_id),
          windowStart,
          windowEnd,
          trigger: "scheduled",
        });
        if (claim.claimed) {
          triggered += 1;
          await container.pool.query(
            `UPDATE chat_config SET sched_cursor = $2, updated_at = now()
             WHERE chat_id = $1 AND (sched_cursor IS NULL OR sched_cursor < $2)`,
            [row.chat_id, windowEnd],
          );
        }
      } catch {
        // executeRun already marked the run failed; keep the cursor where it is so the
        // next tick retries this chat's window (widened to the new hour boundary), and
        // keep going so one bad chat cannot starve the rest.
        failed += 1;
      }
    }

    return Response.json({ ok: true, triggered, failed });
  };
}

export function createCronGet(deps: CronDeps = {}) {
  const runCron = createCronRunner(deps);
  return async function cronGet(request: Request): Promise<Response> {
    const authError = requireBearer(request, "CRON_SECRET");
    if (authError) {
      return authError;
    }
    return runCron();
  };
}

export function createCronPost(deps: CronDeps = {}) {
  const runCron = createCronRunner(deps);
  return async function cronPost(request: Request): Promise<Response> {
    const authError = requireBearer(request, "CRON_SECRET");
    if (authError) {
      return authError;
    }
    return runCron();
  };
}
