// 10 fixture conversations for probing A7 (schema-pass rate of Anthropic structured
// output against SummarySchema). Deliberately varied: multi-topic, single-topic,
// sparse, emoji, code snippets, non-Latin script, links, no-decision, long, dense.
export const FIXTURES = [
  {
    id: 'f01-multi-topic',
    window: { start: '2026-06-01T09:00:00Z', end: '2026-06-01T10:00:00Z' },
    messages: [
      { from: 'alice', text: 'Morning! Two things today: deploy window and the design review.' },
      { from: 'bob', text: 'For deploy: lets ship at 2pm, after standup.' },
      { from: 'alice', text: 'Agreed, 2pm it is.' },
      { from: 'carol', text: 'Design review — I think we should go with option B for the nav bar.' },
      { from: 'bob', text: 'Option B works for me too. Carol can you send the Figma link?' },
      { from: 'carol', text: 'https://figma.com/file/example-nav' },
      { from: 'alice', text: 'Action: bob to write deploy runbook by EOD.' },
    ],
  },
  {
    id: 'f02-single-topic',
    window: { start: '2026-06-02T09:00:00Z', end: '2026-06-02T09:30:00Z' },
    messages: [
      { from: 'dave', text: 'Quick sync on the invoice bug.' },
      { from: 'erin', text: 'Root cause is a rounding error in the tax calc.' },
      { from: 'dave', text: 'Decision: fix in the shared money lib, not per-caller.' },
      { from: 'erin', text: 'Action: erin opens a PR today.' },
    ],
  },
  {
    id: 'f03-sparse',
    window: { start: '2026-06-03T09:00:00Z', end: '2026-06-03T09:15:00Z' },
    messages: [
      { from: 'frank', text: 'anyone around?' },
      { from: 'grace', text: 'here, whats up' },
      { from: 'frank', text: 'nvm figured it out' },
    ],
  },
  {
    id: 'f04-emoji',
    window: { start: '2026-06-04T09:00:00Z', end: '2026-06-04T09:45:00Z' },
    messages: [
      { from: 'heidi', text: 'ship it! 🚀🎉' },
      { from: 'ivan', text: 'lgtm 👍 merging now' },
      { from: 'heidi', text: 'decision: cut release v1.4.0 tonight 🌙' },
      { from: 'ivan', text: 'action: ivan tags the release and posts changelog' },
    ],
  },
  {
    id: 'f05-code-snippet',
    window: { start: '2026-06-05T09:00:00Z', end: '2026-06-05T10:00:00Z' },
    messages: [
      { from: 'judy', text: 'the bug is in this loop:' },
      { from: 'judy', text: '```js\nfor (let i = 0; i <= arr.length; i++) { sum += arr[i]; }\n```' },
      { from: 'kevin', text: 'off-by-one, should be i < arr.length' },
      { from: 'judy', text: 'decision: fix and add a unit test for the boundary' },
      { from: 'kevin', text: 'action: kevin opens the fix PR' },
    ],
  },
  {
    id: 'f06-non-latin',
    window: { start: '2026-06-06T09:00:00Z', end: '2026-06-06T09:40:00Z' },
    messages: [
      { from: 'liu', text: '会议改到下午三点，大家没问题吧？' },
      { from: 'mei', text: '没问题，我会提前发议程。' },
      { from: 'liu', text: '决定：下午三点开会，梅发议程。' },
      { from: 'nikolai', text: 'Спасибо, буду там.' },
    ],
  },
  {
    id: 'f07-no-decision',
    window: { start: '2026-06-07T09:00:00Z', end: '2026-06-07T09:20:00Z' },
    messages: [
      { from: 'omar', text: 'anyone tried the new onboarding flow?' },
      { from: 'petra', text: 'not yet, will check it out later' },
      { from: 'omar', text: 'ok no rush' },
    ],
  },
  {
    id: 'f08-links-heavy',
    window: { start: '2026-06-08T09:00:00Z', end: '2026-06-08T10:00:00Z' },
    messages: [
      { from: 'quinn', text: 'good reads: https://example.com/a and https://example.com/b' },
      { from: 'rosa', text: 'also see https://example.com/c for the RFC' },
      { from: 'quinn', text: 'decision: adopt RFC from https://example.com/c' },
      { from: 'rosa', text: 'action: rosa schedules a follow-up' },
    ],
  },
  {
    id: 'f09-long-dense',
    window: { start: '2026-06-09T09:00:00Z', end: '2026-06-09T12:00:00Z' },
    messages: Array.from({ length: 40 }, (_, i) => ({
      from: ['sam', 'tara', 'uma'][i % 3],
      text: `topic ${1 + (i % 5)}: message ${i} discussing progress on stream ${1 + (i % 5)}`,
    })).concat([
      { from: 'sam', text: 'decision: prioritize stream 2 next sprint' },
      { from: 'tara', text: 'action: tara writes the sprint plan' },
    ]),
  },
  {
    id: 'f10-mixed-participants',
    window: { start: '2026-06-10T09:00:00Z', end: '2026-06-10T09:50:00Z' },
    messages: [
      { from: 'vik', text: 'incident retro time. what went wrong?' },
      { from: 'wendy', text: 'alerting fired 20 min late' },
      { from: 'xavier', text: 'root cause: metric pipeline lag' },
      { from: 'vik', text: 'decision: add a synthetic canary alert' },
      { from: 'wendy', text: 'action: wendy configures the canary by Friday' },
      { from: 'xavier', text: 'action: xavier writes the postmortem doc' },
    ],
  },
];
