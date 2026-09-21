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

/**
 * What the editor knows about whether the saved version can be rendered: the
 * text rules and the structural timeline rules, each reported by the domain
 * validator that owns it. The panel derives validity, so a caller cannot claim
 * a document is renderable and blocked at the same time.
 */
export type RenderValidation = {
  textValid: boolean;
  blockingIssues: number;
};

type Props = {
  client: RenderPanelClient;
  projectId: string;
  /** The saved document and the exact revision a render would name. */
  documentId: string;
  documentRevision: number;
  templateId: RenderJob["template_id"];
  templateVersion: RenderJob["template_version"];
  facts: Omit<RenderEditorFacts, "documentValid">;
  validation: RenderValidation;
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
  projectId: string;
  documentId: string;
  documentRevision: number;
  templateId: string;
  templateVersion: number;
  presetId: string;
};

const actionButton =
  "rounded-md border border-border px-3 py-1.5 text-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40";

/**
 * The render context is one identity, not five props: a different project,
 * document, revision, or template is a different render surface. Keying the
 * panel on it replaces the whole surface, so no confirmation, selection,
 * attempt, timer, or listener can outlive the context that owns it.
 */
export function RenderPanel(props: Props) {
  const { projectId, documentId, documentRevision, templateId, templateVersion } = props;
  return (
    <RenderSurface
      key={`${projectId}|${documentId}|${documentRevision}|${templateId}|${templateVersion}`}
      {...props}
    />
  );
}

function RenderSurface({
  client,
  projectId,
  documentId,
  documentRevision,
  templateId,
  templateVersion,
  facts,
  validation,
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
  // Read by handlers that must answer for themselves rather than trust a
  // rendered attribute, and by the settlement path, which runs between renders.
  const offlineRef = useRef(!facts.online);
  offlineRef.current = state.isOffline || !facts.online;
  // At most one recovery is owed at a time: a reconnect during a request waits
  // for that request to settle instead of starting a second one.
  const recoveryOwedRef = useRef(false);
  const aliveRef = useRef(true);
  const recoverRef = useRef<() => Promise<void>>(async () => {});

  const load = useCallback(async () => {
    dispatch({ type: "load_started" });
    const generation = ++generationRef.current;
    try {
      const [capability, page] = await Promise.all([
        client.getRenderCapability(projectId),
        client.listRenderJobs(projectId),
      ]);
      // A page without records is an empty history, not a broken panel.
      const jobs = page.jobs ?? [];
      dispatch({ type: "loaded", generation, capability, jobs });
      // A reload lands on a render already running: the control plane names it,
      // so the panel resumes that one instead of inventing a rule of its own.
      const activeId = capability.active_render_job_id;
      if (
        activeId &&
        stateRef.current.selectedJobId === null &&
        jobs.some((entry) => entry.render_job_id === activeId)
      ) {
        dispatch({ type: "job_selected", renderJobId: activeId });
      }
    } catch (error) {
      dispatch({ type: "load_failed", generation, code: codeOf(error) });
    }
  }, [client, projectId]);

  /**
   * Land the outcome of a mutation. Every outcome ends in authoritative state
   * while the panel is online; offline, exactly one refresh or replay is owed
   * to the reconnect instead, and an attempt still unaccounted for stays whole
   * so the replay can reuse its original key.
   */
  const land = useCallback(
    async (outcome: { ok: true; job?: RenderJob } | { ok: false; code: unknown }) => {
      if (!aliveRef.current) return;
      const owed = recoveryOwedRef.current;
      if (outcome.ok) {
        dispatch({
          type: "mutation_succeeded",
          generation: generationRef.current,
          job: outcome.job,
        });
      } else if (offlineRef.current || owed) {
        recoveryOwedRef.current = true;
        return;
      } else {
        // Re-read first: a reload clears the last error, so the reason a person
        // needs is dispatched afterwards, under the generation the reload left.
        await load();
        if (!aliveRef.current) return;
        dispatch({
          type: "mutation_failed",
          generation: generationRef.current,
          code: outcome.code,
        });
        return;
      }
      if (offlineRef.current || owed) {
        recoveryOwedRef.current = true;
        return;
      }
      await load();
    },
    [load],
  );

  /** Run a create or retry under a key the caller owns, then re-read the truth. */
  const runAttempt = useCallback(
    async (attempt: RenderAttempt, attemptKey: string) => {
      if (inFlightRef.current || offlineRef.current) return;
      inFlightRef.current = true;
      try {
        const job =
          attempt.kind === "create"
            ? await client.createRenderJob(projectId, attemptKey, attempt.request)
            : await client.retryRenderJob(projectId, attempt.renderJobId, attemptKey);
        await land({ ok: true, job });
      } catch (error) {
        await land({ ok: false, code: codeOf(error) });
      } finally {
        inFlightRef.current = false;
      }
      await recoverRef.current();
    },
    [client, projectId, land],
  );

  /** Run a mutation the server identifies by the job alone. */
  const runPlain = useCallback(
    async (mutation: "cancel" | "download" | "cleanup", work: () => Promise<RenderJob | void>) => {
      if (inFlightRef.current || stateRef.current.mutation !== null) return;
      // Offline is refused here, not only by a disabled attribute a synthetic
      // event can ignore: no request leaves this panel without a connection.
      if (offlineRef.current) return;
      inFlightRef.current = true;
      dispatch({ type: "mutation_started", mutation });
      try {
        const job = await work();
        await land({ ok: true, job: job ?? undefined });
      } catch (error) {
        await land({ ok: false, code: codeOf(error) });
      } finally {
        inFlightRef.current = false;
      }
      await recoverRef.current();
    },
    [land],
  );

  /**
   * Execute the one recovery that is owed, once nothing is in flight and the
   * connection is back: replay the attempt still unaccounted for under its own
   * key, or re-read authoritative state. The flag is cleared first, so a
   * recovery that fails becomes an ordinary failure rather than a retry loop.
   */
  const recover = useCallback(async () => {
    if (!aliveRef.current || !recoveryOwedRef.current) return;
    if (inFlightRef.current || offlineRef.current) return;
    recoveryOwedRef.current = false;
    const { mutation, attemptKey } = stateRef.current;
    const attempt = attemptRef.current;
    if (mutation !== null && attemptKey !== null && attempt !== null) {
      await runAttempt(attempt, attemptKey);
    } else {
      await load();
    }
  }, [load, runAttempt]);
  recoverRef.current = recover;

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const goOffline = () => {
      offlineRef.current = true;
      generationRef.current += 1;
      // Whatever was in flight settles into an unknown, so one recovery is owed.
      if (inFlightRef.current || stateRef.current.mutation !== null) {
        recoveryOwedRef.current = true;
      }
      dispatch({ type: "went_offline" });
    };
    const goOnline = () => {
      offlineRef.current = false;
      dispatch({ type: "went_online" });
      // A reconnect always owes one action; while a request is still outstanding
      // it waits for that request to settle instead of starting a second one.
      recoveryOwedRef.current = true;
      void recoverRef.current();
    };
    window.addEventListener("offline", goOffline);
    window.addEventListener("online", goOnline);
    return () => {
      window.removeEventListener("offline", goOffline);
      window.removeEventListener("online", goOnline);
    };
  }, []);

  // Nothing here survives unmount: the last callbacks are answered by nobody.
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      generationRef.current += 1;
    };
  }, []);

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

  const blockingIssues = validation.blockingIssues;
  const gate = renderGate(
    { ...facts, documentValid: validation.textValid && blockingIssues === 0 },
    state,
  );
  // A structural problem is nameable, so the guidance says how many stand in
  // the way instead of repeating the generic invalid-document sentence.
  const gateText =
    gate.reason === "document_invalid" && blockingIssues > 0
      ? `Fix ${blockingIssues} timeline issue${blockingIssues === 1 ? "" : "s"} before rendering.`
      : gate.reason
        ? gateCopy[gate.reason]
        : null;
  const offline = state.isOffline || !facts.online;

  const openConfirm = () => {
    if (!gate.allowed || state.capability === null) return;
    setConfirmCreate({
      projectId,
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
          aria-describedby={gateText !== null ? gateReasonId : undefined}
          onClick={openConfirm}
        >
          Render video
        </button>
        {gateText !== null ? (
          <span id={gateReasonId} className="sr-only">
            {gateText}
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
                disabled={state.mutation !== null || offline}
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
                disabled={state.mutation !== null || offline}
                onClick={() => startDownload(selected)}
              >
                Download video
              </button>
            ) : null}
            {canCleanup(selected) ? (
              <button
                type="button"
                className={actionButton}
                disabled={state.mutation !== null || offline}
                onClick={() => {
                  if (offlineRef.current) return;
                  setConfirmCleanup(selected.render_job_id);
                }}
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
          role="group"
          aria-labelledby={confirmTitleId}
          className="flex flex-col gap-2 rounded-md border border-border bg-card p-3 text-sm"
        >
          <h3 id={confirmTitleId} className="font-medium">
            Render this version?
          </h3>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 text-xs text-muted-foreground">
            <dt>Project</dt>
            <dd className="font-mono">{confirmCreate.projectId}</dd>
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
          role="group"
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
