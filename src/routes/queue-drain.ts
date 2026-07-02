import { requireBearer } from "@/src/auth";
import { buildContainer as defaultBuildContainer } from "@/src/container";
import { buildQueueDrainer, type QueueDrainerOptions } from "@/src/queue-drainer";

interface QueueDrainDeps {
  buildContainer?: typeof defaultBuildContainer;
  buildDrainer?: typeof buildQueueDrainer;
}

function drainOptionsFromEnv(): QueueDrainerOptions {
  return {
    limit: Number(process.env.QUEUE_DRAIN_LIMIT) || undefined,
    leaseSeconds: Number(process.env.QUEUE_LEASE_SECONDS) || undefined,
    maxAttempts: Number(process.env.QUEUE_MAX_ATTEMPTS) || undefined,
    backoffBaseSeconds: Number(process.env.QUEUE_BACKOFF_BASE_SECONDS) || undefined,
    backoffMaxSeconds: Number(process.env.QUEUE_BACKOFF_MAX_SECONDS) || undefined,
  };
}

export function createQueueDrainPost({
  buildContainer = defaultBuildContainer,
  buildDrainer = buildQueueDrainer,
}: QueueDrainDeps = {}) {
  return async function queueDrainPost(request: Request): Promise<Response> {
    const authError = requireBearer(request, "CRON_SECRET");
    if (authError) {
      return authError;
    }

    const container = buildContainer();
    const result = await buildDrainer(container).drain(drainOptionsFromEnv());
    return Response.json({ ok: true, ...result });
  };
}
