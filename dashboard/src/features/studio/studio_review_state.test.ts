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
    append: false,
  });
  state = reviewReducer(state, {
    type: "comments_loaded",
    comments: [comment("c1", 2), comment("c2", 3)],
    nextCursor: null,
    append: true,
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
