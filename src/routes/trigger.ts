import { requireBearer } from "@/src/auth";
import { buildContainer as defaultBuildContainer } from "@/src/container";
import { triggerSummary as defaultTriggerSummary } from "@/src/pipeline";
import { defaultRateLimiter, type RouteRateLimiter } from "@/src/rate-limit";
import { kickQueueDrain, type QueueKick } from "@/src/routes/queue-kick";

interface TriggerBody {
  chatId?: unknown;
  telegramChatId?: unknown;
  windowStart?: unknown;
  windowEnd?: unknown;
}

interface TriggerDeps {
  buildContainer?: typeof defaultBuildContainer;
  triggerSummary?: typeof defaultTriggerSummary;
  rateLimiter?: RouteRateLimiter;
  kickQueue?: QueueKick;
}

export function createTriggerPost({
  buildContainer = defaultBuildContainer,
  triggerSummary = defaultTriggerSummary,
  rateLimiter = defaultRateLimiter,
  kickQueue = kickQueueDrain,
}: TriggerDeps = {}) {
  return async function triggerPost(request: Request): Promise<Response> {
    const authError = requireBearer(request, "OPERATOR_SECRET");
    if (authError) {
      return authError;
    }

    let body: TriggerBody;

    try {
      body = (await request.json()) as TriggerBody;
    } catch {
      return Response.json({ error: "invalid json" }, { status: 400 });
    }

    if (!body.windowStart || !body.windowEnd) {
      return Response.json({ error: "windowStart and windowEnd required" }, { status: 400 });
    }

    const windowStart = parseTriggerDate(body.windowStart);
    const windowEnd = parseTriggerDate(body.windowEnd);
    if (!windowStart || !windowEnd) {
      return Response.json({ error: "windowStart and windowEnd must be valid dates" }, { status: 400 });
    }
    if (windowStart.getTime() >= windowEnd.getTime()) {
      return Response.json({ error: "windowStart must be before windowEnd" }, { status: 400 });
    }

    if (body.chatId !== undefined && !isTriggerIdentifier(body.chatId)) {
      return Response.json({ error: "chatId must be a safe integer" }, { status: 400 });
    }
    if (body.telegramChatId !== undefined && !isTriggerIdentifier(body.telegramChatId)) {
      return Response.json({ error: "telegramChatId must be a safe integer" }, { status: 400 });
    }

    let chatId = body.chatId;
    const telegramChatId = body.telegramChatId;
    if (chatId == null && telegramChatId == null) {
      return Response.json({ error: "chatId or telegramChatId required" }, { status: 400 });
    }

    const container = buildContainer();
    const rateLimitError = await rateLimiter({ pool: container.pool, request, scope: "operator:trigger" });
    if (rateLimitError) {
      return rateLimitError;
    }

    if (chatId == null && telegramChatId != null) {
      const result = await container.pool.query<{ id: string }>(`SELECT id FROM chat WHERE telegram_chat_id = $1`, [
        telegramChatId,
      ]);
      if (result.rows.length === 0) {
        return Response.json({ error: "unknown chat" }, { status: 404 });
      }
      chatId = Number(result.rows[0].id);
    }
    if (chatId == null) {
      return Response.json({ error: "chatId or telegramChatId required" }, { status: 400 });
    }

    if (telegramChatId == null) {
      const chatExists = await container.pool.query<{ id: string }>(`SELECT id FROM chat WHERE id = $1`, [chatId]);
      if (chatExists.rows.length === 0) {
        return Response.json({ error: "unknown chat" }, { status: 404 });
      }
    }

    const result = await triggerSummary(container, {
      chatId,
      windowStart,
      windowEnd,
      trigger: "manual",
    });
    if (result.claimed) {
      kickQueue(request);
    }

    return Response.json({ ok: true, ...result });
  };
}

function parseTriggerDate(value: unknown): Date | null {
  if (typeof value !== "string") {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date;
}

function isTriggerIdentifier(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}
