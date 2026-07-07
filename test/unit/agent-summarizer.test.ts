import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AgentSummarizerPort,
  AgentSummaryOutputSchema,
  buildAgentPool,
  toPooledAgent,
  type PooledSummaryAgent,
  type SdkGenerativeAgent,
} from "@/src/agentSummarizer";
import { renderSummary } from "@/src/render";
import type { SummaryInput } from "@/src/summary";

// A deterministic in-memory pool agent that records the prompts it was asked to summarize.
// This is the DI test seam: no network, no SDK, same generate(prompt, schema) contract.
class FakePooledAgent implements PooledSummaryAgent {
  readonly calls: string[] = [];

  constructor(
    readonly label: string,
    private readonly output: z.infer<typeof AgentSummaryOutputSchema>,
  ) {}

  async generate(prompt: string, schema: z.ZodTypeAny): Promise<unknown> {
    this.calls.push(prompt);
    // Prove the port passes a usable schema through by validating our canned output against it.
    return schema.parse(this.output);
  }
}

function inputFor(chatId: number, hour: number): SummaryInput {
  const start = new Date(Date.UTC(2026, 6, 2, hour, 0, 0));
  const end = new Date(Date.UTC(2026, 6, 2, hour + 1, 0, 0));
  return {
    chatId,
    windowStart: start,
    windowEnd: end,
    messages: [
      { fromUser: "alice", text: "ship the release", sentAt: new Date(start.getTime() + 60_000) },
      { fromUser: "bob", text: "verified on staging", sentAt: new Date(start.getTime() + 120_000) },
    ],
  };
}

describe("AgentSummarizerPort routing", () => {
  it("spreads summarization across >=2 distinct agents for different inputs, reproducibly", async () => {
    const agentA = new FakePooledAgent("fake:alpha", {
      tldr: "release shipped",
      points: ["ship the release"],
      participants: ["alice"],
    });
    const agentB = new FakePooledAgent("fake:beta", {
      tldr: "verified",
      points: ["verified on staging"],
      participants: ["bob"],
    });
    const port = new AgentSummarizerPort([agentA, agentB]);

    const handled = new Set<string>();
    for (let chatId = 1; chatId <= 12; chatId += 1) {
      const summary = await port.summarize(inputFor(chatId, 0));
      expect(summary.agent).toBeDefined();
      handled.add(summary.agent as string);
    }

    // Both agents in the pool must have handled at least one input — proving the load
    // genuinely spreads rather than always hitting the first agent.
    expect(handled).toEqual(new Set(["fake:alpha", "fake:beta"]));

    // Deterministic: the same input routes to the same agent every time.
    const first = await port.summarize(inputFor(7, 3));
    const again = await port.summarize(inputFor(7, 3));
    expect(again.agent).toBe(first.agent);
  });

  it("maps the agent's structured output into a renderable grounded summary", async () => {
    const agent = new FakePooledAgent("fake:alpha", {
      tldr: "team shipped and verified the release",
      points: ["ship the release", "verified on staging"],
      participants: ["alice", "bob"],
    });
    const port = new AgentSummarizerPort([agent]);

    const summary = await port.summarize(inputFor(42, 0));
    expect(summary.agent).toBe("fake:alpha");
    expect(summary.topics[0].title).toBe("team shipped and verified the release");
    expect(summary.topics[0].participants).toEqual(["alice", "bob"]);

    const rendered = renderSummary(summary);
    expect(rendered).toContain("- ship the release");
    expect(rendered).toContain("- verified on staging");
    // A real model call was made for a non-empty window.
    expect(agent.calls).toHaveLength(1);
    expect(agent.calls[0]).toContain("alice: ship the release");
  });

  it("short-circuits empty windows without invoking the model", async () => {
    const agent = new FakePooledAgent("fake:alpha", { tldr: "", points: [], participants: [] });
    const port = new AgentSummarizerPort([agent]);

    const summary = await port.summarize({
      chatId: 1,
      windowStart: new Date("2026-07-02T00:00:00.000Z"),
      windowEnd: new Date("2026-07-02T01:00:00.000Z"),
      messages: [{ fromUser: null, text: null, sentAt: new Date("2026-07-02T00:05:00.000Z") }],
    });

    expect(agent.calls).toHaveLength(0);
    expect(summary.agent).toBe("fake:alpha");
    expect(summary.topics[0].title).toBe("No messages in this window");
    expect(summary.topics[0].points).toEqual([]);
  });

  it("rejects an empty pool", () => {
    expect(() => new AgentSummarizerPort([])).toThrow(/at least one/);
  });

  it("falls back to a default title when the model returns an empty tl;dr", async () => {
    const agent = new FakePooledAgent("fake:alpha", {
      tldr: "   ",
      points: ["a point"],
      participants: ["alice"],
    });
    const port = new AgentSummarizerPort([agent]);
    const summary = await port.summarize(inputFor(3, 0));
    expect(summary.topics[0].title).toBe("Conversation summary");
  });
});

describe("toPooledAgent", () => {
  it("adapts an SDK generate({ prompt, outputSchema }) contract and reads .output", async () => {
    const captured: Array<{ prompt: string }> = [];
    const fakeSdkAgent: SdkGenerativeAgent = {
      async generate(args) {
        captured.push({ prompt: args.prompt });
        return { output: { tldr: "ok", points: [], participants: [] } };
      },
    };

    const pooled = toPooledAgent("sdk:test", fakeSdkAgent);
    expect(pooled.label).toBe("sdk:test");

    const result = await pooled.generate("summarize this", AgentSummaryOutputSchema);
    expect(AgentSummaryOutputSchema.parse(result).tldr).toBe("ok");
    expect(captured[0].prompt).toBe("summarize this");
  });
});

describe("buildAgentPool", () => {
  it("returns an empty pool when no provider keys are set", () => {
    expect(buildAgentPool({} as NodeJS.ProcessEnv)).toEqual([]);
  });

  it("spans an Anthropic and an OpenAI agent when both keys are present", () => {
    const pool = buildAgentPool({ ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o" } as NodeJS.ProcessEnv);
    const labels = pool.map((agent) => agent.label);
    expect(labels).toEqual(["anthropic:claude-opus-4-8", "openai:gpt-4o"]);
  });

  it("still spans two distinct models with only the Anthropic key", () => {
    const pool = buildAgentPool({ ANTHROPIC_API_KEY: "a" } as NodeJS.ProcessEnv);
    const labels = pool.map((agent) => agent.label);
    expect(labels).toEqual(["anthropic:claude-opus-4-8", "anthropic:claude-haiku-4-5"]);
    expect(new Set(labels).size).toBe(2);
  });

  it("still spans two distinct models with only the OpenAI key", () => {
    const pool = buildAgentPool({ OPENAI_API_KEY: "o" } as NodeJS.ProcessEnv);
    const labels = pool.map((agent) => agent.label);
    expect(labels).toEqual(["openai:gpt-4o", "openai:gpt-4o-mini"]);
    expect(new Set(labels).size).toBe(2);
  });

  it("ignores blank keys", () => {
    expect(buildAgentPool({ ANTHROPIC_API_KEY: "   ", OPENAI_API_KEY: "" } as NodeJS.ProcessEnv)).toEqual([]);
  });

  it("pins model ids from SUMMARY_*_MODELS env overrides", () => {
    const pool = buildAgentPool({
      ANTHROPIC_API_KEY: "a",
      OPENAI_API_KEY: "o",
      SUMMARY_ANTHROPIC_MODELS: "claude-5-custom",
      SUMMARY_OPENAI_MODELS: "gpt-5.5, gpt-5.5-mini",
    } as NodeJS.ProcessEnv);
    expect(pool.map((agent) => agent.label)).toEqual(["anthropic:claude-5-custom", "openai:gpt-5.5"]);
  });

  it("spreads across two overridden models when only one provider is set", () => {
    const pool = buildAgentPool({
      OPENAI_API_KEY: "o",
      SUMMARY_OPENAI_MODELS: "gpt-5.5,gpt-5.5-mini",
    } as NodeJS.ProcessEnv);
    expect(pool.map((agent) => agent.label)).toEqual(["openai:gpt-5.5", "openai:gpt-5.5-mini"]);
  });

  it("does not fabricate a second model when only one override id is given", () => {
    const pool = buildAgentPool({
      ANTHROPIC_API_KEY: "a",
      SUMMARY_ANTHROPIC_MODELS: "solo-model",
    } as NodeJS.ProcessEnv);
    expect(pool.map((agent) => agent.label)).toEqual(["anthropic:solo-model"]);
  });
});
