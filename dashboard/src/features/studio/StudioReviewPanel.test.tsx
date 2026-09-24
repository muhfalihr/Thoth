/// <reference types="bun-types" />

import { afterEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";

import {
  StudioReviewRequestError,
  type CreateComment,
  type CreateDecision,
  type EditDocument,
  type ReviewComment,
  type ReviewDecision,
} from "@/api/control-plane";
import { StudioReviewPanel, type StudioReviewClient } from "./StudioReviewPanel";

const actor = { actor_id: "owner", actor_type: "user", display_name: "Owner" } as const;

function savedDocument(revision: number): EditDocument {
  return {
    schema_version: 1,
    document_id: "document_001",
    project_id: "project_001",
    revision,
    canvas: { width: 1080, height: 1920, fps: 30, duration_in_frames: 150 },
    template: { template_id: "vertical_text_story", version: 1 },
    tracks: [{ track_id: "track_visual", kind: "visual", clip_ids: [] }],
    scenes: [],
    clips: [],
  };
}

function comment(id: string, revision: number, overrides: Partial<ReviewComment> = {}): ReviewComment {
  return {
    comment_id: id,
    project_id: "project_001",
    document_id: "document_001",
    document_revision: revision,
    actor,
    text: `Comment ${id}`,
    frame: null,
    created_at: "2026-09-24T09:00:00Z",
    ...overrides,
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function makeClient(seed: { comments?: ReviewComment[]; decisions?: ReviewDecision[] } = {}) {
  return {
    listStudioReviewComments: mock(async (_projectId: string, _documentId: string) => ({
      comments: seed.comments ?? [],
      next_cursor: null,
    })),
    listStudioReviewDecisions: mock(async (_projectId: string, _documentId: string) => ({
      decisions: seed.decisions ?? [],
      next_cursor: null,
    })),
    createStudioReviewComment: mock(async (_projectId: string, _documentId: string, request: CreateComment) =>
      comment("c_new", request.base_revision, { text: request.text, frame: request.frame ?? null }),
    ),
    createStudioReviewDecision: mock(async (_projectId: string, _documentId: string, request: CreateDecision) =>
      decision("d_new", request.base_revision, request.decision),
    ),
  } satisfies StudioReviewClient;
}

type PanelProps = ComponentProps<typeof StudioReviewPanel>;

function props(client: StudioReviewClient, overrides: Partial<PanelProps> = {}): PanelProps {
  return {
    client,
    projectId: "project_001",
    documentId: "document_001",
    savedDocument: savedDocument(3),
    saveStatus: "saved",
    isOffline: false,
    blockingIssues: 0,
    currentFrame: 29,
    ...overrides,
  };
}

async function renderPanel(client: StudioReviewClient, overrides: Partial<PanelProps> = {}) {
  const view = render(<StudioReviewPanel {...props(client, overrides)} />);
  await waitFor(() => expect(client.listStudioReviewDecisions).toHaveBeenCalled());
  await act(async () => {});
  return view;
}

const button = (name: string | RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;
const typeComment = (text: string) =>
  fireEvent.change(screen.getByLabelText("Review comment"), { target: { value: text } });
const commentValue = () => (screen.getByLabelText("Review comment") as HTMLTextAreaElement).value;

afterEach(cleanup);

test("posts a comment at the preview's current frame against the saved revision", async () => {
  const client = makeClient();
  await renderPanel(client);
  expect(screen.getByText("Review applies to saved revision 3.")).toBeDefined();

  typeComment("Adjust opening");
  fireEvent.click(button("Post comment"));
  expect(client.createStudioReviewComment).toHaveBeenCalledWith(
    "project_001",
    "document_001",
    expect.objectContaining({ base_revision: 3, text: "Adjust opening", frame: 29 }),
  );
  expect(client.createStudioReviewComment.mock.calls[0]![2].operation_id.startsWith("op_")).toBe(true);
  await screen.findByText("Comment posted.");
  expect(screen.getByText("Adjust opening")).toBeDefined();
  expect(commentValue()).toBe("");
});

test("posts a document-level comment when the frame pin is cleared", async () => {
  const client = makeClient();
  await renderPanel(client);
  fireEvent.click(screen.getByLabelText("Pin to current frame 0:00:29"));
  typeComment("Whole video note");
  fireEvent.click(button("Post comment"));
  expect(client.createStudioReviewComment.mock.calls[0]![2].frame).toBeNull();
});

test("labels earlier-revision comments and treats only a same-revision decision as current", async () => {
  const client = makeClient({
    comments: [comment("c1", 2, { frame: 29 }), comment("c2", 3)],
    decisions: [decision("d1", 2)],
  });
  await renderPanel(client);
  expect(screen.getByText("Comment c1")).toBeDefined();
  expect(screen.getByText(/Earlier revision 2/)).toBeDefined();
  expect(screen.getByText(/at 0:00:29/)).toBeDefined();
  expect(screen.getByText("No decision on revision 3 yet.")).toBeDefined();
  expect(screen.getByText(/Approved on revision 2/)).toBeDefined();
});

test("shows the current decision for the saved revision", async () => {
  const client = makeClient({ decisions: [decision("d2", 3, "changes_requested")] });
  await renderPanel(client);
  expect(screen.getByText("Current decision: Changes requested on revision 3")).toBeDefined();
});

test("renders review text as plain text", async () => {
  const client = makeClient({ comments: [comment("c1", 3, { text: "<b>bold</b>" })] });
  const view = await renderPanel(client);
  expect(screen.getByText("<b>bold</b>")).toBeDefined();
  expect(view.container.querySelector("b") === null).toBe(true);
});

test.each([
  ["offline", { isOffline: true }, /unavailable while offline/],
  ["unsaved", { saveStatus: "dirty" as const }, /Wait for your changes to save/],
  ["conflict", { saveStatus: "conflict" as const }, /Resolve the save conflict/],
])("disables every review mutation while %s and says why", async (_name, overrides, reason) => {
  const client = makeClient();
  await renderPanel(client, overrides);
  typeComment("Keep this");
  expect(button("Post comment").disabled).toBe(true);
  expect(button("Approve").disabled).toBe(true);
  expect(button("Request changes").disabled).toBe(true);
  expect(screen.getByText(reason)).toBeDefined();
});

test("blocks approval, but not a change request, while the saved revision has blocking issues", async () => {
  const client = makeClient();
  await renderPanel(client, { blockingIssues: 2 });
  expect(button("Approve").disabled).toBe(true);
  expect(button("Request changes").disabled).toBe(false);
  expect(screen.getByText(/Fix 2 blocking issues/)).toBeDefined();
});

test("confirms the target revision before deciding and reports success from the server", async () => {
  const client = makeClient();
  const pending = deferred<ReviewDecision>();
  client.createStudioReviewDecision.mockImplementationOnce(() => pending.promise);
  await renderPanel(client);

  const approve = button("Approve");
  approve.focus();
  fireEvent.click(approve);
  expect(screen.getByText("Approve saved revision 3?")).toBeDefined();
  expect(document.activeElement === button("Confirm approval")).toBe(true);
  fireEvent.click(button("Cancel"));
  expect(document.activeElement === button("Approve")).toBe(true);
  expect(client.createStudioReviewDecision).not.toHaveBeenCalled();

  fireEvent.click(button("Approve"));
  fireEvent.click(button("Confirm approval"));
  expect(client.createStudioReviewDecision.mock.calls[0]![2]).toMatchObject({ base_revision: 3, decision: "approved" });
  expect(screen.queryByText(/Current decision/) === null).toBe(true);
  expect(button("Post comment").disabled).toBe(true);

  await act(async () => pending.resolve(decision("d9", 3)));
  expect(screen.getByText("Current decision: Approved on revision 3")).toBeDefined();
  expect(screen.getByRole("status").textContent).toContain("Approval recorded for revision 3.");
});

test("sends the change-request reason as plain text", async () => {
  const client = makeClient();
  await renderPanel(client);
  fireEvent.change(screen.getByLabelText("Decision reason (optional)"), { target: { value: "Tighten the hook" } });
  fireEvent.click(button("Request changes"));
  expect(screen.getByText("Request changes on saved revision 3?")).toBeDefined();
  fireEvent.click(button("Confirm change request"));
  expect(client.createStudioReviewDecision.mock.calls[0]![2]).toMatchObject({
    decision: "changes_requested",
    reason: "Tighten the hook",
  });
});

test("keeps the text after a stale write and resubmits only by hand once the newer revision is loaded", async () => {
  const client = makeClient();
  client.createStudioReviewComment.mockImplementationOnce(async () => {
    throw new StudioReviewRequestError("review_revision_conflict", 4);
  });
  const onLoadRevision = mock((_revision: number) => {});
  const view = await renderPanel(client, { onLoadRevision });

  typeComment("Adjust opening");
  fireEvent.click(button("Post comment"));
  await screen.findByText(/Revision 4 is now the latest saved revision/);
  expect(commentValue()).toBe("Adjust opening");
  expect(button("Post comment").disabled).toBe(true);

  fireEvent.click(button("Load revision 4"));
  expect(onLoadRevision).toHaveBeenCalledWith(4);
  await act(async () => {});
  expect(client.createStudioReviewComment).toHaveBeenCalledTimes(1);

  view.rerender(<StudioReviewPanel {...props(client, { onLoadRevision, savedDocument: savedDocument(4) })} />);
  expect(commentValue()).toBe("Adjust opening");
  fireEvent.click(button("Post comment"));
  expect(client.createStudioReviewComment).toHaveBeenCalledTimes(2);
  const [first, second] = client.createStudioReviewComment.mock.calls.map((call) => call[2]);
  expect(second!.base_revision).toBe(4);
  expect(second!.operation_id === first!.operation_id).toBe(false);
});

test("keeps the text after a network failure and retries the same request only on demand", async () => {
  const client = makeClient();
  client.createStudioReviewComment.mockImplementationOnce(async () => {
    throw new StudioReviewRequestError("review_request_failed");
  });
  await renderPanel(client);
  typeComment("Adjust opening");
  fireEvent.click(button("Post comment"));
  await screen.findByText(/Could not reach Studio/);
  expect(commentValue()).toBe("Adjust opening");
  await act(async () => {});
  expect(client.createStudioReviewComment).toHaveBeenCalledTimes(1);

  fireEvent.click(button("Retry"));
  await screen.findByText("Comment posted.");
  const [first, second] = client.createStudioReviewComment.mock.calls.map((call) => call[2]);
  expect(second).toEqual(first!);
});

test("drops a late list response after the document changes", async () => {
  const client = makeClient();
  const late = deferred<{ comments: ReviewComment[]; next_cursor: null }>();
  client.listStudioReviewComments.mockImplementationOnce(() => late.promise);
  const view = render(<StudioReviewPanel {...props(client)} />);
  view.rerender(<StudioReviewPanel {...props(client, { documentId: "document_002" })} />);
  await act(async () => {});

  await act(async () => late.resolve({ comments: [comment("c_old", 3)], next_cursor: null }));
  expect(screen.queryByText("Comment c_old") === null).toBe(true);
  expect(client.listStudioReviewComments.mock.calls.at(-1)![1]).toBe("document_002");
});

test("drops a late mutation response after the document changes", async () => {
  const client = makeClient();
  const late = deferred<ReviewComment>();
  client.createStudioReviewComment.mockImplementationOnce(() => late.promise);
  const view = await renderPanel(client);
  typeComment("Adjust opening");
  fireEvent.click(button("Post comment"));

  view.rerender(<StudioReviewPanel {...props(client, { documentId: "document_002" })} />);
  await act(async () => {});
  await act(async () => late.resolve(comment("c_late", 3, { text: "Adjust opening" })));
  expect(screen.queryByText("Comment posted.") === null).toBe(true);
  expect(screen.queryByText("Adjust opening") === null).toBe(true);
});

test("labels every control for keyboard use", async () => {
  const client = makeClient();
  await renderPanel(client);
  expect(screen.getByRole("region", { name: "Review" })).toBeDefined();
  expect(screen.getByLabelText("Review comment").tagName).toBe("TEXTAREA");
  expect(screen.getByLabelText("Pin to current frame 0:00:29").getAttribute("type")).toBe("checkbox");
  expect(screen.getByRole("status")).toBeDefined();
});

test("reads a malformed history page as a load failure instead of crashing Studio", async () => {
  const client = makeClient();
  client.listStudioReviewDecisions.mockImplementationOnce(async () => ({}) as never);
  client.listStudioReviewComments.mockImplementationOnce(async () => ({}) as never);
  await renderPanel(client);
  expect(screen.getByText("Could not load review history.")).toBeDefined();
  expect(screen.getByText("No decision on revision 3 yet.")).toBeDefined();
});

function withLateHistory() {
  const client = makeClient();
  const comments = deferred<{ comments: ReviewComment[]; next_cursor: null }>();
  const decisions = deferred<{ decisions: ReviewDecision[]; next_cursor: null }>();
  client.listStudioReviewComments.mockImplementationOnce(() => comments.promise);
  client.listStudioReviewDecisions.mockImplementationOnce(() => decisions.promise);
  return { client, comments, decisions };
}

test("a late history load keeps the comment and decision that landed after it began", async () => {
  const { client, comments, decisions } = withLateHistory();
  client.createStudioReviewComment.mockImplementationOnce(async (_p, _d, request) =>
    comment("c_new", request.base_revision, { text: request.text, created_at: "2026-09-24T10:00:00Z" }),
  );
  client.createStudioReviewDecision.mockImplementationOnce(async (_p, _d, request) => ({
    ...decision("d_new", request.base_revision, request.decision),
    created_at: "2026-09-24T10:00:00Z",
  }));
  render(<StudioReviewPanel {...props(client)} />);

  typeComment("Posted before history");
  fireEvent.click(button("Post comment"));
  await screen.findByText("Comment posted.");
  fireEvent.click(button("Approve"));
  fireEvent.click(button("Confirm approval"));
  await screen.findByText("Approval recorded for revision 3.");

  await act(async () => {
    comments.resolve({ comments: [comment("c1", 2)], next_cursor: null });
    decisions.resolve({ decisions: [decision("d1", 2)], next_cursor: null });
  });
  expect(screen.getByText("Posted before history")).toBeDefined();
  expect(screen.getByText("Comment c1")).toBeDefined();
  expect(screen.getByText("Current decision: Approved on revision 3")).toBeDefined();
});

test("a draft edited while its request is pending survives success and is never retried stale", async () => {
  const client = makeClient();
  const posted = deferred<ReviewComment>();
  const decided = deferred<ReviewDecision>();
  client.createStudioReviewComment.mockImplementationOnce(() => posted.promise);
  client.createStudioReviewDecision.mockImplementationOnce(() => decided.promise);
  await renderPanel(client);

  typeComment("First note");
  fireEvent.click(button("Post comment"));
  typeComment("Second note");
  await act(async () => posted.resolve(comment("c_new", 3, { text: "First note" })));
  expect(commentValue()).toBe("Second note");

  const reason = () => screen.getByLabelText("Decision reason (optional)") as HTMLTextAreaElement;
  fireEvent.change(reason(), { target: { value: "Ship it" } });
  fireEvent.click(button("Approve"));
  fireEvent.click(button("Confirm approval"));
  fireEvent.change(reason(), { target: { value: "Ship it after the caption fix" } });
  await act(async () => decided.reject(new StudioReviewRequestError("review_request_failed")));
  expect(reason().value).toBe("Ship it after the caption fix");
  expect(screen.queryByRole("button", { name: "Retry" }) === null).toBe(true);
  expect(client.createStudioReviewDecision).toHaveBeenCalledTimes(1);
});

test.each([
  ["comments fail before decisions load", "comments", true],
  ["comments fail after decisions load", "comments", false],
  ["decisions fail before comments load", "decisions", true],
  ["decisions fail after comments load", "decisions", false],
] as const)("keeps the history failure visible when %s", async (_name, failing, failFirst) => {
  const { client, comments, decisions } = withLateHistory();
  render(<StudioReviewPanel {...props(client)} />);
  const fail = () =>
    failing === "comments"
      ? comments.reject(new StudioReviewRequestError("review_request_failed"))
      : decisions.reject(new StudioReviewRequestError("review_request_failed"));
  const succeed = () =>
    failing === "comments"
      ? decisions.resolve({ decisions: [decision("d1", 3)], next_cursor: null })
      : comments.resolve({ comments: [comment("c1", 3)], next_cursor: null });

  await act(async () => (failFirst ? fail() : succeed()));
  await act(async () => (failFirst ? succeed() : fail()));
  expect(screen.getByText("Could not load review history.")).toBeDefined();
  expect(
    failing === "comments"
      ? screen.getByText("Current decision: Approved on revision 3")
      : screen.getByText("Comment c1"),
  ).toBeDefined();
});

test("Reload recovers the failed history list and keeps the loaded one", async () => {
  const { client, comments, decisions } = withLateHistory();
  render(<StudioReviewPanel {...props(client)} />);
  await act(async () => comments.reject(new StudioReviewRequestError("review_request_failed")));
  await act(async () => decisions.resolve({ decisions: [decision("d1", 3)], next_cursor: null }));

  client.listStudioReviewComments.mockImplementationOnce(async () => ({ comments: [comment("c1", 3)], next_cursor: null }));
  fireEvent.click(button("Reload review"));
  await screen.findByText("Comment c1");
  expect(screen.queryByText("Could not load review history.") === null).toBe(true);
  expect(screen.getByText("Current decision: Approved on revision 3")).toBeDefined();
  expect(client.listStudioReviewDecisions).toHaveBeenCalledTimes(1);
});

test("Retry of a pinned comment names the original frame after the playhead moves", async () => {
  const client = makeClient();
  client.createStudioReviewComment.mockImplementationOnce(async () => {
    throw new StudioReviewRequestError("review_request_failed");
  });
  const view = await renderPanel(client);
  typeComment("Adjust opening");
  fireEvent.click(button("Post comment"));
  await screen.findByText(/Could not reach Studio/);

  view.rerender(<StudioReviewPanel {...props(client, { currentFrame: 60 })} />);
  await act(async () => {});
  expect(screen.getByText("Retry resends this comment pinned at 0:00:29, not the current frame.")).toBeDefined();
  expect(client.createStudioReviewComment).toHaveBeenCalledTimes(1);

  fireEvent.click(button("Retry"));
  await screen.findByText("Comment posted.");
  const [first, second] = client.createStudioReviewComment.mock.calls.map((call) => call[2]);
  expect(second).toEqual(first!);
  expect(second!.frame).toBe(29);
});
