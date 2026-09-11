/// <reference types="bun-types" />

import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
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
const content = { main: { title: "Main" }, footage: [], comments: [], figures: [], references: [] };
let importCalls = 0;
let projects: unknown[] = [{ id: "project_001", name: "Project", workspace_path: "", created_at: "", updated_at: "" }];
const originalFetch = globalThis.fetch;
const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });

function stubFetch() {
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === "/api/projects") return response(projects);
    if (path === "/api/scout/content-set/data") return response({ path: "content-set.json", exists: true, output_root: "", content, error: null });
    if (path === "/api/scout/status") return response({ run: { status: "idle" } });
    if (path.includes("/edit-documents/import-content-set")) { importCalls += 1; return response(document); }
    if (path.includes("/edit-documents/document_001")) return response(document);
    return response([]);
  }) as unknown as typeof fetch;
}

afterEach(() => { cleanup(); globalThis.fetch = originalFetch; importCalls = 0; projects = [{ id: "project_001", name: "Project", workspace_path: "", created_at: "", updated_at: "" }]; });

async function openContentSet() {
  stubFetch();
  const { default: App } = await import("./App");
  render(<App />);
  await userEvent.setup().click(screen.getByRole("button", { name: "Content Set" }));
  await screen.findByRole("button", { name: "Open in Studio" });
}

test("opens Guided Studio with the imported document and returns to Content Set", async () => {
  await openContentSet();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Open in Studio" }));
  expect(importCalls).toBe(1);
  expect(await screen.findByLabelText("Heading")).toBeDefined();
  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(await screen.findByRole("button", { name: "Open in Studio" })).toBeDefined();
});

test("disables opening Studio when no project is selected", async () => {
  projects = [];
  await openContentSet();
  expect((screen.getByRole("button", { name: "Open in Studio" }) as HTMLButtonElement).disabled).toBe(true);
  expect(importCalls).toBe(0);
});

test("keeps Send to render on the legacy console path", async () => {
  await openContentSet();
  await userEvent.setup().click(screen.getByRole("button", { name: /Send to render/ }));
  expect((screen.getByLabelText("Content-set path (optional)") as HTMLInputElement).value).toBe("content-set.json");
});
