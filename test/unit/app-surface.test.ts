import React from "react";
import { describe, expect, it } from "vitest";
import { GET as cronGet, POST as cronPost } from "@/app/api/cron/summary/route";
import { POST as webhookPost } from "@/app/api/telegram/webhook/route";
import { GET as outboxGet } from "@/app/api/test/outbox/route";
import { POST as triggerPost } from "@/app/api/trigger/route";
import RootLayout from "@/app/layout";
import Page from "@/app/page";

describe("app deployable surface", () => {
  it("exposes route handlers wired to the authed factories", async () => {
    for (const handler of [cronGet, cronPost, webhookPost, outboxGet, triggerPost]) {
      expect(handler).toBeTypeOf("function");
    }

    // No secrets configured in this test: every handler must fail closed (401/404/503),
    // proving the app/ exports run the same auth gates as the factories they re-export.
    const cron = await cronGet(new Request("https://example.test/api/cron/summary"));
    expect(cron.status).toBe(503);
    const webhook = await webhookPost(
      new Request("https://example.test/api/telegram/webhook", { method: "POST", body: "{}" }),
    );
    expect(webhook.status).toBe(503);
    const outbox = await outboxGet(new Request("https://example.test/api/test/outbox"));
    expect(outbox.status).toBe(404);
    const trigger = await triggerPost(
      new Request("https://example.test/api/trigger", { method: "POST", body: "{}" }),
    );
    expect(trigger.status).toBe(503);
  });

  it("renders the page and layout server components", () => {
    const page = Page();
    expect(page.type).toBe("main");

    const layout = RootLayout({ children: React.createElement("span") });
    expect(layout.type).toBe("html");
  });
});
