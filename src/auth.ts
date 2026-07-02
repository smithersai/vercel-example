export type SecretName = "TELEGRAM_WEBHOOK_SECRET" | "OPERATOR_SECRET" | "CRON_SECRET";

export function configuredSecret(name: SecretName): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

export function unauthorized(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

export function unavailableSecret(name: SecretName): Response {
  return Response.json({ error: `${name} is not configured` }, { status: 503 });
}

export function getBearerToken(request: Request): string | undefined {
  const value = request.headers.get("authorization");
  const match = value?.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

export function tokensEqual(actual: string | undefined, expected: string): boolean {
  if (!actual || actual.length !== expected.length) {
    return false;
  }

  let diff = 0;
  for (let index = 0; index < expected.length; index += 1) {
    diff |= expected.charCodeAt(index) ^ actual.charCodeAt(index);
  }
  return diff === 0;
}

export function requireBearer(request: Request, secretName: "OPERATOR_SECRET" | "CRON_SECRET"): Response | null {
  const expected = configuredSecret(secretName);
  if (!expected) {
    return unavailableSecret(secretName);
  }

  return tokensEqual(getBearerToken(request), expected) ? null : unauthorized();
}

export function requireTelegramSecret(request: Request): Response | null {
  const expected = configuredSecret("TELEGRAM_WEBHOOK_SECRET");
  if (!expected) {
    return unavailableSecret("TELEGRAM_WEBHOOK_SECRET");
  }

  const actual = request.headers.get("x-telegram-bot-api-secret-token") ?? undefined;
  return tokensEqual(actual, expected) ? null : unauthorized();
}
