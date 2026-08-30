/// <reference types="bun-types" />

import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { WorkflowSummary } from "@/api/control-plane";

import { WorkflowMonitor } from "./WorkflowMonitor";

afterEach(cleanup);

function summary(overrides: Partial<WorkflowSummary> = {}): WorkflowSummary {
  return {
    workflow_id: "wf_001",
    status: "running",
    created_at: "2026-08-28T08:00:00Z",
    updated_at: "2026-08-28T08:01:00Z",
    source: { display_url: "https://example.test/p", platform: "example" },
    stages: [{ id: "source", label: "Finding source", status: "running", progress: 0.5 }],
    artifacts: [],
    approval: null,
    failure: null,
    ...overrides,
  };
}

test("shows human workflow status before optional diagnostics", async () => {
  const summary: WorkflowSummary = {
    workflow_id: "wf_001",
    status: "awaiting_approval",
    created_at: "2026-08-28T08:00:00Z",
    updated_at: "2026-08-28T08:01:00Z",
    source: { display_url: "https://example.test/p", platform: "example" },
    stages: [{ id: "review", label: "Review video", status: "waiting", progress: 0.8 }],
    artifacts: [
      {
        artifact_id: "video_001",
        kind: "video",
        label: "Video",
        media_type: "video/mp4",
        location: "output/video.mp4",
      },
    ],
    approval: {
      approval_id: "approval_001",
      kind: "publish",
      prompt: "Publish this video?",
      allowed_decisions: ["approve", "reject"],
    },
    failure: null,
  };
  const client = {
    getWorkflow: mock(async () => summary),
    streamWorkflow: mock((_id: string, accept: (value: WorkflowSummary) => void) => {
      accept(summary);
      return () => {};
    }),
    cancelWorkflow: mock(async () => summary),
    retryWorkflow: mock(async () => summary),
    approveWorkflow: mock(async () => summary),
  };
  render(<WorkflowMonitor workflowId="wf_001" client={client} />);

  expect(await screen.findByText(/Review video/)).toBeDefined();
  expect(screen.getByText("Progress")).toBeDefined();
  expect(screen.getByText("Needs your decision")).toBeDefined();
  expect(screen.getByText("Results")).toBeDefined();
  expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeDefined();
  expect(screen.queryByText("Diagnostics")).toBeNull();
});

test("does not let a stale initial fetch overwrite the live stream snapshot", async () => {
  let resolveInitial: (value: WorkflowSummary) => void = () => {};
  const initial = new Promise<WorkflowSummary>((resolve) => { resolveInitial = resolve; });
  const live = summary({ status: "running" });
  const client = {
    getWorkflow: mock(() => initial),
    streamWorkflow: mock((_id: string, accept: (value: WorkflowSummary) => void) => {
      accept(live);
      return () => {};
    }),
    cancelWorkflow: mock(async () => live),
    retryWorkflow: mock(async () => live),
    approveWorkflow: mock(async () => live),
  };
  render(<WorkflowMonitor workflowId="wf_001" client={client} />);

  expect(await screen.findByText("running")).toBeDefined();
  resolveInitial(summary({ status: "queued" }));
  await Promise.resolve();

  expect(screen.getByText("running")).toBeDefined();
  expect(client.getWorkflow).not.toHaveBeenCalled();
});

test("renders action summaries and errors, and averages all stage progress", async () => {
  const user = userEvent.setup();
  const running = summary({
    stages: [
      { id: "source", label: "Source", status: "completed", progress: 1 },
      { id: "assets", label: "Assets", status: "running", progress: 0.5 },
      { id: "render", label: "Render", status: "queued", progress: null },
    ],
  });
  const cancelled = summary({ status: "cancelled" });
  const client = {
    getWorkflow: mock(async () => running),
    streamWorkflow: mock((_id: string, accept: (value: WorkflowSummary) => void) => {
      accept(running);
      return () => {};
    }),
    cancelWorkflow: mock(async () => cancelled),
    retryWorkflow: mock(async () => { throw new Error("checkpoint is unavailable"); }),
    approveWorkflow: mock(async () => running),
  };
  render(<WorkflowMonitor workflowId="wf_001" client={client} />);

  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(await screen.findByText("cancelled")).toBeDefined();
  expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("50");

  await user.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("checkpoint is unavailable")).toBeDefined();
});
