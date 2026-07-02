#!/usr/bin/env node
// Validates whether a Vercel `vercel.json` cron entry is deployable on a given
// Vercel plan, per documented limits (see vercel-cron-docs-2026-06-16.md).
//
// This mirrors the deploy-time check Vercel itself performs for Hobby projects:
// a cron expression that would fire more than once per day fails deployment.
// Use as reference logic for a preflight check / CI gate before deploying the
// vercel-example project's single `/api/cron/tick` entry.

import { strict as assert } from "node:assert";

/** @param {string} expr 5-field cron expression */
function firesMoreThanOncePerDay(expr) {
  const fields = expr.trim().split(/\s+/);
  assert.equal(fields.length, 5, `expected 5-field cron expression, got "${expr}"`);
  const [minute, hour] = fields;
  // Once-per-day means both minute and hour are fixed (single values), not
  // wildcards, ranges, steps, or lists.
  const isFixed = (f) => /^\d+$/.test(f);
  return !(isFixed(minute) && isFixed(hour));
}

/** @returns {{ ok: boolean, reason?: string }} */
function validateCronForPlan(expr, plan) {
  if (plan === "hobby" && firesMoreThanOncePerDay(expr)) {
    return {
      ok: false,
      reason:
        "Hobby accounts are limited to daily cron jobs. This cron expression would run more than once per day.",
    };
  }
  return { ok: true };
}

const cases = [
  { expr: "* * * * *", plan: "hobby" }, // target design: 1-minute tick
  { expr: "* * * * *", plan: "pro" },
  { expr: "0 9 * * *", plan: "hobby" },
  { expr: "*/5 * * * *", plan: "hobby" },
];

for (const { expr, plan } of cases) {
  const result = validateCronForPlan(expr, plan);
  console.log(
    `plan=${plan.padEnd(6)} expr="${expr}" -> ${result.ok ? "OK" : "REJECTED: " + result.reason}`,
  );
}

// This project's actual design (docs/planning/02-design.md, Decision D21):
// a single `* * * * *` entry hitting /api/cron/tick.
const designExpr = "* * * * *";
const hobbyResult = validateCronForPlan(designExpr, "hobby");
const proResult = validateCronForPlan(designExpr, "pro");

console.log("\n--- Design check for docs/planning/02-design.md Decision D21 ---");
console.log(`Hobby: ${hobbyResult.ok ? "would deploy" : "would FAIL deploy — " + hobbyResult.reason}`);
console.log(`Pro:   ${proResult.ok ? "would deploy" : "would FAIL deploy — " + proResult.reason}`);
