/// <reference types="bun-types" />

import { afterEach, expect, mock, test } from "bun:test";

import {
  createControlPlaneClient,
  type EditDocument,
  type EditDocumentPatch,
  type EditorAssetPage,
  type EditorPreviewCapability,
  type ProjectPromptBinding,
  type PromptLayerLock,
  type PromptModelPreference,
  type PromptStageDefinition,
  type PromptTemplateRevision,
  type ResolvedPromptDraft,
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
