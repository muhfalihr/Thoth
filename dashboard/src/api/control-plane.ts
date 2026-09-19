import type { components } from "./generated/control-plane";

export type WorkflowRequest = components["schemas"]["WorkflowRequest"];
export type WorkflowSummary = components["schemas"]["WorkflowSummary"];
export type StylePreset = components["schemas"]["StylePreset"];
export type ApprovalSubmission = components["schemas"]["ApprovalSubmission"];
export type RetryRequest = components["schemas"]["RetryRequest"];
export type ContentSetImportRequest = components["schemas"]["ContentSetImportRequest"];
export type EditDocumentV1 = components["schemas"]["EditDocumentV1"];
export type EditDocumentV2 = components["schemas"]["EditDocumentV2"];
export type EditDocument = EditDocumentV1 | EditDocumentV2;
export type EditDocumentPatch = components["schemas"]["EditDocumentPatch"];
export type EditDocumentOperation = EditDocumentPatch["operations"][number];
export type UpgradeTimelineRequest = components["schemas"]["UpgradeTimelineRequest"];
export type DocumentRevisionConflictBody =
  components["schemas"]["DocumentRevisionConflictBody"];
export type EditDocumentPatchResult =
  | { kind: "saved"; document: EditDocument }
  | { kind: "conflict"; latest: EditDocument };
export type EditorAsset = components["schemas"]["EditorAsset"];
export type EditorAssetPage = components["schemas"]["EditorAssetPage"];
export type EditorPreviewCapability = components["schemas"]["PreviewCapabilityResponse"];
export type PromptStageDefinition = components["schemas"]["PromptStageDefinition"];
export type PromptTemplateRevision = components["schemas"]["PromptTemplateRevision"];
export type SavePromptTemplateRequest = components["schemas"]["SavePromptTemplateRequest"];
export type ProjectPromptBinding = components["schemas"]["ProjectPromptBinding"];
export type SaveProjectPromptBindingRequest = components["schemas"]["SaveProjectPromptBindingRequest"];
export type ResolvedPromptDraft = components["schemas"]["ResolvedPromptDraft"];
export type PromptTemplateSaveResult =
  | { kind: "saved"; value: PromptTemplateRevision }
  | { kind: "conflict"; latest: PromptTemplateRevision };
export type PromptBindingSaveResult =
  | { kind: "saved"; value: ProjectPromptBinding }
  | { kind: "conflict"; latest: ProjectPromptBinding };

export type PromptProvider = components["schemas"]["PromptProviderDefinition"];
export type PromptStarter = components["schemas"]["PromptStarterDefinition"];
export type PromptModelPreference = components["schemas"]["ProjectPromptModelPreference"];
export type PromptLayerLock = components["schemas"]["ProjectPromptLayerLock"];
export type PromptPreferenceSaveResult =
  | { kind: "saved"; value: PromptModelPreference }
  | { kind: "conflict"; latest: PromptModelPreference };
export type PromptLockSaveResult =
  | { kind: "saved"; value: PromptLayerLock }
  | { kind: "conflict"; latest: PromptLayerLock };
export type PromptProposalResource = components["schemas"]["PromptProposal"];
export type PromptProposalPageResource = components["schemas"]["PromptProposalPage"];
export type SavePromptModelPreferencePayload =
  components["schemas"]["SavePromptModelPreferenceRequest"];
export type SavePromptLayerLockPayload = components["schemas"]["SavePromptLayerLockRequest"];
export type CreatePromptProposalPayload = components["schemas"]["CreatePromptProposalRequest"];
export type PromptStageId = CreatePromptProposalPayload["stage_id"];
const PROMPT_STAGE_IDS: readonly PromptStageId[] = [
  "narrative_plan",
  "visual_plan",
  "caption_copy",
];
export function isPromptStageId(value: string): value is PromptStageId {
  return (PROMPT_STAGE_IDS as readonly string[]).includes(value);
}
export type ApplyPromptProposalPayload = components["schemas"]["ApplyPromptProposalRequest"];
export type PromptProposalApplyResultResource =
  components["schemas"]["PromptProposalApplyResult"];

export type ControlPlaneClient = {
  listStylePresets: () => Promise<StylePreset[]>;
  createWorkflow: (request: WorkflowRequest) => Promise<WorkflowSummary>;
  getWorkflow: (workflowId: string) => Promise<WorkflowSummary>;
  streamWorkflow: (
    workflowId: string,
    onSnapshot: (snapshot: WorkflowSummary) => void,
    lastEventId?: string,
  ) => () => void;
  approveWorkflow: (workflowId: string, approval: ApprovalSubmission) => Promise<WorkflowSummary>;
  cancelWorkflow: (workflowId: string) => Promise<WorkflowSummary>;
  retryWorkflow: (workflowId: string, retry?: RetryRequest) => Promise<WorkflowSummary>;
  importContentSet: (projectId: string, request: ContentSetImportRequest) => Promise<EditDocument>;
  getEditDocument: (projectId: string, documentId: string) => Promise<EditDocument>;
  patchEditDocument: (
    projectId: string,
    documentId: string,
    patch: EditDocumentPatch,
  ) => Promise<EditDocumentPatchResult>;
  upgradeEditDocument: (
    projectId: string,
    documentId: string,
    request: UpgradeTimelineRequest,
    idempotencyKey: string,
  ) => Promise<EditDocumentPatchResult>;
  listEditorAssets: (
    projectId: string,
    cursor?: string,
    limit?: number,
  ) => Promise<EditorAssetPage>;
  createEditorPreviewCapability: (
    projectId: string,
    assetId: string,
  ) => Promise<EditorPreviewCapability>;
  listPromptStages: () => Promise<PromptStageDefinition[]>;
  listPromptTemplates: (projectId: string, stageId: string) => Promise<PromptTemplateRevision[]>;
  savePromptTemplate: (
    projectId: string,
    request: SavePromptTemplateRequest,
  ) => Promise<PromptTemplateSaveResult>;
  getPromptBinding: (projectId: string, stageId: string) => Promise<ProjectPromptBinding | null>;
  savePromptBinding: (
    projectId: string,
    stageId: string,
    request: SaveProjectPromptBindingRequest,
  ) => Promise<PromptBindingSaveResult>;
  getResolvedPrompt: (projectId: string, stageId: string) => Promise<ResolvedPromptDraft>;
  listPromptProviders: () => Promise<PromptProvider[]>;
  getPromptStarter: (stageId: string) => Promise<PromptStarter>;
  getPromptPreference: (
    projectId: string,
    stageId: string,
  ) => Promise<PromptModelPreference | null>;
  savePromptPreference: (
    projectId: string,
    stageId: string,
    request: SavePromptModelPreferencePayload,
  ) => Promise<PromptPreferenceSaveResult>;
  getPromptLocks: (projectId: string, stageId: string) => Promise<PromptLayerLock[]>;
  savePromptLock: (
    projectId: string,
    stageId: string,
    layer: string,
    request: SavePromptLayerLockPayload,
  ) => Promise<PromptLockSaveResult>;
  createPromptProposal: (
    projectId: string,
    idempotencyKey: string,
    request: CreatePromptProposalPayload,
  ) => Promise<PromptProposalResource>;
  listPromptProposals: (
    projectId: string,
    stageId: string,
    cursor?: string,
    limit?: number,
  ) => Promise<PromptProposalPageResource>;
  getPromptProposal: (projectId: string, proposalId: string) => Promise<PromptProposalResource>;
  applyPromptProposal: (
    projectId: string,
    proposalId: string,
    request: ApplyPromptProposalPayload,
  ) => Promise<PromptProposalApplyResultResource>;
  rejectPromptProposal: (projectId: string, proposalId: string) => Promise<PromptProposalResource>;
};

type ClientOptions = { baseUrl?: string; apiKey?: string; fetch?: typeof fetch };

const defaultBaseUrl = (import.meta.env.VITE_CONTROL_PLANE_URL ?? "").replace(/\/$/, "");
const defaultApiKey = import.meta.env.VITE_CONTROL_PLANE_API_KEY ?? "";

function eventBlocks(chunk: string): Array<{ id?: string; data: string }> {
  return chunk.split("\n\n").flatMap((block) => {
    const fields = block.split("\n");
    const id = fields.find((line) => line.startsWith("id:"))?.slice(3).trim();
    const data = fields
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    return data ? [{ id, data }] : [];
  });
}

export function createControlPlaneClient(options: ClientOptions = {}): ControlPlaneClient {
  const baseUrl = (options.baseUrl ?? defaultBaseUrl).replace(/\/$/, "");
  const apiKey = options.apiKey ?? defaultApiKey;
  const doFetch = options.fetch ?? fetch;
  const headers = (extra: HeadersInit = {}) => ({ Authorization: `Bearer ${apiKey}`, ...extra });

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await doFetch(`${baseUrl}${path}`, {
      ...init,
      headers: headers(init.headers),
    });
    if (!response.ok) throw new Error(`Control plane request failed (${response.status})`);
    return response.json() as Promise<T>;
  }

  // `typedConflict` unwraps the `{ code, latest }` envelope that preference/lock 409s use;
  // template/binding 409s still return the bare latest resource.
  async function saveWithConflict<T>(
    path: string,
    method: "POST" | "PUT",
    body: unknown,
    typedConflict = false,
  ) {
    const response = await doFetch(`${baseUrl}${path}`, {
      method,
      headers: headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    if (response.status === 409) {
      const raw = await response.json();
      return { kind: "conflict" as const, latest: (typedConflict ? raw.latest : raw) as T };
    }
    if (!response.ok) throw new Error(`Control plane request failed (${response.status})`);
    return { kind: "saved" as const, value: (await response.json()) as T };
  }

  // Document writes answer 409 with `{ code, latest }`, so the latest document is unwrapped
  // from that envelope rather than read straight off the body.
  async function documentWrite(
    path: string,
    method: "PATCH" | "POST",
    body: unknown,
    extraHeaders: HeadersInit = {},
  ): Promise<EditDocumentPatchResult> {
    const response = await doFetch(`${baseUrl}${path}`, {
      method,
      headers: headers({ "Content-Type": "application/json", ...extraHeaders }),
      body: JSON.stringify(body),
    });
    if (response.status === 409) {
      const conflict = (await response.json()) as DocumentRevisionConflictBody;
      return { kind: "conflict", latest: conflict.latest };
    }
    if (!response.ok) throw new Error(`Control plane request failed (${response.status})`);
    return { kind: "saved", document: (await response.json()) as EditDocument };
  }

  const client: ControlPlaneClient = {
    listStylePresets: () => request<StylePreset[]>("/api/v1/style-presets"),
    createWorkflow: (workflow) =>
      request<WorkflowSummary>("/api/v1/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify(workflow),
      }),
    getWorkflow: (workflowId) => request<WorkflowSummary>(`/api/v1/workflows/${workflowId}`),
    approveWorkflow: (workflowId, approval) =>
      request<WorkflowSummary>(`/api/v1/workflows/${workflowId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(approval),
      }),
    cancelWorkflow: (workflowId) =>
      request<WorkflowSummary>(`/api/v1/workflows/${workflowId}/cancel`, { method: "POST" }),
    retryWorkflow: (workflowId, retry = {}) =>
      request<WorkflowSummary>(`/api/v1/workflows/${workflowId}/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(retry),
      }),
    importContentSet: (projectId, document) =>
      request<EditDocument>(
        `/api/v1/projects/${encodeURIComponent(projectId)}/edit-documents/import-content-set`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(document),
        },
      ),
    getEditDocument: (projectId, documentId) =>
      request<EditDocument>(
        `/api/v1/projects/${encodeURIComponent(projectId)}/edit-documents/${encodeURIComponent(documentId)}`,
      ),
    patchEditDocument: (projectId, documentId, patch) =>
      documentWrite(
        `/api/v1/projects/${encodeURIComponent(projectId)}/edit-documents/${encodeURIComponent(documentId)}`,
        "PATCH",
        patch,
      ),
    upgradeEditDocument: (projectId, documentId, request, idempotencyKey) =>
      documentWrite(
        `/api/v1/projects/${encodeURIComponent(projectId)}/edit-documents/${encodeURIComponent(documentId)}/upgrade-timeline`,
        "POST",
        request,
        { "Idempotency-Key": idempotencyKey },
      ),
    listEditorAssets: (projectId, cursor, limit = 20) => {
      const query = new URLSearchParams({ limit: String(Math.min(Math.max(limit, 1), 50)) });
      if (cursor) query.set("cursor", cursor);
      return request<EditorAssetPage>(
        `/api/v1/projects/${encodeURIComponent(projectId)}/editor-assets?${query.toString()}`,
      );
    },
    createEditorPreviewCapability: (projectId, assetId) =>
      // `credentials: "include"` is what lets the HttpOnly capability cookie be stored;
      // the capability value itself never enters this module.
      request<EditorPreviewCapability>(
        `/api/v1/projects/${encodeURIComponent(projectId)}/editor-assets/${encodeURIComponent(assetId)}/preview-capability`,
        { method: "POST", credentials: "include" },
      ),
    listPromptStages: () => request<PromptStageDefinition[]>("/api/v1/prompt-stages"),
    listPromptTemplates: (projectId, stageId) =>
      request<PromptTemplateRevision[]>(
        `/api/v1/projects/${encodeURIComponent(projectId)}/prompt-lab/templates?stage_id=${encodeURIComponent(stageId)}`,
      ),
    savePromptTemplate: (projectId, request) =>
      saveWithConflict<PromptTemplateRevision>(
        `/api/v1/projects/${encodeURIComponent(projectId)}/prompt-lab/templates`,
        "POST",
        request,
      ),
    getPromptBinding: (projectId, stageId) =>
      request<ProjectPromptBinding | null>(
        `/api/v1/projects/${encodeURIComponent(projectId)}/prompt-lab/bindings/${encodeURIComponent(stageId)}`,
      ).catch((error: unknown) => {
        if (error instanceof Error && error.message.endsWith("(404)")) return null;
        throw error;
      }),
    savePromptBinding: (projectId, stageId, request) =>
      saveWithConflict<ProjectPromptBinding>(
        `/api/v1/projects/${encodeURIComponent(projectId)}/prompt-lab/bindings/${encodeURIComponent(stageId)}`,
        "PUT",
        request,
      ),
    getResolvedPrompt: (projectId, stageId) =>
      request<ResolvedPromptDraft>(
        `/api/v1/projects/${encodeURIComponent(projectId)}/prompt-lab/resolved/${encodeURIComponent(stageId)}`,
      ),
    listPromptProviders: () => request<PromptProvider[]>("/api/v1/prompt-providers"),
    getPromptStarter: (stageId) =>
      request<PromptStarter>(
        `/api/v1/prompt-stages/${encodeURIComponent(stageId)}/starter`,
      ),
    getPromptPreference: (projectId, stageId) =>
      request<PromptModelPreference | null>(
        `/api/v1/projects/${encodeURIComponent(projectId)}/prompt-lab/preferences/${encodeURIComponent(stageId)}`,
      ).catch((error: unknown) => {
        if (error instanceof Error && error.message.endsWith("(404)")) return null;
        throw error;
      }),
    savePromptPreference: (projectId, stageId, req) =>
      saveWithConflict<PromptModelPreference>(
        `/api/v1/projects/${encodeURIComponent(projectId)}/prompt-lab/preferences/${encodeURIComponent(stageId)}`,
        "PUT",
        req,
        true,
      ),
    getPromptLocks: (projectId, stageId) =>
      request<PromptLayerLock[]>(
        `/api/v1/projects/${encodeURIComponent(projectId)}/prompt-lab/locks/${encodeURIComponent(stageId)}`,
      ),
    savePromptLock: (projectId, stageId, layer, req) =>
      saveWithConflict<PromptLayerLock>(
        `/api/v1/projects/${encodeURIComponent(projectId)}/prompt-lab/locks/${encodeURIComponent(stageId)}/${encodeURIComponent(layer)}`,
        "PUT",
        req,
        true,
      ),
    createPromptProposal: (projectId, idempotencyKey, req) =>
      request<PromptProposalResource>(
        `/api/v1/projects/${encodeURIComponent(projectId)}/prompt-lab/proposals`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
          body: JSON.stringify(req),
        },
      ),
    listPromptProposals: (projectId, stageId, cursor, limit = 20) => {
      const query = new URLSearchParams({ stage_id: stageId, limit: String(limit) });
      if (cursor) query.set("cursor", cursor);
      return request<PromptProposalPageResource>(
        `/api/v1/projects/${encodeURIComponent(projectId)}/prompt-lab/proposals?${query.toString()}`,
      );
    },
    getPromptProposal: (projectId, proposalId) =>
      request<PromptProposalResource>(
        `/api/v1/projects/${encodeURIComponent(projectId)}/prompt-lab/proposals/${encodeURIComponent(proposalId)}`,
      ),
    applyPromptProposal: (projectId, proposalId, req) =>
      request<PromptProposalApplyResultResource>(
        `/api/v1/projects/${encodeURIComponent(projectId)}/prompt-lab/proposals/${encodeURIComponent(proposalId)}/apply`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req) },
      ),
    rejectPromptProposal: (projectId, proposalId) =>
      request<PromptProposalResource>(
        `/api/v1/projects/${encodeURIComponent(projectId)}/prompt-lab/proposals/${encodeURIComponent(proposalId)}/reject`,
        { method: "POST" },
      ),
    streamWorkflow(workflowId, onSnapshot, lastEventId) {
      let active = true;
      let cursor = lastEventId;
      let controller: AbortController | undefined;
      let snapshotRefresh = Promise.resolve();

      const refreshSnapshot = () => {
        snapshotRefresh = snapshotRefresh.then(async () => {
          if (!active) return;
          try {
            onSnapshot(await client.getWorkflow(workflowId));
          } catch {
            // A later stream retry or user action will obtain the next snapshot.
          }
        });
        return snapshotRefresh;
      };
      void refreshSnapshot();

      void (async () => {
        while (active) {
          controller = new AbortController();
          try {
            const response = await fetch(`${baseUrl}/api/v1/workflows/${workflowId}/events`, {
              headers: headers(cursor ? { "Last-Event-ID": cursor } : {}),
              signal: controller.signal,
            });
            if (!response.ok || response.body === null) throw new Error("workflow stream unavailable");
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let pending = "";
            while (active) {
              const { done, value } = await reader.read();
              pending = (pending + decoder.decode(value, { stream: !done })).replace(/\r\n/g, "\n");
              let boundary = pending.indexOf("\n\n");
              while (boundary >= 0) {
                for (const event of eventBlocks(pending.slice(0, boundary))) {
                  if (event.id) cursor = event.id;
                  await refreshSnapshot();
                }
                pending = pending.slice(boundary + 2);
                boundary = pending.indexOf("\n\n");
              }
              if (done) break;
            }
          } catch {
            // The immediately refreshed snapshot is authoritative after every reconnect.
          }
          await refreshSnapshot();
          if (active) await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
      })();
      return () => {
        active = false;
        controller?.abort();
      };
    },
  };
  return client;
}

export const controlPlaneClient = createControlPlaneClient();
