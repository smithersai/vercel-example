import { z } from "zod";
// Import the SDK agents from the agents package directly, not the `smithers-orchestrator`
// umbrella entry: the umbrella transitively pulls in bun-only modules (bun:sqlite) that a
// Vercel Node function / vitest cannot load. The agents package is a plain-HTTPS, bun-free
// slice — the only part we need here.
import { AnthropicAgent, OpenAIAgent } from "@smithers-orchestrator/agents";
import { SummarySchema, type Summary, type SummarizerPort, type SummaryInput } from "./summary";

// The structured shape we ask each SDK agent to emit. Kept small and grounded so the
// model produces a real, typed summary rather than free-form prose.
export const AgentSummaryOutputSchema = z.object({
  tldr: z.string(),
  points: z.array(z.string()),
  participants: z.array(z.string()),
});

export type AgentSummaryOutput = z.infer<typeof AgentSummaryOutputSchema>;

// A summarizer backed by a single in-process SDK agent. `label` identifies which model
// handled a run so the variety is recorded and reproducible.
export interface PooledSummaryAgent {
  readonly label: string;
  generate(prompt: string, schema: z.ZodTypeAny): Promise<unknown>;
}

// The narrow slice of the smithers SDK-agent surface this app depends on: a `generate`
// that accepts a prompt + a zod output schema and resolves a structured `output`.
// `AnthropicAgent` / `OpenAIAgent` (AI SDK ToolLoopAgent subclasses) satisfy this.
export interface SdkGenerativeAgent {
  generate(args: { prompt: string; outputSchema: z.ZodTypeAny }): Promise<{ output: unknown }>;
}

const SYSTEM_INSTRUCTIONS =
  "You summarize a window of group-chat messages. Produce a faithful, grounded summary: " +
  "a one-line tl;dr, the key discussion points, and the participants who spoke. " +
  "Only use information present in the transcript; never invent details.";

function buildPrompt(window: { start: string; end: string }, transcript: string): string {
  return [
    `Summarize this chat window (${window.start} to ${window.end}).`,
    "",
    "Transcript:",
    transcript,
  ].join("\n");
}

// Wrap any SDK agent that follows the `generate({ prompt, outputSchema })` contract into
// a labelled pool entry. Exported so it can be unit-tested with a fake agent (no network).
export function toPooledAgent(label: string, agent: SdkGenerativeAgent): PooledSummaryAgent {
  return {
    label,
    async generate(prompt, schema) {
      const result = await agent.generate({ prompt, outputSchema: schema });
      return result.output;
    },
  };
}

function compact(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

// Default model ids for the pool. Override via SUMMARY_ANTHROPIC_MODELS /
// SUMMARY_OPENAI_MODELS (comma-separated) so a deployment can pin exact/current
// models without a code change. The first id is the primary; a second id is used
// to spread work when only one provider is configured.
const DEFAULT_ANTHROPIC_MODELS = ["claude-opus-4-8", "claude-haiku-4-5"];
const DEFAULT_OPENAI_MODELS = ["gpt-4o", "gpt-4o-mini"];

function modelsFromEnv(value: string | undefined, fallback: readonly string[]): string[] {
  const parsed = compact(value)
    ?.split(",")
    .map((m) => m.trim())
    .filter((m) => m.length > 0);
  return parsed && parsed.length > 0 ? parsed : [...fallback];
}

// Build the pool of in-process SDK summarizer agents from the environment.
//
// Serverless correctness: these are SDK agents (plain HTTPS calls, no subprocess), never
// CLI agents — a Vercel Node function has no container to spawn a vendor binary in.
//
// Variety ("scale tasks across a variety of agents"): with both provider keys the pool
// spans an Anthropic model and an OpenAI model; with a single provider it still spans two
// distinct models of that provider, so summarization work demonstrably spreads either way.
// No keys → empty pool (caller falls back to the fixture).
export function buildAgentPool(env: NodeJS.ProcessEnv = process.env): PooledSummaryAgent[] {
  const anthropicKey = compact(env.ANTHROPIC_API_KEY);
  const openaiKey = compact(env.OPENAI_API_KEY);
  const anthropicModels = modelsFromEnv(env.SUMMARY_ANTHROPIC_MODELS, DEFAULT_ANTHROPIC_MODELS);
  const openaiModels = modelsFromEnv(env.SUMMARY_OPENAI_MODELS, DEFAULT_OPENAI_MODELS);
  const anthropicAgent = (model: string) =>
    toPooledAgent(`anthropic:${model}`, new AnthropicAgent({ model, instructions: SYSTEM_INSTRUCTIONS }));
  const openaiAgent = (model: string) =>
    toPooledAgent(`openai:${model}`, new OpenAIAgent({ model, instructions: SYSTEM_INSTRUCTIONS }));
  const pool: PooledSummaryAgent[] = [];

  if (anthropicKey) pool.push(anthropicAgent(anthropicModels[0]));
  if (openaiKey) pool.push(openaiAgent(openaiModels[0]));

  // With only one provider configured, add a second distinct model of that
  // provider so the pool still spreads across agents (skip when only one model
  // id was configured for it).
  if (pool.length === 1) {
    if (anthropicKey && anthropicModels[1]) pool.push(anthropicAgent(anthropicModels[1]));
    else if (openaiKey && openaiModels[1]) pool.push(openaiAgent(openaiModels[1]));
  }

  return pool;
}

export class AgentSummarizerPort implements SummarizerPort {
  private readonly agents: readonly PooledSummaryAgent[];

  constructor(agents: readonly PooledSummaryAgent[]) {
    if (agents.length === 0) {
      throw new Error("AgentSummarizerPort requires at least one pooled agent");
    }
    this.agents = agents;
  }

  // Deterministic FNV-1a routing over chatId + window. Same input → same agent (reproducible),
  // and different inputs spread across the pool.
  private route(input: SummaryInput): PooledSummaryAgent {
    const key = `${input.chatId ?? ""}:${input.windowStart.toISOString()}:${input.windowEnd.toISOString()}`;
    let hash = 2166136261;
    for (let index = 0; index < key.length; index += 1) {
      hash ^= key.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return this.agents[(hash >>> 0) % this.agents.length];
  }

  async summarize(input: SummaryInput): Promise<Summary> {
    const agent = this.route(input);
    const window = {
      start: input.windowStart.toISOString(),
      end: input.windowEnd.toISOString(),
    };

    const grounded = input.messages.filter((message) => (message.text ?? "").trim().length > 0);
    if (grounded.length === 0) {
      // Nothing to summarize — don't spend a model call on an empty window.
      return SummarySchema.parse({
        window,
        topics: [{ title: "No messages in this window", points: [], participants: [] }],
        agent: agent.label,
      });
    }

    const transcript = grounded
      .map((message) => `${message.fromUser ?? "unknown"}: ${message.text}`)
      .join("\n");

    const raw = await agent.generate(buildPrompt(window, transcript), AgentSummaryOutputSchema);
    const structured = AgentSummaryOutputSchema.parse(raw);

    return SummarySchema.parse({
      window,
      topics: [
        {
          title: structured.tldr.trim() || "Conversation summary",
          points: structured.points,
          participants: structured.participants,
        },
      ],
      agent: agent.label,
    });
  }
}
