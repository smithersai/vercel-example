// smithers-source: seeded
// smithers-metadata-version: 1
// smithers-display-name: Plan
// smithers-description: Create a practical implementation plan before code changes begin.
// smithers-tags: planning
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import { PlanPanel, planOutputSchema, planSynthesisSchema } from "../components/PlanPanel";

// The run's printed output: a deterministic summary of the plan produced,
// so a finished run reports what it did instead of `output: null`.
const outputSchema = z.looseObject({
  summary: z.string().default(""),
  steps: z.array(z.string()).default([]),
  stepCount: z.number().default(0),
});

const inputSchema = z.object({
  prompt: z.string().default("Create an implementation plan."),
});

const { Workflow, Task, Sequence, smithers, outputs } = createSmithers({
  input: inputSchema,
  plan: planOutputSchema,
  planSynthesis: planSynthesisSchema,
  output: outputSchema,
});

export default smithers((ctx) => {
  const plan = ctx.outputMaybe("planSynthesis", { nodeId: "plan-moderator" });
  return (
    <Workflow name="plan">
      <Sequence>
        <PlanPanel idPrefix="plan" prompt={ctx.input.prompt} />
        {plan ? (
          <Task id="output" output={outputs.output}>
            {() => ({ summary: plan.summary, steps: plan.steps ?? [], stepCount: (plan.steps ?? []).length })}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
