/// <reference types="bun-types" />

import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";

import type { WorkflowSummary } from "@/api/control-plane";

import { WorkflowMonitor } from "./WorkflowMonitor";

afterEach(cleanup);

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
    streamWorkflow: mock(() => () => {}),
    cancelWorkflow: mock(async () => summary),
    retryWorkflow: mock(async () => summary),
    approveWorkflow: mock(async () => summary),
  };
  render(<WorkflowMonitor workflowId="wf_001" client={client} />);

  expect(await screen.findByText(/Review video/)).toBeDefined();
  expect(screen.getByText("Progress")).toBeDefined();
  expect(screen.getByText("Needs decision")).toBeDefined();
  expect(screen.getByText("Results")).toBeDefined();
  expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeDefined();
  expect(screen.queryByText("Diagnostics")).toBeNull();
});
