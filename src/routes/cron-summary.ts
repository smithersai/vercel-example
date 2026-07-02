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
    const result = await container.pool.query<CronChatRow>(
      `SELECT chat.id AS chat_id,
              COALESCE(chat_config.sched_cursor, now() - interval '1 hour') AS window_start,
              now() AS window_end
       FROM chat_config
       JOIN chat ON chat.id = chat_config.chat_id
       WHERE chat_config.enabled = true`,
    );

    let triggered = 0;
    for (const row of result.rows) {
      const claim = await triggerSummary(container, {
        chatId: Number(row.chat_id),
        windowStart: new Date(row.window_start),
        windowEnd: new Date(row.window_end),
        trigger: "scheduled",
      });
      if (claim.claimed) {
        triggered += 1;
      }
    }

    return Response.json({ ok: true, triggered });
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
