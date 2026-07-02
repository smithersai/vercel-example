// smithers-source: generated
// smithers-metadata-version: 1
// smithers-display-name: Smithering Implementation
// smithers-description: Execute docs/planning/06-orchestration.md — DAG-parallel ticket workers in per-ticket worktrees, cross-family review, independent verification, continuous single-lane landing onto the integration branch.
// smithers-tags: implementation, worktrees, tickets, orchestration
//
// ─────────────────────────────────────────────────────────────────────────────
// smithering-impl — bespoke implementation workflow for the Telegram summary bot.
//
// Implements the recorded decisions verbatim:
//   O1 worktrees   — one git worktree per ticket at .smithers/worktrees/<runId>/<ticketId>,
//                    branch smithering/<runId>/<ticketId>, forked from the integration branch
//                    (which already contains every landed dependency).
//   O2 mergePolicy — serialized land lane: <MergeQueue maxConcurrency={1}>. No optimistic
//                    merging, no eviction saga. Landing is continuous and PER TICKET: a ticket
//                    lands as soon as ITS gates are green and ITS deps are landed — never
//                    batched per wave.
//   O3 testTiers   — Tier-1 pre-merge gates run live by the independent verifier on the
//                    REBASED tip, and re-run by the land lane on the merged tip with
//                    infra-aware gate classification. Tier-2 (Preview e2e, long-task PR
//                    variant, smoke skip-behavior) runs after EVERY land and BLOCKS further
//                    dispatch/landing until green. Tier-3 is nightly (final report).
//   O4 models      — Anthropic implements+verifies, OpenAI (codex) reviews. Reviewer family
//                    ≠ implementer family on every ticket, statically. Review is a REQUIRED
//                    landing signal: review.json with approved=true must exist on disk.
//   O5 concurrency — max 3 parallel implementation workers + 1 merge-lane slot.
//   O6 observability — evidence at artifacts/smithering/build/<runId>/<ticketId>/ (run-scoped
//                    path = belt one) AND the per-ticket evidence dir is deleted before every
//                    (re)dispatch (belt two). Done-checks read ONLY on-disk evidence.
//   O7 context    — every worker prompt is fresh-context and self-contained (full ticket JSON
//                    verbatim, exact doc paths, worktree/branch/base/runId, evidence contract,
//                    model policy, may-not-assume list).
//
// Hard rules encoded here:
//   - NO agent used inside a <Worktree> pins a cwd (agent.cwd ?? worktreePath ?? repoRoot —
//     a pinned cwd would defeat worktree isolation). All agents below are constructed WITHOUT
//     cwd; do not reuse .smithers/agents.ts instances (those pin process.cwd()).
//   - Worktree paths are resolved ONLY via ctx.worktreePath(id) ?? ctx.resolveWorktreePath(path).
//   - Verdicts are captured FROM DISK (verify.json / review.json / challenge.json inside the
//     worktree), never from agent structured returns.
//   - NEVER merges to main. Work lands on `smithering/integration`; merging that branch into
//     main is a human act after delivery.
//   - Every loop has maxIterations. No custom side-effecting tools are defined; no `cache`
//     prop is used anywhere (side-effect tasks are never cached).
//   - Transient/infra errors (SESSION_ERROR, OOM, timeouts, rate limits) retry as infra and,
//     when exhausted, block only their own ticket (continueOnFail everywhere) — unrelated
//     verified tickets still land.
// ─────────────────────────────────────────────────────────────────────────────
/** @jsxImportSource smithers-orchestrator */
import { createSmithers, Sequence, Parallel, Worktree, MergeQueue } from "smithers-orchestrator";
import { ClaudeCodeAgent, CodexAgent } from "smithers-orchestrator";
import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod/v4";

// ─── Constants ────────────────────────────────────────────────────────────────

const REPO_ROOT = process.cwd(); // orchestrator-side only; NEVER used for worker paths
const TICKETS_PATH = "artifacts/smithering/tickets.json";
function integrationBranch(runId: string): string {
  return `smithering/${runId}/integration`; // run-scoped: never merges to main, isolated per run
}
const MAX_ITERATIONS = 4; // implement→review→verify attempts per ticket (land bounces also consume attempts)
const MAX_WORKERS = 3; // O5
const PLANNING_DOCS = [
  "docs/planning/01-prd.md",
  "docs/planning/02-design.md",
  "docs/planning/03-eng.md",
  "docs/planning/04-backpressure.md",
  "docs/planning/06-orchestration.md",
];
// Tickets whose gates are safety/security-critical: these additionally require an
// adversarial challenge verdict (challenge.json.approved) before landing.
const SAFETY_TICKET_IDS = new Set(["machine-auth-boundaries", "ci-coverage-and-secret-gates"]);
// A13 human gate (BP-3): blocks DISPATCH of the exactly-once ticket until the PRD
// records the placeholder-residual amendment acceptance. Never raised from here.
const A13_TICKET_ID = "exactly-once-chunk-delivery";
// A2 durable pre-merge gate: the Sandbox ticket may not pass capture without the live
// >20-minute run result on disk (completed:true), checked mechanically — not prompt prose.
const A2_TICKET_ID = "sandbox-async-executor-invocation";
const A2_EVIDENCE_REL = "artifacts/smithering/probes/A2/evidence/run-result.json";

// ─── Tickets: imported at module load; task ids derive from ticket ids ───────

type Ticket = {
  id: string;
  title: string;
  instructions: string;
  requirementIds?: string[];
  verification?: unknown[];
  dependsOn?: string[];
  complexity?: "small" | "medium" | "large";
  [k: string]: unknown;
};

function loadTickets(): Ticket[] {
  const raw = JSON.parse(readFileSync(resolve(REPO_ROOT, TICKETS_PATH), "utf8"));
  const list: Ticket[] = Array.isArray(raw) ? raw : raw.tickets;
  if (!Array.isArray(list) || list.length === 0) throw new Error(`No tickets found in ${TICKETS_PATH}`);
  return list;
}

const ALL_TICKETS = loadTickets();
const TICKET_BY_ID = new Map(ALL_TICKETS.map((t) => [t.id, t]));

function depsOf(t: Ticket): string[] {
  return Array.isArray(t.dependsOn) ? t.dependsOn.filter((d) => TICKET_BY_ID.has(d)) : [];
}

// Topological waves — stable ordering only; readiness (not wave membership) drives
// dispatch, so every ready antichain runs in parallel and the critical path is DAG depth.
function computeWaves(tickets: Ticket[]): Map<string, number> {
  const wave = new Map<string, number>();
  let remaining = tickets.slice();
  let level = 0;
  while (remaining.length > 0) {
    const ready = remaining.filter((t) => depsOf(t).every((d) => wave.has(d)));
    if (ready.length === 0) throw new Error(`Ticket dependency cycle among: ${remaining.map((t) => t.id).join(", ")}`);
    for (const t of ready) wave.set(t.id, level);
    remaining = remaining.filter((t) => !wave.has(t.id));
    level += 1;
  }
  return wave;
}

const WAVE_OF = computeWaves(ALL_TICKETS);

// ─── Agents (NO cwd — <Worktree> owns each worker's working directory) ───────

const fable = new ClaudeCodeAgent({ model: "claude-fable-5" });
const opusFallback = new ClaudeCodeAgent({ model: "claude-opus-4-8" });
const sonnet = new ClaudeCodeAgent({ model: "claude-sonnet-5" });
// Reviewer family is OpenAI via the codex CLI (GPT-5.4) — never a Claude fallback:
// a same-family (Claude-reviews-Claude) fallback is explicitly forbidden (O4).
const codexReviewer = new CodexAgent({ model: "gpt-5.4", skipGitRepoCheck: true });

const strongClaude = [fable, opusFallback]; // fable with recorded opus fallback
// O4 assignment table, keyed by tickets.json complexity.
function implementerFor(t: Ticket) {
  return t.complexity === "large" ? strongClaude : [sonnet];
}
function verifierFor(t: Ticket) {
  return t.complexity === "small" ? [sonnet] : strongClaude;
}

// ─── Output schemas (loose + defaulted: agent structured returns are advisory;
//     authoritative verdicts are read from disk by the capture compute tasks) ──

const setupSchema = z.object({
  integrationBranch: z.string(),
  baseCommit: z.string(),
  evidenceRoot: z.string(),
  notes: z.array(z.string()).default([]),
});

const agentReportSchema = z.looseObject({
  ticketId: z.string().default(""),
  summary: z.string().default(""),
  blockers: z.array(z.string()).default([]),
});

const captureSchema = z.object({
  ticketId: z.string(),
  attempt: z.number().int(),
  pass: z.boolean(),
  rebasedTipOk: z.boolean(),
  evidenceOk: z.boolean(),
  challengeApproved: z.boolean().nullable(),
  reviewApproved: z.boolean(),
  reviewAdvisory: z.string().nullable(),
  feedback: z.string().nullable(),
  missingEvidence: z.array(z.string()),
});

const landSchema = z.object({
  ticketId: z.string(),
  attempt: z.number().int(),
  landed: z.boolean(),
  bounced: z.boolean(),
  infra: z.boolean(),
  commit: z.string().nullable(),
  feedback: z.string().nullable(),
  gateLog: z.array(z.string()),
});

// O3 Tier-2 post-land backpressure verdict (Preview e2e, long-task PR variant, smoke skip).
const tier2Schema = z.object({
  ticketId: z.string(),
  attempt: z.number().int(),
  verdict: z.enum(["green", "red", "infra"]),
  results: z.array(z.object({ name: z.string(), status: z.string(), log: z.string() })),
});

const credentialSchema = z.object({
  ticketId: z.string(),
  status: z.literal("needs-credential"),
  missingEnv: z.array(z.string()),
});

const reportSchema = z.looseObject({
  status: z.enum(["finished", "partial"]).default("finished"),
  summary: z.string().default(""),
  landed: z.array(z.string()).default([]),
  blocked: z.array(z.string()).default([]),
  needsCredential: z.array(z.string()).default([]),
  markdownBody: z.string().default(""),
});

const inputSchema = z.object({
  // smoke=true: process ONLY the first ticket end-to-end (including verification),
  // with no approval/human gates, and reach status finished.
  smoke: z.boolean().default(false),
  maxConcurrency: z.number().int().min(1).max(5).default(MAX_WORKERS),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: inputSchema,
  setup: setupSchema,
  implement: agentReportSchema,
  review: agentReportSchema,
  verify: agentReportSchema,
  challenge: agentReportSchema,
  prep: z.object({ ticketId: z.string(), attempt: z.number().int(), cleaned: z.boolean() }),
  capture: captureSchema,
  land: landSchema,
  tier2: tier2Schema,
  credential: credentialSchema,
  report: reportSchema,
});

// ─── Small helpers ────────────────────────────────────────────────────────────

function git(args: string[], cwd: string = REPO_ROOT) {
  return spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

function evidenceRel(runId: string, ticketId: string): string {
  return join("artifacts", "smithering", "build", runId, ticketId);
}

function orchestratorStateDir(runId: string): string {
  return resolve(REPO_ROOT, "artifacts", "smithering", "build", runId, "_orchestrator");
}

function wtPathProp(runId: string, ticketId: string): string {
  // Absolute so the location is deterministic regardless of launch root; always read
  // back via ctx.worktreePath/resolveWorktreePath — never reconstructed elsewhere.
  return resolve(REPO_ROOT, ".smithers", "worktrees", runId, ticketId);
}

function ticketBranch(runId: string, ticketId: string): string {
  return `smithering/${runId}/${ticketId}`;
}

function worktreeRootFor(ctx: any, runId: string, ticketId: string): string | null {
  // First-class worktree path API only. NEVER process.cwd()/import.meta.dir/../.. guesses.
  return ctx.worktreePath(`wt-${ticketId}`) ?? ctx.resolveWorktreePath(wtPathProp(runId, ticketId)) ?? null;
}

function readJsonMaybe(path: string): any | null {
  try {
    if (!existsSync(path)) return null;
    const text = readFileSync(path, "utf8");
    return text.trim().length > 0 ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

// Fresh-run idempotency: a ticket whose land marker commit is already on the
// integration branch is DONE — never rebuild it.
function landedOnIntegration(runId: string, ticketId: string): boolean {
  const res = git(["log", integrationBranch(runId), "--grep", `^smithering-land: ${ticketId}$`, "--format=%H", "-n", "1"]);
  return res.status === 0 && (res.stdout ?? "").trim().length > 0;
}

function integrationTip(runId: string): string {
  return (git(["rev-parse", integrationBranch(runId)]).stdout ?? "").trim();
}

// Explicit-credential detection: a ticket blocks as needs-credential:<KEY> only when its
// own text explicitly requires an external credential env var that is absent. Heuristic
// is deliberately narrow (require/must-be-set phrasing around *_TOKEN/*_API_KEY/*_SECRET)
// so tickets that merely *mention* optional tokens (e.g. skip-without-token lanes) still run.
function missingRequiredCredentials(t: Ticket): string[] {
  const text = `${t.instructions ?? ""}\n${JSON.stringify(t.verification ?? [])}`;
  const explicit = Array.isArray((t as any).requiredEnv) ? ((t as any).requiredEnv as string[]) : [];
  const found = new Set<string>(explicit);
  const patterns = [
    /requires?[^.\n]{0,80}?\b([A-Z][A-Z0-9_]*(?:_TOKEN|_API_KEY|_SECRET))\b/g,
    /\b([A-Z][A-Z0-9_]*(?:_TOKEN|_API_KEY|_SECRET))\b[^.\n]{0,60}?(?:must be set|is required)/gi,
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) found.add(m[1]);
  }
  return [...found].filter((key) => !(key in process.env) || !process.env[key]);
}

// A13 (BP-3): the exactly-once ticket may not be DISPATCHED before the PRD records the
// placeholder-residual amendment acceptance. DECISION: a loose prose regex is not a
// robust blocking gate, so acceptance must be recorded as an explicit machine-checkable
// marker LINE in docs/planning/01-prd.md, e.g. `A13-ACCEPTED: 2026-07-01 <approver>`.
// Humans write the marker; the workflow only reads it.
function a13Accepted(): boolean {
  try {
    const prd = readFileSync(resolve(REPO_ROOT, "docs/planning/01-prd.md"), "utf8");
    return /^\s*A13-ACCEPTED\b/m.test(prd);
  } catch {
    return false;
  }
}

// O7: worker prompts must name EXACT decision-doc paths, not a wildcard. Enumerated at
// prompt-build time so newly recorded decisions appear in later dispatches.
function decisionDocPaths(): string[] {
  try {
    return readdirSync(resolve(REPO_ROOT, "artifacts", "smithering", "decisions"))
      .filter((f) => f.endsWith(".html"))
      .sort()
      .map((f) => `artifacts/smithering/decisions/${f}`);
  } catch {
    return [];
  }
}

// Per-ticket fork point: the base every prompt/diff references must be the ticket
// branch's ACTUAL fork point off the moving integration branch, never the setup-time tip.
function forkPointOf(runId: string, ticketId: string): string {
  const mb = git(["merge-base", ticketBranch(runId, ticketId), integrationBranch(runId)]);
  if (mb.status === 0 && (mb.stdout ?? "").trim()) return (mb.stdout ?? "").trim();
  return integrationTip(runId); // branch not created yet — <Worktree> will fork from the current tip
}

// ─── Infra-aware gate runner (contractual) ────────────────────────────────────
// `tsc --noEmit` is red ONLY on `error TS` diagnostics; `bun/vitest` tests are red ONLY
// when tests actually ran and reported failures. Nonzero exits, SIGABRT/OOM, signal
// kills, and timeouts with no such report are INFRA → retried up to 3 attempts with a
// bigger heap and backoff, and NEVER blamed on the ticket code.

type GateResult = { status: "green" | "red" | "infra" | "unavailable"; log: string };

function classifyGateOutput(kind: "tsc" | "test" | "other", out: string, exitCode: number | null, signal: string | null): "green" | "red" | "infra" {
  if (exitCode === 0) return "green";
  if (signal) return "infra";
  if (kind === "tsc") return /error TS\d+/.test(out) ? "red" : "infra";
  if (kind === "test") {
    const ranAndFailed = /\b\d+\s+(failed|failing)\b/i.test(out) || /✗|FAIL\b/.test(out);
    const crashed = /out of memory|heap limit|SIGABRT|SIGSEGV|SIGKILL|ETIMEDOUT|ECONNRESET/i.test(out);
    return ranAndFailed && !crashed ? "red" : ranAndFailed ? "red" : "infra";
  }
  return "red";
}

function runGate(kind: "tsc" | "test" | "other", command: string, args: string[], cwd: string): GateResult {
  let lastOut = "";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const res = spawnSync(command, args, {
      cwd,
      encoding: "utf8",
      timeout: 25 * 60 * 1000,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=6144", CI: "1" },
    });
    lastOut = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
    const verdict = classifyGateOutput(kind, lastOut, res.status, res.signal as string | null);
    if (verdict === "green") return { status: "green", log: lastOut.slice(-8000) };
    if (verdict === "red") return { status: "red", log: lastOut.slice(-8000) };
    // infra → short backoff, then retry (no concurrent heavy work: the land lane is depth-1)
    spawnSync("sleep", [String(5 * attempt)]);
  }
  return { status: "infra", log: lastOut.slice(-8000) };
}

function packageScripts(cwd: string): Record<string, string> {
  const pkg = readJsonMaybe(join(cwd, "package.json"));
  return pkg?.scripts ?? {};
}

// Ticket-specific named blocking checks: parsed from the ticket's own verification rows
// (backpressure `pnpm test:* -t "..."` / `pnpm check:*` commands). Nightly `eval:*` lanes
// are Tier-3 and deliberately excluded from the merge path.
function ticketNamedChecks(t: Ticket): Array<{ name: string; kind: "tsc" | "test" | "other"; command: string; args: string[] }> {
  const text = `${JSON.stringify(t.verification ?? [])}\n${t.instructions ?? ""}`;
  const checks: Array<{ name: string; kind: "tsc" | "test" | "other"; command: string; args: string[] }> = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/pnpm ((?:test|check)[\w:-]*)(?:\s+-t\s+\\?"((?:[^"\\]|\\.)*?)\\?")?/g)) {
    const script = m[1];
    const filter = m[2]?.replace(/\\"/g, '"');
    const name = filter ? `${script} -t "${filter}"` : script;
    if (seen.has(name)) continue;
    seen.add(name);
    checks.push({ name, kind: script.startsWith("check") ? "other" : "test", command: "pnpm", args: filter ? [script, "-t", filter] : [script] });
  }
  return checks;
}

function runGateSet(
  cwd: string,
  gates: Array<{ name: string; kind: "tsc" | "test" | "other"; command: string; args: string[]; available: boolean; requiredWhenScaffolded?: boolean }>,
): { verdict: "green" | "red" | "infra"; results: Array<{ name: string; status: GateResult["status"]; log: string }> } {
  // Bootstrap exception ONLY: with no package.json at all (pre-walking-skeleton) a missing
  // script is `unavailable`. Once the tree is scaffolded, a missing REQUIRED gate is RED —
  // an absent check is a failing check, never a silent pass (04-backpressure.md §wiring).
  const scaffolded = existsSync(join(cwd, "package.json"));
  const results: Array<{ name: string; status: GateResult["status"]; log: string }> = [];
  let verdict: "green" | "red" | "infra" = "green";
  for (const gate of gates) {
    if (!gate.available) {
      if (scaffolded && gate.requiredWhenScaffolded !== false) {
        results.push({ name: gate.name, status: "red", log: "REQUIRED blocking gate is not wired on this tree (missing script/config/binary) — an absent gate is red, not unavailable" });
        verdict = "red";
      } else {
        results.push({ name: gate.name, status: "unavailable", log: "pre-scaffold tree (no package.json) — recorded, not red" });
      }
      continue;
    }
    const r = runGate(gate.kind, gate.command, gate.args, cwd);
    results.push({ name: gate.name, status: r.status, log: r.log });
    if (r.status === "red") verdict = "red";
    else if (r.status === "infra" && verdict !== "red") verdict = "infra";
  }
  return { verdict, results };
}

// Tier-1 pre-merge gate set (04-backpressure.md §Merge-check wiring), run on a tree at
// `cwd`: tsc, unit+integration with the 100% line+branch coverage gate, local e2e,
// gitleaks full-history, docs-markers lint, env-docs check, plus the ticket's own named
// blocking checks.
function runTier1Gates(cwd: string, extraChecks: Array<{ name: string; kind: "tsc" | "test" | "other"; command: string; args: string[] }> = []) {
  const scripts = packageScripts(cwd);
  const gitleaksAvailable = spawnSync("gitleaks", ["version"], { encoding: "utf8" }).status === 0;
  const gates: Array<{ name: string; kind: "tsc" | "test" | "other"; command: string; args: string[]; available: boolean; requiredWhenScaffolded?: boolean }> = [
    { name: "tsc", kind: "tsc", command: "npx", args: ["tsc", "--noEmit"], available: existsSync(join(cwd, "tsconfig.json")) },
    { name: "coverage-100 (REQ-10.1)", kind: "test", command: "pnpm", args: ["test:coverage"], available: Boolean(scripts["test:coverage"]) },
    { name: "test:unit", kind: "test", command: "pnpm", args: ["test:unit"], available: Boolean(scripts["test:unit"]) },
    { name: "test:integration", kind: "test", command: "pnpm", args: ["test:integration"], available: Boolean(scripts["test:integration"]) },
    { name: "test:e2e", kind: "test", command: "pnpm", args: ["test:e2e"], available: Boolean(scripts["test:e2e"]) },
    // Full-history secret scan (REQ-11.3): gitleaks scans the repo's git history by default.
    { name: "gitleaks-full-history (REQ-11.3)", kind: "other", command: "gitleaks", args: ["detect", "--source", ".", "--redact"], available: gitleaksAvailable },
    { name: "docs-markers (REQ-11.2)", kind: "test", command: "pnpm", args: ["test:unit", "-t", "docs markers"], available: Boolean(scripts["test:unit"]) },
    { name: "check:env-docs (REQ-11.3)", kind: "other", command: "pnpm", args: ["check:env-docs"], available: Boolean(scripts["check:env-docs"]) },
    ...extraChecks.map((c) => ({ ...c, available: Boolean(scripts[c.args[0]]) })),
  ];
  return runGateSet(cwd, gates);
}

// Tier-2 post-land backpressure (O3): Preview e2e, the long-task PR variant, and the
// smoke skip-behavior leg run after EVERY land and block further dispatch/landing.
// DECISION: pre-scaffold (no package.json yet), a missing preview URL/script is recorded
// `unavailable` — there is nothing to wire yet. Once the tree is scaffolded, an absent
// script or preview URL is a REQUIRED gate that never got wired, so it goes RED like any
// other missing Tier-1/Tier-2 gate (04-backpressure.md §wiring) — it must never stay green
// (or silently `unavailable`) just because the script/URL doesn't exist on this tree.
function runTier2Gates(cwd: string) {
  const scripts = packageScripts(cwd);
  const previewUrl = process.env.PREVIEW_URL ?? process.env.VERCEL_PREVIEW_URL ?? "";
  const gates: Array<{ name: string; kind: "tsc" | "test" | "other"; command: string; args: string[]; available: boolean; requiredWhenScaffolded?: boolean }> = [
    {
      name: "e2e-preview (REQ-10.3)",
      kind: "test",
      command: "pnpm",
      args: previewUrl && scripts["test:e2e"] ? ["test:e2e", "--base-url", previewUrl] : ["test:e2e:preview"],
      available: Boolean((previewUrl && scripts["test:e2e"]) || scripts["test:e2e:preview"]),
    },
    { name: "longtask-pr-variant (REQ-9.3)", kind: "test", command: "pnpm", args: ["test:e2e", "-t", "longtask short"], available: Boolean(scripts["test:e2e"]) },
    { name: "smoke-skip-behavior (REQ-10.4)", kind: "test", command: "pnpm", args: ["test:e2e", "-t", "smoke"], available: Boolean(scripts["test:e2e"]) },
  ];
  return runGateSet(cwd, gates);
}

// ─── Run ledger (O6): artifacts/smithering/build/<runId>/index.md ────────────

function updateIndex(runId: string, rows: Array<{ id: string; status: string; detail: string }>) {
  const dir = resolve(REPO_ROOT, "artifacts", "smithering", "build", runId);
  mkdirSync(dir, { recursive: true });
  const body = [
    `# Smithering build ledger — run ${runId}`,
    "",
    "| ticket | status | detail |",
    "|---|---|---|",
    ...rows.map((r) => `| ${r.id} | ${r.status} | ${r.detail.replace(/\|/g, "/").slice(0, 160)} |`),
    "",
  ].join("\n");
  writeFileSync(join(dir, "index.md"), body);
}

// ─── Fresh-context prompts (O7) — self-contained strings, nothing inherited ──

const MAY_NOT_ASSUME = `
WHAT YOU MAY NOT ASSUME (fresh context — nothing exists unless named here or on disk):
- You have NO memory of any other ticket, prior attempt, or planning conversation. If it
  is not in this prompt or in a file this prompt names, it does not exist.
- Repo state is the integration branch at your worktree's fork point plus this ticket's
  declared dependencies (guaranteed already landed). Undeclared cross-ticket coupling is a
  bug to REPORT in your summary, not code around.
- No prior run's artifacts count as evidence. No live credentials exist unless the ticket
  names the env var AND it is set. NEVER invent test results — write unknown/unverified
  facts as exactly that in the evidence files.
- Model policy: claude-sonnet-4-7 DOES NOT EXIST; never request it.
- NEVER raise human gates yourself (no ask-human). Surface blockers in your summary.
- NEVER push, force-push, open PRs, switch branches, or touch main or the integration
  branch. Commit locally to YOUR worktree branch only; the orchestrator owns all landing.`;

function requiredEvidenceList(evidencePath: string): string {
  return `
REQUIRED evidence files (O6) under ${evidencePath}/ (worktree-relative; absence of any
REQUIRED file is a gate FAILURE, never a pass):
- plan.md — your implementation plan.
- diff.patch — final diff vs the fork point (git diff <base>...HEAD).
- gates.json — one entry per blocking gate you claim, each with { criterionId, command,
  redRunPath, greenRunPath }. redRunPath/greenRunPath are CONTRACTUAL: they must equal the
  worktree-relative paths of real, non-empty log files you actually wrote (under
  ${evidencePath}/test-output/ and ${evidencePath}/rbg/). Naming drift fails verification.
- test-output/ — raw output of every Tier-1 gate run, one file per gate, named by
  backpressure criterionId.
- rbg/ — red-before-green pairs for every BP-5 (RBG) gate: the committed failing run log
  AND the passing run log. For fixes: prove red BEFORE green.
- review.json / verify.json / challenge.json — written by the reviewer/verifier/challenger
  roles respectively (not by the implementer).
- decisions/*.html — a self-contained HTML decision doc for EVERY judgment call
  (alternatives considered, example inputs/outputs, diffs), same format as
  artifacts/smithering/decisions/.`;
}

function ticketContext(t: Ticket, runId: string, ticketId: string, evidencePath: string, baseCommit: string): string {
  return `
TICKET (verbatim JSON from ${TICKETS_PATH} — instructions are self-contained; never paraphrased):
${JSON.stringify(t, null, 2)}

READ BEFORE WRITING ANY CODE (exact paths):
${PLANNING_DOCS.map((p) => `- ${p}`).join("\n")}
- 03-eng.md includes the §19 probe amendments; 04-backpressure.md holds YOUR gate rows.
- Recorded decision docs (exact paths — read every one relevant to your ticket's eng sections):
${decisionDocPaths().length > 0 ? decisionDocPaths().map((p) => `  - ${p}`).join("\n") : "  - (none recorded yet under artifacts/smithering/decisions/)"}

RUN CONTEXT:
- runId: ${runId}
- Your worktree: the current working directory (already an isolated checkout — do NOT cd elsewhere).
- Branch: ${ticketBranch(runId, ticketId)} (forked from ${integrationBranch(runId)} @ ${baseCommit}).
- Evidence path (worktree-relative): ${evidencePath}/
${requiredEvidenceList(evidencePath)}
${MAY_NOT_ASSUME}`;
}

function implementPrompt(t: Ticket, runId: string, baseCommit: string, feedback: string | null, attempt: number): string {
  const evidencePath = evidenceRel(runId, t.id);
  const a2Note = t.id === A2_TICKET_ID
    ? `\nGATE A2 (mechanically enforced): a live 25-minute Sandbox run is STEP ZERO of this ticket. Its result MUST be committed at ${A2_EVIDENCE_REL} (worktree-relative) as JSON with "completed": true plus the run's start/end timestamps and output checksum. The capture gate reads that exact file; without it the ticket CANNOT land. If you cannot run it (missing access), stop and report the blocker in your summary — do not fake it.\n`
    : "";
  return `You are the IMPLEMENTER (Anthropic family) for one ticket, attempt ${attempt + 1}/${MAX_ITERATIONS}.
${ticketContext(t, runId, t.id, evidencePath, baseCommit)}
${a2Note}
${feedback ? `FEEDBACK FROM THE PREVIOUS ATTEMPT / REVIEW / LAND BOUNCE (fix ALL of it):\n${feedback}\n` : ""}
DO:
1. Step zero: run \`git status\` and \`git log --oneline -5\`; if the tree has conflicts or
   unexpected state (e.g. after an auto-rebase on resume), resolve it BEFORE anything else.
2. Read the named docs, write ${evidencePath}/plan.md.
3. Implement the ticket with tests. For every RBG-marked gate: commit the failing test
   first, save the red run log, then make it green and save the green run log (rbg/).
4. Run your ticket's Tier-1 gates (04-backpressure.md rows) and save raw logs to
   test-output/. Iterating on a named-test subset is fine for speed, but the ticket cannot
   land on a subset — leave the full tier green.
5. Write gates.json with EXACT redRunPath/greenRunPath values matching the files you wrote,
   and diff.patch, and decisions/*.html for every judgment call.
6. Commit everything (code + evidence) to this branch in atomic conventional commits.
Return JSON: { "ticketId": "${t.id}", "summary": "<what you did + open risks>", "blockers": [] }.`;
}

function reviewPrompt(t: Ticket, runId: string, baseCommit: string): string {
  const evidencePath = evidenceRel(runId, t.id);
  return `You are the ADVERSARIAL REVIEWER (OpenAI family — you must NOT be the implementer's
family) for one ticket. You review; you NEVER modify code.
${ticketContext(t, runId, t.id, evidencePath, baseCommit)}

Review the implementation in this worktree against the ticket instructions and its
04-backpressure.md gate rows. Inputs: ${evidencePath}/plan.md, ${evidencePath}/diff.patch,
and the working tree itself (git diff ${baseCommit}...HEAD). Never ask for the
implementer's transcript — it does not exist for you.

Produce findings, or an explicit "no findings" verdict WITH reasons. Write your verdict to
${evidencePath}/review.json as:
{ "approved": <bool>, "model": "gpt-5.4", "findings": [{ "severity": "...", "title": "...", "detail": "...", "file": "..." }], "reasons": "..." }
Your review is a REQUIRED landing signal (O4): the ticket CANNOT land unless review.json
exists on disk with approved=true. Approve only when you found no blocking issues; your
findings are also fed back to the implementer. Commit review.json to the branch.
Return JSON: { "ticketId": "${t.id}", "summary": "<verdict + top findings>", "blockers": [] }.`;
}

function verifyPrompt(t: Ticket, runId: string, baseCommit: string): string {
  const evidencePath = evidenceRel(runId, t.id);
  return `You are the INDEPENDENT VERIFIER (Anthropic family, fresh context, test authority)
for one ticket. You do not trust the implementer, the reviewer, or any prose. You verify by
EXECUTING. You may fix nothing; you only verify and record.
${ticketContext(t, runId, t.id, evidencePath, baseCommit)}

DO, in order:
1. VALIDATE AS IT WILL LAND: rebase this worktree branch onto the CURRENT tip of
   ${integrationBranch(runId)} (git fetch is unnecessary — same repo; use
   \`git rebase ${integrationBranch(runId)}\`). If the rebase conflicts, STOP: record
   pass=false with the conflict output as feedback.
2. Re-run EVERY Tier-1 pre-merge gate for this ticket LIVE on the rebased tip: full
   unit+integration with the 100% line+branch coverage gate, the full local e2e lane,
   gitleaks/env-docs/docs-markers lints where wired, and the ticket's own named checks.
   INFRA RULE: \`tsc --noEmit\` is red ONLY if it printed \`error TS\` diagnostics; a test
   command is red ONLY if tests ran and reported failures. Crashes/OOM/signals/timeouts
   with no such report are INFRA: retry up to 3 times with
   NODE_OPTIONS=--max-old-space-size=6144 and backoff. If infra persists, record
   pass=false with "infra": true and the raw output — never blame the ticket code.
3. EVIDENCE CONTRACT: open ${evidencePath}/gates.json; for EVERY declared gate, resolve its
   redRunPath and greenRunPath from THIS worktree root and require a real, NON-EMPTY file.
   Where BP-5 (RBG) applies, re-run the failing-first commit to confirm the red run was
   real. Reconstructed names or naming drift = pass=false. A missing REQUIRED evidence
   file (plan.md, diff.patch, gates.json, test-output/, rbg/, decisions/) = pass=false.
4. Write ${evidencePath}/verify.json:
{ "pass": <bool>, "model": "<your model id>", "rebasedTip": { "base": "<integration tip sha>", "ok": <bool> },
  "gatesRun": [{ "criterionId": "...", "command": "...", "status": "green|red|infra" }],
  "evidenceChecked": [{ "path": "...", "ok": <bool> }], "infra": <bool>, "feedback": "<exact failures for the implementer, or null>" }
   Commit verify.json (and the rebased state) to the branch.
Return JSON: { "ticketId": "${t.id}", "summary": "<pass/fail + why>", "blockers": [] }.`;
}

function challengePrompt(t: Ticket, runId: string, baseCommit: string): string {
  const evidencePath = evidenceRel(runId, t.id);
  return `You are the ADVERSARIAL SECURITY CHALLENGER (OpenAI family) for a safety/security
ticket. Attempt to BREAK the implementation: bypass auth boundaries, leak a secret, defeat
the gate it claims to add. Default to approved=false if uncertain. You modify nothing.
${ticketContext(t, runId, t.id, evidencePath, baseCommit)}
Write ${evidencePath}/challenge.json:
{ "approved": <bool>, "model": "gpt-5.4", "attacks": [{ "vector": "...", "result": "blocked|SUCCEEDED", "detail": "..." }], "reasons": "..." }
Commit it to the branch.
Return JSON: { "ticketId": "${t.id}", "summary": "<verdict>", "blockers": [] }.`;
}

// ─── On-disk verdict capture (the ONLY source of "done") ─────────────────────

function computeCapture(ctx: any, t: Ticket, attempt: number) {
  const runId: string = ctx.runId;
  const root = worktreeRootFor(ctx, runId, t.id);
  const evidence = root ? join(root, evidenceRel(runId, t.id)) : null;
  const missing: string[] = [];
  let verify: any = null;
  let review: any = null;
  let challenge: any = null;
  let evidenceOk = true;

  if (!root || !evidence || !existsSync(evidence)) {
    missing.push(evidence ?? "worktree evidence dir (worktree path unresolved)");
    evidenceOk = false;
  } else {
    verify = readJsonMaybe(join(evidence, "verify.json"));
    review = readJsonMaybe(join(evidence, "review.json"));
    if (SAFETY_TICKET_IDS.has(t.id)) challenge = readJsonMaybe(join(evidence, "challenge.json"));
    // review.json is REQUIRED for EVERY ticket (O4 — cross-family review is a landing signal).
    for (const req of ["plan.md", "diff.patch", "gates.json", "review.json"]) {
      if (!existsSync(join(evidence, req))) missing.push(req);
    }
    // Required evidence DIRECTORIES: raw gate logs, and at least one decision doc.
    const nonEmptyDir = (rel: string) => {
      try { return readdirSync(join(evidence, rel)).length > 0; } catch { return false; }
    };
    if (!nonEmptyDir("test-output")) missing.push("test-output/ (raw Tier-1 gate logs, one per criterionId)");
    if (!(() => { try { return readdirSync(join(evidence, "decisions")).some((f) => f.endsWith(".html")); } catch { return false; } })()) {
      missing.push("decisions/*.html (at least one recorded decision doc)");
    }
    // Contractual gate coverage: gates.json must be a NON-EMPTY array, every entry must
    // declare BOTH redRunPath and greenRunPath, and each must resolve to a real,
    // non-empty file in THIS worktree. An empty gate list is a failing contract, not a pass.
    const gates = readJsonMaybe(join(evidence, "gates.json"));
    if (!Array.isArray(gates) || gates.length === 0) {
      missing.push("gates.json: non-empty array of gate entries required (empty gate coverage never passes)");
    } else {
      for (const g of gates) {
        for (const key of ["redRunPath", "greenRunPath"]) {
          const p = g?.[key];
          if (typeof p !== "string" || p.length === 0) {
            missing.push(`${g?.criterionId ?? "gate"}:${key} missing (BP-5 contract: both paths are mandatory, red-before-green)`);
            continue;
          }
          const abs = join(root, p);
          if (!existsSync(abs) || readFileSync(abs, "utf8").trim().length === 0) missing.push(`${g.criterionId ?? "gate"}:${key}=${p}`);
        }
      }
    }
    // A2 durable gate: the Sandbox ticket requires the live >20-min run result on disk.
    if (t.id === A2_TICKET_ID) {
      const a2 = readJsonMaybe(join(root, A2_EVIDENCE_REL));
      if (a2?.completed !== true) missing.push(`${A2_EVIDENCE_REL} with completed:true (live 25-min Sandbox proof)`);
    }
    if (missing.length > 0) evidenceOk = false;
  }

  const rebasedTipOk = verify?.rebasedTip?.ok === true;
  const challengeApproved = SAFETY_TICKET_IDS.has(t.id) ? challenge?.approved === true : null;
  const verifyPass = verify?.pass === true;
  // O4: the cross-family review is a REQUIRED landing signal — review.json with
  // approved=true must exist on disk; a missing or rejecting review blocks landing.
  const reviewApproved = review?.approved === true;
  const pass = verifyPass && rebasedTipOk && evidenceOk && reviewApproved && (challengeApproved !== false);

  const feedbackParts: string[] = [];
  if (!verify) feedbackParts.push("Verifier produced no verify.json — the verdict on disk is the only landing signal; ensure it is written and committed.");
  else if (!verifyPass) feedbackParts.push(`VERIFIER FAILED: ${verify.feedback ?? JSON.stringify(verify.gatesRun ?? []).slice(0, 2000)}`);
  if (verify && !rebasedTipOk) feedbackParts.push("Rebased-tip proof missing/false: rebase onto the current integration tip and re-run the gates there.");
  if (!evidenceOk) feedbackParts.push(`EVIDENCE CONTRACT VIOLATIONS (missing/empty): ${missing.join(", ")}`);
  if (challengeApproved === false) feedbackParts.push(`SECURITY CHALLENGE REJECTED: ${challenge?.reasons ?? "see challenge.json attacks"}`);
  if (!review) feedbackParts.push("REQUIRED CROSS-FAMILY REVIEW MISSING: no review.json on disk (O4) — the codex reviewer must write and commit it with approved=true before landing.");
  const reviewAdvisory = review && review.approved === false
    ? `REVIEW REJECTED (O4 blocking — fix the findings or rebut them in decisions/ and get re-approval): ${JSON.stringify(review.findings ?? review.reasons ?? "").slice(0, 2000)}`
    : null;
  if (reviewAdvisory) feedbackParts.push(reviewAdvisory);

  // Snapshot the verdicts orchestrator-side so attempt history survives the per-attempt
  // evidence wipe (O6 belt two).
  try {
    const snapDir = join(orchestratorStateDir(runId), t.id, `attempt-${attempt}`);
    mkdirSync(snapDir, { recursive: true });
    writeFileSync(join(snapDir, "capture.json"), JSON.stringify({ verify, review, challenge, missing, pass }, null, 2));
  } catch {
    // ledger snapshot is best-effort; the durable verdict is this task's output
  }

  return {
    ticketId: t.id,
    attempt,
    pass,
    rebasedTipOk,
    evidenceOk,
    challengeApproved,
    reviewApproved,
    reviewAdvisory,
    feedback: feedbackParts.length > 0 ? feedbackParts.join("\n\n") : null,
    missingEvidence: missing,
  };
}

// ─── Land lane (single serialized slot; continuous, per-ticket) ──────────────

function integrationWorktreePath(runId: string): string {
  return resolve(REPO_ROOT, ".smithers", "worktrees", runId, "_integration");
}

function ensureIntegrationWorktree(runId: string): string {
  const path = integrationWorktreePath(runId);
  if (!existsSync(join(path, ".git"))) {
    mkdirSync(resolve(REPO_ROOT, ".smithers", "worktrees", runId), { recursive: true });
    const res = git(["worktree", "add", path, integrationBranch(runId)]);
    if (res.status !== 0) throw new Error(`integration worktree add failed: ${res.stderr}`);
  }
  return path;
}

function computeLand(ctx: any, t: Ticket, attempt: number) {
  const runId: string = ctx.runId;
  const gateLog: string[] = [];
  const bounce = (feedback: string) => ({ ticketId: t.id, attempt, landed: false, bounced: true, infra: false, commit: null, feedback, gateLog });
  const infra = (feedback: string) => ({ ticketId: t.id, attempt, landed: false, bounced: false, infra: true, commit: null, feedback, gateLog });

  if (landedOnIntegration(runId, t.id)) {
    return { ticketId: t.id, attempt, landed: true, bounced: false, infra: false, commit: integrationTip(runId), feedback: "already landed (idempotent)", gateLog };
  }
  // Re-check deps landed at execution time (queue may have reordered).
  const unlanded = depsOf(t).filter((d) => !landedOnIntegration(runId, d));
  if (unlanded.length > 0) return infra(`deps not landed yet at land time: ${unlanded.join(", ")} (retryable)`);

  const iwt = ensureIntegrationWorktree(runId);
  git(["merge", "--abort"], iwt); // clear any stale state; ignore failure
  const branch = ticketBranch(runId, t.id);
  const merge = git(["merge", "--no-ff", "--no-commit", branch], iwt);
  if (merge.status !== 0) {
    git(["merge", "--abort"], iwt);
    return bounce(`MERGE CONFLICT landing ${branch} onto ${integrationBranch(runId)}:\n${(merge.stdout ?? "") + (merge.stderr ?? "")}\nRebase your branch onto the current integration tip, resolve, re-verify, and re-land.`);
  }
  // Re-run Tier-1 gates on the exact merged tip (O2 land protocol step 2), infra-aware —
  // including this ticket's own named blocking checks from its backpressure rows.
  const gates = runTier1Gates(iwt, ticketNamedChecks(t));
  for (const g of gates.results) gateLog.push(`${g.name}: ${g.status}`);
  if (gates.verdict === "red") {
    const failing = gates.results.filter((g) => g.status === "red").map((g) => `--- ${g.name} ---\n${g.log}`).join("\n");
    git(["merge", "--abort"], iwt);
    git(["reset", "--hard", integrationBranch(runId)], iwt);
    return bounce(`MERGED-TIP GATES RED (real failures on the tree as it would land):\n${failing.slice(0, 6000)}`);
  }
  if (gates.verdict === "infra") {
    git(["merge", "--abort"], iwt);
    git(["reset", "--hard", integrationBranch(runId)], iwt);
    return infra(`merged-tip gates hit persistent INFRA (crash/OOM/timeout, zero real failures) after retries — retryable, not the ticket's fault. ${gateLog.join(", ")}`);
  }
  const commit = git(["commit", "-m", `smithering-land: ${t.id}`], iwt);
  if (commit.status !== 0) {
    // "nothing to commit" ⇒ branch contributed no changes — that is a real bounce (empty branch).
    const out = (commit.stdout ?? "") + (commit.stderr ?? "");
    git(["merge", "--abort"], iwt);
    return /nothing to commit/i.test(out)
      ? bounce("Land found NOTHING TO MERGE: the ticket branch is empty relative to integration. Ensure work is committed in the ticket worktree (never a pinned cwd writing to repo root).")
      : infra(`git commit failed during land: ${out}`);
  }
  return { ticketId: t.id, attempt, landed: true, bounced: false, infra: false, commit: integrationTip(runId), feedback: null, gateLog };
}

// ─── Tier-2 post-land backpressure (O3): runs after EVERY land on the integration tip;
//     while pending or red, NO further worker dispatch and NO further landing happens. ──

function computeTier2(ctx: any, t: Ticket, attempt: number) {
  const iwt = ensureIntegrationWorktree(ctx.runId);
  git(["merge", "--abort"], iwt); // clear any stale land state; ignore failure
  git(["reset", "--hard", integrationBranch(ctx.runId)], iwt);
  const g = runTier2Gates(iwt);
  return {
    ticketId: t.id,
    attempt,
    verdict: g.verdict,
    results: g.results.map((r) => ({ name: r.name, status: r.status, log: r.log.slice(0, 4000) })),
  };
}

const tier2Id = (id: string, n: number, retry: boolean) => `ticket:${id}:tier2:${n}${retry ? ":retry" : ""}`;

// ─── Per-ticket state machine (all verdicts from durable compute outputs) ─────

type TicketState =
  | { kind: "waiting-deps"; on: string[] }
  | { kind: "blocked-by-dep"; on: string[] }
  | { kind: "needs-credential"; missing: string[] }
  | { kind: "waiting-human"; gate: string }
  | { kind: "working"; attempt: number; feedback: string | null }
  | { kind: "ready-to-land"; attempt: number; landRetry: boolean }
  | { kind: "landed" }
  | { kind: "blocked"; reason: string };

const capId = (id: string, n: number) => `ticket:${id}:capture:${n}`;
const landId = (id: string, n: number, retry: boolean) => `ticket:${id}:land:${n}${retry ? ":retry" : ""}`;

function ticketState(ctx: any, t: Ticket, smoke: boolean, stateOf: (id: string) => TicketState): TicketState {
  const missing = missingRequiredCredentials(t);
  if (missing.length > 0) return { kind: "needs-credential", missing };
  if (!smoke && t.id === A13_TICKET_ID && !a13Accepted()) return { kind: "waiting-human", gate: "A13 placeholder-residual amendment not yet accepted in docs/planning/01-prd.md" };
  if (landedOnIntegration(ctx.runId, t.id)) return { kind: "landed" }; // fresh-run idempotency

  const deps = depsOf(t);
  const depStates = deps.map((d) => ({ d, s: stateOf(d) }));
  const terminalBlockers = depStates.filter(({ s }) => s.kind === "blocked" || s.kind === "needs-credential" || s.kind === "waiting-human" || s.kind === "blocked-by-dep");
  if (terminalBlockers.length > 0) return { kind: "blocked-by-dep", on: terminalBlockers.map(({ d }) => d) };
  const pending = depStates.filter(({ s }) => s.kind !== "landed");
  if (pending.length > 0) return { kind: "waiting-deps", on: pending.map(({ d }) => d) };

  let feedback: string | null = null;
  for (let n = 0; n < MAX_ITERATIONS; n += 1) {
    const cap = ctx.outputMaybe("capture", { nodeId: capId(t.id, n) });
    if (!cap) return { kind: "working", attempt: n, feedback };
    if (!cap.pass) {
      feedback = [cap.feedback, cap.reviewAdvisory].filter(Boolean).join("\n\n") || "verification failed with no recorded detail";
      continue;
    }
    const land = ctx.outputMaybe("land", { nodeId: landId(t.id, n, false) });
    if (!land) return { kind: "ready-to-land", attempt: n, landRetry: false };
    if (land.landed) return { kind: "landed" };
    if (land.bounced) {
      feedback = `LAND BOUNCE (merged-tip validation): ${land.feedback}`;
      continue; // reopens the worker loop at the next attempt (up to MAX_ITERATIONS)
    }
    // infra land → one serialized retry, then blocked as infra (retryable by rerun)
    const retry = ctx.outputMaybe("land", { nodeId: landId(t.id, n, true) });
    if (!retry) return { kind: "ready-to-land", attempt: n, landRetry: true };
    if (retry.landed) return { kind: "landed" };
    if (retry.bounced) {
      feedback = `LAND BOUNCE: ${retry.feedback}`;
      continue;
    }
    return { kind: "blocked", reason: `land lane infra error persisted after retry: ${retry.feedback}` };
  }
  return { kind: "blocked", reason: `maxIterations (${MAX_ITERATIONS}) exhausted; last feedback: ${(feedback ?? "none").slice(0, 500)}` };
}

// Memoized state resolver (the DAG is small; recursion depth is DAG depth).
function buildStates(ctx: any, tickets: Ticket[], smoke: boolean): Map<string, TicketState> {
  const memo = new Map<string, TicketState>();
  const stateOf = (id: string): TicketState => {
    if (memo.has(id)) return memo.get(id)!;
    const t = TICKET_BY_ID.get(id);
    if (!t) return { kind: "landed" }; // unknown dep — treated as satisfied (recorded in report)
    // Cycle guard: waves computation already rejected cycles, so plain recursion is safe.
    const s = ticketState(ctx, t, smoke, stateOf);
    memo.set(id, s);
    return s;
  };
  for (const t of tickets) stateOf(t.id);
  return memo;
}

// ─── Render helpers ───────────────────────────────────────────────────────────

function renderWorker(ctx: any, t: Ticket, attempt: number, feedback: string | null) {
  const runId: string = ctx.runId;
  const path = wtPathProp(runId, t.id);
  // Per-ticket base: the branch's ACTUAL fork point off the moving integration branch —
  // never the setup-time tip, so diffs/reviews never include landed-dependency changes.
  const baseCommit = forkPointOf(runId, t.id);
  const isSafety = SAFETY_TICKET_IDS.has(t.id);
  const evidenceAbs = () => {
    const root = worktreeRootFor(ctx, runId, t.id);
    return root ? join(root, evidenceRel(runId, t.id)) : null;
  };
  return (
    <Worktree
      key={`wt-${t.id}`}
      id={`wt-${t.id}`}
      path={path}
      branch={ticketBranch(runId, t.id)}
      baseBranch={integrationBranch(runId)}
    >
      <Sequence>
        {/* O6 belt two: wipe this ticket's evidence dir before every (re)dispatch so a
            retried attempt can never inherit its own earlier verdicts. */}
        <Task id={`ticket:${t.id}:prep:${attempt}`} output={outputs.prep} continueOnFail>
          {() => {
            const dir = evidenceAbs();
            if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
            if (dir) mkdirSync(dir, { recursive: true });
            return { ticketId: t.id, attempt, cleaned: Boolean(dir) };
          }}
        </Task>
        <Task
          id={`ticket:${t.id}:implement:${attempt}`}
          output={outputs.implement}
          agent={implementerFor(t)}
          retries={3}
          continueOnFail
          timeoutMs={4 * 60 * 60 * 1000}
          heartbeatTimeoutMs={20 * 60 * 1000}
        >
          {implementPrompt(t, runId, baseCommit, feedback, attempt)}
        </Task>
        <Task
          id={`ticket:${t.id}:review:${attempt}`}
          output={outputs.review}
          agent={[codexReviewer]}
          retries={3}
          continueOnFail
          timeoutMs={60 * 60 * 1000}
          heartbeatTimeoutMs={15 * 60 * 1000}
        >
          {reviewPrompt(t, runId, baseCommit)}
        </Task>
        <Task
          id={`ticket:${t.id}:verify:${attempt}`}
          output={outputs.verify}
          agent={verifierFor(t)}
          retries={3}
          continueOnFail
          timeoutMs={2 * 60 * 60 * 1000}
          heartbeatTimeoutMs={20 * 60 * 1000}
        >
          {verifyPrompt(t, runId, baseCommit)}
        </Task>
        {isSafety && (
          <Task
            id={`ticket:${t.id}:challenge:${attempt}`}
            output={outputs.challenge}
            agent={[codexReviewer]}
            retries={3}
            continueOnFail
            timeoutMs={60 * 60 * 1000}
            heartbeatTimeoutMs={15 * 60 * 1000}
          >
            {challengePrompt(t, runId, baseCommit)}
          </Task>
        )}
        {/* Verdicts from DISK, not agent returns: this compute task is the only "done" source. */}
        <Task id={capId(t.id, attempt)} output={outputs.capture} continueOnFail>
          {() => computeCapture(ctx, t, attempt)}
        </Task>
      </Sequence>
    </Worktree>
  );
}

function stateDetail(s: TicketState): string {
  switch (s.kind) {
    case "waiting-deps": return `waiting on ${s.on.join(", ")}`;
    case "blocked-by-dep": return `blocked by ${s.on.join(", ")}`;
    case "needs-credential": return `needs-credential:${s.missing.join(",")}`;
    case "waiting-human": return s.gate;
    case "working": return `attempt ${s.attempt + 1}/${MAX_ITERATIONS}`;
    case "ready-to-land": return `verified green, queued for land (attempt ${s.attempt + 1})`;
    case "landed": return "landed on integration";
    case "blocked": return s.reason;
  }
}

// ─── Workflow ────────────────────────────────────────────────────────────────

export default smithers((ctx) => {
  const smoke: boolean = ctx.input.smoke ?? false;
  const maxConcurrency: number = ctx.input.maxConcurrency ?? MAX_WORKERS;
  // smoke=true: ONLY the first ticket, end-to-end incl. verification, no human gates.
  const tickets = smoke ? [ALL_TICKETS[0]] : ALL_TICKETS.slice().sort((a, b) =>
    (WAVE_OF.get(a.id)! - WAVE_OF.get(b.id)!) || a.id.localeCompare(b.id));

  const setup = ctx.outputMaybe("setup", { nodeId: "impl:setup" });
  const states = setup ? buildStates(ctx, tickets, smoke) : new Map<string, TicketState>();

  const terminalKinds = new Set(["landed", "blocked", "needs-credential", "waiting-human", "blocked-by-dep"]);
  const allTerminal = setup ? tickets.every((t) => terminalKinds.has(states.get(t.id)!.kind)) : false;

  if (setup) {
    updateIndex(ctx.runId, tickets.map((t) => ({ id: t.id, status: states.get(t.id)!.kind, detail: stateDetail(states.get(t.id)!) })));
  }

  // O3 Tier-2 backpressure: every successful land must be followed by a green Tier-2 run
  // on the integration tip. While any Tier-2 run is pending, red, or infra, NO further
  // worker dispatch and NO further landing happens. Infra/red gets exactly one retry;
  // a persistently non-green Tier-2 halts the run (surfaced in the final report).
  const tier2Pending: Array<{ t: Ticket; attempt: number; retry: boolean }> = [];
  let tier2Red = false;
  if (setup) {
    for (const t of tickets) {
      for (let n = 0; n < MAX_ITERATIONS; n += 1) {
        const landedHere = [false, true].some((r) => ctx.outputMaybe("land", { nodeId: landId(t.id, n, r) })?.landed === true);
        if (!landedHere) continue;
        const first = ctx.outputMaybe("tier2", { nodeId: tier2Id(t.id, n, false) });
        if (!first) { tier2Pending.push({ t, attempt: n, retry: false }); continue; }
        if (first.verdict === "green") continue;
        const retry = ctx.outputMaybe("tier2", { nodeId: tier2Id(t.id, n, true) });
        if (!retry) { tier2Pending.push({ t, attempt: n, retry: true }); continue; }
        if (retry.verdict !== "green") tier2Red = true;
      }
    }
  }
  const tier2Blocking = tier2Pending.length > 0 || tier2Red;

  const working = tier2Blocking ? [] : tickets.filter((t) => states.get(t.id)?.kind === "working");
  const readyToLand = tier2Blocking ? [] : tickets.filter((t) => states.get(t.id)?.kind === "ready-to-land");
  // Report when everything is terminal AND Tier-2 is settled, or when a persistently red
  // Tier-2 has halted the run (nothing further may dispatch or land).
  const reportReady = setup ? ((allTerminal && !tier2Blocking) || (tier2Red && tier2Pending.length === 0)) : false;

  return (
    <Workflow name="smithering-impl">
      <Sequence>
        <Task id="impl:setup" output={outputs.setup}>
          {() => {
            const notes: string[] = [];
            mkdirSync(orchestratorStateDir(ctx.runId), { recursive: true });
            // Ignore rules for worktree/db/artifact roots. Written to the WORKING TREE only
            // (never committed on the current branch); committed on the integration branch below.
            const IGNORE_LINES = [".smithers/worktrees/", "smithers.db*", ".smithers/*.db*", "*.db-shm", "*.db-wal", "node_modules/"];
            const appendIgnores = (giPath: string): string[] => {
              const current = existsSync(giPath) ? readFileSync(giPath, "utf8") : "";
              const additions = IGNORE_LINES.filter((l) => !current.split("\n").includes(l));
              if (additions.length > 0) {
                writeFileSync(giPath, `${current}${current.endsWith("\n") || current === "" ? "" : "\n"}${additions.join("\n")}\n`);
              }
              return additions;
            };
            if (appendIgnores(resolve(REPO_ROOT, ".gitignore")).length > 0) {
              notes.push("wrote .gitignore in the working tree (NOT committed on the current branch)");
            }
            // Integration branch: created once; NEVER merged back to main here, and setup
            // NEVER creates commits on the user's current branch.
            if (git(["rev-parse", "--verify", integrationBranch(ctx.runId)]).status !== 0) {
              if (git(["rev-parse", "HEAD"]).status === 0) {
                const create = git(["branch", integrationBranch(ctx.runId), git(["rev-parse", "--verify", "main"]).status === 0 ? "main" : "HEAD"]);
                if (create.status !== 0) throw new Error(`cannot create ${integrationBranch(ctx.runId)}: ${create.stderr}`);
              } else {
                // No-HEAD repo: build the baseline commit with plumbing on a TEMP index so
                // main/current branch gets NO commit and db artifacts are never staged
                // (.gitignore above plus explicit pathspec excludes, belt and suspenders).
                const env = { ...process.env, GIT_INDEX_FILE: resolve(orchestratorStateDir(ctx.runId), "baseline-index") };
                const plumb = (args: string[]) => spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", env, maxBuffer: 32 * 1024 * 1024 });
                // NOTE: no exclusion pathspecs here — `git add -A -- :!node_modules ...`
                // makes git treat the implicit match-all pathspec as explicitly naming
                // ignored paths and it hard-fails ("paths are ignored by .gitignore").
                // The ignore rules written above already keep node_modules/db files out.
                const add = plumb(["add", "-A"]);
                if (add.status !== 0) throw new Error(`baseline staging failed: ${add.stderr}`);
                const tree = (plumb(["write-tree"]).stdout ?? "").trim();
                const sha = (plumb(["commit-tree", tree, "-m", "chore: smithering baseline (integration branch only; main untouched)"]).stdout ?? "").trim();
                if (!tree || !sha) throw new Error("baseline commit-tree failed");
                const create = git(["branch", integrationBranch(ctx.runId), sha]);
                if (create.status !== 0) throw new Error(`cannot create ${integrationBranch(ctx.runId)}: ${create.stderr}`);
                notes.push("no-HEAD repo: baseline commit created directly on the integration branch via plumbing (main untouched)");
              }
            }
            // Commit the ignore rules ON THE INTEGRATION BRANCH so every ticket worktree
            // inherits them — the current branch is never committed to.
            const iwt = ensureIntegrationWorktree(ctx.runId);
            if (appendIgnores(join(iwt, ".gitignore")).length > 0) {
              git(["add", ".gitignore"], iwt);
              git(["commit", "-m", "chore: ignore smithers worktree/db artifacts"], iwt);
              notes.push("committed .gitignore on the integration branch");
            }
            return {
              integrationBranch: integrationBranch(ctx.runId),
              baseCommit: integrationTip(ctx.runId),
              evidenceRoot: `artifacts/smithering/build/${ctx.runId}`,
              notes,
            };
          }}
        </Task>

        {setup && !reportReady && (
          // Workers and the land lane run CONCURRENTLY: landing is continuous and
          // per-ticket, never a lane after a whole wave. When Tier-2 is pending/red,
          // working/readyToLand are empty and only the Tier-2 tasks below run.
          <Parallel>
            <Parallel maxConcurrency={maxConcurrency}>
              {working.map((t) => {
                const s = states.get(t.id) as Extract<TicketState, { kind: "working" }>;
                return renderWorker(ctx, t, s.attempt, s.feedback);
              })}
            </Parallel>
            {/* O2: exactly one serialized land slot, fed individual ready tickets. */}
            <MergeQueue maxConcurrency={1}>
              {/* O3: Tier-2 post-land runs in the serialized lane (uses the integration
                  worktree) ahead of any further landing. */}
              {tier2Pending.map(({ t, attempt, retry }) => (
                <Task
                  key={tier2Id(t.id, attempt, retry)}
                  id={tier2Id(t.id, attempt, retry)}
                  output={outputs.tier2}
                  continueOnFail
                >
                  {() => computeTier2(ctx, t, attempt)}
                </Task>
              ))}
              {readyToLand.map((t) => {
                const s = states.get(t.id) as Extract<TicketState, { kind: "ready-to-land" }>;
                return (
                  <Task
                    key={landId(t.id, s.attempt, s.landRetry)}
                    id={landId(t.id, s.attempt, s.landRetry)}
                    output={outputs.land}
                    continueOnFail
                  >
                    {() => computeLand(ctx, t, s.attempt)}
                  </Task>
                );
              })}
            </MergeQueue>
            {/* Explicit needs-credential blocks: no implement/verify runs, no crash/retry;
                only transitive dependents are blocked; exact env vars surface in the report. */}
            {tickets
              .filter((t) => states.get(t.id)?.kind === "needs-credential")
              .map((t) => {
                const s = states.get(t.id) as Extract<TicketState, { kind: "needs-credential" }>;
                return (
                  <Task key={`ticket:${t.id}:credential`} id={`ticket:${t.id}:credential`} output={outputs.credential}>
                    {{ ticketId: t.id, status: "needs-credential" as const, missingEnv: s.missing }}
                  </Task>
                );
              })}
          </Parallel>
        )}

        {reportReady && (
          <Task
            id="impl:report"
            output={outputs.report}
            agent={strongClaude}
            retries={3}
            timeoutMs={30 * 60 * 1000}
          >
            {`You are writing the FINAL RUN REPORT for smithering-impl run ${ctx.runId}. Fresh
context: read everything from disk; invent nothing.

Ground truth:
- Ledger: artifacts/smithering/build/${ctx.runId}/index.md
- Per-attempt verdict snapshots: artifacts/smithering/build/${ctx.runId}/_orchestrator/<ticketId>/attempt-N/capture.json
- Integration branch: ${integrationBranch(ctx.runId)} (git log main..${integrationBranch(ctx.runId)} — land commits
  are "smithering-land: <ticketId>"). NEVER merge it into main; that is a human act.

Ticket terminal states (orchestrator view):
${tickets.map((t) => `- ${t.id}: ${states.get(t.id)!.kind} — ${stateDetail(states.get(t.id)!)}`).join("\n")}

Tier-2 post-land backpressure status: ${tier2Red
    ? "RED after retry — the run was HALTED (no further dispatch/landing); treat non-landed tickets as blocked by Tier-2 and lead the report with this."
    : "green/settled for every land."}

Write artifacts/smithering/build/${ctx.runId}/report.md covering: landed tickets (with land
commits), blocked tickets (root cause + which dependents they blocked), every
needs-credential ticket with the EXACT missing env var name(s), advisory review findings
left open, Tier-2/Tier-3 work that remains post-land (Preview e2e, nightly grounding eval,
>20-min proof, fresh-eyes walkthroughs), and next actions for the human.
Return JSON matching the schema: status ("finished" if every ticket landed, else
"partial"), summary, landed[], blocked[], needsCredential[] (as "ticket:ENV_VAR"),
markdownBody (the report).`}
          </Task>
        )}
      </Sequence>
    </Workflow>
  );
});
