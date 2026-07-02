import { buildContainer as defaultBuildContainer } from "@/src/container";
import { requireTelegramSecret } from "@/src/auth";
import { ingestUpdate as defaultIngestUpdate, type TelegramUpdate } from "@/src/ingest";
import { defaultRateLimiter, type RouteRateLimiter } from "@/src/rate-limit";

interface WebhookDeps {
  buildContainer?: typeof defaultBuildContainer;
  ingestUpdate?: typeof defaultIngestUpdate;
  rateLimiter?: RouteRateLimiter;
}

export function createTelegramWebhookPost({
  buildContainer = defaultBuildContainer,
  ingestUpdate = defaultIngestUpdate,
  rateLimiter = defaultRateLimiter,
}: WebhookDeps = {}) {
  return async function telegramWebhookPost(request: Request): Promise<Response> {
    const authError = requireTelegramSecret(request);
    if (authError) {
      return authError;
    }

    const container = buildContainer();
    const rateLimitError = await rateLimiter({ pool: container.pool, request, scope: "telegram:webhook" });
    if (rateLimitError) {
      return rateLimitError;
    }

    let update: TelegramUpdate;

    try {
      update = (await request.json()) as TelegramUpdate;
    } catch {
      return Response.json({ error: "invalid json" }, { status: 400 });
    }

    if (!update.message) {
      return Response.json({ ok: true, ignored: true });
    }

    const result = await ingestUpdate(container.pool, update);
    return Response.json({ ok: true, ...result });
  };
}
