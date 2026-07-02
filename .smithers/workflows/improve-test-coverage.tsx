// smithers-source: seeded
// smithers-metadata-version: 1
// smithers-display-name: Improve Test Coverage
// smithers-description: Find and add high-impact missing tests for the current repository.
// smithers-tags: testing, quality
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import { ValidationLoop, implementOutputSchema, validateOutputSchema } from "../components/ValidationLoop";
import { reviewOutputSchema } from "../components/Review";

// The run's printed output: the tests added and whether they pass + were approved.
const outputSchema = z.looseObject({
  summary: z.string().default(""),
  filesChanged: z.array(z.string()).default([]),
  allTestsPassing: z.boolean().default(false),
  approved: z.boolean().default(false),
});

const inputSchema = z.object({
  prompt: z.string().default("Improve the test coverage for the current repository."),
});

const { Workflow, Task, Sequence, smithers, outputs } = createSmithers({
  input: inputSchema,
  implement: implementOutputSchema,
  validate: validateOutputSchema,
  review: reviewOutputSchema,
  output: outputSchema,
});

export default smithers((ctx) => {
  const impl = ctx.outputs.implement?.at(-1);
  const validate = ctx.outputs.validate?.at(-1);
  const reviews = ctx.outputs.review ?? [];
  const anyApproved = reviews.length > 0 && reviews.some((r: any) => r.approved === true);
  return (
    <Workflow name="improve-test-coverage">
      <Sequence>
        <ValidationLoop
          idPrefix="improve-test-coverage"
          prompt={ctx.input.prompt}
          implementAgents={agents.smartTool}
          validateAgents={agents.cheapFast}
          reviewAgents={agents.smart}
        />
        {impl ? (
          <Task id="output" output={outputs.output}>
            {() => ({ summary: impl.summary ?? "", filesChanged: impl.filesChanged ?? [], allTestsPassing: validate ? validate.allPassed !== false : (impl.allTestsPassing ?? false), approved: anyApproved })}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
