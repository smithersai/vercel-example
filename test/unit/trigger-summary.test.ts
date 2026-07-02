import { describe, expect, it } from "vitest";
import { triggerSummary, type ClaimRunArgs, type TriggerContainer } from "@/src/pipeline";

class AtomicFakeClaimer {
  private runId: number | undefined;

  async claimRun(_args: ClaimRunArgs): Promise<{ runId: number; claimed: boolean }> {
    if (this.runId != null) {
      return { runId: this.runId, claimed: false };
    }
    this.runId = 501;
    return { runId: this.runId, claimed: true };
  }
}

describe("triggerSummary", () => {
  it("only enqueues the run and never executes inline", async () => {
    const invocations: number[] = [];
    const container: TriggerContainer = {
      runClaimer: new AtomicFakeClaimer(),
      invoker: {
        async invokeExecutor(runId: number) {
          invocations.push(runId);
          await new Promise((resolve) => setTimeout(resolve, 5));
        },
      },
    };
    const args: ClaimRunArgs = {
      chatId: 42,
      windowStart: new Date("2026-07-02T00:00:00.000Z"),
      windowEnd: new Date("2026-07-02T01:00:00.000Z"),
      trigger: "manual",
    };

    const [first, second] = await Promise.all([triggerSummary(container, args), triggerSummary(container, args)]);

    expect(first.runId).toBe(501);
    expect(second.runId).toBe(501);
    expect([first.claimed, second.claimed].sort()).toEqual([false, true]);
    expect(invocations).toEqual([]);
  });
});
