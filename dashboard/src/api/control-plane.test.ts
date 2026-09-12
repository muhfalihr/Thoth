/// <reference types="bun-types" />

import { afterEach, expect, mock, test } from "bun:test";

import {
  createControlPlaneClient,
  type EditDocument,
  type EditDocumentPatch,
  type ProjectPromptBinding,
  type PromptStageDefinition,
  type PromptTemplateRevision,
  type ResolvedPromptDraft,
  type SaveProjectPromptBindingRequest,
  type SavePromptTemplateRequest,
  type WorkflowSummary,
} from "./control-plane";

test("lists prompt stages from the control plane registry", async () => {
  const stages = [
    { stage_id: "narrative_plan", label: "Narrative plan", status: "draft_only" },
    { stage_id: "visual_plan", label: "Visual plan", status: "draft_only" },
    { stage_id: "caption_copy", label: "Caption and copy", status: "draft_only" },
  ] satisfies PromptStageDefinition[];
  const fetchMock = mock(async () => new Response(JSON.stringify(stages), { status: 200 }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  const client = createControlPlaneClient({ baseUrl: "http://control-plane.test", apiKey: "secret" });

  await expect(client.listPromptStages()).resolves.toEqual(stages);
  expect(fetchMock).toHaveBeenCalledWith(
    "http://control-plane.test/api/v1/prompt-stages",
    expect.objectContaining({ headers: { Authorization: "Bearer secret" } }),
  );
});

test("lists prompt template heads for one encoded stage", async () => {
  const fetchMock = mock(async () => new Response(JSON.stringify([]), { status: 200 }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  const client = createControlPlaneClient({ baseUrl: "http://control-plane.test", apiKey: "secret" });

  await client.listPromptTemplates("project/one", "narrative_plan");
  expect(fetchMock).toHaveBeenCalledWith(
    "http://control-plane.test/api/v1/projects/project%2Fone/prompt-lab/templates?stage_id=narrative_plan",
    expect.objectContaining({ headers: { Authorization: "Bearer secret" } }),
  );
});

test("saves prompt templates and returns the conflict latest revision", async () => {
  const latest = {
    project_id: "project_a",
    template_id: "ptpl_001",
    revision: 4,
    stage_id: "narrative_plan",
    language: "id-ID",
    body: "Latest",
  } satisfies PromptTemplateRevision;
  const fetchMock = mock(async () => new Response(JSON.stringify(latest), { status: 409 }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  const client = createControlPlaneClient({ baseUrl: "http://control-plane.test", apiKey: "secret" });
  const request = {
    stage_id: "narrative_plan",
    language: "id-ID",
    body: "Write a hook",
    template_id: "ptpl_001",
    base_revision: 3,
  } satisfies SavePromptTemplateRequest;

  await expect(client.savePromptTemplate("project/one", request)).resolves.toEqual({
    kind: "conflict",
    latest,
  });
  expect(fetchMock).toHaveBeenCalledWith(
    "http://control-plane.test/api/v1/projects/project%2Fone/prompt-lab/templates",
    expect.objectContaining({
      method: "POST",
      headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
      body: JSON.stringify(request),
    }),
  );
});

test("reads a missing prompt binding as null", async () => {
  globalThis.fetch = mock(async () => new Response("missing", { status: 404 })) as unknown as typeof fetch;
  const client = createControlPlaneClient({ baseUrl: "http://control-plane.test", apiKey: "secret" });

  await expect(client.getPromptBinding("project/one", "narrative_plan")).resolves.toBeNull();
  expect(globalThis.fetch).toHaveBeenCalledWith(
    "http://control-plane.test/api/v1/projects/project%2Fone/prompt-lab/bindings/narrative_plan",
    expect.objectContaining({ headers: { Authorization: "Bearer secret" } }),
  );
});

test("saves prompt bindings with PUT and preserves the typed conflict latest", async () => {
  const latest = {
    project_id: "project_a",
    stage_id: "narrative_plan",
    template_id: "ptpl_001",
    template_revision: 1,
    project_override: "Use Indonesian",
    revision: 2,
  } satisfies ProjectPromptBinding;
  const fetchMock = mock(async () => new Response(JSON.stringify(latest), { status: 409 }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  const client = createControlPlaneClient({ baseUrl: "http://control-plane.test", apiKey: "secret" });
  const request = {
    template_id: "ptpl_001",
    template_revision: 1,
    project_override: "Use conversational Indonesian",
    base_revision: 1,
  } satisfies SaveProjectPromptBindingRequest;

  await expect(client.savePromptBinding("project/a", "narrative_plan", request)).resolves.toEqual({
    kind: "conflict",
    latest,
  });
  expect(fetchMock).toHaveBeenCalledWith(
    "http://control-plane.test/api/v1/projects/project%2Fa/prompt-lab/bindings/narrative_plan",
    expect.objectContaining({ method: "PUT" }),
  );
});

test("fetches the visible resolved prompt draft", async () => {
  const resolved = {
    stage_id: "narrative_plan",
    sections: [
      { kind: "template", label: "Template", text: "Write a hook" },
      { kind: "project_override", label: "Project override", text: "Use Indonesian" },
    ],
    visible_text: "Template\nWrite a hook\n\nProject override\nUse Indonesian",
  } satisfies ResolvedPromptDraft;
  const fetchMock = mock(async () => new Response(JSON.stringify(resolved), { status: 200 }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  const client = createControlPlaneClient({ baseUrl: "http://control-plane.test", apiKey: "secret" });

  await expect(client.getResolvedPrompt("project/one", "caption_copy")).resolves.toEqual(resolved);
  expect(fetchMock).toHaveBeenCalledWith(
    "http://control-plane.test/api/v1/projects/project%2Fone/prompt-lab/resolved/caption_copy",
    expect.objectContaining({ headers: { Authorization: "Bearer secret" } }),
  );
});

test("exposes no provider-backed AI action on the prompt client", async () => {
  globalThis.fetch = mock(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
  const client = createControlPlaneClient({ baseUrl: "http://control-plane.test", apiKey: "secret" });

  const actions = Object.keys(client).join(" ").toLowerCase();
  expect(actions).not.toContain("improve");
  expect(actions).not.toContain("translate");
  expect(actions).not.toContain("proposal");
  expect(typeof client.savePromptTemplate).toBe("function");
  expect(typeof client.savePromptBinding).toBe("function");
});

test("patches edit documents with encoded IDs and returns conflict latest document", async () => {
  const latest = { revision: 4, title: "Latest" } as unknown as EditDocument;
  const fetchMock = mock(async () => new Response(JSON.stringify(latest), { status: 409 }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  const client = createControlPlaneClient({ baseUrl: "http://control-plane.test", apiKey: "secret" });
  const patch = {
    base_revision: 3,
    operations: [
      {
        kind: "replace_text",
        operation_id: "op_001",
        clip_id: "clip_001",
        field: "heading",
        value: "Updated",
      },
    ],
  } satisfies EditDocumentPatch;

  await expect(client.patchEditDocument("project / one", "document / one", patch)).resolves.toEqual({
    kind: "conflict",
    latest,
  });
  expect(fetchMock).toHaveBeenCalledWith(
    "http://control-plane.test/api/v1/projects/project%20%2F%20one/edit-documents/document%20%2F%20one",
    expect.objectContaining({
      method: "PATCH",
      headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }),
  );
});

test("returns saved documents from successful edit patches", async () => {
  const document = { revision: 4, title: "Saved" } as unknown as EditDocument;
  globalThis.fetch = mock(async () => new Response(JSON.stringify(document), { status: 200 })) as unknown as typeof fetch;
  const client = createControlPlaneClient({ baseUrl: "http://control-plane.test", apiKey: "secret" });
  const patch = {
    base_revision: 3,
    operations: [
      {
        kind: "replace_text",
        operation_id: "op_001",
        clip_id: "clip_001",
        field: "heading",
        value: "Updated",
      },
    ],
  } satisfies EditDocumentPatch;

  await expect(client.patchEditDocument("project_001", "document_001", patch)).resolves.toEqual({
    kind: "saved",
    document,
  });
});

test("keeps generic errors for non-conflict edit patch failures", async () => {
  globalThis.fetch = mock(async () => new Response("invalid", { status: 422 })) as unknown as typeof fetch;
  const client = createControlPlaneClient({ baseUrl: "http://control-plane.test", apiKey: "secret" });
  const patch = {
    base_revision: 3,
    operations: [
      {
        kind: "replace_text",
        operation_id: "op_001",
        clip_id: "clip_001",
        field: "heading",
        value: "Updated",
      },
    ],
  } satisfies EditDocumentPatch;

  await expect(client.patchEditDocument("project_001", "document_001", patch)).rejects.toThrow(
    "Control plane request failed (422)",
  );
});

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
