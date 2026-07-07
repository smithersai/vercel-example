import { createOutboxGet } from "@/src/routes/outbox";

// pg + node:crypto require the Node.js runtime (not edge).
export const runtime = "nodejs";

export const GET = createOutboxGet();
