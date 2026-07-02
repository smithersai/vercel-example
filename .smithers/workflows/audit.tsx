// smithers-source: seeded
// smithers-metadata-version: 1
// smithers-display-name: Audit
// smithers-description: Audit feature groups for tests, docs, observability, and maintainability gaps.
// smithers-tags: audit, quality
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import { ForEachFeature, forEachFeatureMergeSchema, forEachFeatureResultSchema } from "../components/ForEachFeature";
import AuditPrompt from "../prompts/audit.mdx";

// The run's printed output: how many feature groups were audited, plus the summary.
const outputSchema = z.looseObject({
  totalGroups: z.number().default(0),
  summary: z.string().default(""),
});

const inputSchema = z.object({
  features: z.record(z.string(), z.array(z.string())).default({}),
  focus: z.string().default("code review"),
  additionalContext: z.string().nullable().default(null),
  maxConcurrency: z.number().int().default(5),
});

const { Workflow, Task, Sequence, smithers, outputs } = createSmithers({
  input: inputSchema,
  auditFeature: forEachFeatureResultSchema,
  audit: forEachFeatureMergeSchema,
  output: outputSchema,
});

export default smithers((ctx) => {
  const merge = ctx.outputMaybe("audit", { nodeId: "audit:merge" });
  return (
    <Workflow name="audit">
      <Sequence>
        <ForEachFeature
          idPrefix="audit"
          agent={agents.smart}
          features={ctx.input.features}
          prompt={<AuditPrompt focus={ctx.input.focus} additionalContext={ctx.input.additionalContext} />}
          maxConcurrency={ctx.input.maxConcurrency}
          mergeAgent={agents.smart}
        />
        {merge ? (
          <Task id="output" output={outputs.output}>
            {() => ({ totalGroups: merge.totalGroups ?? 0, summary: merge.summary ?? "" })}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
