// A5 probe: does a pooled Postgres connection sustain ~60 concurrent clients
// each repeatedly running claim (SELECT ... FOR UPDATE SKIP LOCKED) + heartbeat
// (UPDATE) queries, without connection errors?
//
// NOTE ON DB USED: no Neon connection string was available in this environment
// (no NEON_*/DATABASE_URL env var, no .env file). The only real Postgres reachable
// from this sandbox is TEVM_APP_DB, a Railway Postgres accessed through Railway's
// TCP proxy (autorack.proxy.rlwy.net). This is NOT Neon's pooled (pgbouncer)
// endpoint, so this probe validates "many concurrent short-lived pooled-style
// connections against a real remote Postgres over a proxy" as a stand-in, not
// Neon's pooler specifically. See planImpact.

import pg from "pg";

const CONNECTION_STRING = process.env.TEVM_APP_DB;
if (!CONNECTION_STRING) {
  console.error(JSON.stringify({ error: "TEVM_APP_DB not set" }));
  process.exit(1);
}

const NUM_CLIENTS = 60; // tick(1) + 50 executors + UI(~9) ~= 60, per A5 wording
const ITERATIONS_PER_CLIENT = 5;
const RUN_DURATION_MS = 15_000;

const pool = new pg.Pool({
  connectionString: CONNECTION_STRING,
  max: NUM_CLIENTS,
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 5_000,
});

async function setup() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS a5_probe_jobs (
        id SERIAL PRIMARY KEY,
        claimed_by TEXT,
        claimed_at TIMESTAMPTZ,
        heartbeat_at TIMESTAMPTZ
      )
    `);
    await client.query(`TRUNCATE a5_probe_jobs`);
    const values = [];
    for (let i = 0; i < 200; i++) values.push(`(NULL, NULL, NULL)`);
    await client.query(
      `INSERT INTO a5_probe_jobs (claimed_by, claimed_at, heartbeat_at) VALUES ${values.join(",")}`
    );
  } finally {
    client.release();
  }
}

async function teardown() {
  const client = await pool.connect();
  try {
    await client.query(`DROP TABLE IF EXISTS a5_probe_jobs`);
  } finally {
    client.release();
  }
}

async function claimAndHeartbeat(workerId, results) {
  for (let i = 0; i < ITERATIONS_PER_CLIENT; i++) {
    const client = await pool.connect();
    try {
      // claim: pick one unclaimed row, skip locked (executor-claim pattern)
      const claimRes = await client.query(
        `UPDATE a5_probe_jobs
         SET claimed_by = $1, claimed_at = now()
         WHERE id = (
           SELECT id FROM a5_probe_jobs
           WHERE claimed_by IS NULL
           ORDER BY id
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         RETURNING id`,
        [`worker-${workerId}`]
      );

      if (claimRes.rowCount === 0) {
        results.push({ workerId, iter: i, ok: true, note: "no rows left to claim" });
        continue;
      }

      const jobId = claimRes.rows[0].id;

      // heartbeat: simulate periodic liveness update
      await client.query(
        `UPDATE a5_probe_jobs SET heartbeat_at = now() WHERE id = $1`,
        [jobId]
      );

      results.push({ workerId, iter: i, ok: true, jobId });
    } catch (err) {
      results.push({ workerId, iter: i, ok: false, error: String(err && err.message || err) });
    } finally {
      client.release();
    }
    // small jitter so 60 clients don't all hammer in perfect lockstep
    await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));
  }
}

async function main() {
  const startedAt = new Date().toISOString();
  const t0 = performance.now();

  await setup();

  const results = [];
  const workers = [];
  for (let w = 0; w < NUM_CLIENTS; w++) {
    workers.push(claimAndHeartbeat(w, results));
  }
  await Promise.all(workers);

  const elapsedMs = performance.now() - t0;

  const failures = results.filter((r) => !r.ok);
  const successes = results.filter((r) => r.ok);

  const summary = {
    startedAt,
    finishedAt: new Date().toISOString(),
    elapsedMs: Math.round(elapsedMs),
    numClients: NUM_CLIENTS,
    iterationsPerClient: ITERATIONS_PER_CLIENT,
    totalOperations: results.length,
    successCount: successes.length,
    failureCount: failures.length,
    failures,
    poolStats: {
      totalCount: pool.totalCount,
      idleCount: pool.idleCount,
      waitingCount: pool.waitingCount,
    },
  };

  await teardown();
  await pool.end();

  console.log(JSON.stringify(summary, null, 2));

  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ fatalError: String(err && err.stack || err) }));
  process.exitCode = 1;
});
