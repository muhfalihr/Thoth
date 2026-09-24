import type {
  CreateComment,
  CreateDecision,
  ReviewComment,
  ReviewDecision,
  ReviewErrorCode,
} from "@/api/control-plane";

import type { EditorSaveStatus } from "./editor_state";

/** The longest comment or reason the control plane accepts. */
export const REVIEW_TEXT_LIMIT = 2_000;

export type ReviewDecisionKind = ReviewDecision["decision"];

/** One review write, kept whole so Retry replays the same idempotency key. */
export type ReviewSubmission =
  | { kind: "comment"; request: CreateComment }
  | { kind: "decision"; request: CreateDecision };

export type ReviewState = {
  /** Oldest first, as the control plane pages them. */
  comments: ReviewComment[];
  /** Newest first, so the head is the latest decision. */
  decisions: ReviewDecision[];
  commentCursor: string | null;
  decisionCursor: string | null;
  loadStatus: "loading" | "loaded" | "failed";
  /** Unsent text survives every failure; only the server's answer clears it. */
  commentText: string;
  pinToFrame: boolean;
  reason: string;
  confirming: ReviewDecisionKind | null;
  pending: ReviewSubmission | null;
  /** The write a transport failure interrupted; Retry sends it unchanged. */
  retryable: ReviewSubmission | null;
  /** The newer saved revision a stale write reported. */
  staleRevision: number | null;
  /** A fixed code only; no server message ever lands here. */
  error: ReviewErrorCode | null;
  /** The last settled outcome, announced once. */
  notice: string | null;
};

export type ReviewAction =
  | { type: "reset" }
  | { type: "comments_loaded"; comments: ReviewComment[]; nextCursor: string | null }
  | { type: "decisions_loaded"; decisions: ReviewDecision[]; nextCursor: string | null }
  | { type: "load_failed" }
  | { type: "comment_edited"; text: string }
  | { type: "pin_toggled"; pinned: boolean }
  | { type: "reason_edited"; reason: string }
  | { type: "decision_confirming"; decision: ReviewDecisionKind | null }
  | { type: "submitted"; submission: ReviewSubmission }
  | { type: "comment_created"; comment: ReviewComment }
  | { type: "decision_created"; decision: ReviewDecision }
  | { type: "submit_failed"; code: ReviewErrorCode; latestRevision: number | null };

/** What the editor tells the review surface, and nothing of its draft. */
export type ReviewFacts = {
  savedRevision: number;
  saveStatus: EditorSaveStatus;
  isOffline: boolean;
  blockingIssues: number;
};

export type ReviewGate = {
  canComment: boolean;
  canApprove: boolean;
  blockedReason: string | null;
  approveBlockedReason: string | null;
};

export function createReviewState(): ReviewState {
  return {
    comments: [],
    decisions: [],
    commentCursor: null,
    decisionCursor: null,
    loadStatus: "loading",
    commentText: "",
    pinToFrame: true,
    reason: "",
    confirming: null,
    pending: null,
    retryable: null,
    staleRevision: null,
    error: null,
    notice: null,
  };
}

/** The reason a decision sends: blank text means no reason. */
export const reasonPayload = (reason: string): string | null => (reason.trim() ? reason : null);

// History is append-only, so a page never removes a record: it is a union with
// what is already held, re-sorted into the control plane's (created_at, id) order.
// ponytail: Date.parse keeps milliseconds; two events in one millisecond fall back
// to id order, where the server would compare microseconds first.
function merge<T extends { created_at: string }>(
  current: T[],
  page: T[],
  key: (item: T) => string,
  newestFirst = false,
): T[] {
  const byKey = new Map(current.map((item) => [key(item), item]));
  for (const item of page) if (!byKey.has(key(item))) byKey.set(key(item), item);
  const order = (a: T, b: T) =>
    Date.parse(a.created_at) - Date.parse(b.created_at) || (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
  return [...byKey.values()].sort((a, b) => (newestFirst ? order(b, a) : order(a, b)));
}

/** Whether the displayed draft is still exactly what this submission sent. */
function draftMatches(state: ReviewState, submission: ReviewSubmission | null): boolean {
  if (submission?.kind === "comment") {
    const { text, frame } = submission.request;
    return state.commentText === text && state.pinToFrame === (frame !== null && frame !== undefined);
  }
  if (submission?.kind === "decision") return reasonPayload(state.reason) === (submission.request.reason ?? null);
  return false;
}

const RETRYABLE: readonly ReviewErrorCode[] = ["review_request_failed", "review_unavailable"];

export function reviewReducer(state: ReviewState, action: ReviewAction): ReviewState {
  switch (action.type) {
    case "reset":
      return createReviewState();
    case "comments_loaded":
      return {
        ...state,
        comments: merge(state.comments, action.comments, (item) => item.comment_id),
        commentCursor: action.nextCursor,
        loadStatus: "loaded",
      };
    case "decisions_loaded":
      return {
        ...state,
        decisions: merge(state.decisions, action.decisions, (item) => item.decision_id, true),
        decisionCursor: action.nextCursor,
        loadStatus: "loaded",
      };
    case "load_failed":
      return { ...state, loadStatus: "failed" };
    case "comment_edited":
      return {
        ...state,
        commentText: action.text,
        retryable: state.retryable?.kind === "comment" ? null : state.retryable,
      };
    case "pin_toggled":
      return {
        ...state,
        pinToFrame: action.pinned,
        retryable: state.retryable?.kind === "comment" ? null : state.retryable,
      };
    case "reason_edited":
      return {
        ...state,
        reason: action.reason,
        retryable: state.retryable?.kind === "decision" ? null : state.retryable,
      };
    case "decision_confirming":
      return { ...state, confirming: action.decision };
    case "submitted":
      return {
        ...state,
        pending: action.submission,
        retryable: null,
        staleRevision: null,
        error: null,
        notice: null,
      };
    case "comment_created":
      return {
        ...state,
        comments: merge(state.comments, [action.comment], (item) => item.comment_id),
        commentText: draftMatches(state, state.pending) ? "" : state.commentText,
        pending: null,
        notice: "Comment posted.",
      };
    case "decision_created":
      return {
        ...state,
        decisions: merge(state.decisions, [action.decision], (item) => item.decision_id, true),
        reason: draftMatches(state, state.pending) ? "" : state.reason,
        confirming: null,
        pending: null,
        notice: `${action.decision.decision === "approved" ? "Approval" : "Change request"} recorded for revision ${action.decision.document_revision}.`,
      };
    case "submit_failed": {
      const failed = { ...state, pending: null, confirming: null };
      if (action.code === "review_revision_conflict" && action.latestRevision !== null) {
        return { ...failed, staleRevision: action.latestRevision };
      }
      if (RETRYABLE.includes(action.code)) {
        // Retry replays the original key only while the draft on screen is what it sent.
        return { ...failed, retryable: draftMatches(state, state.pending) ? state.pending : null, error: action.code };
      }
      return { ...failed, error: action.code };
    }
  }
}

/** Every disabled reason derives from the saved document and the editor, never the draft. */
export function reviewGate(state: ReviewState, facts: ReviewFacts): ReviewGate {
  let blockedReason: string | null = null;
  if (facts.isOffline) blockedReason = "Review is unavailable while offline. Your text is kept.";
  else if (facts.saveStatus === "conflict") blockedReason = "Resolve the save conflict before reviewing.";
  else if (facts.saveStatus !== "saved") blockedReason = "Wait for your changes to save before reviewing.";
  else if (state.staleRevision !== null && facts.savedRevision < state.staleRevision) {
    blockedReason = `Load revision ${state.staleRevision} before reviewing again.`;
  } else if (state.pending) blockedReason = "Waiting for the last review action to finish.";
  const canComment = blockedReason === null;
  const approveBlockedReason =
    canComment && facts.blockingIssues > 0
      ? `Fix ${facts.blockingIssues} blocking issue${facts.blockingIssues === 1 ? "" : "s"} in the saved revision before approving.`
      : null;
  return { canComment, canApprove: canComment && facts.blockingIssues === 0, blockedReason, approveBlockedReason };
}

/** The latest decision is the current one only while it belongs to the saved revision. */
export function currentDecision(decisions: ReviewDecision[], savedRevision: number): ReviewDecision | null {
  const latest = decisions[0];
  return latest && latest.document_revision === savedRevision ? latest : null;
}

export function formatTimecode(frame: number, fps: number): string {
  const seconds = Math.floor(frame / fps);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${Math.floor(seconds / 60)}:${pad(seconds % 60)}:${pad(frame % fps)}`;
}
