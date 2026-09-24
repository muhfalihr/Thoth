/// <reference types="bun-types" />

import { afterEach, expect, mock, test } from "bun:test";

import {
  asRenderErrorCode,
  createControlPlaneClient,
  StudioImportRequestError,
  StudioReviewRequestError,
  type EditDocument,
  type EditDocumentPatch,
  type EditorAssetPage,
  type EditorPreviewCapability,
  type ProjectPromptBinding,
  type PromptLayerLock,
  type PromptModelPreference,
  type PromptStageDefinition,
  type PromptTemplateRevision,
  type RenderCapability,
  type RenderErrorCode,
  type RenderJob,
  type RenderJobPage,
  type ReviewComment,
  type ReviewDecision,
  type ReviewErrorCode,
  RenderRequestError,
  type ResolvedPromptDraft,
  type StudioSourceProjection,
  type SaveProjectPromptBindingRequest,
  type SavePromptTemplateRequest,
  type CreatePromptProposalPayload,
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

test("unwraps the typed preference conflict envelope into its latest resource", async () => {
  const latest = {
    project_id: "project_a",
    stage_id: "narrative_plan",
    provider_id: "novita",
    model_id: "deepseek/deepseek-v3.1",
    revision: 9,
    updated_at: "2026-09-13T08:00:00Z",
  } satisfies PromptModelPreference;
  const body = { code: "preference_revision_conflict", latest };
  const fetchMock = mock(async () => new Response(JSON.stringify(body), { status: 409 }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  const client = createControlPlaneClient({ baseUrl: "http://control-plane.test", apiKey: "secret" });

  await expect(
    client.savePromptPreference("project_a", "narrative_plan", {
      provider_id: "novita",
      model_id: "deepseek/deepseek-v3.1",
      base_revision: 1,
    }),
  ).resolves.toEqual({ kind: "conflict", latest });
});

test("unwraps the typed lock conflict envelope into its latest resource", async () => {
  const latest = {
    project_id: "project_a",
    stage_id: "narrative_plan",
    layer: "template",
    locked: true,
    revision: 9,
    updated_at: "2026-09-13T08:00:00Z",
  } satisfies PromptLayerLock;
  const body = { code: "lock_revision_conflict", latest };
  const fetchMock = mock(async () => new Response(JSON.stringify(body), { status: 409 }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  const client = createControlPlaneClient({ baseUrl: "http://control-plane.test", apiKey: "secret" });

  await expect(
    client.savePromptLock("project_a", "narrative_plan", "template", { locked: false, base_revision: 1 }),
  ).resolves.toEqual({ kind: "conflict", latest });
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
  expect(typeof client.savePromptTemplate).toBe("function");
  expect(typeof client.savePromptBinding).toBe("function");
  expect(typeof client.createPromptProposal).toBe("function");
  expect(typeof client.applyPromptProposal).toBe("function");
  expect(typeof client.rejectPromptProposal).toBe("function");
});

test("patches edit documents with encoded IDs and unwraps the typed conflict envelope", async () => {
  const latest = { revision: 4, title: "Latest" } as unknown as EditDocument;
  const fetchMock = mock(async () =>
    new Response(JSON.stringify({ code: "document_revision_conflict", latest }), { status: 409 }),
  );
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

test("createPromptProposal sends one authenticated idempotent request", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = mock(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(C2_PROPOSAL), { status: 202 });
  }) as unknown as typeof fetch;
  const client = createControlPlaneClient({ baseUrl: "http://control-plane.test", apiKey: "secret", fetch: fetchMock });
  await client.createPromptProposal("project/a", "request-1", C2_CREATE);
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe("http://control-plane.test/api/v1/projects/project%2Fa/prompt-lab/proposals");
  expect(calls[0].init?.method).toBe("POST");
  const headers = calls[0].init?.headers as Record<string, string>;
  expect(headers["Idempotency-Key"]).toBe("request-1");
  expect(headers.Authorization).toBe("Bearer secret");
  expect(String(calls[0].init?.body)).not.toContain("base_url");
});

test("prompt C2 read/write methods hit encoded routes", async () => {
  const page = { proposals: [C2_PROPOSAL], next_cursor: null };
  const calls: Array<{ url: string }> = [];
  const fetchMock = mock(async (url: RequestInfo | URL, _init?: RequestInit) => {
    calls.push({ url: String(url) });
    return new Response(JSON.stringify(page), { status: 200 });
  }) as unknown as typeof fetch;
  const client = createControlPlaneClient({ baseUrl: "http://control-plane.test", apiKey: "secret", fetch: fetchMock });
  await client.listPromptProviders();
  await client.getPromptStarter("narrative_plan");
  await client.savePromptPreference("project_a", "narrative_plan", {
    provider_id: "novita",
    model_id: "deepseek/deepseek-v3.1",
  });
  await client.getPromptLocks("project_a", "narrative_plan");
  await client.savePromptLock("project_a", "narrative_plan", "template", { locked: true });
  await client.listPromptProposals("project_a", "narrative_plan", "cursor-1", 5);
  await client.getPromptProposal("project_a", "proposal_1");
  await client.applyPromptProposal("project_a", "proposal_1", {
    source_template_revision: 1,
    source_binding_revision: 1,
    change_ids: ["change_abc"],
  });
  await client.rejectPromptProposal("project_a", "proposal_1");
  expect(calls.length).toBe(9);
  expect(calls[1]?.url).toContain("/prompt-stages/narrative_plan/starter");
  expect(calls[5]?.url).toContain("stage_id=narrative_plan");
  expect(calls[5]?.url).toContain("cursor=cursor-1");
  expect(calls[7]?.url).toContain("/apply");
  expect(calls[8]?.url).toContain("/reject");
});

test("getPromptPreference maps 404 to null", async () => {
  const fetchMock = mock(async () => new Response("missing", { status: 404 })) as unknown as typeof fetch;
  const client = createControlPlaneClient({ baseUrl: "http://control-plane.test", apiKey: "secret", fetch: fetchMock });
  await expect(client.getPromptPreference("project_a", "narrative_plan")).resolves.toBeNull();
});

const C2_CREATE = {
  kind: "improve",
  stage_id: "narrative_plan",
  provider_id: "novita",
  model_id: "deepseek/deepseek-v3.1",
  target_layer: "template",
  source_template_id: "ptpl_001",
  source_template_revision: 1,
  source_binding_revision: 1,
} satisfies CreatePromptProposalPayload;

const C2_PROPOSAL = {
  proposal_id: "proposal_1",
  project_id: "project_a",
  stage_id: "narrative_plan",
  kind: "improve",
  status: "queued",
  target_layers: ["template"],
  source: {
    template_id: "ptpl_001",
    template_revision: 1,
    binding_revision: 1,
    template_language: "id-ID",
    template_body: "Write a hook",
    project_override: null,
  },
  provider_id: "novita",
  model_id: "deepseek/deepseek-v3.1",
  changes: [],
  translated_template_body: null,
  translated_project_override: null,
  failure_code: null,
  created_at: "2026-09-13T08:00:00Z",
  started_at: null,
  finished_at: null,
};

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

type RecordedCall = { url: string; init?: RequestInit };

function recordingFetch(calls: RecordedCall[], respond: () => Response): typeof fetch {
  return mock(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return respond();
  }) as unknown as typeof fetch;
}

const UPGRADED_DOCUMENT = { schema_version: 2, revision: 5 } as unknown as EditDocument;

test("upgradeEditDocument sends one idempotent POST with encoded identifiers", async () => {
  const calls: RecordedCall[] = [];
  const client = createControlPlaneClient({
    baseUrl: "",
    apiKey: "secret",
    fetch: recordingFetch(calls, () => new Response(JSON.stringify(UPGRADED_DOCUMENT), { status: 200 })),
  });

  await expect(
    client.upgradeEditDocument("project_001", "edoc_001", { base_revision: 4 }, "upgrade_001"),
  ).resolves.toEqual({ kind: "saved", document: UPGRADED_DOCUMENT });

  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    url: "/api/v1/projects/project_001/edit-documents/edoc_001/upgrade-timeline",
    init: { method: "POST" },
  });
  expect(new Headers(calls[0].init?.headers).get("Idempotency-Key")).toBe("upgrade_001");
  expect(calls[0].init?.body).toBe(JSON.stringify({ base_revision: 4 }));
});

test("upgradeEditDocument encodes unsafe identifiers into the path", async () => {
  const calls: RecordedCall[] = [];
  const client = createControlPlaneClient({
    baseUrl: "http://control-plane.test",
    apiKey: "secret",
    fetch: recordingFetch(calls, () => new Response(JSON.stringify(UPGRADED_DOCUMENT), { status: 200 })),
  });

  await client.upgradeEditDocument("project / one", "doc / one", { base_revision: 1 }, "key / one");
  expect(calls[0].url).toBe(
    "http://control-plane.test/api/v1/projects/project%20%2F%20one/edit-documents/doc%20%2F%20one/upgrade-timeline",
  );
});

test("upgradeEditDocument unwraps the typed revision conflict envelope", async () => {
  const latest = { schema_version: 1, revision: 9 } as unknown as EditDocument;
  const client = createControlPlaneClient({
    baseUrl: "",
    apiKey: "secret",
    fetch: mock(async () =>
      new Response(JSON.stringify({ code: "document_revision_conflict", latest }), { status: 409 }),
    ) as unknown as typeof fetch,
  });

  await expect(
    client.upgradeEditDocument("project_001", "edoc_001", { base_revision: 4 }, "upgrade_001"),
  ).resolves.toEqual({ kind: "conflict", latest });
});

test("upgradeEditDocument raises a generic error for other failures", async () => {
  const client = createControlPlaneClient({
    baseUrl: "",
    apiKey: "secret",
    fetch: mock(async () => new Response("no", { status: 503 })) as unknown as typeof fetch,
  });

  await expect(
    client.upgradeEditDocument("project_001", "edoc_001", { base_revision: 4 }, "upgrade_001"),
  ).rejects.toThrow("Control plane request failed (503)");
});

test("listEditorAssets sends one bounded page request", async () => {
  const page = { assets: [], next_cursor: null } as unknown as EditorAssetPage;
  const calls: RecordedCall[] = [];
  const client = createControlPlaneClient({
    baseUrl: "",
    apiKey: "secret",
    fetch: recordingFetch(calls, () => new Response(JSON.stringify(page), { status: 200 })),
  });

  await expect(client.listEditorAssets("project / one")).resolves.toEqual(page);
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe("/api/v1/projects/project%20%2F%20one/editor-assets?limit=20");
  expect(calls[0].init?.method ?? "GET").toBe("GET");
});

test("listEditorAssets forwards an explicit cursor and clamps the page limit", async () => {
  const page = { assets: [], next_cursor: null } as unknown as EditorAssetPage;
  const calls: RecordedCall[] = [];
  const client = createControlPlaneClient({
    baseUrl: "",
    apiKey: "secret",
    fetch: recordingFetch(calls, () => new Response(JSON.stringify(page), { status: 200 })),
  });

  await client.listEditorAssets("project_001", "Y3Vyc29y", 500);
  await client.listEditorAssets("project_001", undefined, 0);
  expect(calls.map((call) => call.url)).toEqual([
    "/api/v1/projects/project_001/editor-assets?limit=50&cursor=Y3Vyc29y",
    "/api/v1/projects/project_001/editor-assets?limit=1",
  ]);
});

test("createEditorPreviewCapability posts with credentials and returns a same-origin URL", async () => {
  const capability = {
    preview_url: "/api/v1/projects/project_001/editor-assets/asset_001/preview",
    expires_at: "2026-09-19T10:05:00Z",
  } satisfies EditorPreviewCapability;
  const calls: RecordedCall[] = [];
  const client = createControlPlaneClient({
    baseUrl: "",
    apiKey: "secret",
    fetch: recordingFetch(calls, () => new Response(JSON.stringify(capability), { status: 200 })),
  });

  await expect(
    client.createEditorPreviewCapability("project_001", "asset / 001"),
  ).resolves.toEqual(capability);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    url: "/api/v1/projects/project_001/editor-assets/asset%20%2F%20001/preview-capability",
    init: { method: "POST", credentials: "include" },
  });
  // The capability itself travels only in the response cookie: no body is sent or read back.
  expect(calls[0].init?.body).toBeUndefined();
});

test("no preview capability value reaches a document payload", async () => {
  const calls: RecordedCall[] = [];
  const client = createControlPlaneClient({
    baseUrl: "",
    apiKey: "secret",
    fetch: recordingFetch(calls, () =>
      new Response(
        JSON.stringify({
          preview_url: "/api/v1/projects/project_001/editor-assets/asset_001/preview",
          expires_at: "2026-09-19T10:05:00Z",
        }),
        { status: 200, headers: { "Set-Cookie": "thoth_editor_preview=token; HttpOnly" } },
      ),
    ),
  });

  const issued = await client.createEditorPreviewCapability("project_001", "asset_001");
  expect(Object.keys(issued)).toEqual(["preview_url", "expires_at"]);
  expect(JSON.stringify(issued)).not.toContain("token");
});

const RENDER_JOB = {
  render_job_id: "rj_002",
  project_id: "project_001",
  document_id: "edoc_001",
  document_revision: 7,
  status: "preparing",
  template_id: "vertical_story",
  template_version: "1",
  preset_id: "standard_vertical_mp4_v1",
  renderer_version: "remotion-4.0.523",
  created_at: "2026-09-21T10:00:00Z",
} as unknown as RenderJob;

function renderClient(calls: RecordedCall[], respond: () => Response) {
  return createControlPlaneClient({ baseUrl: "", apiKey: "secret", fetch: recordingFetch(calls, respond) });
}

test("reads render capability from the project's own route", async () => {
  const capability = {
    available: true,
    preset_id: "standard_vertical_mp4_v1",
    renderer_version: "remotion-4.0.523",
  } satisfies RenderCapability;
  const calls: RecordedCall[] = [];
  const client = renderClient(calls, () => new Response(JSON.stringify(capability), { status: 200 }));

  await expect(client.getRenderCapability("project / one")).resolves.toEqual(capability);
  expect(calls[0]).toMatchObject({ url: "/api/v1/projects/project%20%2F%20one/render-capability" });
  expect(new Headers(calls[0].init?.headers).get("Authorization")).toBe("Bearer secret");
});

test("creates a render job with the caller's idempotency key and revision only", async () => {
  const calls: RecordedCall[] = [];
  const client = renderClient(calls, () => new Response(JSON.stringify(RENDER_JOB), { status: 201 }));

  await expect(
    client.createRenderJob("project_001", "attempt_001", { document_id: "edoc_001", document_revision: 7 }),
  ).resolves.toEqual(RENDER_JOB);
  expect(calls[0]).toMatchObject({
    url: "/api/v1/projects/project_001/render-jobs",
    init: { method: "POST" },
  });
  expect(new Headers(calls[0].init?.headers).get("Idempotency-Key")).toBe("attempt_001");
  expect(calls[0].init?.body).toBe(
    JSON.stringify({ document_id: "edoc_001", document_revision: 7 }),
  );
});

test("replaying one create attempt never regenerates its idempotency key", async () => {
  const calls: RecordedCall[] = [];
  const client = renderClient(calls, () => new Response(JSON.stringify(RENDER_JOB), { status: 201 }));
  const attempt = { document_id: "edoc_001", document_revision: 7 } as const;

  await client.createRenderJob("project_001", "attempt_001", attempt);
  await client.createRenderJob("project_001", "attempt_001", attempt);

  const keys = calls.map((call) => new Headers(call.init?.headers).get("Idempotency-Key"));
  expect(keys).toEqual(["attempt_001", "attempt_001"]);
});

test("lists one bounded newest-first page of render jobs", async () => {
  const page = { jobs: [RENDER_JOB], next_cursor: null } as unknown as RenderJobPage;
  const calls: RecordedCall[] = [];
  const client = renderClient(calls, () => new Response(JSON.stringify(page), { status: 200 }));

  await expect(client.listRenderJobs("project_001", "cursor / one", 500)).resolves.toEqual(page);
  expect(calls[0].url).toBe(
    "/api/v1/projects/project_001/render-jobs?limit=50&cursor=cursor+%2F+one",
  );
});

test("reads, cancels, retries, and cleans one render job through its own routes", async () => {
  const calls: RecordedCall[] = [];
  const client = renderClient(calls, () => new Response(JSON.stringify(RENDER_JOB), { status: 200 }));

  await expect(client.getRenderJob("project_001", "rj / 002")).resolves.toEqual(RENDER_JOB);
  await client.cancelRenderJob("project_001", "rj_002");
  await client.retryRenderJob("project_001", "rj_002", "attempt_002");
  await client.cleanupRenderArtifacts("project_001", "rj_002");

  expect(calls.map((call) => `${call.init?.method ?? "GET"} ${call.url}`)).toEqual([
    "GET /api/v1/projects/project_001/render-jobs/rj%20%2F%20002",
    "POST /api/v1/projects/project_001/render-jobs/rj_002/cancel",
    "POST /api/v1/projects/project_001/render-jobs/rj_002/retry",
    "DELETE /api/v1/projects/project_001/render-jobs/rj_002/artifacts",
  ]);
  expect(new Headers(calls[2].init?.headers).get("Idempotency-Key")).toBe("attempt_002");
  // Cancel, retry, and cleanup name the job in the path and send nothing else.
  expect(calls.slice(1).every((call) => call.init?.body === undefined)).toBe(true);
});

test("downloads the finished render as a Blob and returns no locator", async () => {
  const calls: RecordedCall[] = [];
  const client = renderClient(
    calls,
    () =>
      new Response(new Blob(["rendered-bytes"], { type: "video/mp4" }), {
        status: 200,
        headers: { "Content-Type": "video/mp4" },
      }),
  );

  const blob = await client.downloadRenderOutput("project_001", "rj_002");
  expect(blob).toBeInstanceOf(Blob);
  expect(blob.type).toBe("video/mp4");
  expect(calls[0].url).toBe("/api/v1/projects/project_001/render-jobs/rj_002/output");
  expect(new Headers(calls[0].init?.headers).get("Authorization")).toBe("Bearer secret");
});

test("a render failure surfaces its fixed code and never the server's own words", async () => {
  const calls: RecordedCall[] = [];
  const client = renderClient(
    calls,
    () =>
      new Response(
        JSON.stringify({
          detail: { code: "render_busy", message: "C:/srv/artifacts/temp/rj_001 is locked" },
        }),
        { status: 409 },
      ),
  );

  const failure = await client
    .createRenderJob("project_001", "attempt_001", { document_id: "edoc_001", document_revision: 7 })
    .catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(RenderRequestError);
  expect((failure as RenderRequestError).code).toBe("render_busy");
  expect(String(failure)).not.toContain("/srv/");
  expect(String(failure)).not.toContain("locked");
});

test("an unrecognised render failure body becomes one fixed generic code", async () => {
  const calls: RecordedCall[] = [];
  const client = renderClient(
    calls,
    () => new Response("<html>Traceback (most recent call last): C:/srv/artifacts</html>", { status: 500 }),
  );

  const failure = await client.getRenderJob("project_001", "rj_002").catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(RenderRequestError);
  expect((failure as RenderRequestError).code).toBe("render_request_failed");
  expect(String(failure)).not.toContain("Traceback");
  expect(String(failure)).not.toContain("/srv/");
});

test("a transport failure never repeats the browser's own words", async () => {
  const client = createControlPlaneClient({
    baseUrl: "",
    apiKey: "secret",
    fetch: mock(async () => {
      throw new Error(
        "connect ECONNREFUSED https://renderer.internal:9000 via C:/srv/proxy.pem (token=abc)",
      );
    }) as unknown as typeof fetch,
  });

  const failure = await client.getRenderCapability("project_001").catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(RenderRequestError);
  expect((failure as RenderRequestError).code).toBe("render_request_failed");
  expect(String(failure)).not.toContain("renderer.internal");
  expect(String(failure)).not.toContain("C:/srv/");
  expect(String(failure)).not.toContain("token=abc");
});

test("a body that cannot be decoded does not leak the decoder's exception", async () => {
  const calls: RecordedCall[] = [];
  const client = renderClient(calls, () => new Response("{ this is not json", { status: 200 }));

  const failure = await client.getRenderJob("project_001", "rj_002").catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(RenderRequestError);
  expect((failure as RenderRequestError).code).toBe("render_request_failed");
  expect(String(failure)).not.toContain("JSON");
});

test("a download whose bytes cannot be read stays a fixed code", async () => {
  const unreadable = {
    ok: true,
    status: 200,
    blob: () => Promise.reject(new Error("read of C:/srv/artifacts/rj_002/output.mp4 failed")),
  } as unknown as Response;
  const client = createControlPlaneClient({
    baseUrl: "",
    apiKey: "secret",
    fetch: mock(async () => unreadable) as unknown as typeof fetch,
  });

  const failure = await client
    .downloadRenderOutput("project_001", "rj_002")
    .catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(RenderRequestError);
  expect((failure as RenderRequestError).code).toBe("render_request_failed");
  expect(String(failure)).not.toContain("C:/srv/");
});

test("only the fixed render codes are representable", () => {
  const code: RenderErrorCode = "render_busy";
  expect(new RenderRequestError(code).code).toBe("render_busy");
  expect(asRenderErrorCode("render_output_unavailable")).toBe("render_output_unavailable");
  expect(asRenderErrorCode("render_import_unresolved")).toBe("render_import_unresolved");
  expect(asRenderErrorCode("render_revision_stale")).toBe("render_revision_stale");
  expect(asRenderErrorCode("ENOENT C:/srv/artifacts")).toBe("render_request_failed");
  expect(asRenderErrorCode(new Error("boom"))).toBe("render_request_failed");
  expect(asRenderErrorCode(undefined)).toBe("render_request_failed");
});

const REVIEW_COMMENT = {
  comment_id: "rev_comment_1",
  project_id: "project_001",
  document_id: "edoc_001",
  document_revision: 3,
  actor: { actor_id: "owner", actor_type: "user", display_name: null },
  text: "Check the hook",
  frame: 29,
  created_at: "2026-09-24T09:00:00Z",
} satisfies ReviewComment;
const REVIEW_DECISION = {
  decision_id: "rev_decision_1",
  project_id: "project_001",
  document_id: "edoc_001",
  document_revision: 3,
  actor: { actor_id: "owner", actor_type: "user", display_name: null },
  decision: "approved",
  reason: null,
  created_at: "2026-09-24T09:00:00Z",
} satisfies ReviewDecision;
const REVIEW_BASE = "/api/v1/projects/project%20one/edit-documents/edoc%2F001";

async function reviewFailure(promise: Promise<unknown>): Promise<StudioReviewRequestError> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error instanceof StudioReviewRequestError).toBe(true);
  return error as StudioReviewRequestError;
}

test("posts one review comment and one decision to the document's own routes", async () => {
  const calls: RecordedCall[] = [];
  let body: unknown = REVIEW_COMMENT;
  const client = renderClient(calls, () => new Response(JSON.stringify(body), { status: 201 }));
  const comment = { base_revision: 3, operation_id: "op_review_1", text: "Check the hook", frame: 29 };

  await expect(client.createStudioReviewComment("project one", "edoc/001", comment)).resolves.toEqual(
    REVIEW_COMMENT,
  );
  body = REVIEW_DECISION;
  await expect(
    client.createStudioReviewDecision("project one", "edoc/001", {
      base_revision: 3,
      operation_id: "op_review_3",
      decision: "approved",
    }),
  ).resolves.toEqual(REVIEW_DECISION);

  expect(calls.map((call) => `${call.init?.method} ${call.url}`)).toEqual([
    `POST ${REVIEW_BASE}/review-comments`,
    `POST ${REVIEW_BASE}/review-decisions`,
  ]);
  // The caller's operation ID travels unchanged in the body; nothing else is added.
  expect(calls[0].init?.body).toBe(JSON.stringify(comment));
  expect(new Headers(calls[0].init?.headers).get("Authorization")).toBe("Bearer secret");
});

test("lists bounded review pages with an opaque cursor", async () => {
  const calls: RecordedCall[] = [];
  const client = renderClient(
    calls,
    () => new Response(JSON.stringify({ comments: [], next_cursor: null }), { status: 200 }),
  );

  await client.listStudioReviewComments("project one", "edoc/001");
  await client.listStudioReviewDecisions("project one", "edoc/001", { limit: 500, cursor: "c / 1" });

  expect(calls.map((call) => call.url)).toEqual([
    `${REVIEW_BASE}/review-comments?limit=50`,
    `${REVIEW_BASE}/review-decisions?limit=50&cursor=c+%2F+1`,
  ]);
});

test("a stale review write surfaces only the typed latest revision", async () => {
  const calls: RecordedCall[] = [];
  const client = renderClient(
    calls,
    () =>
      new Response(JSON.stringify({ code: "review_revision_conflict", latest_revision: 4 }), {
        status: 409,
      }),
  );

  const error = await reviewFailure(
    client.createStudioReviewComment("project_001", "edoc_001", {
      base_revision: 3,
      operation_id: "op_review_1",
      text: "Check",
    }),
  );

  expect(error.code).toBe("review_revision_conflict");
  expect(error.latestRevision).toBe(4);
  expect(calls.length).toBe(1);
});

test("every other review failure collapses to a fixed safe code", async () => {
  const bodies: Array<[number, unknown, ReviewErrorCode]> = [
    [409, { detail: { code: "review_not_eligible", issues: ["main_track_gap"] } }, "review_not_eligible"],
    [503, { detail: { code: "review_unavailable" } }, "review_unavailable"],
    [500, { detail: "postgresql://user:secret@db/thoth" }, "review_request_failed"],
    [409, { code: "review_revision_conflict", latest_revision: "C:/secret" }, "review_request_failed"],
  ];
  for (const [status, body, code] of bodies) {
    const client = renderClient([], () => new Response(JSON.stringify(body), { status }));
    const error = await reviewFailure(
      client.createStudioReviewDecision("project_001", "edoc_001", {
        base_revision: 3,
        operation_id: "op_review_3",
        decision: "approved",
      }),
    );
    expect(error.code).toBe(code);
    expect(error.latestRevision).toBe(null);
    expect(error.message.includes("secret")).toBe(false);
  }
  const offline = createControlPlaneClient({
    baseUrl: "",
    fetch: mock(async () => {
      throw new Error("connect ECONNREFUSED C:/secret");
    }) as unknown as typeof fetch,
  });
  const error = await reviewFailure(offline.listStudioReviewComments("project_001", "edoc_001"));
  expect(error.code).toBe("review_request_failed");
});

const SOURCE_KEY = "a".repeat(64);
const STUDIO_SOURCE = {
  items: [
    {
      role: "main",
      order: 0,
      title: "Main",
      text: null,
      platform: "tiktok",
      source_url: "https://example.test/main",
      media_kind: "video",
      trim_start_seconds: null,
    },
  ],
  unsupported: [],
} satisfies StudioSourceProjection;
const importClient = (calls: RecordedCall[], respond: () => Response) =>
  createControlPlaneClient({ baseUrl: "", apiKey: "secret", fetch: recordingFetch(calls, respond) });
const ok = (value: unknown, status = 200) => () => new Response(JSON.stringify(value), { status });

test("Studio import inspection posts the source and reads back drafts", async () => {
  const calls: RecordedCall[] = [];
  const inspection = { project_id: "project_001", source_key: SOURCE_KEY, items: [], drafts: [], more_drafts: false };
  await expect(
    importClient(calls, ok(inspection)).inspectStudioImport("project / 1", STUDIO_SOURCE),
  ).resolves.toEqual(inspection);
  expect(calls[0]).toMatchObject({
    url: "/api/v1/projects/project%20%2F%201/studio-imports/inspect",
    init: { method: "POST", body: JSON.stringify(STUDIO_SOURCE) },
  });
});

test("Studio import creation carries the caller's own idempotency key", async () => {
  const calls: RecordedCall[] = [];
  const client = importClient(calls, ok({ document_id: "edoc_001" }, 201));
  const body = { source: STUDIO_SOURCE, source_key: SOURCE_KEY };

  await client.createStudioImport("project_001", body, "create_001");
  await client.createStudioImport("project_001", body, "create_001");

  expect(calls.map((call) => call.url)).toEqual([
    "/api/v1/projects/project_001/studio-imports",
    "/api/v1/projects/project_001/studio-imports",
  ]);
  expect(calls.map((call) => new Headers(call.init?.headers).get("Idempotency-Key"))).toEqual([
    "create_001",
    "create_001",
  ]);
  expect(calls[0].init?.body).toBe(JSON.stringify(body));
});

test("Studio import drafts, inventory, and decisions use their own routes", async () => {
  const calls: RecordedCall[] = [];
  const client = importClient(calls, ok({}));
  const decision = { base_revision: 3, decision: { kind: "attach_asset", asset_id: "asset_1" } } as const;

  await client.listStudioImportDrafts("project_001", SOURCE_KEY);
  await client.getStudioImportInventory("project_001", "edoc / 1");
  await client.resolveStudioImportItem("project_001", "edoc_001", "footage_000", decision);

  expect(calls.map((call) => [call.url, call.init?.method ?? "GET"])).toEqual([
    [`/api/v1/projects/project_001/studio-imports/${SOURCE_KEY}`, "GET"],
    ["/api/v1/projects/project_001/studio-imports/documents/edoc%20%2F%201", "GET"],
    ["/api/v1/projects/project_001/studio-imports/documents/edoc_001/items/footage_000/resolve", "POST"],
  ]);
  expect(calls[2].init?.body).toBe(JSON.stringify(decision));
});

test("an editor asset upload streams the file itself with its media type", async () => {
  const calls: RecordedCall[] = [];
  const file = new File(["frames"], "clip.mp4", { type: "video/mp4" });

  await importClient(calls, ok({ asset_id: "asset_1" }, 201)).uploadEditorAsset("project_001", file);

  expect(calls[0].url).toBe("/api/v1/projects/project_001/editor-assets");
  expect(calls[0].init?.method).toBe("POST");
  expect(calls[0].init?.body).toBe(file);
  expect(new Headers(calls[0].init?.headers).get("Content-Type")).toBe("video/mp4");
});

test("a Studio import failure carries its status and fixed code, never the server's words", async () => {
  const conflict = importClient([], () =>
    new Response(JSON.stringify({ detail: { code: "stale_source_key" }, message: "C:\\secret" }), { status: 409 }),
  );
  const refused = await conflict
    .createStudioImport("project_001", { source: STUDIO_SOURCE, source_key: SOURCE_KEY }, "k")
    .catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(StudioImportRequestError);
  expect(refused).toMatchObject({ status: 409, code: "stale_source_key" });
  expect(String(refused)).not.toContain("secret");

  const stale = await importClient([], () =>
    new Response(JSON.stringify({ code: "document_revision_conflict", latest: {} }), { status: 409 }),
  )
    .resolveStudioImportItem("project_001", "edoc_001", "main_000", { base_revision: 1, decision: { kind: "exclude" } })
    .catch((error: unknown) => error);
  expect(stale).toMatchObject({ status: 409, code: "document_revision_conflict" });

  const offline = createControlPlaneClient({
    baseUrl: "",
    fetch: mock(async () => {
      throw new TypeError("proxy at C:\\proxy failed");
    }) as unknown as typeof fetch,
  });
  const lost = await offline.inspectStudioImport("project_001", STUDIO_SOURCE).catch((error: unknown) => error);
  expect(lost).toMatchObject({ status: null, code: null });
  expect(String(lost)).not.toContain("proxy");
});
