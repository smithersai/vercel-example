// Probe A2: can a Vercel Sandbox invoked from a Function run ~25 minutes of real
// incremental loop work to completion?
//
// This is a standalone Node script that mimics what a Vercel Function handler would do:
// create a Sandbox, run a long-lived command inside it that does incremental work
// (writes a heartbeat line + counter every few seconds), stream logs, and wait for exit.
//
// Usage:
//   VERCEL_TOKEN=... VERCEL_TEAM_ID=... VERCEL_PROJECT_ID=... \
//     node run-sandbox-loop.mjs [durationSeconds]
//
// Requires a valid Vercel auth token with Sandbox access (OIDC token from `vercel env pull`
// or a personal access token) plus a linked team/project. None were available in this
// environment (see evidence/auth-failure.txt), so this script could not be exercised live.

import { Sandbox } from '@vercel/sandbox';
import { writeFileSync } from 'node:fs';

const durationSeconds = Number(process.argv[2] ?? 1500); // default 25 min

async function main() {
  const startedAt = Date.now();
  const sandbox = await Sandbox.create({
    timeout: (durationSeconds + 60) * 1000, // pad 60s over the requested loop duration
  });

  try {
    const script = `
      i=0
      end=$((\$(date +%s) + ${durationSeconds}))
      while [ "$(date +%s)" -lt "$end" ]; do
        i=$((i+1))
        echo "tick $i at $(date +%s)"
        sleep 5
      done
      echo "DONE after $i ticks"
    `;

    const cmd = await sandbox.runCommand({
      cmd: 'sh',
      args: ['-c', script],
      detached: true,
    });

    const logLines = [];
    for await (const log of cmd.logs()) {
      logLines.push(log.data);
      process.stdout.write(log.data);
    }

    const finished = await cmd.wait();
    const elapsedMs = Date.now() - startedAt;

    writeFileSync(
      'evidence/run-result.json',
      JSON.stringify(
        {
          requestedDurationSeconds: durationSeconds,
          elapsedMs,
          exitCode: finished.exitCode,
          tickCount: logLines.filter((l) => l.startsWith('tick')).length,
          completed: logLines.some((l) => l.includes('DONE')),
        },
        null,
        2,
      ),
    );
  } finally {
    await sandbox.stop();
  }
}

main().catch((err) => {
  writeFileSync(
    'evidence/auth-failure.txt',
    `Probe run failed: ${err?.message ?? err}\n\nStack:\n${err?.stack ?? ''}\n`,
  );
  console.error('Probe failed:', err);
  process.exit(1);
});
