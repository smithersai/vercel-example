// Extracts a ```sql ... ``` fenced block from markdown text.
// Returns null (early exit) when no valid sql fence is present.
export function extractSqlFence(markdown: string): string | null {
  const start = markdown.indexOf("```sql");
  if (start === -1) {
    return null; // branch A: no opening fence
  }

  const bodyStart = markdown.indexOf("\n", start);
  if (bodyStart === -1) {
    return null; // branch B: opening fence has no newline (malformed)
  }

  const end = markdown.indexOf("```", bodyStart);
  if (end === -1) {
    return null; // branch C: no closing fence
  }

  const body = markdown.slice(bodyStart + 1, end).trim();
  if (body.length === 0) {
    return null; // branch D: empty sql body
  }

  return body; // branch E: happy path
}
