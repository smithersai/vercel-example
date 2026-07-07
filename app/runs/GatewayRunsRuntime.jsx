"use client";

import { useEffect, useMemo, useState } from "react";
import {
  SmithersCollectionsProvider,
  useGatewayActions,
  useGatewayApprovals,
  useGatewayConnectionStatus,
  useGatewayRun,
  useGatewayRunEvents,
  useGatewayRunTree,
  useGatewayRuns,
} from "smithers-orchestrator/gateway-react";
import {
  GatewayRunsDashboard,
  GatewayRunsLoadingState,
  approvalKey,
  selectDefaultRunId,
  submitApprovalDecision,
} from "./GatewayRunsDashboard";

const runsRequest = { filter: { limit: 50 } };

export default function GatewayRunsClient() {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return <GatewayRunsLoadingState />;
  }

  return <GatewayRunsProvider />;
}

function GatewayRunsProvider() {
  const mode = useMemo(() => {
    // Same-origin by default: /v1/api/* is rewritten to the gateway by
    // next.config.mjs and gated by the operator cookie in middleware.ts. Set
    // NEXT_PUBLIC_SMITHERS_GATEWAY_URL only for a directly reachable gateway.
    const gatewayBaseUrl = process.env.NEXT_PUBLIC_SMITHERS_GATEWAY_URL?.trim();
    return {
      kind: "local",
      apiBaseUrl: gatewayBaseUrl || globalThis.location.origin,
    };
  }, []);

  return (
    <SmithersCollectionsProvider mode={mode}>
      <GatewayRunsLive />
    </SmithersCollectionsProvider>
  );
}

function GatewayRunsLive() {
  const [selectedRunId, setSelectedRunId] = useState();
  const [pendingApprovalKey, setPendingApprovalKey] = useState();
  const runs = useGatewayRuns(runsRequest);
  const runRows = runs.data ?? [];
  const activeRunId = selectDefaultRunId(selectedRunId, runRows);
  const run = useGatewayRun(activeRunId);
  const tree = useGatewayRunTree(activeRunId);
  const stream = useGatewayRunEvents(activeRunId, { afterSeq: 0, maxEvents: 100 });
  const approvalsRequest = useMemo(
    () => ({
      filter: activeRunId ? { runId: activeRunId, limit: 20 } : { limit: 20 },
    }),
    [activeRunId],
  );
  const approvals = useGatewayApprovals(approvalsRequest);
  const actions = useGatewayActions();
  const connection = useGatewayConnectionStatus();

  useEffect(() => {
    const nextRunId = selectDefaultRunId(selectedRunId, runRows);
    if (nextRunId !== selectedRunId) {
      setSelectedRunId(nextRunId);
    }
  }, [runRows, selectedRunId]);

  async function decideApproval(approval, approved) {
    const key = approvalKey(approval);
    setPendingApprovalKey(key);
    try {
      await submitApprovalDecision(actions, approval, approved);
      await approvals.refetch();
    } finally {
      setPendingApprovalKey(undefined);
    }
  }

  return (
    <GatewayRunsDashboard
      model={{
        connectionStatus: connection.status,
        runs: runRows,
        runsLoading: runs.loading,
        activeRunId,
        selectedRun: run.data,
        selectedRunLoading: run.loading,
        nodeRoot: tree.root,
        nodeCount: tree.nodes.length,
        nodeLoading: tree.isLoading,
        nodeError: tree.error?.message,
        approvals: approvals.data ?? [],
        approvalsLoading: approvals.loading,
        events: stream.events,
        eventsStreaming: stream.streaming,
        eventsError: stream.error?.message,
        lastHeartbeatSeq: stream.lastHeartbeat?.seq,
        pendingApprovalKey,
      }}
      onApprovalDecision={(approval, approved) => void decideApproval(approval, approved)}
      onSelectRun={setSelectedRunId}
    />
  );
}
