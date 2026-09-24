/// <reference types="bun-types" />

import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { EditDocument } from "./api/control-plane";

const document = {
  schema_version: 1, document_id: "document_001", project_id: "project_001", revision: 1,
  canvas: { width: 1080, height: 1920, fps: 30, duration_in_frames: 150 },
  template: { template_id: "vertical_text_story", version: 1 },
  tracks: [{ track_id: "track_visual", kind: "visual", clip_ids: ["clip_001"] }],
  scenes: [{ scene_id: "scene_001", role: "title", start_frame: 0, duration_in_frames: 150, clip_ids: ["clip_001"] }],
  clips: [{ kind: "text", clip_id: "clip_001", scene_id: "scene_001", track_id: "track_visual", start_frame: 0, duration_in_frames: 150, heading: "Heading", body: "Body", ownership: "ai_managed", style_slot: "title" }],
} satisfies EditDocument;
const content = {
  main: { title: "Main", url: "https://example.test/main?sig=secret", image_path: "C:\\Users\\operator\\main.jpg" },
  footage: [],
  comments: [],
  figures: [],
  references: [],
};
const sourceKey = "c".repeat(64);
const draft = { document_id: "document_001", source_key: sourceKey, revision: 1, created_at: "2026-09-24T18:02:00Z" };
let inspectBodies: string[] = [];
let createCalls = 0;
let projects: unknown[] = [{ id: "project_001", name: "Project", workspace_path: "", created_at: "", updated_at: "" }];
const originalFetch = globalThis.fetch;
const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });

function stubFetch() {
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === "/api/projects" && init?.method === "POST") {
      return response({ id: "project_002", name: "Other", workspace_path: "", created_at: "", updated_at: "" });
    }
    if (path === "/api/projects") return response(projects);
    if (path === "/api/scout/content-set/data") return response({ path: "content-set.json", exists: true, output_root: "", content, error: null });
    if (path === "/api/scout/status") return response({ run: { status: "idle" } });
    if (path.endsWith("/studio-imports/inspect")) {
      inspectBodies.push(String(init?.body));
      return response({ project_id: "project_001", source_key: sourceKey, items: [], drafts: [draft], more_drafts: false });
    }
    if (path.endsWith("/studio-imports")) { createCalls += 1; return response(draft); }
    if (path.endsWith("/studio-imports/documents/document_001")) {
      return response({ document_id: "document_001", source_key: sourceKey, revision: 1, items: [] });
    }
    if (path.includes("/edit-documents/document_001")) return response(document);
    return response([]);
  }) as unknown as typeof fetch;
}

afterEach(() => { cleanup(); globalThis.fetch = originalFetch; inspectBodies = []; createCalls = 0; projects = [{ id: "project_001", name: "Project", workspace_path: "", created_at: "", updated_at: "" }]; });

async function openContentSet() {
  stubFetch();
  const { default: App } = await import("./App");
  render(<App />);
  await userEvent.setup().click(screen.getByRole("button", { name: "Content Set" }));
  await screen.findByRole("button", { name: "Open in Studio" });
}

async function resumeDraft(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("radio", { name: /revision 1/ }));
  await user.click(screen.getByRole("button", { name: "Resume" }));
  await user.click(await screen.findByRole("button", { name: "Continue in Studio" }));
}

test("Open in Studio only inspects, and Resume opens the chosen draft in Guided Studio", async () => {
  await openContentSet();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Open in Studio" }));
  await screen.findByRole("dialog", { name: "Open in Studio — Main" });
  expect(inspectBodies).toHaveLength(1);
  expect(createCalls).toBe(0);

  await resumeDraft(user);
  expect(await screen.findByLabelText("Heading")).toBeDefined();
  expect(createCalls).toBe(0);
  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(await screen.findByRole("button", { name: "Open in Studio" })).toBeDefined();
});

test("disables opening Studio when no project is selected", async () => {
  projects = [];
  await openContentSet();
  expect((screen.getByRole("button", { name: "Open in Studio" }) as HTMLButtonElement).disabled).toBe(true);
  expect(inspectBodies).toHaveLength(0);
});

test("the inspected source carries no local path and no signed query", async () => {
  await openContentSet();
  await userEvent.setup().click(screen.getByRole("button", { name: "Open in Studio" }));
  await screen.findByRole("dialog", { name: "Open in Studio — Main" });
  expect(inspectBodies[0]).toContain("https://example.test/main");
  for (const leak of ["C:\\", "operator", "sig=", "secret", "image_path"]) expect(inspectBodies[0]).not.toContain(leak);
});

test("switching the project while choosing never creates a draft", async () => {
  await openContentSet();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Open in Studio" }));
  await screen.findByRole("radio", { name: /revision 1/ });

  await user.click(screen.getByRole("button", { name: /new project/i }));
  await user.type(screen.getByLabelText("New project name"), "Other");
  await user.click(screen.getByRole("button", { name: /^create$/i }));
  await screen.findByRole("button", { name: /new project/i });

  expect(createCalls).toBe(0);
  expect(inspectBodies).toHaveLength(1);
});

test("keeps Send to render on the legacy console path", async () => {
  await openContentSet();
  await userEvent.setup().click(screen.getByRole("button", { name: /Send to render/ }));
  expect((screen.getByLabelText("Content-set path (optional)") as HTMLInputElement).value).toBe("content-set.json");
});

test("keeps naming the Studio document's project after the global project changes", async () => {
  await openContentSet();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Open in Studio" }));
  await resumeDraft(user);
  await screen.findByLabelText("Heading");
  const header = globalThis.document.querySelector<HTMLElement>('section[aria-label="Guided Studio"] > header')!;
  expect(within(header).getByText("Project project_001")).toBeDefined();

  await user.click(screen.getByRole("button", { name: /new project/i }));
  await user.type(screen.getByLabelText("New project name"), "Other");
  await user.click(screen.getByRole("button", { name: /^create$/i }));

  // The switcher selects the new project once its form closes.
  await screen.findByRole("button", { name: /new project/i });
  expect(within(header).getByText("Project project_001")).toBeDefined();
  expect(within(header).getByText("Saved revision 1")).toBeDefined();
});
