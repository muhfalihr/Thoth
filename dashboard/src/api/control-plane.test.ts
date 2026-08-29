/// <reference types="bun-types" />

import { afterEach, expect, mock, test } from "bun:test";

import { createControlPlaneClient, type WorkflowSummary } from "./control-plane";

const RUNNING_SUMMARY = {
  workflow_id: "wf_001",
  status: "running" as const,
  created_at: "2026-08-28T08:00:00Z",
  updated_at: "2026-08-28T08:01:00Z",
  source: { display_url: "https://example.test/post/1", platform: "example" },
  stages: [{ id: "source", label: "Finding source", status: "running" as const, progress: 0.4 }],
  artifacts: [],
  approval: null,
  failure: null,
} satisfies WorkflowSummary;

afterEach(() => {
  mock.restore();
});

test("creates workflows with the v1 auth and idempotency headers", async () => {
  const fetchMock = mock(async () =>
    new Response(JSON.stringify({ workflow_id: "wf_001", status: "queued" }), { status: 202 }),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  const client = createControlPlaneClient({ baseUrl: "http://control-plane.test", apiKey: "secret" });

  await client.createWorkflow({
    source: { url: "https://example.test/post/1", intent: "produce_video" },
    style: { preset_id: "news-vertical" },
    output: { format: "mp4", language: "id" },
    review: { require_publish_approval: true },
  });

  expect(fetchMock).toHaveBeenCalledWith(
    "http://control-plane.test/api/v1/workflows",
    expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({
        Authorization: "Bearer secret",
        "Idempotency-Key": expect.any(String),
      }),
    }),
  );
});

test("reopens the event stream with Last-Event-ID and refreshes the authoritative snapshot", async () => {
  const client = createControlPlaneClient({ baseUrl: "http://control-plane.test", apiKey: "secret" });
  const snapshots = mock(async () => ({ workflow_id: "wf_001", status: "running" }));
  client.getWorkflow = snapshots as unknown as typeof client.getWorkflow;
  const fetchMock = mock(async () => new Response("", { status: 200 }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  const stop = client.streamWorkflow("wf_001", mock(() => {}), "41");
  await Promise.resolve();
  await Promise.resolve();
  stop();

  expect(fetchMock).toHaveBeenCalledWith(
    "http://control-plane.test/api/v1/workflows/wf_001/events",
    expect.objectContaining({ headers: { Authorization: "Bearer secret", "Last-Event-ID": "41" } }),
  );
  expect(snapshots).toHaveBeenCalledWith("wf_001");
});

test("turns incremental events into authoritative typed snapshots", async () => {
  const client = createControlPlaneClient({ baseUrl: "http://control-plane.test", apiKey: "secret" });
  client.getWorkflow = mock(async () => RUNNING_SUMMARY);
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          'id: 42\nevent: stage.progress\ndata: {"workflow_id":"wf_001","sequence":42}\n\n',
        ),
      );
    },
  });
  globalThis.fetch = mock(async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
  const received: unknown[] = [];
  const stop = client.streamWorkflow("wf_001", (snapshot) => received.push(snapshot));
  await new Promise((resolve) => setTimeout(resolve, 20));
  stop();

  expect(received.length).toBeGreaterThanOrEqual(2);
  expect(received.every((value) => value === RUNNING_SUMMARY)).toBe(true);
});

test("preserves an SSE frame split across network chunks", async () => {
  const client = createControlPlaneClient({ baseUrl: "http://control-plane.test", apiKey: "secret" });
  const snapshots = mock(async () => RUNNING_SUMMARY);
  client.getWorkflow = snapshots;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("id: 42\nevent: stage.progress\ndata: {\"work"));
      controller.enqueue(
        new TextEncoder().encode('flow_id":"wf_001","sequence":42}\n\n'),
      );
    },
  });
  globalThis.fetch = mock(async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
  const stop = client.streamWorkflow("wf_001", () => {});
  await new Promise((resolve) => setTimeout(resolve, 20));
  stop();

  expect(snapshots).toHaveBeenCalledTimes(2);
});

test("does not let a slower initial snapshot overwrite a newer event refresh", async () => {
  const client = createControlPlaneClient({ baseUrl: "http://control-plane.test", apiKey: "secret" });
  let resolveInitial: (summary: WorkflowSummary) => void = () => {};
  const initial = new Promise<WorkflowSummary>((resolve) => {
    resolveInitial = resolve;
  });
  let call = 0;
  client.getWorkflow = mock(() => (++call === 1 ? initial : Promise.resolve(RUNNING_SUMMARY)));
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          'id: 42\nevent: stage.progress\ndata: {"workflow_id":"wf_001","sequence":42}\n\n',
        ),
      );
    },
  });
  globalThis.fetch = mock(async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
  const received: WorkflowSummary[] = [];
  const stop = client.streamWorkflow("wf_001", (snapshot) => received.push(snapshot));
  await new Promise((resolve) => setTimeout(resolve, 10));
  resolveInitial({ ...RUNNING_SUMMARY, status: "queued" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  stop();

  expect(received.at(-1)?.status).toBe("running");
});
