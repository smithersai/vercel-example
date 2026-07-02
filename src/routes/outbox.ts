import { requireBearer } from "@/src/auth";
import { buildContainer as defaultBuildContainer } from "@/src/container";

interface OutboxDeps {
  buildContainer?: typeof defaultBuildContainer;
}

export function createOutboxGet({ buildContainer = defaultBuildContainer }: OutboxDeps = {}) {
  return async function outboxGet(request: Request): Promise<Response> {
    if (
      process.env.E2E_TEST_ROUTES !== "1" ||
      process.env.NODE_ENV === "production" ||
      process.env.VERCEL_ENV === "production"
    ) {
      return Response.json({ error: "not found" }, { status: 404 });
    }

    const authError = requireBearer(request, "OPERATOR_SECRET");
    if (authError) {
      return authError;
    }

    const container = buildContainer();
    const chatId = new URL(request.url).searchParams.get("chatId");
    const result = chatId
      ? await container.pool.query(
          `SELECT id, method, chat_id, payload, message_id, created_at
           FROM telegram_outbox WHERE chat_id = $1 ORDER BY id`,
          [Number(chatId)],
        )
      : await container.pool.query(
          `SELECT id, method, chat_id, payload, message_id, created_at
           FROM telegram_outbox ORDER BY id`,
        );

    return Response.json({ outbox: result.rows });
  };
}
