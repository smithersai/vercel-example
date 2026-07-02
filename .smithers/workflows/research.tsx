// smithers-source: seeded
// smithers-metadata-version: 1
// smithers-display-name: Research
// smithers-description: Gather repository and external context before planning or building.
// smithers-tags: research
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import ResearchPrompt from "../prompts/research.mdx";

const researchOutputSchema = z.looseObject({
  summary: z.string(),
  keyFindings: z.array(z.string()).default([]),
});

// The run's printed output: a deterministic summary of what was found.
const outputSchema = z.looseObject({
  summary: z.string().default(""),
  keyFindings: z.array(z.string()).default([]),
  findingCount: z.number().default(0),
});

const inputSchema = z.object({
  prompt: z.string().default("Research the given topic."),
});

const { Workflow, Task, Sequence, smithers, outputs } = createSmithers({
  input: inputSchema,
  research: researchOutputSchema,
  output: outputSchema,
});

export default smithers((ctx) => {
  const research = ctx.outputMaybe("research", { nodeId: "research" });
  return (
    <Workflow name="research">
      <Sequence>
        <Task id="research" output={researchOutputSchema} agent={agents.smartTool}>
          <ResearchPrompt prompt={ctx.input.prompt} />
        </Task>
        {research ? (
          <Task id="output" output={outputs.output}>
            {() => ({ summary: research.summary, keyFindings: research.keyFindings ?? [], findingCount: (research.keyFindings ?? []).length })}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
