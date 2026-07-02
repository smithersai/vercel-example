#!/usr/bin/env node
// Sanity check for schema.mjs's validator, independent of any live API call — proves
// the harness used by probe.mjs correctly accepts/rejects SummarySchema shapes.
import { validateAgainstSchema } from './schema.mjs';

const cases = [
  {
    name: 'valid-single-topic',
    obj: {
      window: { start: '2026-06-01T00:00:00Z', end: '2026-06-01T01:00:00Z' },
      topics: [
        { title: 'deploy', participants: ['a'], decisions: ['ship at 2pm'], actionItems: [], links: [] },
      ],
    },
    expectValid: true,
  },
  {
    name: 'valid-seven-topics',
    obj: {
      window: { start: '2026-06-01T00:00:00Z', end: '2026-06-01T01:00:00Z' },
      topics: Array.from({ length: 7 }, (_, i) => ({
        title: `t${i}`,
        participants: [],
        decisions: [],
        actionItems: [],
        links: [],
      })),
    },
    expectValid: true,
  },
  {
    name: 'invalid-zero-topics',
    obj: { window: { start: 'a', end: 'b' }, topics: [] },
    expectValid: false,
  },
  {
    name: 'invalid-eight-topics',
    obj: {
      window: { start: 'a', end: 'b' },
      topics: Array.from({ length: 8 }, (_, i) => ({
        title: `t${i}`,
        participants: [],
        decisions: [],
        actionItems: [],
        links: [],
      })),
    },
    expectValid: false,
  },
  {
    name: 'invalid-missing-window',
    obj: { topics: [{ title: 't', participants: [], decisions: [], actionItems: [], links: [] }] },
    expectValid: false,
  },
  {
    name: 'invalid-non-string-participant',
    obj: {
      window: { start: 'a', end: 'b' },
      topics: [{ title: 't', participants: [1], decisions: [], actionItems: [], links: [] }],
    },
    expectValid: false,
  },
];

let failures = 0;
for (const c of cases) {
  const { valid } = validateAgainstSchema(c.obj);
  const ok = valid === c.expectValid;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${c.name} (valid=${valid}, expected=${c.expectValid})`);
  if (!ok) failures++;
}
if (failures > 0) {
  console.error(`${failures} validator self-test(s) failed`);
  process.exitCode = 1;
} else {
  console.log('all validator self-tests passed');
}
