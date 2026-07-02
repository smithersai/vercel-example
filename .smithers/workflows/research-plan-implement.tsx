// smithers-source: seeded
// smithers-metadata-version: 1
// smithers-display-name: Research Plan Implement
// smithers-description: Research a request, produce a plan, then implement it with validation and review.
// smithers-tags: research, planning, coding
// smithers-aliases: rpi
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import { ValidationLoop, implementOutputSchema, validateOutputSchema } from "../components/ValidationLoop";
import { reviewOutputSchema, reviewSynthesisSchema, reviewGate } from "../components/Review";
import { implementer, panelists } from "../components/roles";
import ResearchPrompt from "../prompts/research.mdx";
import { PlanPanel, planOutputSchema, planSynthesisSchema } from "../components/PlanPanel";

const researchOutputSchema = z.looseObject({
  summary: z.string(),
  keyFindings: z.array(z.string()).default([]),
});

// The run's printed output: research + plan size, files changed, validated, approved.
const outputSchema = z.looseObject({
  summary: z.string().default(""),
  filesChanged: z.array(z.string()).default([]),
  planSteps: z.number().default(0),
  allTestsPassing: z.boolean().default(false),
  approved: z.boolean().default(false),
});

const inputSchema = z.object({
  prompt: z.string().default("Implement the requested change."),
  tdd: z.boolean().default(false),
});

const { Workflow, Task, Sequence, smithers, outputs } = createSmithers({
  input: inputSchema,
  research: researchOutputSchema,
  plan: planOutputSchema,
  planSynthesis: planSynthesisSchema,
  implement: implementOutputSchema,
  validate: validateOutputSchema,
  review: reviewOutputSchema,
  reviewSynthesis: reviewSynthesisSchema,
  output: outputSchema,
});

export default smithers((ctx) => {
  const prompt = ctx.input.prompt;
  const tdd = ctx.input.tdd;

  const research = ctx.outputMaybe("research", { nodeId: "research" });
  const plan = ctx.outputMaybe("planSynthesis", { nodeId: "plan-moderator" });
  const impl = ctx.outputs.implement?.at(-1);

  // Enrich plan prompt with research findings
  const planPromptParts = [
    prompt,
    research
      ? `RESEARCH FINDINGS:\n${research.summary}\n\nKey findings:\n${research.keyFindings.map((f: string) => `- ${f}`).join("\n")}`
      : null,
    tdd
      ? "IMPORTANT: Write tests FIRST. The plan MUST start with test steps before any implementation steps. Follow test-driven development: define expected behavior in tests, then implement to make them pass."
      : null,
  ];
  const planPrompt = planPromptParts.filter(Boolean).join("\n\n---\n");

  // Enrich implement prompt with both research and plan
  const implementPrompt = [
    prompt,
    research ? `RESEARCH FINDINGS:\n${research.summary}\n\nKey findings:\n${research.keyFindings.map((f: string) => `- ${f}`).join("\n")}` : null,
    plan ? `IMPLEMENTATION PLAN:\n${plan.summary}\n\nSteps:\n${plan.steps.map((s: string, i: number) => `${i + 1}. ${s}`).join("\n")}` : null,
    tdd ? "IMPORTANT: Follow the plan's test-first approach. Write or update tests before implementing production code." : null,
  ].filter(Boolean).join("\n\n---\n");

  // Validation loop feedback
  const validate = ctx.outputMaybe("validate", { nodeId: "impl:validate" });

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
    <Workflow name="research-plan-implement">
      <Sequence>
        <Task id="research" output={researchOutputSchema} agent={agents.smartTool}>
          <ResearchPrompt prompt={prompt} />
        </Task>
        <PlanPanel idPrefix="plan" prompt={planPrompt} />
        <ValidationLoop
          idPrefix="impl"
          prompt={implementPrompt}
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
              planSteps: (plan?.steps ?? []).length,
              allTestsPassing: validate ? validate.allPassed !== false : (impl.allTestsPassing ?? false),
              approved: anyApproved,
            })}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
