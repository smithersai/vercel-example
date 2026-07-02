// smithers-source: seeded
/** @jsxImportSource smithers-orchestrator */
import { Panel, type AgentLike } from "smithers-orchestrator";
import { z } from "zod/v4";
import { panelists as defaultPanelists, synthesizer as defaultSynthesizer } from "./roles";
import PlanPrompt from "../prompts/plan.mdx";

// One panelist's plan. Loose so panelists may include extra grounded detail.
export const planOutputSchema = z.looseObject({
  summary: z.string(),
  steps: z.array(z.string()).default([]),
});

// The MODERATOR's synthesized plan — one consolidated plan merged from every
// panelist. MUST be a distinct schema object from planOutputSchema so it
// resolves to its own output channel (channels are keyed by schema identity).
export const planSynthesisSchema = z.looseObject({
  summary: z.string(),
  steps: z.array(z.string()).default([]),
});

type PlanPanelProps = {
  idPrefix: string;
  prompt: unknown;
  /** Panelist planners (run in parallel); defaults to the shared model-diverse pair. */
  panelists?: AgentLike[];
  /** The moderator that synthesizes the plans into one; defaults to the shared synthesizer (usually Codex, with Opus fallback). An AgentLike[] is a failover chain. */
  moderator?: AgentLike | AgentLike[];
  /** Per-panelist plan schema; defaults to planOutputSchema. Pass a workflow's own schema to preserve extra fields (e.g. risks). */
  panelistOutput?: z.ZodObject<any>;
  /** Synthesized plan schema; defaults to planSynthesisSchema. Must be a DISTINCT object from panelistOutput. */
  synthesisOutput?: z.ZodObject<any>;
};

/**
 * <PlanPanel> — a model-diverse planning PANEL that gets SYNTHESIZED. Each
 * panelist plans in parallel (writing the panelist schema), then the moderator
 * merges them into a single synthesized plan at the node `${idPrefix}-moderator`.
 * Read the merged plan from the `planSynthesis` channel at that node id.
 *
 * The workflow must register both the panelist plan schema and
 * `planSynthesis: <synthesis schema>` (moderator) in createSmithers.
 */
// Long-agent task tuning. The published PanelProps does not declare these two props yet
// (the widened type exists upstream); a spread carries them without excess-prop errors —
// the linked runtime honors them, the published one ignores them.
const taskTuning = {
  panelistTaskProps: { continueOnFail: true, timeoutMs: 1_800_000, heartbeatTimeoutMs: 600_000 },
  moderatorTaskProps: { timeoutMs: 1_800_000, heartbeatTimeoutMs: 600_000 },
} as Record<string, unknown>;

export function PlanPanel({
  idPrefix,
  prompt,
  panelists = defaultPanelists,
  moderator = defaultSynthesizer,
  panelistOutput = planOutputSchema,
  synthesisOutput = planSynthesisSchema,
}: PlanPanelProps) {
  const promptText = typeof prompt === "string" ? prompt : JSON.stringify(prompt ?? null);
  return (
    <Panel
      id={idPrefix}
      panelists={panelists}
      // Published PanelProps types moderator as a single AgentLike, but the runtime Task
      // it feeds accepts failover chains (agent?: AgentLike | AgentLike[]); the widened
      // prop type exists upstream and just hasn't shipped yet.
      moderator={moderator as AgentLike}
      panelistOutput={panelistOutput}
      moderatorOutput={synthesisOutput}
      strategy="synthesize"
      {...taskTuning}
    >
      <PlanPrompt prompt={promptText} />
    </Panel>
  );
}
