// A10 probe: does a Vercel Function ("tick") return quickly while a fire-and-forget
// invocation of a background task (standing in for a Vercel Sandbox task) keeps running?
//
// This is a LOCAL simulation of the Node.js event-loop semantics only. It intentionally
// does NOT prove anything about the Vercel Lambda runtime, because that requires a real
// deployment. See NOTES.md for the documented Vercel-specific behavior that this probe
// cannot exercise locally, and why the assumption fails as stated.

import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const log = [];
const record = (msg) => {
  const line = `[t+${Date.now() - t0}ms] ${msg}`;
  log.push(line);
  console.log(line);
};

const t0 = Date.now();

// Simulated "Sandbox task": takes 5s, far longer than we want the tick to block for.
async function simulatedSandboxTask() {
  record("sandbox task: started");
  await sleep(5000);
  record("sandbox task: finished");
}

// Simulated "tick" handler: fires the task WITHOUT awaiting it, then returns immediately.
async function tick() {
  record("tick: invoked");
  // fire-and-forget — no await
  simulatedSandboxTask().catch((err) => record(`sandbox task: error ${err}`));
  record("tick: returning");
  return { status: 202 };
}

const result = await tick();
record(`tick: returned response ${JSON.stringify(result)} (handler-return elapsed)`);

// Keep the local process alive long enough to observe whether the detached task
// actually completes. On a real Vercel Function, the process/container can be frozen
// or torn down as soon as the response is sent — this local script CANNOT reproduce
// that freezing behavior because there is no Lambda runtime here.
await sleep(6000);
record("probe: done waiting, exiting");

writeFileSync(
  new URL("./output.log", import.meta.url),
  log.join("\n") + "\n"
);
