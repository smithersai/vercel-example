import { describe, expect, it } from "vitest";
import { extractSqlFence } from "./sqlFence";

describe("extractSqlFence", () => {
  it("branch A: returns null when no opening fence", () => {
    expect(extractSqlFence("no fence here")).toBeNull();
  });

  it("branch C: returns null when no closing fence", () => {
    expect(extractSqlFence("```sql\nselect 1;")).toBeNull();
  });

  it("branch E: returns trimmed body on happy path", () => {
    expect(extractSqlFence("```sql\nselect 1;\n```")).toBe("select 1;");
  });

  it("branch B: returns null when opening fence has no trailing newline", () => {
    expect(extractSqlFence("```sql")).toBeNull();
  });

  it("branch D: returns null when sql body is empty", () => {
    expect(extractSqlFence("```sql\n\n```")).toBeNull();
  });
});
