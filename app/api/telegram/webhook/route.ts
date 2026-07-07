import { createTelegramWebhookPost } from "@/src/routes/telegram-webhook";

// pg + node:crypto require the Node.js runtime (not edge).
export const runtime = "nodejs";

export const POST = createTelegramWebhookPost();
