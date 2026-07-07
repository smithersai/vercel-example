import { z } from "zod";

export const SummaryMessageSchema = z.object({
  fromUser: z.string().nullable(),
  text: z.string().nullable(),
  sentAt: z.date(),
});

export const SummaryInputSchema = z.object({
  // Optional: lets a multi-agent pool route reproducibly per chat as well as per window.
  // Absent for callers (and tests) that only supply a window's messages.
  chatId: z.number().optional(),
  windowStart: z.date(),
  windowEnd: z.date(),
  messages: z.array(SummaryMessageSchema),
});

export const SummarySchema = z.object({
  window: z.object({
    start: z.string(),
    end: z.string(),
  }),
  topics: z.array(
    z.object({
      title: z.string(),
      points: z.array(z.string()),
      participants: z.array(z.string()),
    }),
  ),
  // Which summarizer produced this summary — "fixture" for the string-concat fallback,
  // or the pooled SDK agent label (e.g. "anthropic:claude-opus-4-8"). Persisted on the
  // run row so the DB / dashboard shows how work spread across agents.
  agent: z.string().optional(),
});

export type SummaryMessage = z.infer<typeof SummaryMessageSchema>;
export type SummaryInput = z.infer<typeof SummaryInputSchema>;
export type Summary = z.infer<typeof SummarySchema>;

export interface SummarizerPort {
  summarize(input: SummaryInput): Promise<Summary>;
}

export class FixtureSummarizerPort implements SummarizerPort {
  async summarize(input: SummaryInput): Promise<Summary> {
    const participants = Array.from(
      new Set(input.messages.map((message) => message.fromUser).filter((value): value is string => Boolean(value))),
    );
    const points = input.messages.map((message) => message.text).filter((value): value is string => Boolean(value));

    return SummarySchema.parse({
      window: {
        start: input.windowStart.toISOString(),
        end: input.windowEnd.toISOString(),
      },
      topics: [
        {
          title: "Conversation summary",
          points,
          participants,
        },
      ],
      agent: "fixture",
    });
  }
}
