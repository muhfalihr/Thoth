/// <reference types="bun-types" />

import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { EditorAction, EditorMode } from "./editor_state";
import { IssuesPanel } from "./IssuesPanel";
import { timelineDocument } from "./timeline-test-fixtures";

afterEach(cleanup);

/** A document whose main track starts late and whose music runs past the canvas. */
function brokenDocument() {
  const document = timelineDocument();
  document.clips![0]!.from_frame = 30;
  document.clips![2]!.duration_in_frames = 200;
  return document;
}

/**
 * Render the panel next to the elements it focuses, so the stable DOM IDs the
 * timeline publishes are the ones under test.
 */
function mount(mode: EditorMode = "advanced", selectedIssueId = "") {
  const actions: EditorAction[] = [];
  render(
    <>
      <IssuesPanel
        document={brokenDocument()}
        selectedIssueId={selectedIssueId}
        mode={mode}
        dispatch={(action) => actions.push(action)}
      />
      <button type="button" id="timeline-clip-clip_main">
        target one
      </button>
      <button type="button" id="timeline-clip-clip_music">
        target two
      </button>
    </>,
  );
  return { actions };
}

test("lists every issue in readable language", () => {
  mount();
  const items = screen.getAllByRole("listitem");
  expect(items).toHaveLength(2);
  expect(items[0]!.textContent).toContain("Main video");
  expect(items[0]!.textContent).toContain("gap");
  expect(items[1]!.textContent).toContain("Music");
  expect(items[1]!.textContent).toContain("past the end");
});

test("says so when nothing is wrong", () => {
  render(
    <IssuesPanel
      document={timelineDocument()}
      selectedIssueId=""
      mode="advanced"
      dispatch={() => {}}
    />,
  );
  expect(screen.getByText("No issues found")).toBeDefined();
  expect(screen.queryByRole("listitem")).toBeNull();
});

test("selecting an issue selects its target and focuses the clip", () => {
  const { actions } = mount();
  fireEvent.click(screen.getByRole("button", { name: /Main video/ }));

  expect(actions).toEqual([
    { type: "select_issue", issueId: "main_track_gap:clip_main" },
    { type: "select_track", trackId: "track_main" },
    { type: "select_clip", clipId: "clip_main" },
  ]);
  expect(document.activeElement?.id).toBe("timeline-clip-clip_main");
});

test("opens Advanced mode only when the editor is still simple", () => {
  const advanced = mount("advanced");
  fireEvent.click(screen.getByRole("button", { name: /Music/ }));
  expect(advanced.actions.some((action) => action.type === "set_editor_mode")).toBe(false);

  cleanup();
  const simple = mount("simple");
  fireEvent.click(screen.getByRole("button", { name: /Music/ }));
  expect(simple.actions[0]).toEqual({ type: "set_editor_mode", mode: "advanced" });
});

test("marks the selected issue without stealing focus in the background", () => {
  mount("advanced", "main_track_gap:clip_main");
  const selected = screen.getByRole("button", { name: /Main video/ });
  expect(selected.getAttribute("aria-current")).toBe("true");
  expect(document.activeElement).toBe(document.body);
});
