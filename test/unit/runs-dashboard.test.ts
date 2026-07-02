import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  GatewayRunsDashboard,
  GatewayRunsLoadingState,
  type GatewayRunsDashboardModel,
  selectDefaultRunId,
  submitApprovalDecision,
} from "@/app/runs/GatewayRunsDashboard";

const submitApproval = vi.fn();

vi.mock("@/app/runs/GatewayRunsRuntime", () => ({
  default: function MockGatewayRunsClient() {
    return React.createElement("main", null, "mock runs client");
  },
}));

const dashboardModel: GatewayRunsDashboardModel = {
  connectionStatus: "online",
  runs: [
    {
      runId: "run-1",
      workflowKey: "smithering",
      status: "running",
      createdAtMs: 1782950221000,
    },
    {
      runId: "run-2",
      workflowKey: "remediation",
      status: "finished",
      createdAtMs: 1782950200000,
    },
  ],
  runsLoading: false,
  activeRunId: "run-1",
  selectedRun: {
    runId: "run-1",
    workflowKey: "smithering",
    status: "running",
    createdAtMs: 1782950221000,
  },
  selectedRunLoading: false,
  nodeRoot: {
    id: "root",
    name: "Smithering",
    kind: "workflow",
    status: "running",
    children: [
      {
        id: "implement",
        name: "Implement",
        kind: "task",
        status: "running",
        iteration: 1,
      },
    ],
  },
  nodeCount: 2,
  nodeLoading: false,
  approvals: [
    {
      runId: "run-1",
      workflowKey: "smithering",
      nodeId: "design-approval",
      iteration: 2,
      requestTitle: "Approve implementation plan",
      requestSummary: "The workflow is waiting before implementation.",
    },
  ],
  approvalsLoading: false,
  events: [
    {
      event: "task.started",
      seq: 3,
      payload: { nodeId: "implement" },
    },
  ],
  eventsStreaming: true,
  lastHeartbeatSeq: 4,
};

describe("GatewayRunsDashboard", () => {
  it("selects the current run when present and falls back to the newest run", () => {
    const runs = [
      { runId: "older", createdAtMs: 20 },
      { runId: "newer", createdAtMs: 30 },
    ];

    expect(selectDefaultRunId("older", runs)).toBe("older");
    expect(selectDefaultRunId("missing", runs)).toBe("newer");
    expect(selectDefaultRunId(undefined, runs)).toBe("newer");
    expect(selectDefaultRunId(undefined, [])).toBeUndefined();
  });

  it("renders live run status, tree, events, and approval actions from gateway hooks", () => {
    const html = renderToStaticMarkup(
      React.createElement(GatewayRunsDashboard, {
        model: dashboardModel,
        onApprovalDecision: () => {},
        onSelectRun: () => {},
      }),
    );

    expect(html).toContain("Smithers Runs");
    expect(html).toContain("run-1");
    expect(html).toContain("Smithering");
    expect(html).toContain("Implement");
    expect(html).toContain("task.started");
    expect(html).toContain("Approve implementation plan");
    expect(html).toContain("Approve");
    expect(html).toContain("Deny");
  });

  it("renders disconnected, empty, and error states without gateway data", () => {
    const emptyModel: GatewayRunsDashboardModel = {
      connectionStatus: "offline",
      runs: [],
      runsLoading: false,
      selectedRunLoading: false,
      nodeRoot: null,
      nodeCount: 0,
      nodeLoading: false,
      nodeError: "Failed to load run tree.",
      approvals: [],
      approvalsLoading: false,
      events: [],
      eventsStreaming: false,
      eventsError: "Run event stream failed.",
      lastHeartbeatSeq: 8,
    };

    const html = renderToStaticMarkup(
      React.createElement(GatewayRunsDashboard, {
        model: emptyModel,
        onApprovalDecision: () => {},
        onSelectRun: () => {},
      }),
    );

    expect(html).toContain("Gateway disconnected.");
    expect(html).toContain("No runs yet");
    expect(html).toContain("No node tree");
    expect(html).toContain("No approvals");
    expect(html).toContain("Last heartbeat seq 8");
    expect(html).toContain("Failed to load run tree.");
    expect(html).toContain("Run event stream failed.");
  });

  it("renders loading and fallback labels for sparse gateway rows", () => {
    const sparseModel: GatewayRunsDashboardModel = {
      connectionStatus: "unauthorized",
      runs: [{ runId: "run-sparse" }],
      runsLoading: true,
      activeRunId: "run-sparse",
      selectedRunLoading: true,
      nodeRoot: {
        id: "root",
        status: "waiting-approval",
        children: [{ id: "child", status: "cancelled" }],
      },
      nodeCount: 2,
      nodeLoading: true,
      approvals: [],
      approvalsLoading: true,
      events: [
        { seq: 1 },
        { event: "payload.missing" },
        { event: "payload.circular", payload: circularPayload() },
      ],
      eventsStreaming: false,
    };

    const html = renderToStaticMarkup(
      React.createElement(GatewayRunsDashboard, {
        model: sparseModel,
        onApprovalDecision: () => {},
        onSelectRun: () => {},
      }),
    );

    expect(html).toContain("Gateway authorization failed.");
    expect(html).toContain("Loading");
    expect(html).toContain("workflow");
    expect(html).toContain("Not recorded");
    expect(html).toContain("No payload");
    expect(html).toContain("[object Object]");
  });

  it("wires run selection and approval button handlers", () => {
    const onSelectRun = vi.fn();
    const onApprovalDecision = vi.fn();
    const tree = React.createElement(GatewayRunsDashboard, {
      model: dashboardModel,
      onApprovalDecision,
      onSelectRun,
    });
    const buttons = collectButtons(tree);

    clickButton(buttons.find((button) => button.childrenAsText.includes("run-1")));
    clickButton(buttons.find((button) => button.childrenAsText === "Approve"));
    clickButton(buttons.find((button) => button.childrenAsText === "Deny"));

    expect(onSelectRun).toHaveBeenCalledWith("run-1");
    expect(onApprovalDecision).toHaveBeenNthCalledWith(1, dashboardModel.approvals[0], true);
    expect(onApprovalDecision).toHaveBeenNthCalledWith(2, dashboardModel.approvals[0], false);
  });

  it("disables pending approval actions", () => {
    const pending = {
      ...dashboardModel,
      pendingApprovalKey: "run-1:design-approval:2",
    };
    const tree = React.createElement(GatewayRunsDashboard, {
      model: pending,
      onApprovalDecision: () => {},
      onSelectRun: () => {},
    });
    const approvalButtons = collectButtons(tree).filter((button) =>
      button.childrenAsText === "Approve" || button.childrenAsText === "Deny",
    );

    expect(approvalButtons.every((button) => button.disabled === true)).toBe(true);
  });

  it("renders the mounted loading shell and the app-router page", async () => {
    const loading = renderToStaticMarkup(React.createElement(GatewayRunsLoadingState));
    expect(loading).toContain("Run status will appear");

    const { default: RunsPage } = await import("@/app/runs/page");
    const page = RunsPage();
    expect(page.type).toBeTypeOf("function");
  });

  it("submits approval decisions with the gateway submitApproval payload", async () => {
    submitApproval.mockResolvedValueOnce({ approved: true });

    await submitApprovalDecision(
      { submitApproval },
      { runId: "run-1", nodeId: "design-approval", iteration: 2 },
      true,
    );

    expect(submitApproval).toHaveBeenCalledWith({
      runId: "run-1",
      nodeId: "design-approval",
      iteration: 2,
      decision: {
        approved: true,
        note: "Approved from Next.js Gateway UI",
      },
    });

    submitApproval.mockResolvedValueOnce({ approved: false });

    await submitApprovalDecision(
      { submitApproval },
      { runId: "run-1", nodeId: "design-approval", iteration: 2 },
      false,
    );

    expect(submitApproval).toHaveBeenLastCalledWith({
      runId: "run-1",
      nodeId: "design-approval",
      iteration: 2,
      decision: {
        approved: false,
        note: "Denied from Next.js Gateway UI",
      },
    });
  });
});

function circularPayload() {
  const value: { self?: unknown } = {};
  value.self = value;
  return value;
}

type ButtonProps = {
  childrenAsText: string;
  disabled?: boolean;
  onClick?: () => void;
};

function collectButtons(node: unknown): ButtonProps[] {
  const buttons: ButtonProps[] = [];

  function visit(value: unknown): void {
    if (Array.isArray(value)) {
      for (const child of value) {
        visit(child);
      }
      return;
    }
    if (!React.isValidElement(value)) {
      return;
    }
    if (typeof value.type === "function") {
      const Component = value.type as (props: unknown) => unknown;
      visit(Component(value.props));
      return;
    }
    if (value.type === "button") {
      const props = value.props as { children?: unknown; disabled?: boolean; onClick?: () => void };
      buttons.push({
        childrenAsText: textContent(props.children),
        disabled: props.disabled,
        onClick: props.onClick,
      });
    }
    visit((value.props as { children?: unknown }).children);
  }

  visit(node);
  return buttons;
}

function textContent(node: unknown): string {
  if (Array.isArray(node)) {
    return node.map(textContent).join("");
  }
  if (React.isValidElement(node)) {
    return textContent((node.props as { children?: unknown }).children);
  }
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
}

function clickButton(button: ButtonProps | undefined) {
  expect(button?.onClick).toBeTypeOf("function");
  button?.onClick?.();
}
