/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import type { ReviewComment, ReviewDecision } from "@/api/control-plane";
import {
  createReviewState,
  currentDecision,
  formatTimecode,
  reviewGate,
  reviewReducer,
  type ReviewFacts,
  type ReviewState,
  type ReviewSubmission,
} from "./studio_review_state";

const actor = { actor_id: "owner", actor_type: "user", display_name: null } as const;

function comment(id: string, revision: number): ReviewComment {
  return {
    comment_id: id,
    project_id: "project_001",
    document_id: "document_001",
    document_revision: revision,
    actor,
    text: `Comment ${id}`,
    frame: null,
    created_at: "2026-09-24T09:00:00Z",
  };
}

function decision(id: string, revision: number, kind: ReviewDecision["decision"] = "approved"): ReviewDecision {
  return {
    decision_id: id,
    project_id: "project_001",
    document_id: "document_001",
    document_revision: revision,
    actor,
    decision: kind,
    reason: null,
    created_at: "2026-09-24T09:00:00Z",
  };
}

const facts: ReviewFacts = { savedRevision: 3, saveStatus: "saved", isOffline: false, blockingIssues: 0 };
const commentSubmission: ReviewSubmission = {
  kind: "comment",
  request: { base_revision: 3, operation_id: "op_1", text: "Adjust opening", frame: 29 },
};

function withComment(text: string): ReviewState {
  return reviewReducer(createReviewState(), { type: "comment_edited", text });
}

test("a decision is current only while it belongs to the saved revision", () => {
  expect(currentDecision([decision("d2", 3), decision("d1", 2)], 3)?.decision_id).toBe("d2");
  expect(currentDecision([decision("d2", 3)], 4)).toBeNull();
  expect(currentDecision([], 3)).toBeNull();
});

test("pages merge by identity and keep their cursor", () => {
  let state = reviewReducer(createReviewState(), {
    type: "comments_loaded",
    comments: [comment("c1", 2)],
    nextCursor: "next",
  });
  state = reviewReducer(state, {
    type: "comments_loaded",
    comments: [comment("c1", 2), comment("c2", 3)],
    nextCursor: null,
  });
  expect(state.comments.map((item) => item.comment_id)).toEqual(["c1", "c2"]);
  expect(state.commentCursor).toBeNull();
  expect(state.loadStatus).toBe("loaded");
});

test("a created comment appears from the server response and clears only its own text", () => {
  let state = reviewReducer(withComment("Adjust opening"), { type: "reason_edited", reason: "Keep me" });
  state = reviewReducer(state, { type: "submitted", submission: commentSubmission });
  expect(state.pending).toEqual(commentSubmission);
  expect(state.comments).toEqual([]);

  state = reviewReducer(state, { type: "comment_created", comment: comment("c9", 3) });
  expect(state.comments.map((item) => item.comment_id)).toEqual(["c9"]);
  expect(state.commentText).toBe("");
  expect(state.reason).toBe("Keep me");
  expect(state.pending).toBeNull();
});

test("a created decision becomes newest and closes its confirmation", () => {
  let state = reviewReducer(createReviewState(), { type: "decision_confirming", decision: "approved" });
  state = reviewReducer(state, {
    type: "submitted",
    submission: { kind: "decision", request: { base_revision: 3, operation_id: "op_2", decision: "approved" } },
  });
  state = reviewReducer(state, { type: "decision_created", decision: decision("d3", 3) });
  expect(state.decisions[0]?.decision_id).toBe("d3");
  expect(state.confirming).toBeNull();
});

test("a stale write keeps the text and records the newer revision without retrying", () => {
  let state = reviewReducer(withComment("Adjust opening"), { type: "submitted", submission: commentSubmission });
  state = reviewReducer(state, { type: "submit_failed", code: "review_revision_conflict", latestRevision: 4 });
  expect(state.commentText).toBe("Adjust opening");
  expect(state.staleRevision).toBe(4);
  expect(state.retryable).toBeNull();
  expect(state.pending).toBeNull();
});

test("a transport failure keeps the text and offers the same request for Retry until the text changes", () => {
  let state = reviewReducer(withComment("Adjust opening"), { type: "submitted", submission: commentSubmission });
  state = reviewReducer(state, { type: "submit_failed", code: "review_request_failed", latestRevision: null });
  expect(state.commentText).toBe("Adjust opening");
  expect(state.retryable).toEqual(commentSubmission);

  state = reviewReducer(state, { type: "comment_edited", text: "Adjust the opening" });
  expect(state.retryable).toBeNull();
});

test("a fixed server refusal is reported by code alone", () => {
  let state = reviewReducer(withComment("Adjust opening"), { type: "submitted", submission: commentSubmission });
  state = reviewReducer(state, { type: "submit_failed", code: "review_frame_out_of_range", latestRevision: null });
  expect(state.error).toBe("review_frame_out_of_range");
  expect(state.retryable).toBeNull();
  expect(state.commentText).toBe("Adjust opening");
});

test("every gate derives from the saved document and the editor, never the draft", () => {
  const idle = createReviewState();
  expect(reviewGate(idle, facts)).toEqual({ canComment: true, canApprove: true, blockedReason: null, approveBlockedReason: null });

  expect(reviewGate(idle, { ...facts, isOffline: true }).canComment).toBe(false);
  expect(reviewGate(idle, { ...facts, saveStatus: "dirty" }).canComment).toBe(false);
  expect(reviewGate(idle, { ...facts, saveStatus: "conflict" }).blockedReason).toMatch(/save conflict/);

  const blocked = reviewGate(idle, { ...facts, blockingIssues: 2 });
  expect(blocked.canComment).toBe(true);
  expect(blocked.canApprove).toBe(false);
  expect(blocked.approveBlockedReason).toMatch(/2 blocking issues/);

  const pending = reviewReducer(idle, { type: "submitted", submission: commentSubmission });
  expect(reviewGate(pending, facts).canComment).toBe(false);
  expect(reviewGate(pending, facts).canApprove).toBe(false);
});

test("a stale write blocks review until Studio holds the newer saved revision", () => {
  const stale = reviewReducer(
    reviewReducer(withComment("Adjust opening"), { type: "submitted", submission: commentSubmission }),
    { type: "submit_failed", code: "review_revision_conflict", latestRevision: 4 },
  );
  expect(reviewGate(stale, facts).canComment).toBe(false);
  expect(reviewGate(stale, facts).blockedReason).toMatch(/revision 4/);
  expect(reviewGate(stale, { ...facts, savedRevision: 4 }).canComment).toBe(true);
});

test("a frame reads as minutes, seconds, and frames", () => {
  expect(formatTimecode(29, 30)).toBe("0:00:29");
  expect(formatTimecode(30 * 61 + 5, 30)).toBe("1:01:05");
});

const at = <T extends ReviewComment | ReviewDecision>(item: T, created_at: string): T => ({ ...item, created_at });
const decisionSubmission = (reason: string | null): ReviewSubmission => ({
  kind: "decision",
  request: { base_revision: 3, operation_id: "op_2", decision: "approved", reason },
});

test("a late first comment page keeps a comment posted after the load began, in contract order", () => {
  let state = reviewReducer(withComment("Adjust opening"), { type: "submitted", submission: commentSubmission });
  state = reviewReducer(state, { type: "comment_created", comment: at(comment("c9", 3), "2026-09-24T10:00:00Z") });
  state = reviewReducer(state, {
    type: "comments_loaded",
    comments: [at(comment("c1", 2), "2026-09-24T08:00:00Z")],
    nextCursor: "next",
  });
  expect(state.comments.map((item) => item.comment_id)).toEqual(["c1", "c9"]);

  state = reviewReducer(state, {
    type: "comments_loaded",
    comments: [at(comment("c2", 2), "2026-09-24T09:00:00Z"), at(comment("c9", 3), "2026-09-24T10:00:00Z")],
    nextCursor: null,
  });
  expect(state.comments.map((item) => item.comment_id)).toEqual(["c1", "c2", "c9"]);
  expect(state.commentCursor).toBeNull();
});

test("a late first decision page keeps a decision recorded after the load began, newest first", () => {
  let state = reviewReducer(createReviewState(), { type: "submitted", submission: decisionSubmission(null) });
  state = reviewReducer(state, { type: "decision_created", decision: at(decision("d9", 3), "2026-09-24T10:00:00Z") });
  state = reviewReducer(state, {
    type: "decisions_loaded",
    decisions: [at(decision("d1", 2), "2026-09-24T08:00:00Z")],
    nextCursor: "older",
  });
  expect(state.decisions.map((item) => item.decision_id)).toEqual(["d9", "d1"]);
  expect(currentDecision(state.decisions, 3)?.decision_id).toBe("d9");

  state = reviewReducer(state, {
    type: "decisions_loaded",
    decisions: [at(decision("d0", 1), "2026-09-24T07:00:00Z")],
    nextCursor: null,
  });
  expect(state.decisions.map((item) => item.decision_id)).toEqual(["d9", "d1", "d0"]);
});

test("a comment that lands keeps a newer draft typed while it was pending", () => {
  let state = reviewReducer(withComment("Adjust opening"), { type: "submitted", submission: commentSubmission });
  state = reviewReducer(state, { type: "comment_edited", text: "Also fix the ending" });
  state = reviewReducer(state, { type: "comment_created", comment: comment("c9", 3) });
  expect(state.commentText).toBe("Also fix the ending");
  expect(state.notice).toBe("Comment posted.");
});

test("a decision that lands keeps a newer reason typed while it was pending", () => {
  let state = reviewReducer(createReviewState(), { type: "reason_edited", reason: "Looks right" });
  state = reviewReducer(state, { type: "submitted", submission: decisionSubmission("Looks right") });
  state = reviewReducer(state, { type: "reason_edited", reason: "Looks right after the fix" });
  state = reviewReducer(state, { type: "decision_created", decision: decision("d9", 3) });
  expect(state.reason).toBe("Looks right after the fix");

  let cleared = reviewReducer(createReviewState(), { type: "reason_edited", reason: "Looks right" });
  cleared = reviewReducer(cleared, { type: "submitted", submission: decisionSubmission("Looks right") });
  cleared = reviewReducer(cleared, { type: "decision_created", decision: decision("d9", 3) });
  expect(cleared.reason).toBe("");
});

test("a transport failure offers no Retry once the comment draft changed while pending", () => {
  let state = reviewReducer(withComment("Adjust opening"), { type: "submitted", submission: commentSubmission });
  state = reviewReducer(state, { type: "comment_edited", text: "Adjust the opening" });
  state = reviewReducer(state, { type: "submit_failed", code: "review_request_failed", latestRevision: null });
  expect(state.retryable).toBeNull();
  expect(state.commentText).toBe("Adjust the opening");
  expect(state.error).toBe("review_request_failed");

  let unpinned = reviewReducer(withComment("Adjust opening"), { type: "submitted", submission: commentSubmission });
  unpinned = reviewReducer(unpinned, { type: "pin_toggled", pinned: false });
  unpinned = reviewReducer(unpinned, { type: "submit_failed", code: "review_unavailable", latestRevision: null });
  expect(unpinned.retryable).toBeNull();

  let unchanged = reviewReducer(withComment("Adjust opening"), { type: "submitted", submission: commentSubmission });
  unchanged = reviewReducer(unchanged, { type: "submit_failed", code: "review_unavailable", latestRevision: null });
  expect(unchanged.retryable).toEqual(commentSubmission);
  expect(reviewReducer(unchanged, { type: "pin_toggled", pinned: false }).retryable).toBeNull();
});

test("a transport failure offers no Retry once the decision reason changed while pending", () => {
  let state = reviewReducer(createReviewState(), { type: "reason_edited", reason: "Looks right" });
  state = reviewReducer(state, { type: "submitted", submission: decisionSubmission("Looks right") });
  state = reviewReducer(state, { type: "reason_edited", reason: "" });
  state = reviewReducer(state, { type: "submit_failed", code: "review_request_failed", latestRevision: null });
  expect(state.retryable).toBeNull();

  let unchanged = reviewReducer(createReviewState(), { type: "reason_edited", reason: "Looks right" });
  unchanged = reviewReducer(unchanged, { type: "submitted", submission: decisionSubmission("Looks right") });
  unchanged = reviewReducer(unchanged, { type: "submit_failed", code: "review_request_failed", latestRevision: null });
  expect(unchanged.retryable).toEqual(decisionSubmission("Looks right"));
});
