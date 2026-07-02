// smithers-source: seeded
// smithers-metadata-version: 1
// smithers-display-name: Ticket Create
// smithers-description: Turn a request into one structured implementation ticket.
// smithers-tags: tickets, planning
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import TicketPrompt from "../prompts/ticket.mdx";

const ticketCreateOutputSchema = z.looseObject({
  title: z.string(),
  description: z.string(),
  acceptanceCriteria: z.array(z.string()).default([]),
});

// The run's printed output: the ticket's title + acceptance-criteria count.
const outputSchema = z.looseObject({
  title: z.string().default(""),
  acceptanceCriteria: z.array(z.string()).default([]),
  acceptanceCriteriaCount: z.number().default(0),
});

const inputSchema = z.object({
  prompt: z.string().default("Create a ticket for the requested work."),
});

const { Workflow, Task, Sequence, smithers, outputs } = createSmithers({
  input: inputSchema,
  ticket: ticketCreateOutputSchema,
  output: outputSchema,
});

export default smithers((ctx) => {
  const ticket = ctx.outputMaybe("ticket", { nodeId: "ticket" });
  return (
    <Workflow name="ticket-create">
      <Sequence>
        <Task id="ticket" output={ticketCreateOutputSchema} agent={agents.smart}>
          <TicketPrompt prompt={ctx.input.prompt} />
        </Task>
        {ticket ? (
          <Task id="output" output={outputs.output}>
            {() => ({ title: ticket.title, acceptanceCriteria: ticket.acceptanceCriteria ?? [], acceptanceCriteriaCount: (ticket.acceptanceCriteria ?? []).length })}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
