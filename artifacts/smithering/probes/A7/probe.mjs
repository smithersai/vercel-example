#!/usr/bin/env node
// Probe A7: does Anthropic structured output conform to SummarySchema >=95% first-try
// on 10 fixture conversations, with one repair retry closing the gap?
//
// Calls the real Anthropic Messages API (model claude-sonnet-5, per repo model policy)
// with SummarySchema as a forced tool call, once per fixture. On schema failure, sends
// one repair retry with the validation errors appended. Records first-try and
// post-repair pass rates. Requires ANTHROPIC_API_KEY; if absent, this is reported as an
// unverified/blocked result rather than fabricated data.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SummarySchema, validateAgainstSchema } from './schema.mjs';
import { FIXTURES } from './fixtures/conversations.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODEL = 'claude-sonnet-5';

function renderConversation(fixture) {
  return fixture.messages.map((m) => `${m.from}: ${m.text}`).join('\n');
}

async function callAnthropic(apiKey, systemPrompt, userPrompt, extraNote) {
  const body = {
    model: MODEL,
    max_tokens: 1024,
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: extraNote ? `${userPrompt}\n\n${extraNote}` : userPrompt,
      },
    ],
    tools: [SummarySchema],
    tool_choice: { type: 'tool', name: SummarySchema.name },
  };
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`Anthropic API error ${res.status}: ${JSON.stringify(json)}`);
  }
  const toolUse = json.content?.find((c) => c.type === 'tool_use');
  if (!toolUse) {
    throw new Error(`No tool_use block in response: ${JSON.stringify(json)}`);
  }
  return toolUse.input;
}

async function runFixture(apiKey, fixture) {
  const system =
    'You summarize chat conversation windows into the summary tool call. ' +
    'Only include topics, decisions, action items, and links that are explicitly ' +
    'present in the conversation. Never fabricate participants or facts.';
  const user = `Conversation window ${fixture.window.start} to ${fixture.window.end}:\n\n${renderConversation(
    fixture,
  )}`;

  const result = { id: fixture.id, firstTry: null, repaired: null };

  let firstOutput;
  try {
    firstOutput = await callAnthropic(apiKey, system, user);
  } catch (err) {
    result.firstTry = { valid: false, errors: [`call failed: ${err.message}`] };
    return result;
  }
  const firstValidation = validateAgainstSchema(firstOutput);
  result.firstTry = { ...firstValidation, output: firstOutput };

  if (firstValidation.valid) {
    return result;
  }

  const repairNote = `Your previous tool call failed schema validation with errors: ${JSON.stringify(
    firstValidation.errors,
  )}. Call the tool again, fixing these issues.`;
  try {
    const repairedOutput = await callAnthropic(apiKey, system, user, repairNote);
    const repairedValidation = validateAgainstSchema(repairedOutput);
    result.repaired = { ...repairedValidation, output: repairedOutput };
  } catch (err) {
    result.repaired = { valid: false, errors: [`repair call failed: ${err.message}`] };
  }
  return result;
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const outputPath = join(__dirname, 'output.json');

  if (!apiKey) {
    const blocked = {
      assumptionId: 'A7',
      blocked: true,
      reason:
        'ANTHROPIC_API_KEY not set in this environment; cannot call the real Anthropic ' +
        'Messages API to measure schema-pass rate. No data fabricated.',
      fixtureCount: FIXTURES.length,
      results: [],
    };
    writeFileSync(outputPath, JSON.stringify(blocked, null, 2));
    console.log(JSON.stringify(blocked, null, 2));
    process.exitCode = 1;
    return;
  }

  const results = [];
  for (const fixture of FIXTURES) {
    console.log(`running ${fixture.id}...`);
    const r = await runFixture(apiKey, fixture);
    results.push(r);
  }

  const firstTryPassed = results.filter((r) => r.firstTry.valid).length;
  const postRepairPassed = results.filter(
    (r) => r.firstTry.valid || (r.repaired && r.repaired.valid),
  ).length;

  const summary = {
    assumptionId: 'A7',
    model: MODEL,
    fixtureCount: FIXTURES.length,
    firstTryPassRate: firstTryPassed / FIXTURES.length,
    postRepairPassRate: postRepairPassed / FIXTURES.length,
    meetsAssumption: firstTryPassed / FIXTURES.length >= 0.95,
    repairClosesGap: postRepairPassed === FIXTURES.length,
    results,
  };
  writeFileSync(outputPath, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(
    {
      firstTryPassRate: summary.firstTryPassRate,
      postRepairPassRate: summary.postRepairPassRate,
      meetsAssumption: summary.meetsAssumption,
      repairClosesGap: summary.repairClosesGap,
    },
    null,
    2,
  ));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
