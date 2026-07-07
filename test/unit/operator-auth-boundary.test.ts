import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";
import {
  OPERATOR_AUTH_COOKIE,
  cleanOperatorTokenUrl,
  evaluateOperatorAuthRequest,
  isProtectedOperatorPath,
} from "@/src/operator-auth";

describe("operator UI auth boundary", () => {
  it("classifies the runs dashboard and Smithers gateway paths as protected", () => {
    for (const path of [
      "/runs",
      "/runs/abc",
      "/v1/rpc/runs.list",
      "/v1/api/runs",
      "/v1/api/stream",
      "/workflows/smithering",
      "/health",
      "/smithers-ws",
    ]) {
      expect(isProtectedOperatorPath(path)).toBe(true);
    }
    expect(isProtectedOperatorPath("/api/trigger")).toBe(false);
  });

  it("rejects missing or wrong tokens without issuing a cookie", async () => {
    const missing = await evaluateOperatorAuthRequest(new URL("https://example.test/runs"), {
      cookieValue: undefined,
      secret: "operator-secret",
    });
    expect(missing).toMatchObject({ kind: "reject", status: 401 });

    const wrong = await evaluateOperatorAuthRequest(new URL("https://example.test/runs?token=wrong"), {
      cookieValue: undefined,
      secret: "operator-secret",
    });
    expect(wrong).toMatchObject({ kind: "reject", status: 401 });
  });

  it("validates a token, sets an HttpOnly Secure SameSite=Lax cookie, and redirects to the clean URL", async () => {
    const decision = await evaluateOperatorAuthRequest(
      new URL("https://example.test/runs?token=operator-secret&view=recent"),
      {
        cookieValue: undefined,
        secret: "operator-secret",
      },
    );

    expect(decision.kind).toBe("redirect");
    if (decision.kind !== "redirect") {
      return;
    }
    expect(decision.location).toBe("https://example.test/runs?view=recent");
    expect(decision.cookie).toMatchObject({
      name: OPERATOR_AUTH_COOKIE,
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
    });
    expect(decision.cookie.value).not.toBe("operator-secret");
  });

  it("allows protected paths with a valid cookie", async () => {
    const tokenDecision = await evaluateOperatorAuthRequest(new URL("https://example.test/runs?token=operator-secret"), {
      cookieValue: undefined,
      secret: "operator-secret",
    });
    expect(tokenDecision.kind).toBe("redirect");
    if (tokenDecision.kind !== "redirect") {
      return;
    }

    for (const path of ["/runs", "/v1/rpc/runs.list", "/workflows/smithering", "/health", "/smithers-ws"]) {
      await expect(
        evaluateOperatorAuthRequest(new URL(`https://example.test${path}`), {
          cookieValue: tokenDecision.cookie.value,
          secret: "operator-secret",
        }),
      ).resolves.toEqual({ kind: "allow" });
    }
  });

  it("fails closed when OPERATOR_SECRET is missing", async () => {
    await expect(
      evaluateOperatorAuthRequest(new URL("https://example.test/runs"), {
        cookieValue: undefined,
        secret: undefined,
      }),
    ).resolves.toMatchObject({ kind: "reject", status: 503 });
  });

  it("removes only token from the handoff URL", () => {
    expect(cleanOperatorTokenUrl(new URL("https://example.test/runs?token=secret&run=123")).toString()).toBe(
      "https://example.test/runs?run=123",
    );
  });

  it("wires the Next middleware redirect and cookie attributes", async () => {
    process.env.OPERATOR_SECRET = "operator-secret";
    const response = await middleware(new NextRequest("https://example.test/runs?token=operator-secret"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://example.test/runs");
    const setCookie = response.headers.get("set-cookie");
    expect(setCookie).toContain(`${OPERATOR_AUTH_COOKIE}=`);
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=lax");
    expect(setCookie).not.toContain("operator-secret");
  });
});
