import type { Summary } from "./summary";

export function renderWindowHeader(startIso: string, endIso: string): string {
  return `Summary for ${startIso} to ${endIso}`;
}

export function renderSummary(summary: Summary): string {
  const lines = [renderWindowHeader(summary.window.start, summary.window.end)];

  for (const topic of summary.topics) {
    lines.push("", `* ${topic.title}`);
    if (topic.participants.length > 0) {
      lines.push(`participants: ${topic.participants.join(", ")}`);
    }
    for (const point of topic.points) {
      lines.push(`- ${point}`);
    }
  }

  return lines.join("\n");
}
