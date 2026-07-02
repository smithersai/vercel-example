import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Queryable } from "./types";
import { getPool } from "./pool";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "db", "migrations");

export async function migrate(pool: Queryable = getPool()): Promise<void> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  for (const file of files) {
    await pool.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate()
    .then(async () => {
      console.log("migrations applied");
      await getPool().end();
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
}
