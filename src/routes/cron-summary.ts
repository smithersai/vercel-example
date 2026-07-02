import { requireBearer } from "@/src/auth";
import { buildContainer as defaultBuildContainer, type Container } from "@/src/container";
import { triggerSummary as defaultTriggerSummary } from "@/src/pipeline";
import { buildQueueDrainer, type QueueDrainResult } from "@/src/queue-drainer";
import { defaultRateLimiter, type RouteRateLimiter } from "@/src/rate-limit";

interface CronChatRow {
  chat_id: string;
  window_start: Date;
  window_end: Date;
}

interface CronDeps {
  buildContainer?: typeof defaultBuildContainer;
  triggerSummary?: typeof defaultTriggerSummary;
  buildDrainer?: typeof buildQueueDrainer;
  rateLimiter?: RouteRateLimiter;
}

function createCronRunner({
  triggerSummary = defaultTriggerSummary,
  buildDrainer = buildQueueDrainer,
}: CronDeps = {}) {
  return async function runCron(container: Container): Promise<Response> {
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
        // Keep going so one bad chat cannot starve the rest. Once a run row exists,
        // retries are owned by the queue drainer rather than by the scheduler cursor.
        failed += 1;
      }
    }

    const drain: QueueDrainResult = await buildDrainer(container).drain();
    return Response.json({ ok: true, triggered, failed, drain });
  };
}

export function createCronGet(deps: CronDeps = {}) {
  const runCron = createCronRunner(deps);
  return async function cronGet(request: Request): Promise<Response> {
    const authError = requireBearer(request, "CRON_SECRET");
    if (authError) {
      return authError;
    }
    const container = (deps.buildContainer ?? defaultBuildContainer)();
    const rateLimitError = await (deps.rateLimiter ?? defaultRateLimiter)({
      pool: container.pool,
      request,
      scope: "cron:summary",
    });
    if (rateLimitError) {
      return rateLimitError;
    }
    return runCron(container);
  };
}

export function createCronPost(deps: CronDeps = {}) {
  const runCron = createCronRunner(deps);
  return async function cronPost(request: Request): Promise<Response> {
    const authError = requireBearer(request, "CRON_SECRET");
    if (authError) {
      return authError;
    }
    const container = (deps.buildContainer ?? defaultBuildContainer)();
    const rateLimitError = await (deps.rateLimiter ?? defaultRateLimiter)({
      pool: container.pool,
      request,
      scope: "cron:summary",
    });
    if (rateLimitError) {
      return rateLimitError;
    }
    return runCron(container);
  };
}
