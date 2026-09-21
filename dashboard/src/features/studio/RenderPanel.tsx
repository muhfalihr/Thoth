import { useCallback, useEffect, useId, useReducer, useRef, useState } from "react";

import type {
  ControlPlaneClient,
  CreateRenderJobPayload,
  RenderCapability,
  RenderErrorCode,
  RenderJob,
  RenderJobStatus,
} from "@/api/control-plane";

import {
  canCancel,
  canCleanup,
  canDownload,
  canRetry,
  createRenderJobState,
  renderGate,
  renderJobReducer,
  selectedRenderJob,
  type RenderEditorFacts,
  type RenderGateReason,
} from "./render_job_state";

/** Only the render half of the control plane: the panel can reach nothing else. */
export type RenderPanelClient = Pick<
  ControlPlaneClient,
  | "getRenderCapability"
  | "createRenderJob"
  | "listRenderJobs"
  | "getRenderJob"
  | "cancelRenderJob"
  | "retryRenderJob"
  | "downloadRenderOutput"
  | "cleanupRenderArtifacts"
>;

type RenderUnavailableReason = NonNullable<RenderCapability["reason"]>;
type RenderFailureCode = NonNullable<RenderJob["failure_code"]>;

type Props = {
  client: RenderPanelClient;
  projectId: string;
  /** The saved document and the exact revision a render would name. */
  documentId: string;
  documentRevision: number;
  templateId: RenderJob["template_id"];
  templateVersion: RenderJob["template_version"];
  facts: RenderEditorFacts;
};

const POLL_INTERVAL_MS = 1_500;

/** The statuses the lifecycle can still move on, mirroring the state module. */
const RUNNING_STATUSES: ReadonlySet<RenderJobStatus> = new Set([
  "preparing",
  "rendering",
  "finalizing",
]);

const statusCopy: Record<RenderJobStatus, string> = {
  preparing: "Preparing",
  rendering: "Rendering",
  finalizing: "Finalizing",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

const gateCopy: Record<RenderGateReason, string> = {
  offline: "You are offline. Rendering resumes when the connection returns.",
  saving: "Rendering starts once your changes finish saving.",
  conflict: "A newer version exists. Resolve it before rendering.",
  dirty: "Save your changes before rendering.",
  document_invalid: "Fix the issues in your document before rendering.",
  renderer_unavailable: "Rendering is not available right now.",
  render_busy: "Another render is already running.",
  mutation_in_progress: "A render request is already in progress.",
};

const unavailableCopy: Record<RenderUnavailableReason, string> = {
  renderer_not_configured: "Rendering is not set up on this installation.",
  render_busy: "Another render is already running. You can start a new one when it finishes.",
};

/**
 * Every fixed code the client can end a request with, mapped to copy a person
 * can act on. Nothing else is representable, so no message, path, provider
 * detail, or exception can reach the screen through an error.
 */
const errorCopy: Record<RenderErrorCode, string> = {
  render_job_not_found: "That render is no longer available.",
  render_busy: "A render is already running. Try again when it finishes.",
  idempotency_conflict: "That request was already used for a different render.",
  render_job_not_active: "That render has already finished.",
  render_job_not_cancellable: "That render can no longer be cancelled.",
  render_job_not_retryable: "That render cannot be retried.",
  render_job_not_cleanable: "Those render files cannot be deleted.",
  render_preparation_failed: "This version could not be prepared for rendering.",
  render_output_unavailable: "The rendered video is no longer available to download.",
  invalid_render_cursor: "The render history could not be loaded.",
  render_document_invalid: "This version cannot be rendered as it is.",
  renderer_not_configured: "Rendering is not available on this installation.",
  render_dispatch_failed: "The render could not be started. Try again.",
  render_unavailable: "Rendering is unavailable right now. Try again later.",
  render_request_failed: "Something went wrong. Try again.",
};

/** How a render ended, in the same fixed-code spirit as the request errors. */
const failureCopy: Record<RenderFailureCode, string> = {
  render_asset_unavailable: "A file this render needs was not available.",
  render_bundle_invalid: "This version could not be packaged for rendering.",
  render_deadline_exceeded: "The render took too long and was stopped.",
  render_dispatch_failed: "The render never started.",
  render_engine_failed: "The renderer could not finish this video.",
  render_output_invalid: "The rendered video did not come out usable.",
  render_storage_failed: "The rendered video could not be saved.",
  renderer_unavailable: "The renderer was unavailable while this render ran.",
};

const GENERIC_FAILURE = "The render did not finish.";

function failureText(job: RenderJob): string {
  const code = job.failure_code;
  return (code && failureCopy[code as RenderFailureCode]) || GENERIC_FAILURE;
}

/**
 * Read the fixed code off a rejection and nothing else: the reducer narrows
 * whatever this returns, so an arbitrary throw becomes the generic code.
 */
function codeOf(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code;
}

/** What a create or retry needs to be replayed under its original key. */
type RenderAttempt =
  | { kind: "create"; request: CreateRenderJobPayload }
  | { kind: "retry"; renderJobId: string };

/** The facts a render is confirmed against, frozen when the dialog opens. */
type RenderConfirmation = {
  documentId: string;
  documentRevision: number;
  templateId: string;
  templateVersion: number;
  presetId: string;
};

const actionButton =
  "rounded-md border border-border px-3 py-1.5 text-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40";

export function RenderPanel({
  client,
  projectId,
  documentId,
  documentRevision,
  templateId,
  templateVersion,
  facts,
}: Props) {
  const [state, dispatch] = useReducer(renderJobReducer, undefined, createRenderJobState);
  const [confirmCreate, setConfirmCreate] = useState<RenderConfirmation | null>(null);
  const [confirmCleanup, setConfirmCleanup] = useState<string | null>(null);
  const gateReasonId = useId();
  const confirmTitleId = useId();

  // Kept in lockstep with the reducer's own counter: every dispatch that moves
  // the generation moves this too, so an asynchronous callback can tell whether
  // the document it was started for is still the one on screen.
  const generationRef = useRef(0);
  // Set before a request leaves, so two clicks in one tick cannot both fire.
  const inFlightRef = useRef(false);
  const attemptRef = useRef<RenderAttempt | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  const load = useCallback(async () => {
    dispatch({ type: "load_started" });
    const generation = ++generationRef.current;
    try {
      const [capability, page] = await Promise.all([
        client.getRenderCapability(projectId),
        client.listRenderJobs(projectId),
      ]);
      // A page without records is an empty history, not a broken panel.
      dispatch({ type: "loaded", generation, capability, jobs: page.jobs ?? [] });
    } catch (error) {
      dispatch({ type: "load_failed", generation, code: codeOf(error) });
    }
  }, [client, projectId]);

  /** Run a create or retry under a key the caller owns, then re-read the truth. */
  const runAttempt = useCallback(
    async (attempt: RenderAttempt, attemptKey: string) => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      const generation = generationRef.current;
      try {
        const job =
          attempt.kind === "create"
            ? await client.createRenderJob(projectId, attemptKey, attempt.request)
            : await client.retryRenderJob(projectId, attempt.renderJobId, attemptKey);
        dispatch({ type: "mutation_succeeded", generation, job });
        if (generation === generationRef.current) await load();
      } catch (error) {
        dispatch({ type: "mutation_failed", generation, code: codeOf(error) });
      } finally {
        inFlightRef.current = false;
      }
    },
    [client, projectId, load],
  );

  /** Run a mutation the server identifies by the job alone. */
  const runPlain = useCallback(
    async (mutation: "cancel" | "download" | "cleanup", work: () => Promise<RenderJob | void>) => {
      if (inFlightRef.current || stateRef.current.mutation !== null) return;
      inFlightRef.current = true;
      dispatch({ type: "mutation_started", mutation });
      const generation = generationRef.current;
      try {
        const job = await work();
        dispatch({ type: "mutation_succeeded", generation, job: job ?? undefined });
        if (generation === generationRef.current) await load();
      } catch (error) {
        dispatch({ type: "mutation_failed", generation, code: codeOf(error) });
      } finally {
        inFlightRef.current = false;
      }
    },
    [load],
  );

  // A different document or revision is a different render surface: pending
  // confirmations and selections belong to the old one and are dropped.
  useEffect(() => {
    setConfirmCreate(null);
    setConfirmCleanup(null);
    dispatch({ type: "job_selected", renderJobId: null });
    void load();
  }, [load, documentId, documentRevision]);

  useEffect(() => {
    const goOffline = () => {
      generationRef.current += 1;
      dispatch({ type: "went_offline" });
    };
    const goOnline = () => {
      dispatch({ type: "went_online" });
      const { mutation, attemptKey } = stateRef.current;
      const attempt = attemptRef.current;
      // An attempt that may or may not have reached the server is replayed under
      // its original key; anything else recovers by re-reading the truth.
      if (mutation !== null && attemptKey !== null && attempt !== null) {
        void runAttempt(attempt, attemptKey);
      } else {
        void load();
      }
    };
    window.addEventListener("offline", goOffline);
    window.addEventListener("online", goOnline);
    return () => {
      window.removeEventListener("offline", goOffline);
      window.removeEventListener("online", goOnline);
    };
  }, [load, runAttempt]);

  // Nothing here survives unmount: the last callbacks are answered by nobody.
  useEffect(
    () => () => {
      generationRef.current += 1;
    },
    [],
  );

  const selected = selectedRenderJob(state);
  const pollJobId = selected && RUNNING_STATUSES.has(selected.status) ? selected.render_job_id : null;
  const paused = state.isOffline || !facts.online;

  useEffect(() => {
    if (pollJobId === null || paused) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The next poll is scheduled only once the current one has settled, so the
    // panel never has two status requests out or an unbounded timer chain.
    const tick = () => {
      const generation = generationRef.current;
      client
        .getRenderJob(projectId, pollJobId)
        .then((job) => {
          if (live) dispatch({ type: "job_refreshed", generation, job });
        })
        .catch(() => {})
        .finally(() => {
          if (live) timer = setTimeout(tick, POLL_INTERVAL_MS);
        });
    };
    timer = setTimeout(tick, POLL_INTERVAL_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [client, projectId, pollJobId, paused]);

  const gate = renderGate(facts, state);

  const openConfirm = () => {
    if (!gate.allowed || state.capability === null) return;
    setConfirmCreate({
      documentId,
      documentRevision,
      templateId,
      templateVersion,
      presetId: state.capability.preset_id,
    });
  };

  const startCreate = () => {
    const confirmation = confirmCreate;
    setConfirmCreate(null);
    // The guard and the label read the same gate, so what is explained as
    // impossible is impossible.
    if (confirmation === null || !gate.allowed || inFlightRef.current) return;
    const attempt: RenderAttempt = {
      kind: "create",
      request: {
        document_id: confirmation.documentId,
        document_revision: confirmation.documentRevision,
      },
    };
    const attemptKey = crypto.randomUUID();
    attemptRef.current = attempt;
    dispatch({ type: "mutation_started", mutation: "create", attemptKey });
    void runAttempt(attempt, attemptKey);
  };

  const startRetry = (job: RenderJob) => {
    if (inFlightRef.current || state.mutation !== null) return;
    const attempt: RenderAttempt = { kind: "retry", renderJobId: job.render_job_id };
    const attemptKey = crypto.randomUUID();
    attemptRef.current = attempt;
    dispatch({ type: "mutation_started", mutation: "retry", attemptKey });
    void runAttempt(attempt, attemptKey);
  };

  const startCancel = (job: RenderJob) => {
    void runPlain("cancel", () => client.cancelRenderJob(projectId, job.render_job_id));
  };

  const startDownload = (job: RenderJob) => {
    void runPlain("download", async () => {
      const blob = await client.downloadRenderOutput(projectId, job.render_job_id);
      const url = URL.createObjectURL(blob);
      try {
        const anchor = window.document.createElement("a");
        anchor.href = url;
        // The name belongs to this panel: no server path is read or revealed.
        anchor.download = `render-${job.render_job_id}.mp4`;
        anchor.click();
      } finally {
        URL.revokeObjectURL(url);
      }
    });
  };

  const startCleanup = (renderJobId: string) => {
    setConfirmCleanup(null);
    void runPlain("cleanup", () => client.cleanupRenderArtifacts(projectId, renderJobId));
  };

  return (
    <section className="flex flex-col gap-3 border-t border-border px-4 py-3" aria-label="Render">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={actionButton}
          disabled={!gate.allowed}
          aria-describedby={gate.reason ? gateReasonId : undefined}
          onClick={openConfirm}
        >
          Render video
        </button>
        {gate.reason ? (
          <span id={gateReasonId} className="sr-only">
            {gateCopy[gate.reason]}
          </span>
        ) : null}
        {state.capability === null ? (
          <span className="text-xs text-muted-foreground">Loading render options…</span>
        ) : null}
      </div>

      {state.capability !== null && !state.capability.available && state.capability.reason ? (
        <p role="status" className="text-sm text-muted-foreground">
          {unavailableCopy[state.capability.reason]}
        </p>
      ) : null}

      {state.lastError !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {errorCopy[state.lastError]}
        </p>
      ) : null}

      {selected ? (
        <div className="flex flex-col gap-2" aria-label="Current render">
          <p role="status" className="text-sm">
            {statusCopy[selected.status]}
            {typeof selected.progress_percent === "number"
              ? ` · ${selected.progress_percent}%`
              : ""}
          </p>
          {selected.status === "failed" ? (
            <p className="text-sm text-muted-foreground">{failureText(selected)}</p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {canCancel(selected) ? (
              <button
                type="button"
                className={actionButton}
                disabled={state.mutation !== null}
                onClick={() => startCancel(selected)}
              >
                Cancel render
              </button>
            ) : null}
            {canRetry(selected) ? (
              <button
                type="button"
                className={actionButton}
                disabled={!gate.allowed}
                onClick={() => startRetry(selected)}
              >
                Retry render
              </button>
            ) : null}
            {canDownload(selected) ? (
              <button
                type="button"
                className={actionButton}
                disabled={state.mutation !== null}
                onClick={() => startDownload(selected)}
              >
                Download video
              </button>
            ) : null}
            {canCleanup(selected) ? (
              <button
                type="button"
                className={actionButton}
                disabled={state.mutation !== null}
                onClick={() => setConfirmCleanup(selected.render_job_id)}
              >
                Delete render files
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      <ol className="flex flex-col gap-1" aria-label="Render history">
        {state.history.map((entry) => (
          <li key={entry.render_job_id}>
            <button
              type="button"
              className="w-full rounded-md px-2 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`Render started ${entry.created_at}, ${statusCopy[entry.status]}`}
              aria-current={entry.render_job_id === state.selectedJobId}
              onClick={() =>
                dispatch({ type: "job_selected", renderJobId: entry.render_job_id })
              }
            >
              {statusCopy[entry.status]} · {entry.created_at}
            </button>
          </li>
        ))}
      </ol>

      {confirmCreate ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby={confirmTitleId}
          className="flex flex-col gap-2 rounded-md border border-border bg-card p-3 text-sm"
        >
          <h3 id={confirmTitleId} className="font-medium">
            Render this version?
          </h3>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 text-xs text-muted-foreground">
            <dt>Project</dt>
            <dd className="font-mono">{projectId}</dd>
            <dt>Document</dt>
            <dd className="font-mono">{confirmCreate.documentId}</dd>
            <dt>Revision</dt>
            <dd className="font-mono">{confirmCreate.documentRevision}</dd>
            <dt>Template</dt>
            <dd className="font-mono">
              {confirmCreate.templateId} v{confirmCreate.templateVersion}
            </dd>
            <dt>Preset</dt>
            <dd className="font-mono">{confirmCreate.presetId}</dd>
          </dl>
          <p className="text-xs text-muted-foreground">
            This renders the saved version exactly as it is now.
          </p>
          <div className="flex gap-2">
            <button type="button" className={actionButton} onClick={startCreate}>
              Start render
            </button>
            <button
              type="button"
              className={actionButton}
              onClick={() => setConfirmCreate(null)}
            >
              Keep editing
            </button>
          </div>
        </div>
      ) : null}

      {confirmCleanup !== null ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Delete render files"
          className="flex flex-col gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm"
        >
          <p>This permanently deletes the rendered video. It cannot be undone.</p>
          <div className="flex gap-2">
            <button
              type="button"
              className={actionButton}
              onClick={() => startCleanup(confirmCleanup)}
            >
              Delete files
            </button>
            <button
              type="button"
              className={actionButton}
              onClick={() => setConfirmCleanup(null)}
            >
              Keep files
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
