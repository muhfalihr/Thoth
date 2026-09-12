/// <reference types="bun-types" />

import { afterEach, expect, jest, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  EditDocument,
  ProjectPromptBinding,
  PromptStageDefinition,
  PromptTemplateRevision,
  ResolvedPromptDraft,
} from "@/api/control-plane";

mock.module("./StudioPreview", () => ({
  StudioPreview: ({ document }: { document: EditDocument }) => (
    <div aria-label="Draft preview">{document.clips[0]?.heading}</div>
  ),
}));

const promptStage = {
  stage_id: "narrative_plan",
  label: "Narrative plan",
  status: "draft_only",
} satisfies PromptStageDefinition;

const promptTemplate = {
  project_id: "project_001",
  template_id: "ptpl_001",
  revision: 1,
  stage_id: "narrative_plan",
  language: "id-ID",
  body: "Write a hook",
} satisfies PromptTemplateRevision;

const promptBinding = {
  project_id: "project_001",
  stage_id: "narrative_plan",
  template_id: "ptpl_001",
  template_revision: 1,
  project_override: "Use Indonesian",
  revision: 1,
} satisfies ProjectPromptBinding;

const promptResolved = {
  stage_id: "narrative_plan",
  sections: [{ kind: "template", label: "Template", text: "Write a hook" }],
  visible_text: "Template\nWrite a hook",
} satisfies ResolvedPromptDraft;

const promptClientBase = {
  listPromptStages: mock(async () => [promptStage]),
  listPromptTemplates: mock(async () => [promptTemplate]),
  savePromptTemplate: mock(async () => ({ kind: "saved" as const, value: promptTemplate })),
  getPromptBinding: mock(async () => promptBinding),
  savePromptBinding: mock(async () => ({ kind: "saved" as const, value: promptBinding })),
  getResolvedPrompt: mock(async () => promptResolved),
};

const document = {
  schema_version: 1,
  document_id: "document_001",
  project_id: "project_001",
  revision: 1,
  canvas: { width: 1080, height: 1920, fps: 30, duration_in_frames: 150 },
  template: { template_id: "vertical_text_story", version: 1 },
  tracks: [{ track_id: "track_visual", kind: "visual", clip_ids: ["clip_001"] }],
  scenes: [{ scene_id: "scene_001", role: "title", start_frame: 0, duration_in_frames: 150, clip_ids: ["clip_001"] }],
  clips: [{
    kind: "text",
    clip_id: "clip_001",
    scene_id: "scene_001",
    track_id: "track_visual",
    start_frame: 0,
    duration_in_frames: 150,
    heading: "Original heading",
    body: "Original body",
    ownership: "ai_managed",
    style_slot: "title",
  }],
} satisfies EditDocument;

afterEach(() => cleanup());

test("renders labelled Inspector fields and keyboard-visible editing controls", async () => {
  const { GuidedStudio } = await import("./GuidedStudio");
  const client = {
    ...promptClientBase,
    getEditDocument: mock(async () => document),
    patchEditDocument: mock(async () => ({ kind: "saved" as const, document })),
  };

  render(<GuidedStudio client={client} projectId="project_001" documentId="document_001" onBack={() => {}} />);

  expect(await screen.findByLabelText("Heading")).toBeDefined();
  expect(screen.getByLabelText("Body")).toBeDefined();
  expect(screen.getByLabelText("Ownership")).toBeDefined();
  expect(screen.getByLabelText("Duration (frames)")).toBeDefined();
  expect(screen.getByRole("button", { name: "Undo" })).toBeDefined();
  expect(screen.getByRole("button", { name: "Redo" })).toBeDefined();
  expect(screen.getByText("Saved")).toBeDefined();
});

test("autosaves after 500ms and reports Saving then Saved", async () => {
  let resolveSave: (value: { kind: "saved"; document: EditDocument }) => void = () => {};
  const patchEditDocument = mock(
    () => new Promise<{ kind: "saved"; document: EditDocument }>((resolve) => { resolveSave = resolve; }),
  );
  const { GuidedStudio } = await import("./GuidedStudio");
  render(
    <GuidedStudio
      client={{ ...promptClientBase, getEditDocument: mock(async () => document), patchEditDocument }}
      projectId="project_001"
      documentId="document_001"
      onBack={() => {}}
    />,
  );
  const heading = await screen.findByLabelText("Heading");
  jest.useFakeTimers();
  try {
    fireEvent.change(heading, { target: { value: "Edited heading" } });
    act(() => jest.advanceTimersByTime(499));
    expect(patchEditDocument).toHaveBeenCalledTimes(0);
    act(() => jest.advanceTimersByTime(1));
    expect(patchEditDocument).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Saving")).toBeDefined();
    const savedDocument = {
      ...document,
      revision: 2,
      clips: [{ ...document.clips[0], heading: "Edited heading", ownership: "user_edited" as const }],
    };
    await act(async () => { resolveSave({ kind: "saved", document: savedDocument }); });
    expect(screen.getByText("Saved")).toBeDefined();
  } finally {
    jest.useRealTimers();
  }
});

test("shows safe Retry guidance after a failed save without rendering the raw error", async () => {
  const rawError = "database password=do-not-render";
  const patchEditDocument = mock(async () => { throw new Error(rawError); });
  const { GuidedStudio } = await import("./GuidedStudio");
  const user = userEvent.setup();
  render(
    <GuidedStudio
      client={{ ...promptClientBase, getEditDocument: mock(async () => document), patchEditDocument }}
      projectId="project_001"
      documentId="document_001"
      onBack={() => {}}
    />,
  );
  const heading = await screen.findByLabelText("Heading");
  await user.type(heading, " updated");

  expect((await screen.findByRole("alert", {}, { timeout: 1_000 })).textContent).toContain("Your edits are still here");
  expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
  expect(screen.queryByText(rawError)).toBeNull();
});

test("keeps the local draft on conflict and offers both explicit recovery actions", async () => {
  const latest = {
    ...document,
    revision: 2,
    clips: [{ ...document.clips[0], heading: "Remote heading" }],
  };
  const { GuidedStudio } = await import("./GuidedStudio");
  const user = userEvent.setup();
  render(
    <GuidedStudio
      client={{
        ...promptClientBase,
        getEditDocument: mock(async () => document),
        patchEditDocument: mock(async () => ({ kind: "conflict" as const, latest })),
      }}
      projectId="project_001"
      documentId="document_001"
      onBack={() => {}}
    />,
  );
  const heading = await screen.findByLabelText("Heading");
  await user.clear(heading);
  await user.type(heading, "Local heading");

  expect(await screen.findByText("Conflict", {}, { timeout: 1_000 })).toBeDefined();
  expect((screen.getByLabelText("Heading") as HTMLInputElement).value).toBe("Local heading");
  expect(screen.getByRole("button", { name: "Reload Latest" })).toBeDefined();
  expect(screen.getByRole("button", { name: "Keep Editing Locally" })).toBeDefined();

  await user.click(screen.getByRole("button", { name: "Reload Latest" }));
  expect((screen.getByLabelText("Heading") as HTMLInputElement).value).toBe("Remote heading");
});

test("associates a safe inline validation message with a blank heading", async () => {
  const patchEditDocument = mock(async () => ({ kind: "saved" as const, document }));
  const { GuidedStudio } = await import("./GuidedStudio");
  render(
    <GuidedStudio
      client={{ ...promptClientBase, getEditDocument: mock(async () => document), patchEditDocument }}
      projectId="project_001"
      documentId="document_001"
      onBack={() => {}}
    />,
  );
  const heading = await screen.findByLabelText("Heading");
  jest.useFakeTimers();
  try {
    fireEvent.change(heading, { target: { value: "   " } });
    const message = screen.getByText("Heading is required before saving.");
    expect(heading.getAttribute("aria-invalid")).toBe("true");
    expect(heading.getAttribute("aria-describedby")).toBe(message.id);
    act(() => jest.advanceTimersByTime(500));
    expect(patchEditDocument).toHaveBeenCalledTimes(0);
  } finally {
    jest.useRealTimers();
  }
});

test("switches between Scenes and Prompt Lab tabs and preserves both drafts", async () => {
  const { GuidedStudio } = await import("./GuidedStudio");
  const user = userEvent.setup();
  render(
    <GuidedStudio
      client={{
        ...promptClientBase,
        getEditDocument: mock(async () => document),
        patchEditDocument: mock(async () => ({ kind: "saved" as const, document })),
      }}
      projectId="project_001"
      documentId="document_001"
      onBack={() => {}}
    />,
  );
  const heading = await screen.findByLabelText("Heading");
  const scenesTab = screen.getByRole("tab", { name: "Scenes" });
  const promptTab = screen.getByRole("tab", { name: "Prompt Lab" });

  expect(scenesTab.getAttribute("aria-selected")).toBe("true");
  expect(promptTab.getAttribute("aria-selected")).toBe("false");
  expect(scenesTab.tagName).toBe("BUTTON");
  expect(promptTab.tagName).toBe("BUTTON");

  await user.type(heading, "Kept heading");
  await user.click(promptTab);

  expect(promptTab.getAttribute("aria-selected")).toBe("true");
  expect(scenesTab.getAttribute("aria-selected")).toBe("false");
  const override = (await screen.findByLabelText(
    "Project override",
  )) as HTMLTextAreaElement;
  await user.clear(override);
  await user.type(override, "Keep it concise");

  await user.click(scenesTab);
  expect((screen.getByLabelText("Heading") as HTMLInputElement).value).toBe("Original headingKept heading");

  await user.click(promptTab);
  expect((screen.getByLabelText("Project override") as HTMLTextAreaElement).value).toBe("Keep it concise");
});

test("keeps both tab panels mounted and toggles only the native hidden attribute", async () => {
  const { GuidedStudio } = await import("./GuidedStudio");
  const user = userEvent.setup();
  render(
    <GuidedStudio
      client={{
        ...promptClientBase,
        getEditDocument: mock(async () => document),
        patchEditDocument: mock(async () => ({ kind: "saved" as const, document })),
      }}
      projectId="project_001"
      documentId="document_001"
      onBack={() => {}}
    />,
  );
  await screen.findByLabelText("Heading");
  const scenesPanel = screen.getByRole("tabpanel", { name: "Scenes", hidden: true });
  const promptPanel = globalThis.document.getElementById(
    "studio-panel-prompts",
  ) as HTMLElement;

  expect(scenesPanel.hidden).toBe(false);
  expect(promptPanel.hidden).toBe(true);
  expect(globalThis.document.getElementById("studio-panel-scenes")).toBe(scenesPanel);
  expect(globalThis.document.getElementById("studio-panel-prompts")).toBe(promptPanel);

  await user.click(screen.getByRole("tab", { name: "Prompt Lab" }));

  expect(scenesPanel.hidden).toBe(true);
  expect(promptPanel.hidden).toBe(false);
  expect(globalThis.document.getElementById("studio-panel-scenes")).toBe(scenesPanel);
  expect(globalThis.document.getElementById("studio-panel-prompts")).toBe(promptPanel);
});
