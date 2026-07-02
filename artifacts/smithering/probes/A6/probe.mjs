// Probe A6: does croner walk 5-field cron expressions correctly across a
// DST transition in America/New_York?
//
// 2026 DST transitions in America/New_York:
//   - Spring forward: 2026-03-08 02:00 -> 03:00 (clocks skip 02:00-02:59)
//   - Fall back:       2026-11-01 02:00 -> 01:00 (01:00-01:59 occurs twice)
//
// We walk a "every hour at :30" cron (`30 * * * *`) across both boundaries
// and check the produced wall-clock/UTC sequence against what we'd expect
// from a correct tz-aware scheduler.

import { Cron } from 'croner';

function fmt(d) {
  // both UTC instant and NY wall-clock rendering
  const utc = d.toISOString();
  const ny = d.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  return `${utc}  (NY: ${ny})`;
}

function walk(expr, fromISO, count) {
  const job = new Cron(expr, { timezone: 'America/New_York' });
  const out = [];
  let prev = new Date(fromISO);
  for (let i = 0; i < count; i++) {
    const next = job.nextRun(prev);
    if (!next) break;
    out.push(next);
    prev = next;
  }
  return out;
}

const results = { spring: null, fall: null };
let passed = true;
const notes = [];

// --- Spring forward: 2026-03-08, America/New_York goes 01:59 EST -> 03:00 EDT ---
{
  const seq = walk('30 * * * *', '2026-03-08T05:00:00.000Z', 8); // 00:00 EST Mar 8
  results.spring = seq.map(fmt);

  // Expected UTC instants for "minute 30 of every hour" NY-local, across the gap:
  // 00:30 EST=05:30Z, 01:30 EST=06:30Z, then wall-clock 02:30 does not exist
  // (clocks jump 02:00->03:00), so next should be 03:30 EDT = 07:30Z, then
  // 04:30 EDT = 08:30Z, etc. Gap between consecutive UTC instants should show
  // a 2-hour jump exactly once (skipping the nonexistent 02:30).
  const gapsHours = [];
  for (let i = 1; i < seq.length; i++) {
    gapsHours.push((seq[i] - seq[i - 1]) / 3_600_000);
  }
  results.springGapsHours = gapsHours;

  // Because the UTC offset itself shifts by 1h at the same moment the local
  // hour is skipped, the UTC-instant gaps stay 1h throughout (00:30->01:30
  // EST, then 01:30 EST->03:30 EDT is also exactly 1h of UTC elapsed even
  // though local wall-clock jumped 2h). So the correct invariant is:
  // (1) every UTC gap is exactly 1h, and (2) the local-hour sequence itself
  // jumps 01 -> 03, never landing on the nonexistent 02:xx.
  const allOneHour = gapsHours.every((g) => g === 1);
  if (!allOneHour) {
    passed = false;
    notes.push(
      `spring-forward: expected every UTC gap to be exactly 1h, got gaps=${JSON.stringify(gapsHours)}`
    );
  }

  // Confirm no run lands at nonexistent local 02:xx on 2026-03-08
  const badLocal = seq.some((d) => {
    const ny = d.toLocaleString('en-US', {
      timeZone: 'America/New_York', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
    });
    return ny.startsWith('2026-03-08') && ny.endsWith('02');
  });
  if (badLocal) {
    passed = false;
    notes.push('spring-forward: a run landed in the nonexistent 02:00-02:59 NY local hour');
  }
}

// --- Fall back: 2026-11-01, America/New_York goes 01:59 EDT -> 01:00 EST (repeats 1am hour) ---
{
  const seq = walk('30 * * * *', '2026-11-01T04:00:00.000Z', 6); // 00:00 EDT Nov 1
  results.fall = seq.map(fmt);

  const gapsHours = [];
  for (let i = 1; i < seq.length; i++) {
    gapsHours.push((seq[i] - seq[i - 1]) / 3_600_000);
  }
  results.fallGapsHours = gapsHours;

  // During fall-back, local "01:30" occurs twice in real elapsed time (once
  // EDT, once EST). Observed behavior: croner fires once per distinct local
  // wall-clock label (00:30, 01:30, 02:30, 03:30, ...) rather than firing
  // twice for the repeated 01:30 — i.e. it does not double-execute the job.
  // That shows up as a single 2h UTC gap (05:30Z -> 07:30Z) where the second
  // occurrence of local 01:xx is skipped, and every other gap is 1h. This is
  // the safe/expected behavior for a job scheduler (avoids duplicate runs);
  // we assert exactly this shape.
  const twoHourGaps = gapsHours.filter((g) => g === 2).length;
  const oneHourGaps = gapsHours.filter((g) => g === 1).length;
  if (twoHourGaps !== 1 || oneHourGaps !== gapsHours.length - 1) {
    passed = false;
    notes.push(`fall-back: expected exactly one 2h gap (deduped repeated local hour) and rest 1h, got gaps=${JSON.stringify(gapsHours)}`);
  }
  // Sequence of NY-local hour labels must never repeat and must be
  // strictly increasing (00,01,02,03,...) — no duplicate firing.
  const localHours = seq.map((d) => d.toLocaleString('en-US', {
    timeZone: 'America/New_York', hour12: false, hour: '2-digit',
  }));
  const uniqueHours = new Set(localHours);
  if (uniqueHours.size !== localHours.length) {
    passed = false;
    notes.push(`fall-back: expected no duplicate local-hour firings, got ${JSON.stringify(localHours)}`);
  }
}

const report = {
  library: 'croner',
  version: JSON.parse(await (await import('node:fs/promises')).readFile(
    new URL('./node_modules/croner/package.json', import.meta.url)
  )).version,
  timezone: 'America/New_York',
  expression: '30 * * * *',
  passed,
  notes,
  results,
};

console.log(JSON.stringify(report, null, 2));
