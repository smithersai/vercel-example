"use client";

import { useEffect, useMemo, useState } from "react";
import {
  SmithersGatewayProvider,
  SyncProvider,
  createGatewayCollections,
  useGatewayActions,
  useGatewayApprovals,
  useGatewayConnectionStatus,
  useGatewayRun,
  useGatewayRunEvents,
  useGatewayRunTree,
  useGatewayRuns,
} from "smithers-orchestrator/gateway-react";
import {
  SmithersGatewayClient,
  createSmithersGatewayTransport,
} from "smithers-orchestrator/gateway-client";
import {
  GatewayRunsDashboard,
  GatewayRunsLoadingState,
  approvalKey,
  selectDefaultRunId,
  submitApprovalDecision,
} from "./GatewayRunsDashboard";

const runsRequest = { filter: { limit: 50 } };
const sameOriginBootConfig = {
  apiVersion: "v1",
  kind: "gateway",
  workflowKey: null,
  mountPath: "/runs",
  rpcPath: "/v1/rpc",
  wsPath: "/smithers-ws",
  assetBasePath: "/runs",
  props: {},
};

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
  const { client, collections } = useMemo(() => {
    globalThis.__SMITHERS_GATEWAY_UI__ = sameOriginBootConfig;
    const gatewayBaseUrl = process.env.NEXT_PUBLIC_SMITHERS_GATEWAY_URL?.trim();
    const gatewayClient = new SmithersGatewayClient({
      ...(gatewayBaseUrl ? { baseUrl: gatewayBaseUrl } : {}),
      client: {
        id: "vercel-example-next",
        version: "1.0.0",
        platform: "nextjs",
      },
    });
    return {
      client: gatewayClient,
      collections: createGatewayCollections({
        client: createSmithersGatewayTransport(gatewayClient),
      }),
    };
  }, []);

  return (
    <SmithersGatewayProvider client={client}>
      <SyncProvider client={collections}>
        <GatewayRunsLive />
      </SyncProvider>
    </SmithersGatewayProvider>
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
