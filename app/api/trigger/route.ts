import { createTriggerPost } from "@/src/routes/trigger";

// pg + node:crypto require the Node.js runtime (not edge).
export const runtime = "nodejs";

export const POST = createTriggerPost();
