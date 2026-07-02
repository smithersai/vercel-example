export type QueueKick = (request: Request) => void;

export const noopQueueKick: QueueKick = () => undefined;

export function kickQueueDrain(request: Request): void {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return;
  }

  const url = new URL("/api/queue/drain", request.url);
  void fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}` },
    cache: "no-store",
  }).catch(() => undefined);
}
