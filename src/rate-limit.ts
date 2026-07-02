import type { Queryable } from "./db/types";

export type RateLimitScope = "telegram:webhook" | "operator:trigger" | "cron:summary";

export interface RateLimitPolicy {
  scope: RateLimitScope;
  limit: number;
  windowSeconds: number;
}

export interface RouteRateLimitArgs {
  pool: Queryable;
  request: Request;
  scope: RateLimitScope;
}

export type RouteRateLimiter = (args: RouteRateLimitArgs) => Promise<Response | null>;

const DEFAULT_WINDOW_SECONDS = 60;
const DEFAULT_LIMITS: Record<RateLimitScope, number> = {
  "telegram:webhook": 120,
  "operator:trigger": 20,
  "cron:summary": 10,
};
const LIMIT_ENV: Record<RateLimitScope, string> = {
  "telegram:webhook": "RATE_LIMIT_WEBHOOK_MAX",
  "operator:trigger": "RATE_LIMIT_TRIGGER_MAX",
  "cron:summary": "RATE_LIMIT_CRON_MAX",
};

export const allowAllRateLimiter: RouteRateLimiter = async () => null;

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function policyForScope(scope: RateLimitScope): RateLimitPolicy {
  return {
    scope,
    limit: positiveInteger(process.env[LIMIT_ENV[scope]], DEFAULT_LIMITS[scope]),
    windowSeconds: positiveInteger(process.env.RATE_LIMIT_WINDOW_SECONDS, DEFAULT_WINDOW_SECONDS),
  };
}

function requesterBucket(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwardedFor || request.headers.get("x-real-ip") || "unknown";
}

function rateLimitHeaders(policy: RateLimitPolicy, count: number, resetAt: Date): HeadersInit {
  const remaining = Math.max(0, policy.limit - count);
  const retryAfter = Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000));
  return {
    "retry-after": String(retryAfter),
    "x-ratelimit-limit": String(policy.limit),
    "x-ratelimit-remaining": String(remaining),
    "x-ratelimit-reset": resetAt.toISOString(),
  };
}

export async function enforcePostgresRateLimit(
  pool: Queryable,
  request: Request,
  policy: RateLimitPolicy,
): Promise<Response | null> {
  const bucket = requesterBucket(request);
  const result = await pool.query<{ count: number; reset_at: Date }>(
    `WITH rate_window AS (
       SELECT to_timestamp(
         floor(extract(epoch from now()) / $3::int) * $3::int
       ) AS window_start
     ),
     counter AS (
       INSERT INTO rate_limit_counter (scope, bucket, window_start, count)
       SELECT $1, $2, window_start, 1 FROM rate_window
       ON CONFLICT (scope, bucket, window_start)
       DO UPDATE SET count = rate_limit_counter.count + 1
       RETURNING count, window_start + ($3::int * interval '1 second') AS reset_at
     )
     SELECT count, reset_at FROM counter`,
    [policy.scope, bucket, policy.windowSeconds],
  );
  const row = result.rows[0];
  const count = Number(row.count);
  const resetAt = new Date(row.reset_at);

  if (count <= policy.limit) {
    return null;
  }

  return Response.json(
    { error: "rate limit exceeded" },
    { status: 429, headers: rateLimitHeaders(policy, count, resetAt) },
  );
}

export const defaultRateLimiter: RouteRateLimiter = ({ pool, request, scope }) =>
  enforcePostgresRateLimit(pool, request, policyForScope(scope));
