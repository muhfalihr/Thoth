import {
  asRenderErrorCode,
  type RenderCapability,
  type RenderErrorCode,
  type RenderJob,
  type RenderJobStatus,
} from "@/api/control-plane";

import type { EditorSaveStatus } from "./editor_state";

/** How much render history the dashboard keeps, newest first. */
export const RENDER_HISTORY_LIMIT = 20;

/**
 * The lifecycle the control plane itself enforces, mirrored edge for edge and
 * keyed by the generated status union: a contract change breaks the build here
 * instead of quietly admitting an impossible transition.
 */
const ALLOWED_TRANSITIONS: Record<RenderJobStatus, readonly RenderJobStatus[]> = {
  preparing: ["rendering", "failed", "cancelled"],
  rendering: ["finalizing", "failed", "cancelled"],
  finalizing: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

/** A create or retry, the only mutations that own an idempotency key. */
export type RenderAttemptMutation = "create" | "retry";
/** A mutation the server identifies by the job alone, with no attempt of its own. */
export type RenderPlainMutation = "cancel" | "download" | "cleanup";
export type RenderMutation = RenderAttemptMutation | RenderPlainMutation;

export type RenderGateReason =
  | "offline"
  | "saving"
  | "conflict"
  | "dirty"
  | "document_invalid"
  | "renderer_unavailable"
  | "render_busy"
  | "mutation_in_progress";

/** Everything the editor tells the render surface, and nothing of its draft. */
export type RenderEditorFacts = {
  saveStatus: EditorSaveStatus;
  online: boolean;
  documentValid: boolean;
};

export type RenderJobState = {
  capability: RenderCapability | null;
  /** Newest first, deduplicated by job, and never longer than the limit. */
  history: RenderJob[];
  selectedJobId: string | null;
  mutation: RenderMutation | null;
  /** Rises with every load so an older response cannot overwrite a newer one. */
  generation: number;
  isOffline: boolean;
  /** A fixed code only; no message, path, or exception ever lands here. */
  lastError: RenderErrorCode | null;
  /** The idempotency key of the create or retry attempt currently in flight. */
  attemptKey: string | null;
};

export type RenderJobAction =
  | { type: "load_started" }
  | { type: "loaded"; generation: number; capability: RenderCapability; jobs: RenderJob[] }
  | { type: "load_failed"; generation: number; code: unknown }
  | { type: "job_selected"; renderJobId: string | null }
  | { type: "job_refreshed"; generation: number; job: RenderJob }
  // An attempt is unusable without its key, and the other mutations have none
  // to give, so neither mistake is expressible.
  | { type: "mutation_started"; mutation: RenderAttemptMutation; attemptKey: string }
  | { type: "mutation_started"; mutation: RenderPlainMutation; attemptKey?: never }
  | { type: "mutation_succeeded"; generation: number; job?: RenderJob }
  | { type: "mutation_failed"; generation: number; code: unknown }
  | { type: "went_offline" }
  | { type: "went_online" };

export function createRenderJobState(): RenderJobState {
  return {
    capability: null,
    history: [],
    selectedJobId: null,
    mutation: null,
    generation: 0,
    isOffline: false,
    lastError: null,
    attemptKey: null,
  };
}

/** A job is active exactly as long as the lifecycle still offers it an edge. */
function isActive(job: RenderJob): boolean {
  return ALLOWED_TRANSITIONS[job.status].length > 0;
}

function isAttempt(mutation: RenderMutation): mutation is RenderAttemptMutation {
  return mutation === "create" || mutation === "retry";
}

type RenderProgress = RenderJob["progress_percent"];

/** Progress only ever rises, and a silent report never erases what is known. */
function monotonicProgress(known: RenderProgress, reported: RenderProgress): RenderProgress {
  if (reported === undefined || reported === null) return known;
  if (known === undefined || known === null) return reported;
  return Math.max(known, reported);
}

/**
 * Merge a refreshed record into what is already known, or refuse it outright:
 * a terminal job is final, an active job only moves the way the lifecycle
 * allows, and a same-status update keeps the highest progress seen. A forward
 * transition is taken whole, so a status that carries no progress clears it.
 */
function reconcile(known: RenderJob | undefined, incoming: RenderJob): RenderJob | null {
  if (!known) return incoming;
  if (known.status !== incoming.status) {
    return ALLOWED_TRANSITIONS[known.status].includes(incoming.status) ? incoming : null;
  }
  const progress = monotonicProgress(known.progress_percent, incoming.progress_percent);
  return progress === incoming.progress_percent
    ? incoming
    : { ...incoming, progress_percent: progress };
}

/** Newest first, one record per job, and bounded. Later records win a tie. */
function bounded(jobs: RenderJob[]): RenderJob[] {
  const byIdentity = new Map<string, RenderJob>();
  for (const entry of jobs) byIdentity.set(entry.render_job_id, entry);
  return [...byIdentity.values()]
    .sort(
      (left, right) =>
        right.created_at.localeCompare(left.created_at) ||
        right.render_job_id.localeCompare(left.render_job_id),
    )
    .slice(0, RENDER_HISTORY_LIMIT);
}

function recordJob(history: RenderJob[], job: RenderJob): RenderJob[] {
  const known = history.find((entry) => entry.render_job_id === job.render_job_id);
  const merged = reconcile(known, job);
  return merged === null ? history : bounded([...history, merged]);
}

export function selectedRenderJob(state: RenderJobState): RenderJob | null {
  return state.history.find((entry) => entry.render_job_id === state.selectedJobId) ?? null;
}

export function renderGate(
  facts: RenderEditorFacts,
  state: RenderJobState,
): { allowed: boolean; reason?: RenderGateReason } {
  if (!facts.online || state.isOffline) return { allowed: false, reason: "offline" };
  if (facts.saveStatus === "saving") return { allowed: false, reason: "saving" };
  if (facts.saveStatus === "conflict") return { allowed: false, reason: "conflict" };
  // Anything that is not the saved revision is unrenderable: a render names one
  // exact saved revision and the editor is the only thing that can produce it.
  if (facts.saveStatus !== "saved") return { allowed: false, reason: "dirty" };
  if (!facts.documentValid) return { allowed: false, reason: "document_invalid" };
  const capability = state.capability;
  if (capability === null || (!capability.available && capability.reason !== "render_busy")) {
    return { allowed: false, reason: "renderer_unavailable" };
  }
  if (!capability.available) return { allowed: false, reason: "render_busy" };
  if (state.mutation !== null) return { allowed: false, reason: "mutation_in_progress" };
  return { allowed: true };
}

export function canCancel(job: RenderJob): boolean {
  // One cancel per job: the request is recorded before the renderer confirms.
  return isActive(job) && !job.cancel_requested_at;
}

export function canRetry(job: RenderJob): boolean {
  return job.status === "failed" || job.status === "cancelled";
}

export function canDownload(job: RenderJob): boolean {
  return job.status === "completed" && !!job.output && !job.artifacts_cleaned_at;
}

export function canCleanup(job: RenderJob): boolean {
  return !isActive(job) && !job.artifacts_cleaned_at;
}

export function renderJobReducer(
  state: RenderJobState,
  action: RenderJobAction,
): RenderJobState {
  switch (action.type) {
    case "load_started":
      return { ...state, generation: state.generation + 1, lastError: null };
    case "loaded":
      if (action.generation !== state.generation) return state;
      return {
        ...state,
        capability: action.capability,
        history: bounded(action.jobs),
        lastError: null,
      };
    case "load_failed":
      return action.generation === state.generation
        ? { ...state, lastError: asRenderErrorCode(action.code) }
        : state;
    case "job_selected":
      return { ...state, selectedJobId: action.renderJobId };
    case "job_refreshed":
      return action.generation === state.generation
        ? { ...state, history: recordJob(state.history, action.job) }
        : state;
    case "mutation_started": {
      // A second press replays the attempt already in flight: the original key
      // stays, so the control plane keeps answering the same request.
      if (state.mutation !== null) return state;
      const attemptKey = action.attemptKey?.trim() || null;
      // An attempt that cannot be replayed under its own key never starts.
      if (isAttempt(action.mutation) && attemptKey === null) return state;
      return { ...state, mutation: action.mutation, attemptKey, lastError: null };
    }
    case "mutation_succeeded":
      if (action.generation !== state.generation) return state;
      return {
        ...state,
        mutation: null,
        attemptKey: null,
        history: action.job ? recordJob(state.history, action.job) : state.history,
        selectedJobId: action.job?.render_job_id ?? state.selectedJobId,
        lastError: null,
      };
    case "mutation_failed":
      if (action.generation !== state.generation) return state;
      return {
        ...state,
        mutation: null,
        attemptKey: null,
        lastError: asRenderErrorCode(action.code),
      };
    case "went_offline": {
      // Whatever is in flight may or may not have reached the server, so the
      // generation moves and every pending callback is answered by nobody.
      const ambiguous = state.mutation !== null && isAttempt(state.mutation);
      return {
        ...state,
        isOffline: true,
        generation: state.generation + 1,
        // A create or retry keeps its attempt whole, so recovery replays the
        // very same key instead of minting a second one.
        mutation: ambiguous ? state.mutation : null,
        attemptKey: ambiguous ? state.attemptKey : null,
      };
    }
    case "went_online":
      return { ...state, isOffline: false };
    default:
      return state;
  }
}
