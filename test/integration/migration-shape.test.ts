import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = join(process.cwd(), "db", "migrations", "001_core.sql");

describe("core migration shape", () => {
  it("defines the durable tables and idempotency constraints required by the scaffold", () => {
    const sql = readFileSync(migrationPath, "utf8");

    expect(sql).toContain("CREATE TABLE IF NOT EXISTS chat");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS message");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS run");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS run_chunk");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS telegram_outbox");
    expect(sql).toContain("UNIQUE (chat_id, telegram_message_id)");
    expect(sql).toContain("UNIQUE (chat_id, window_start, window_end)");
    expect(sql).toContain("FOREIGN KEY (assigned_run_id) REFERENCES run(id)");
  });
});
