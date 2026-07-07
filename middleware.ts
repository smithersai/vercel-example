import { NextResponse, type NextRequest } from "next/server";
import { configuredSecret } from "@/src/auth";
import { OPERATOR_AUTH_COOKIE, evaluateOperatorAuthRequest } from "@/src/operator-auth";

export async function middleware(request: NextRequest) {
  const decision = await evaluateOperatorAuthRequest(new URL(request.url), {
    cookieValue: request.cookies.get(OPERATOR_AUTH_COOKIE)?.value,
    secret: configuredSecret("OPERATOR_SECRET"),
  });

  if (decision.kind === "public" || decision.kind === "allow") {
    return NextResponse.next();
  }

  if (decision.kind === "redirect") {
    const response = NextResponse.redirect(decision.location);
    response.cookies.set(decision.cookie);
    return response;
  }

  return NextResponse.json({ error: decision.error }, { status: decision.status });
}

export const config = {
  matcher: ["/runs/:path*", "/v1/rpc/:path*", "/v1/api/:path*", "/workflows/:path*", "/health", "/smithers-ws/:path*"],
};
