/** @jsxImportSource smithers-orchestrator */
// A12 probe: does a 3-step workflow resume from Postgres in a fresh process,
// executing only the steps that hadn't completed yet?
//
// Each step appends a timestamped line to markers.log via an fs call (a real
// side effect, not just an in-memory counter) so we can verify from outside
// the process whether a step re-ran after resume. Step 2 sleeps long enough
// for the harness to SIGKILL the process mid-step-3-wait, simulating a
// Sandbox re-invocation crash.
import { openSmithersBackend, Sequence, Task } from "smithers-orchestrator";
import { z } from "zod";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const MARKER_LOG = join(import.meta.dir, "markers.log");

function mark(step: string) {
  appendFileSync(MARKER_LOG, `${step} ${new Date().toISOString()} pid=${process.pid}\n`);
}

const { Workflow, smithers, outputs } = await openSmithersBackend({
  input: z.object({}),
  step1: z.object({ done: z.boolean() }),
  step2: z.object({ done: z.boolean() }),
  step3: z.object({ done: z.boolean() }),
}, {
  backend: "postgres",
  connectionString: process.env.DATABASE_URL,
});

export default smithers((ctx) => (
  <Workflow name="a12-probe">
    <Sequence>
      <Task id="step1" output={outputs.step1}>
        {async () => {
          mark("step1:start");
          mark("step1:end");
          return { done: true };
        }}
      </Task>
      <Task id="step2" output={outputs.step2}>
        {async () => {
          mark("step2:start");
          mark("step2:end");
          return { done: true };
        }}
      </Task>
      <Task id="step3" output={outputs.step3}>
        {async () => {
          // Widen the kill window: the harness watches markers.log for
          // "step2:end" then SIGKILLs the process before this delay elapses,
          // so step3 must never have started (let alone finished) pre-kill.
          await new Promise((r) => setTimeout(r, 6000));
          mark("step3:start");
          mark("step3:end");
          return { done: true };
        }}
      </Task>
    </Sequence>
  </Workflow>
));
