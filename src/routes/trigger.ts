import { requireBearer } from "@/src/auth";
import { buildContainer as defaultBuildContainer } from "@/src/container";
import { triggerSummary as defaultTriggerSummary } from "@/src/pipeline";

interface TriggerBody {
  chatId?: number;
  telegramChatId?: number;
  windowStart?: string;
  windowEnd?: string;
}

interface TriggerDeps {
  buildContainer?: typeof defaultBuildContainer;
  triggerSummary?: typeof defaultTriggerSummary;
}

export function createTriggerPost({
  buildContainer = defaultBuildContainer,
  triggerSummary = defaultTriggerSummary,
}: TriggerDeps = {}) {
  return async function triggerPost(request: Request): Promise<Response> {
    const authError = requireBearer(request, "OPERATOR_SECRET");
    if (authError) {
      return authError;
    }

    const container = buildContainer();
    let body: TriggerBody;

    try {
      body = (await request.json()) as TriggerBody;
    } catch {
      return Response.json({ error: "invalid json" }, { status: 400 });
    }

    if (!body.windowStart || !body.windowEnd) {
      return Response.json({ error: "windowStart and windowEnd required" }, { status: 400 });
    }

    let chatId = body.chatId;
    if (chatId == null && body.telegramChatId != null) {
      const result = await container.pool.query<{ id: string }>(`SELECT id FROM chat WHERE telegram_chat_id = $1`, [
        body.telegramChatId,
      ]);
      if (result.rows.length === 0) {
        return Response.json({ error: "unknown chat" }, { status: 404 });
      }
      chatId = Number(result.rows[0].id);
    }
    if (chatId == null) {
      return Response.json({ error: "chatId or telegramChatId required" }, { status: 400 });
    }

    const result = await triggerSummary(container, {
      chatId,
      windowStart: new Date(body.windowStart),
      windowEnd: new Date(body.windowEnd),
      trigger: "manual",
    });

    return Response.json({ ok: true, ...result });
  };
}
