// smithers-source: seeded
// smithers-metadata-version: 1
// smithers-display-name: Tickets Create
// smithers-description: Break a larger request into multiple implementable tickets.
// smithers-tags: tickets, planning
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import TicketsCreatePrompt from "../prompts/tickets-create.mdx";

const ticketsCreateOutputSchema = z.looseObject({
  summary: z.string(),
  tickets: z.array(z.object({
    title: z.string(),
    description: z.string(),
    acceptanceCriteria: z.array(z.string()).default([]),
  })).default([]),
});

// The run's printed output: how many tickets, with their titles.
const outputSchema = z.looseObject({
  summary: z.string().default(""),
  ticketCount: z.number().default(0),
  titles: z.array(z.string()).default([]),
});

const inputSchema = z.object({
  prompt: z.string().default("Create tickets for the requested work."),
});

const { Workflow, Task, Sequence, smithers, outputs } = createSmithers({
  input: inputSchema,
  tickets: ticketsCreateOutputSchema,
  output: outputSchema,
});

export default smithers((ctx) => {
  const result = ctx.outputMaybe("tickets", { nodeId: "tickets" });
  return (
    <Workflow name="tickets-create">
      <Sequence>
        <Task id="tickets" output={ticketsCreateOutputSchema} agent={agents.smart}>
          <TicketsCreatePrompt prompt={ctx.input.prompt} />
        </Task>
        {result ? (
          <Task id="output" output={outputs.output}>
            {() => ({ summary: result.summary, ticketCount: (result.tickets ?? []).length, titles: (result.tickets ?? []).map((t: any) => t.title) })}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
