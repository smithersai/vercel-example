import { createCronGet, createCronPost } from "@/src/routes/cron-summary";

// pg + node:crypto require the Node.js runtime; the cron also drains the queue,
// so give it headroom beyond the default function duration.
export const runtime = "nodejs";
export const maxDuration = 60;

export const GET = createCronGet();
export const POST = createCronPost();
