"use client";

import type { ReactNode } from "react";
import styles from "./runs.module.css";

export type GatewayRunSummary = {
  runId: string;
  workflowKey?: string;
  status?: string;
  createdAtMs?: number;
};

export type GatewayRunDetails = GatewayRunSummary & {
  finishedAtMs?: number;
};

export type GatewayNode = {
  key?: string;
  id: string;
  name?: string;
  kind?: string;
  status?: string;
  iteration?: number;
  children?: GatewayNode[];
};

export type GatewayEvent = {
  event?: string;
  seq?: number;
  payload?: unknown;
};

export type GatewayApproval = {
  runId: string;
  workflowKey?: string;
  nodeId: string;
  iteration?: number;
  requestTitle?: string;
  requestSummary?: string;
};

export type GatewayRunsDashboardModel = {
  connectionStatus: string;
  runs: GatewayRunSummary[];
  runsLoading: boolean;
  activeRunId?: string;
  selectedRun?: GatewayRunDetails;
  selectedRunLoading: boolean;
  nodeRoot?: GatewayNode | null;
  nodeCount: number;
  nodeLoading: boolean;
  nodeError?: string;
  approvals: GatewayApproval[];
  approvalsLoading: boolean;
  events: GatewayEvent[];
  eventsStreaming: boolean;
  eventsError?: string;
  lastHeartbeatSeq?: number;
  pendingApprovalKey?: string;
};

type ApprovalDecision = {
  runId: string;
  nodeId: string;
  iteration?: number;
};

type ApprovalActions = {
  submitApproval: (params: {
    runId: string;
    nodeId: string;
    iteration?: number;
    decision: {
      approved: boolean;
      note: string;
    };
  }) => Promise<unknown>;
};

export function selectDefaultRunId(
  selectedRunId: string | undefined,
  runs: ReadonlyArray<Pick<GatewayRunSummary, "runId" | "createdAtMs">>,
): string | undefined {
  if (selectedRunId && runs.some((run) => run.runId === selectedRunId)) {
    return selectedRunId;
  }
  return [...runs].sort((left, right) => (right.createdAtMs ?? 0) - (left.createdAtMs ?? 0))[0]?.runId;
}

export function approvalKey(approval: Pick<GatewayApproval, "runId" | "nodeId" | "iteration">) {
  return `${approval.runId}:${approval.nodeId}:${approval.iteration ?? 0}`;
}

export async function submitApprovalDecision(
  actions: ApprovalActions,
  approval: ApprovalDecision,
  approved: boolean,
) {
  await actions.submitApproval({
    runId: approval.runId,
    nodeId: approval.nodeId,
    iteration: approval.iteration,
    decision: {
      approved,
      note: approved ? "Approved from Next.js Gateway UI" : "Denied from Next.js Gateway UI",
    },
  });
}

export function GatewayRunsDashboard({
  model,
  onSelectRun,
  onApprovalDecision,
}: {
  model: GatewayRunsDashboardModel;
  onSelectRun: (runId: string) => void;
  onApprovalDecision: (approval: GatewayApproval, approved: boolean) => void;
}) {
  const disconnected = model.connectionStatus === "offline" || model.connectionStatus === "unauthorized";

  return (
    <DashboardFrame>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Smithers Gateway</p>
          <h1>Smithers Runs</h1>
        </div>
        <StatusBadge label={model.connectionStatus} tone={model.connectionStatus} />
      </header>

      {disconnected ? (
        <section className={styles.notice} role="status">
          <strong>{model.connectionStatus === "unauthorized" ? "Gateway authorization failed." : "Gateway disconnected."}</strong>
          <span>Start the Smithers gateway locally, or check the configured gateway URL.</span>
        </section>
      ) : null}

      <div className={styles.dashboardGrid}>
        <aside className={styles.sidebar} aria-label="Run selector">
          <div className={styles.panelHeader}>
            <h2>Runs</h2>
            <span>{model.runsLoading ? "Loading" : `${model.runs.length} shown`}</span>
          </div>
          <div className={styles.runList}>
            {model.runs.length ? (
              model.runs.map((item) => (
                <button
                  className={item.runId === model.activeRunId ? styles.runButtonActive : styles.runButton}
                  key={item.runId}
                  onClick={() => onSelectRun(item.runId)}
                  type="button"
                >
                  <span className={styles.runButtonTitle}>{item.workflowKey ?? "workflow"}</span>
                  <span className={styles.runButtonMeta}>{item.runId}</span>
                  <span className={styles.runButtonFooter}>
                    <StatusDot status={item.status} />
                    {formatTimestamp(item.createdAtMs)}
                  </span>
                </button>
              ))
            ) : (
              <EmptyPanel title="No runs yet" detail="The gateway did not return any runs." />
            )}
          </div>
        </aside>

        <section className={styles.mainColumn}>
          <RunSummary
            loading={model.selectedRunLoading}
            run={model.selectedRun}
            runId={model.activeRunId}
          />
          <section className={styles.splitGrid}>
            <Panel title="Node Tree" meta={model.nodeLoading ? "Loading" : `${model.nodeCount} nodes`}>
              {model.nodeError ? <InlineError message={model.nodeError} /> : null}
              {model.nodeRoot ? <NodeTree node={model.nodeRoot} /> : <EmptyPanel title="No node tree" detail="Select a run with devtools data." />}
            </Panel>
            <Panel title="Approvals" meta={model.approvalsLoading ? "Loading" : `${model.approvals.length} pending`}>
              {model.approvals.length ? (
                <div className={styles.approvalList}>
                  {model.approvals.map((approval) => {
                    const key = approvalKey(approval);
                    const pending = model.pendingApprovalKey === key;
                    return (
                      <article className={styles.approvalItem} key={key}>
                        <div>
                          <h3>{approval.requestTitle ?? approval.nodeId}</h3>
                          <p>{approval.requestSummary ?? approval.workflowKey ?? approval.nodeId}</p>
                        </div>
                        <div className={styles.approvalMeta}>
                          <span>{approval.nodeId}</span>
                          <span>Iteration {approval.iteration ?? 0}</span>
                        </div>
                        <div className={styles.approvalActions}>
                          <button
                            className={styles.approveButton}
                            disabled={pending}
                            onClick={() => onApprovalDecision(approval, true)}
                            type="button"
                          >
                            Approve
                          </button>
                          <button
                            className={styles.denyButton}
                            disabled={pending}
                            onClick={() => onApprovalDecision(approval, false)}
                            type="button"
                          >
                            Deny
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              ) : (
                <EmptyPanel title="No approvals" detail="Pending human gates will appear here." />
              )}
            </Panel>
          </section>

          <Panel title="Event Stream" meta={model.eventsStreaming ? "Streaming" : "Idle"}>
            {model.eventsError ? <InlineError message={model.eventsError} /> : null}
            <EventStream events={model.events} lastHeartbeatSeq={model.lastHeartbeatSeq} />
          </Panel>
        </section>
      </div>
    </DashboardFrame>
  );
}

export function GatewayRunsLoadingState() {
  return (
    <DashboardFrame>
      <section className={styles.emptyState} aria-live="polite">
        <p className={styles.eyebrow}>Gateway</p>
        <h1>Smithers Runs</h1>
        <p>Run status will appear when this page connects in the browser.</p>
      </section>
    </DashboardFrame>
  );
}

export function DashboardFrame({ children }: { children: ReactNode }) {
  return <main className={styles.page}>{children}</main>;
}

function Panel({ title, meta, children }: { title: string; meta?: string; children: ReactNode }) {
  return (
    <section className={styles.panel}>
      <div className={styles.panelHeader}>
        <h2>{title}</h2>
        {meta ? <span>{meta}</span> : null}
      </div>
      {children}
    </section>
  );
}

function RunSummary({
  run,
  loading,
  runId,
}: {
  run: GatewayRunDetails | undefined;
  loading: boolean;
  runId: string | undefined;
}) {
  return (
    <section className={styles.summaryPanel}>
      <div>
        <p className={styles.eyebrow}>Selected Run</p>
        <h2>{run?.workflowKey ?? runId ?? "No run selected"}</h2>
        <p className={styles.monoText}>{run?.runId ?? runId ?? "Waiting for gateway data"}</p>
      </div>
      <div className={styles.summaryStats}>
        <Metric label="Status" value={loading ? "Loading" : run?.status ?? "Unknown"} />
        <Metric label="Created" value={formatTimestamp(run?.createdAtMs)} />
        <Metric label="Finished" value={formatTimestamp(run?.finishedAtMs)} />
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.metric}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function NodeTree({ node }: { node: GatewayNode }) {
  return (
    <ol className={styles.nodeTree}>
      <NodeTreeItem node={node} />
    </ol>
  );
}

function NodeTreeItem({ node }: { node: GatewayNode }) {
  return (
    <li>
      <div className={styles.nodeRow}>
        <StatusDot status={node.status} />
        <div>
          <strong>{node.name || node.id}</strong>
          <span>
            {node.kind ?? "node"}
            {node.iteration !== undefined ? ` · iteration ${node.iteration}` : ""}
          </span>
        </div>
      </div>
      {node.children?.length ? (
        <ol className={styles.nodeChildren}>
          {node.children.map((child) => (
            <NodeTreeItem key={child.key ?? child.id} node={child} />
          ))}
        </ol>
      ) : null}
    </li>
  );
}

function EventStream({
  events,
  lastHeartbeatSeq,
}: {
  events: ReadonlyArray<GatewayEvent>;
  lastHeartbeatSeq: number | undefined;
}) {
  if (!events.length) {
    return (
      <EmptyPanel
        title="No events"
        detail={lastHeartbeatSeq === undefined ? "Run events will appear here." : `Last heartbeat seq ${lastHeartbeatSeq}.`}
      />
    );
  }

  return (
    <ol className={styles.eventList}>
      {events.map((event, index) => (
        <li key={`${event.seq ?? index}-${event.event ?? "event"}`}>
          <span className={styles.eventSeq}>#{event.seq ?? "?"}</span>
          <div>
            <strong>{event.event ?? "event"}</strong>
            <code>{previewPayload(event.payload)}</code>
          </div>
        </li>
      ))}
    </ol>
  );
}

function StatusBadge({ label, tone }: { label: string; tone?: string }) {
  const normalized = normalizeStatus(tone);
  return <span className={`${styles.statusBadge} ${styles[`status_${normalized}`]}`}>{label}</span>;
}

function StatusDot({ status }: { status?: string }) {
  const normalized = normalizeStatus(status);
  return <span className={`${styles.statusDot} ${styles[`dot_${normalized}`]}`} aria-hidden="true" />;
}

function EmptyPanel({ title, detail }: { title: string; detail: string }) {
  return (
    <div className={styles.emptyPanel}>
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  );
}

function InlineError({ message }: { message: string }) {
  return <p className={styles.inlineError}>{message}</p>;
}

function normalizeStatus(status: string | undefined) {
  const value = (status ?? "idle").toLowerCase();
  if (value.includes("fail") || value.includes("error") || value === "offline" || value === "unauthorized") {
    return "failed";
  }
  if (value.includes("wait") || value.includes("approval")) {
    return "waiting";
  }
  if (value.includes("run") || value.includes("connect") || value === "online") {
    return "running";
  }
  if (value.includes("finish") || value.includes("ok") || value.includes("success")) {
    return "ok";
  }
  if (value.includes("cancel")) {
    return "cancelled";
  }
  return "idle";
}

function formatTimestamp(value: number | undefined) {
  if (!value) {
    return "Not recorded";
  }
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function previewPayload(payload: unknown) {
  if (payload === undefined) {
    return "No payload";
  }
  try {
    const text = JSON.stringify(payload);
    return text.length > 180 ? `${text.slice(0, 177)}...` : text;
  } catch {
    return String(payload);
  }
}
