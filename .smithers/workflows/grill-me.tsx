// smithers-source: seeded
// smithers-metadata-version: 1
// smithers-display-name: Grill Me
// smithers-description: Ask targeted questions until vague requirements become actionable.
// smithers-tags: requirements, planning
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import { GrillMe, grillOutputSchema } from "../components/GrillMe";

const WORKFLOW_ID = "grill-me";

// The run's printed output: whether the requirements got resolved and the
// shared understanding reached, so a finished run reports the outcome.
const outputSchema = z.looseObject({
  resolved: z.boolean().default(false),
  questionsAsked: z.number().default(0),
  sharedUnderstanding: z.string().nullable().default(null),
  recommendedAnswer: z.string().nullable().default(null),
});

const { Workflow, Task, Sequence, smithers, outputs } = createSmithers({
  input: z.object({
    prompt: z.string().default("Describe what you want to get grilled on."),
    maxIterations: z.number().int().default(30),
  }),
  grill: grillOutputSchema,
  output: outputSchema,
});

export default smithers((ctx) => {
  const grill = ctx.outputs.grill?.at(-1);
  return (
    <Workflow name={WORKFLOW_ID}>
      <Sequence>
        <GrillMe
          idPrefix={WORKFLOW_ID}
          context={ctx.input.prompt}
          agent={agents.smart}
          output={outputs.grill}
          maxIterations={ctx.input.maxIterations}
        />
        {grill ? (
          <Task id="output" output={outputs.output}>
            {() => ({ resolved: grill.resolved === true, questionsAsked: grill.questionsAsked ?? 0, sharedUnderstanding: grill.sharedUnderstanding ?? null, recommendedAnswer: grill.recommendedAnswer ?? null })}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
