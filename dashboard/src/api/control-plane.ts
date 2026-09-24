import type { components } from "./generated/control-plane";

export type WorkflowRequest = components["schemas"]["WorkflowRequest"];
export type WorkflowSummary = components["schemas"]["WorkflowSummary"];
export type StylePreset = components["schemas"]["StylePreset"];
export type ApprovalSubmission = components["schemas"]["ApprovalSubmission"];
export type RetryRequest = components["schemas"]["RetryRequest"];
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
export type StudioSourceProjection = components["schemas"]["StudioSourceProjection"];
export type StudioSourceInspection = components["schemas"]["StudioSourceInspection"];
export type StudioImportItem = components["schemas"]["StudioImportItem"];
export type StudioDraft = components["schemas"]["StudioDraft"];
export type StudioDraftList = components["schemas"]["StudioDraftList"];
export type StudioImportInventory = components["schemas"]["StudioImportInventory"];
export type CreateStudioImport = components["schemas"]["CreateStudioImport"];
export type ResolveStudioImportItem = components["schemas"]["ResolveStudioImportItem"];
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
export type RenderCapability = components["schemas"]["RenderCapability"];
export type RenderJob = components["schemas"]["RenderJobView"];
export type RenderJobPage = components["schemas"]["RenderJobPageView"];
export type RenderOutput = components["schemas"]["RenderOutputView"];
export type CreateRenderJobPayload = components["schemas"]["CreateRenderJobRequest"];
export type RenderJobStatus = RenderJob["status"];
export type CreateComment = components["schemas"]["CreateComment"];
export type CreateDecision = components["schemas"]["CreateDecision"];
export type ReviewComment = components["schemas"]["ReviewComment"];
export type ReviewCommentPage = components["schemas"]["ReviewCommentPage"];
export type ReviewDecision = components["schemas"]["ReviewDecision"];
export type ReviewDecisionPage = components["schemas"]["ReviewDecisionPage"];
export type ReviewListQuery = { limit?: number; cursor?: string };

/**
 * Every fixed code a render request may end with: the server's own safe codes
 * plus one generic fallback. Nothing outside this finite set is representable,
 * so no message, path, or exception can become a render error later on.
 */
const RENDER_ERROR_CODES = [
  "render_job_not_found",
  "render_busy",
  "idempotency_conflict",
  "render_job_not_active",
  "render_job_not_cancellable",
  "render_job_not_retryable",
  "render_job_not_cleanable",
  "render_preparation_failed",
  "render_import_unresolved",
  "render_revision_stale",
  "render_output_unavailable",
  "invalid_render_cursor",
  "render_document_invalid",
  "renderer_not_configured",
  "render_dispatch_failed",
  "render_unavailable",
  "render_request_failed",
] as const;

export type RenderErrorCode = (typeof RENDER_ERROR_CODES)[number];

const KNOWN_RENDER_ERROR_CODES: ReadonlySet<string> = new Set(RENDER_ERROR_CODES);

/** Narrow any runtime value to a fixed code, defaulting to the generic one. */
export function asRenderErrorCode(value: unknown): RenderErrorCode {
  return typeof value === "string" && KNOWN_RENDER_ERROR_CODES.has(value)
    ? (value as RenderErrorCode)
    : "render_request_failed";
}

/** Why a render request failed, as a fixed code the UI may show verbatim. */
export class RenderRequestError extends Error {
  readonly code: RenderErrorCode;

  constructor(code: RenderErrorCode) {
    // The code is the entire message, so a driver string, a traceback, or a
    // local path can never reach a browser log through this error.
    super(`Render request failed (${code})`);
    this.name = "RenderRequestError";
    this.code = code;
  }
}

/** Every fixed code a Studio review request may end with, plus one generic fallback. */
const REVIEW_ERROR_CODES = [
  "review_revision_conflict",
  "review_document_not_found",
  "idempotency_conflict",
  "review_frame_out_of_range",
  "review_not_eligible",
  "invalid_review_page",
  "review_unavailable",
  "review_request_failed",
] as const;

export type ReviewErrorCode = (typeof REVIEW_ERROR_CODES)[number];

const KNOWN_REVIEW_ERROR_CODES: ReadonlySet<string> = new Set(REVIEW_ERROR_CODES);

/** Why a review request failed; a stale write also carries the newer saved revision. */
export class StudioReviewRequestError extends Error {
  readonly code: ReviewErrorCode;
  readonly latestRevision: number | null;

  constructor(code: ReviewErrorCode, latestRevision: number | null = null) {
    super(`Studio review request failed (${code})`);
    this.name = "StudioReviewRequestError";
    this.code = code;
    this.latestRevision = latestRevision;
  }
}

function reviewError(body: unknown): StudioReviewRequestError {
  const raw = (body ?? {}) as { code?: unknown; latest_revision?: unknown; detail?: { code?: unknown } };
  if (raw.code === "review_revision_conflict") {
    return Number.isInteger(raw.latest_revision) && (raw.latest_revision as number) > 0
      ? new StudioReviewRequestError("review_revision_conflict", raw.latest_revision as number)
      : new StudioReviewRequestError("review_request_failed");
  }
  const code = raw.detail?.code;
  return new StudioReviewRequestError(
    typeof code === "string" && KNOWN_REVIEW_ERROR_CODES.has(code)
      ? (code as ReviewErrorCode)
      : "review_request_failed",
  );
}

/**
 * Why a Studio import request failed: the HTTP status, or null when the request
 * never landed, and the server's fixed code. The server's own words are dropped.
 */
export class StudioImportRequestError extends Error {
  readonly status: number | null;
  readonly code: string | null;

  constructor(status: number | null, code: string | null = null) {
    super(`Studio import request failed (${status ?? "offline"})`);
    this.name = "StudioImportRequestError";
    this.status = status;
    this.code = code;
  }
}

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
  inspectStudioImport: (projectId: string, source: StudioSourceProjection) => Promise<StudioSourceInspection>;
  createStudioImport: (
    projectId: string,
    request: CreateStudioImport,
    idempotencyKey: string,
  ) => Promise<StudioDraft>;
  listStudioImportDrafts: (projectId: string, sourceKey: string) => Promise<StudioDraftList>;
  getStudioImportInventory: (projectId: string, documentId: string) => Promise<StudioImportInventory>;
  resolveStudioImportItem: (
    projectId: string,
    documentId: string,
    itemId: string,
    request: ResolveStudioImportItem,
  ) => Promise<StudioImportInventory>;
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
  /** Stream one local file to the project's assets; never a URL or a path. */
  uploadEditorAsset: (projectId: string, file: Blob) => Promise<EditorAsset>;
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
  getRenderCapability: (projectId: string) => Promise<RenderCapability>;
  createRenderJob: (
    projectId: string,
    idempotencyKey: string,
    request: CreateRenderJobPayload,
  ) => Promise<RenderJob>;
  listRenderJobs: (projectId: string, cursor?: string, limit?: number) => Promise<RenderJobPage>;
  getRenderJob: (projectId: string, renderJobId: string) => Promise<RenderJob>;
  cancelRenderJob: (projectId: string, renderJobId: string) => Promise<RenderJob>;
  retryRenderJob: (
    projectId: string,
    renderJobId: string,
    idempotencyKey: string,
  ) => Promise<RenderJob>;
  downloadRenderOutput: (projectId: string, renderJobId: string) => Promise<Blob>;
  cleanupRenderArtifacts: (projectId: string, renderJobId: string) => Promise<RenderJob>;
  listStudioReviewComments: (
    projectId: string,
    documentId: string,
    query?: ReviewListQuery,
  ) => Promise<ReviewCommentPage>;
  createStudioReviewComment: (
    projectId: string,
    documentId: string,
    request: CreateComment,
  ) => Promise<ReviewComment>;
  listStudioReviewDecisions: (
    projectId: string,
    documentId: string,
    query?: ReviewListQuery,
  ) => Promise<ReviewDecisionPage>;
  createStudioReviewDecision: (
    projectId: string,
    documentId: string,
    request: CreateDecision,
  ) => Promise<ReviewDecision>;
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

  // Import failures answer `{ detail: { code } }`, a stale revision `{ code, latest }`.
  // Only the status and the code survive, so no server text reaches the page.
  async function importCall<T>(path: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}`, { ...init, headers: headers(init.headers) });
    } catch {
      throw new StudioImportRequestError(null);
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as
        | { code?: unknown; detail?: { code?: unknown } }
        | null;
      const code = body?.detail?.code ?? body?.code;
      throw new StudioImportRequestError(response.status, typeof code === "string" ? code : null);
    }
    return response.json() as Promise<T>;
  }
  const importPath = (projectId: string, rest = "") =>
    `/api/v1/projects/${encodeURIComponent(projectId)}/studio-imports${rest}`;
  const importPost = <T>(path: string, body: unknown, extra: HeadersInit = {}) =>
    importCall<T>(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...extra },
      body: JSON.stringify(body),
    });

  // Render failures answer `{ detail: { code } }`. Only an allowlisted code is
  // believed; every other body, however it is shaped, becomes one fixed code.
  async function renderCall(path: string, init: RequestInit = {}): Promise<Response> {
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}`, { ...init, headers: headers(init.headers) });
    } catch {
      // A transport error's own words can name a proxy, a certificate path, or
      // a token, so the render surface says only that the request did not land.
      throw new RenderRequestError("render_request_failed");
    }
    if (response.ok) return response;
    const body = (await response.json().catch(() => null)) as { detail?: { code?: unknown } } | null;
    throw new RenderRequestError(asRenderErrorCode(body?.detail?.code));
  }

  /** Read a render response body without letting the reader's error escape. */
  async function renderBody<T>(read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch {
      throw new RenderRequestError("render_request_failed");
    }
  }

  const renderJson = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await renderCall(path, init);
    return renderBody(() => response.json() as Promise<T>);
  };

  // Review calls never retry on their own: a failure, including a stale write,
  // returns to the caller, who resubmits explicitly with a new operation ID.
  async function reviewJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    try {
      const response = await doFetch(`${baseUrl}${path}`, { ...init, headers: headers(init.headers) });
      if (response.ok) return (await response.json()) as T;
      throw reviewError(await response.json().catch(() => null));
    } catch (error) {
      throw error instanceof StudioReviewRequestError
        ? error
        : new StudioReviewRequestError("review_request_failed");
    }
  }

  const reviewPath = (projectId: string, documentId: string, resource: string) =>
    `/api/v1/projects/${encodeURIComponent(projectId)}/edit-documents/${encodeURIComponent(documentId)}/${resource}`;
  const reviewList = <T>(path: string, { limit = 50, cursor }: ReviewListQuery = {}) => {
    const query = new URLSearchParams({ limit: String(Math.min(Math.max(limit, 1), 50)) });
    if (cursor) query.set("cursor", cursor);
    return reviewJson<T>(`${path}?${query.toString()}`);
  };
  const reviewPost = <T>(path: string, body: unknown) =>
    reviewJson<T>(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  const rendersPath = (projectId: string) =>
    `/api/v1/projects/${encodeURIComponent(projectId)}/render-jobs`;
  const renderJobPath = (projectId: string, renderJobId: string) =>
    `${rendersPath(projectId)}/${encodeURIComponent(renderJobId)}`;

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
    inspectStudioImport: (projectId, source) => importPost(importPath(projectId, "/inspect"), source),
    createStudioImport: (projectId, request, idempotencyKey) =>
      importPost(importPath(projectId), request, { "Idempotency-Key": idempotencyKey }),
    listStudioImportDrafts: (projectId, sourceKey) =>
      importCall(importPath(projectId, `/${encodeURIComponent(sourceKey)}`)),
    getStudioImportInventory: (projectId, documentId) =>
      importCall(importPath(projectId, `/documents/${encodeURIComponent(documentId)}`)),
    resolveStudioImportItem: (projectId, documentId, itemId, request) =>
      importPost(
        importPath(
          projectId,
          `/documents/${encodeURIComponent(documentId)}/items/${encodeURIComponent(itemId)}/resolve`,
        ),
        request,
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
    uploadEditorAsset: (projectId, file) =>
      importCall<EditorAsset>(`/api/v1/projects/${encodeURIComponent(projectId)}/editor-assets`, {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file,
      }),
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
    getRenderCapability: (projectId) =>
      renderJson<RenderCapability>(
        `/api/v1/projects/${encodeURIComponent(projectId)}/render-capability`,
      ),
    // The key belongs to one attempt and is supplied by the caller, so a replay
    // of that attempt reaches the control plane as the very same request.
    createRenderJob: (projectId, idempotencyKey, request) =>
      renderJson<RenderJob>(rendersPath(projectId), {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
        body: JSON.stringify(request),
      }),
    listRenderJobs: (projectId, cursor, limit = 20) => {
      const query = new URLSearchParams({ limit: String(Math.min(Math.max(limit, 1), 50)) });
      if (cursor) query.set("cursor", cursor);
      return renderJson<RenderJobPage>(`${rendersPath(projectId)}?${query.toString()}`);
    },
    getRenderJob: (projectId, renderJobId) =>
      renderJson<RenderJob>(renderJobPath(projectId, renderJobId)),
    cancelRenderJob: (projectId, renderJobId) =>
      renderJson<RenderJob>(`${renderJobPath(projectId, renderJobId)}/cancel`, { method: "POST" }),
    retryRenderJob: (projectId, renderJobId, idempotencyKey) =>
      renderJson<RenderJob>(`${renderJobPath(projectId, renderJobId)}/retry`, {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
      }),
    // The bytes arrive through the authenticated control-plane route; no local
    // name, storage locator, or renderer address is returned with them.
    downloadRenderOutput: async (projectId, renderJobId) => {
      const response = await renderCall(`${renderJobPath(projectId, renderJobId)}/output`);
      return renderBody(() => response.blob());
    },
    cleanupRenderArtifacts: (projectId, renderJobId) =>
      renderJson<RenderJob>(`${renderJobPath(projectId, renderJobId)}/artifacts`, {
        method: "DELETE",
      }),
    listStudioReviewComments: (projectId, documentId, query) =>
      reviewList<ReviewCommentPage>(reviewPath(projectId, documentId, "review-comments"), query),
    createStudioReviewComment: (projectId, documentId, request) =>
      reviewPost<ReviewComment>(reviewPath(projectId, documentId, "review-comments"), request),
    listStudioReviewDecisions: (projectId, documentId, query) =>
      reviewList<ReviewDecisionPage>(reviewPath(projectId, documentId, "review-decisions"), query),
    createStudioReviewDecision: (projectId, documentId, request) =>
      reviewPost<ReviewDecision>(reviewPath(projectId, documentId, "review-decisions"), request),
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
