// smithers-source: seeded
// smithers-metadata-version: 1
// smithers-display-name: Implement
// smithers-description: Implement a focused change with validation and review feedback loops.
// smithers-tags: coding, implementation, review
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import { ValidationLoop, implementOutputSchema, validateOutputSchema } from "../components/ValidationLoop";
import { reviewOutputSchema, reviewSynthesisSchema, reviewGate } from "../components/Review";
import { implementer, panelists } from "../components/roles";

// The run's printed output: what the implementation changed and whether it
// validated + was approved, so a finished run reports the result.
const outputSchema = z.looseObject({
  summary: z.string().default(""),
  filesChanged: z.array(z.string()).default([]),
  allTestsPassing: z.boolean().default(false),
  approved: z.boolean().default(false),
});

const inputSchema = z.object({
  prompt: z.string().default("Implement the requested change."),
});

const { Workflow, Task, Sequence, smithers, outputs } = createSmithers({
  input: inputSchema,
  implement: implementOutputSchema,
  validate: validateOutputSchema,
  review: reviewOutputSchema,
  reviewSynthesis: reviewSynthesisSchema,
  output: outputSchema,
});

export default smithers((ctx) => {
  const validate = ctx.outputMaybe("validate", { nodeId: "impl:validate" });
  const impl = ctx.outputs.implement?.at(-1);

  // done = false until validate has run AND passed, AND the synthesized review verdict approved.
  const hasValidated = validate !== undefined;
  const validationPassed = hasValidated && validate.allPassed !== false;
  const gate = reviewGate(ctx, "impl:review-moderator");
  const anyApproved = gate.approved;
  const done = validationPassed && anyApproved;

  const feedbackParts: string[] = [];
  if (validate && !validationPassed && validate.failingSummary) {
    feedbackParts.push(`VALIDATION FAILED:\n${validate.failingSummary}`);
  }
  if (gate.feedback) {
    feedbackParts.push(`REVIEW PANEL REJECTED:\n${gate.feedback}`);
  }
  const feedback = feedbackParts.length > 0 ? feedbackParts.join("\n\n") : null;

  return (
    <Workflow name="implement">
      <Sequence>
        <ValidationLoop
          idPrefix="impl"
          prompt={ctx.input.prompt}
          implementAgents={implementer}
          validateAgents={agents.cheapFast}
          reviewAgents={panelists}
          synthesizeReview
          feedback={feedback}
          done={done}
          maxIterations={3}
        />
        {impl ? (
          <Task id="output" output={outputs.output}>
            {() => ({
              summary: impl.summary ?? "",
              filesChanged: impl.filesChanged ?? [],
              allTestsPassing: validate ? validate.allPassed !== false : (impl.allTestsPassing ?? false),
              approved: anyApproved,
            })}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
