import { tokensEqual } from "@/src/auth";

export const OPERATOR_AUTH_COOKIE = "__Host-smithers_operator";
const OPERATOR_TOKEN_QUERY_PARAM = "token";

export type OperatorAuthCookie = {
  name: typeof OPERATOR_AUTH_COOKIE;
  value: string;
  httpOnly: true;
  secure: true;
  sameSite: "lax";
  path: "/";
};

export type OperatorAuthDecision =
  | { kind: "public" }
  | { kind: "allow" }
  | { kind: "redirect"; location: string; cookie: OperatorAuthCookie }
  | { kind: "reject"; status: 401 | 503; error: string };

export function isProtectedOperatorPath(pathname: string): boolean {
  return (
    pathname === "/runs" ||
    pathname.startsWith("/runs/") ||
    pathname === "/v1/rpc" ||
    pathname.startsWith("/v1/rpc/") ||
    pathname === "/v1/api" ||
    pathname.startsWith("/v1/api/") ||
    pathname === "/workflows" ||
    pathname.startsWith("/workflows/") ||
    pathname === "/health" ||
    pathname === "/smithers-ws" ||
    pathname.startsWith("/smithers-ws/")
  );
}

export async function evaluateOperatorAuthRequest(
  url: URL,
  {
    cookieValue,
    secret,
  }: {
    cookieValue: string | undefined;
    secret: string | undefined;
  },
): Promise<OperatorAuthDecision> {
  if (!isProtectedOperatorPath(url.pathname)) {
    return { kind: "public" };
  }

  if (!secret) {
    return { kind: "reject", status: 503, error: "OPERATOR_SECRET is not configured" };
  }

  const queryToken = url.searchParams.get(OPERATOR_TOKEN_QUERY_PARAM);
  if (queryToken !== null) {
    if (!tokensEqual(queryToken, secret)) {
      return { kind: "reject", status: 401, error: "unauthorized" };
    }

    return {
      kind: "redirect",
      location: cleanOperatorTokenUrl(url).toString(),
      cookie: await buildOperatorAuthCookie(secret),
    };
  }

  const expectedCookieValue = await operatorSessionCookieValue(secret);
  return tokensEqual(cookieValue, expectedCookieValue) ? { kind: "allow" } : { kind: "reject", status: 401, error: "unauthorized" };
}

export function cleanOperatorTokenUrl(url: URL): URL {
  const cleanUrl = new URL(url.toString());
  cleanUrl.searchParams.delete(OPERATOR_TOKEN_QUERY_PARAM);
  return cleanUrl;
}

async function buildOperatorAuthCookie(secret: string): Promise<OperatorAuthCookie> {
  return {
    name: OPERATOR_AUTH_COOKIE,
    value: await operatorSessionCookieValue(secret),
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
  };
}

async function operatorSessionCookieValue(secret: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`smithers-operator-session:${secret}`),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `v1.${hex}`;
}
