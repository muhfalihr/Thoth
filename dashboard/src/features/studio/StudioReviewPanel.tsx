import { useCallback, useEffect, useId, useReducer, useRef } from "react";

import {
  StudioReviewRequestError,
  type ControlPlaneClient,
  type EditDocument,
  type ReviewErrorCode,
} from "@/api/control-plane";
import type { EditorSaveStatus } from "./editor_state";
import {
  REVIEW_TEXT_LIMIT,
  createReviewState,
  currentDecision,
  formatTimecode,
  reviewGate,
  reviewReducer,
  type ReviewAction,
  type ReviewDecisionKind,
  type ReviewSubmission,
} from "./studio_review_state";

export type StudioReviewClient = Pick<
  ControlPlaneClient,
  | "listStudioReviewComments"
  | "createStudioReviewComment"
  | "listStudioReviewDecisions"
  | "createStudioReviewDecision"
>;

type Props = {
  client: StudioReviewClient;
  projectId: string;
  documentId: string;
  /** The saved revision every comment and decision binds to; never the draft. */
  savedDocument: EditDocument;
  saveStatus: EditorSaveStatus;
  isOffline: boolean;
  blockingIssues: number;
  /** The shared preview's playhead, offered as a comment anchor. */
  currentFrame: number;
  /** Asks the editor to bring a newer saved revision in, through its own conflict choice. */
  onLoadRevision?: (revision: number) => void;
};

const actionButton =
  "rounded-md border border-border px-3 py-1.5 text-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40";
const field =
  "w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const DECISION_LABEL: Record<ReviewDecisionKind, string> = {
  approved: "Approved",
  changes_requested: "Changes requested",
};

const ERROR_TEXT: Record<ReviewErrorCode, string> = {
  review_revision_conflict: "A newer saved revision exists. Your text is kept.",
  review_document_not_found: "This document is no longer available for review.",
  idempotency_conflict: "That action clashed with an earlier one. Your text is kept; send it again.",
  review_frame_out_of_range: "The pinned frame is outside the saved revision. Unpin it or pick another frame.",
  review_not_eligible: "The saved revision has blocking issues, so it cannot be approved.",
  invalid_review_page: "Could not load more review history.",
  review_unavailable: "Review is unavailable right now. Your text is kept.",
  review_request_failed: "Could not reach Studio. Your text is kept.",
};

const makeOperationId = () => `op_${crypto.randomUUID()}`;

export function StudioReviewPanel({
  client,
  projectId,
  documentId,
  savedDocument,
  saveStatus,
  isOffline,
  blockingIssues,
  currentFrame,
  onLoadRevision,
}: Props) {
  const [state, dispatch] = useReducer(reviewReducer, undefined, createReviewState);
  const savedRevision = savedDocument.revision;
  const gate = reviewGate(state, { savedRevision, saveStatus, isOffline, blockingIssues });
  const current = currentDecision(state.decisions, savedRevision);
  const timecode = formatTimecode(currentFrame, savedDocument.canvas.fps);
  const staleActive = state.staleRevision !== null && savedRevision < state.staleRevision;
  const commentId = useId();
  const reasonId = useId();
  const confirmTitleId = useId();
  const approveRef = useRef<HTMLButtonElement>(null);
  const requestRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  /** Bumped when the project or document changes, and on unmount, so a late answer is dropped. */
  const generation = useRef(0);

  const loadComments = useCallback(
    (cursor?: string) => {
      const requestGeneration = generation.current;
      void client
        .listStudioReviewComments(projectId, documentId, cursor ? { cursor } : undefined)
        .then((page) => {
          if (requestGeneration !== generation.current) return;
          if (!Array.isArray(page.comments)) throw new Error("malformed review page");
          dispatch({ type: "comments_loaded", comments: page.comments, nextCursor: page.next_cursor ?? null, append: Boolean(cursor) });
        })
        .catch(() => {
          if (requestGeneration === generation.current) dispatch({ type: "load_failed" });
        });
    },
    [client, documentId, projectId],
  );
  const loadDecisions = useCallback(
    (cursor?: string) => {
      const requestGeneration = generation.current;
      void client
        .listStudioReviewDecisions(projectId, documentId, cursor ? { cursor } : undefined)
        .then((page) => {
          if (requestGeneration !== generation.current) return;
          if (!Array.isArray(page.decisions)) throw new Error("malformed review page");
          dispatch({ type: "decisions_loaded", decisions: page.decisions, nextCursor: page.next_cursor ?? null, append: Boolean(cursor) });
        })
        .catch(() => {
          if (requestGeneration === generation.current) dispatch({ type: "load_failed" });
        });
    },
    [client, documentId, projectId],
  );

  useEffect(() => {
    dispatch({ type: "reset" });
    loadComments();
    loadDecisions();
    return () => {
      generation.current += 1;
    };
  }, [loadComments, loadDecisions]);

  useEffect(() => {
    if (state.confirming) confirmRef.current?.focus();
  }, [state.confirming]);

  const submit = (submission: ReviewSubmission) => {
    const requestGeneration = generation.current;
    dispatch({ type: "submitted", submission });
    const request: Promise<ReviewAction> =
      submission.kind === "comment"
        ? client
            .createStudioReviewComment(projectId, documentId, submission.request)
            .then((comment) => ({ type: "comment_created", comment }))
        : client
            .createStudioReviewDecision(projectId, documentId, submission.request)
            .then((decision) => ({ type: "decision_created", decision }));
    void request
      .then((action) => {
        if (requestGeneration === generation.current) dispatch(action);
      })
      .catch((error: unknown) => {
        if (requestGeneration !== generation.current) return;
        const typed = error instanceof StudioReviewRequestError;
        dispatch({
          type: "submit_failed",
          code: typed ? error.code : "review_request_failed",
          latestRevision: typed ? error.latestRevision : null,
        });
      });
  };

  const postComment = () => {
    if (!gate.canComment || !state.commentText.trim()) return;
    submit({
      kind: "comment",
      request: {
        base_revision: savedRevision,
        operation_id: makeOperationId(),
        text: state.commentText,
        frame: state.pinToFrame ? currentFrame : null,
      },
    });
  };

  const decide = (decision: ReviewDecisionKind) => {
    if (decision === "approved" ? !gate.canApprove : !gate.canComment) return;
    submit({
      kind: "decision",
      request: {
        base_revision: savedRevision,
        operation_id: makeOperationId(),
        decision,
        reason: state.reason.trim() ? state.reason : null,
      },
    });
  };

  const cancelConfirmation = () => {
    const trigger = state.confirming === "approved" ? approveRef : requestRef;
    dispatch({ type: "decision_confirming", decision: null });
    trigger.current?.focus();
  };

  const actorName = (actor: { actor_id: string; display_name?: string | null }) => actor.display_name ?? actor.actor_id;
  const when = (createdAt: string) => new Date(createdAt).toLocaleString();

  return (
    <section className="flex flex-col gap-3 rounded-md border border-border bg-card p-3" aria-label="Review">
      <p className="text-sm">Review applies to saved revision {savedRevision}.</p>
      <p className="text-sm font-medium">
        {current
          ? `Current decision: ${DECISION_LABEL[current.decision]} on revision ${current.document_revision}`
          : `No decision on revision ${savedRevision} yet.`}
      </p>

      <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
        {state.pending
          ? state.pending.kind === "comment"
            ? "Posting comment…"
            : "Recording decision…"
          : state.notice}
      </p>
      {gate.blockedReason && !staleActive ? (
        <p className="text-xs text-muted-foreground">{gate.blockedReason}</p>
      ) : null}
      {state.staleRevision !== null ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 rounded-md border border-primary/40 bg-primary/10 p-2 text-sm">
          {staleActive ? (
            <>
              <p>Revision {state.staleRevision} is now the latest saved revision. Your text is kept; load it, review it, then send again.</p>
              {onLoadRevision ? (
                <button type="button" className={actionButton} onClick={() => onLoadRevision(state.staleRevision!)}>
                  Load revision {state.staleRevision}
                </button>
              ) : null}
            </>
          ) : (
            <p>Revision {savedRevision} is loaded. Review it, then send again.</p>
          )}
        </div>
      ) : null}
      {state.error ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-2 text-sm">
          <p>{ERROR_TEXT[state.error]}</p>
          {state.retryable ? (
            <button
              type="button"
              className={actionButton}
              disabled={!gate.canComment}
              onClick={() => state.retryable && submit(state.retryable)}
            >
              Retry
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        <label htmlFor={commentId} className="text-sm font-medium">
          Review comment
        </label>
        <textarea
          id={commentId}
          className={field}
          rows={3}
          maxLength={REVIEW_TEXT_LIMIT}
          value={state.commentText}
          onChange={(event) => dispatch({ type: "comment_edited", text: event.target.value })}
        />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="h-4 w-4 accent-primary"
            checked={state.pinToFrame}
            onChange={(event) => dispatch({ type: "pin_toggled", pinned: event.target.checked })}
          />
          Pin to current frame {timecode}
        </label>
        <button
          type="button"
          className={`${actionButton} self-start`}
          disabled={!gate.canComment || !state.commentText.trim()}
          onClick={postComment}
        >
          Post comment
        </button>
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor={reasonId} className="text-sm font-medium">
          Decision reason (optional)
        </label>
        <textarea
          id={reasonId}
          className={field}
          rows={2}
          maxLength={REVIEW_TEXT_LIMIT}
          value={state.reason}
          onChange={(event) => dispatch({ type: "reason_edited", reason: event.target.value })}
        />
        <div className="flex flex-wrap gap-2">
          <button
            ref={approveRef}
            type="button"
            className={actionButton}
            disabled={!gate.canApprove}
            onClick={() => dispatch({ type: "decision_confirming", decision: "approved" })}
          >
            Approve
          </button>
          <button
            ref={requestRef}
            type="button"
            className={actionButton}
            disabled={!gate.canComment}
            onClick={() => dispatch({ type: "decision_confirming", decision: "changes_requested" })}
          >
            Request changes
          </button>
        </div>
        {gate.approveBlockedReason ? (
          <p className="text-xs text-muted-foreground">{gate.approveBlockedReason}</p>
        ) : null}
        {state.confirming ? (
          <div role="group" aria-labelledby={confirmTitleId} className="flex flex-col gap-2 rounded-md border border-border p-3 text-sm">
            <p id={confirmTitleId} className="font-medium">
              {state.confirming === "approved"
                ? `Approve saved revision ${savedRevision}?`
                : `Request changes on saved revision ${savedRevision}?`}
            </p>
            <p className="text-xs text-muted-foreground">
              This is an editorial decision only; it does not start a render or publish anything.
            </p>
            <div className="flex gap-2">
              <button
                ref={confirmRef}
                type="button"
                className={actionButton}
                disabled={state.confirming === "approved" ? !gate.canApprove : !gate.canComment}
                onClick={() => state.confirming && decide(state.confirming)}
              >
                {state.confirming === "approved" ? "Confirm approval" : "Confirm change request"}
              </button>
              <button type="button" className={actionButton} onClick={cancelConfirmation}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {state.loadStatus === "failed" ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm">
          <p>Could not load review history.</p>
          <button
            type="button"
            className={actionButton}
            onClick={() => {
              loadComments();
              loadDecisions();
            }}
          >
            Reload review
          </button>
        </div>
      ) : null}

      <ol className="flex flex-col gap-2" aria-label="Review comments">
        {state.comments.map((comment) => (
          <li key={comment.comment_id} className="rounded-md border border-border p-2 text-sm">
            <p className="whitespace-pre-wrap break-words">{comment.text}</p>
            <p className="text-xs text-muted-foreground">
              {actorName(comment.actor)} · {when(comment.created_at)} ·{" "}
              {comment.document_revision === savedRevision
                ? `Revision ${comment.document_revision}`
                : `Earlier revision ${comment.document_revision}`}{" "}
              · {comment.frame == null ? "Whole video" : `at ${formatTimecode(comment.frame, savedDocument.canvas.fps)}`}
            </p>
          </li>
        ))}
      </ol>
      {state.commentCursor ? (
        <button type="button" className={`${actionButton} self-start`} onClick={() => loadComments(state.commentCursor!)}>
          Show more comments
        </button>
      ) : null}

      <ol className="flex flex-col gap-1" aria-label="Decision history">
        {state.decisions.map((decision) => (
          <li key={decision.decision_id} className="text-xs text-muted-foreground">
            {`${DECISION_LABEL[decision.decision]} on revision ${decision.document_revision}`} · {actorName(decision.actor)} ·{" "}
            {when(decision.created_at)}
            {decision.reason ? <span className="block whitespace-pre-wrap break-words">{decision.reason}</span> : null}
          </li>
        ))}
      </ol>
      {state.decisionCursor ? (
        <button type="button" className={`${actionButton} self-start`} onClick={() => loadDecisions(state.decisionCursor!)}>
          Show older decisions
        </button>
      ) : null}
    </section>
  );
}
