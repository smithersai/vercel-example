import { createQueueDrainPost } from "@/src/routes/queue-drain";

const drain = createQueueDrainPost();

export const GET = drain;
export const POST = drain;
