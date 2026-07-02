// smithers-source: seeded
// smithers-metadata-version: 1
// smithers-display-name: Feature Enum
// smithers-description: Build or refine a code-backed feature inventory for a repository.
// smithers-tags: audit, inventory
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import { FeatureEnum, featureEnumOutputSchema } from "../components/FeatureEnum";

// The run's printed output: how many features were inventoried, in how many groups.
const outputSchema = z.looseObject({
  totalFeatures: z.number().default(0),
  groupCount: z.number().default(0),
});

const inputSchema = z.object({
  refineIterations: z.number().int().default(1),
  existingFeatures: z.record(z.string(), z.array(z.string())).nullable().default(null),
  lastCommitHash: z.string().nullable().default(null),
  additionalContext: z.string().default(""),
});

const { Workflow, Task, Sequence, smithers, outputs } = createSmithers({
  input: inputSchema,
  featureEnum: featureEnumOutputSchema,
  output: outputSchema,
});

export default smithers((ctx) => {
  const result = ctx.outputMaybe("featureEnum", { nodeId: "feature-enum:result" });
  return (
    <Workflow name="feature-enum">
      <Sequence>
        <FeatureEnum
          idPrefix="feature-enum"
          agent={agents.smartTool}
          refineIterations={ctx.input.refineIterations}
          existingFeatures={ctx.input.existingFeatures}
          lastCommitHash={ctx.input.lastCommitHash}
          additionalContext={ctx.input.additionalContext}
        />
        {result ? (
          <Task id="output" output={outputs.output}>
            {() => ({ totalFeatures: result.totalFeatures ?? 0, groupCount: Object.keys(result.featureGroups ?? {}).length })}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
