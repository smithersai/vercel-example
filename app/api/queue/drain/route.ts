import { createQueueDrainPost } from "@/src/routes/queue-drain";

// pg + node:crypto require the Node.js runtime; draining claims up to
// QUEUE_DRAIN_LIMIT runs per invocation, so give it headroom.
export const runtime = "nodejs";
export const maxDuration = 60;

const drain = createQueueDrainPost();

export const GET = drain;
export const POST = drain;
