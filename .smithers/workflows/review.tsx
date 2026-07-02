// smithers-source: seeded
// smithers-metadata-version: 1
// smithers-display-name: Review
// smithers-description: Review current repository changes with one or more configured agents.
// smithers-tags: review, quality
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import { ReviewPanel, reviewOutputSchema, reviewSynthesisSchema } from "../components/Review";
import { panelists } from "../components/roles";

// The run's printed output: a deterministic verdict aggregated across every
// reviewer, so a finished run reports the outcome instead of `output: null`.
const outputSchema = z.looseObject({
  reviewers: z.number().default(0),
  approved: z.boolean().default(false),
  totalIssues: z.number().default(0),
  criticalIssues: z.number().default(0),
});

const inputSchema = z.object({
  prompt: z.string().default("Review the current repository changes."),
});

const { Workflow, Task, Sequence, smithers, outputs } = createSmithers({
  input: inputSchema,
  review: reviewOutputSchema,
  reviewSynthesis: reviewSynthesisSchema,
  output: outputSchema,
});

export default smithers((ctx) => {
  const reviews = ctx.outputs.review ?? [];
  const verdict = ctx.outputMaybe("reviewSynthesis", { nodeId: "review-moderator" });
  const verdictIssues = (verdict?.issues ?? []) as any[];
  return (
    <Workflow name="review">
      <Sequence>
        <ReviewPanel
          idPrefix="review"
          prompt={ctx.input.prompt}
          agents={panelists}
        />
        {verdict ? (
          <Task id="output" output={outputs.output}>
            {() => ({
              reviewers: reviews.length,
              approved: verdict?.approved === true,
              totalIssues: verdictIssues.length,
              criticalIssues: verdictIssues.filter((i: any) => i.severity === "critical").length,
            })}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
