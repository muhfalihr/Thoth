/// <reference types="bun-types" />

import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  StudioImportRequestError,
  type EditorAsset,
  type StudioImportInventory,
  type StudioImportItem,
  type StudioSourceInspection,
  type StudioSourceProjection,
} from "@/api/control-plane";
import { StudioImportGate, type StudioImportClient } from "./StudioImportGate";

afterEach(() => cleanup());

const SOURCE_KEY = "b".repeat(64);
const sourceItem = (role: "main" | "footage" | "comment", order: number, media: "video" | "image" | "none") => ({
  role,
  order,
  title: role === "main" ? "Neon Nights" : null,
  text: role === "comment" ? "Great clip" : null,
  platform: role === "comment" ? null : "tiktok",
  source_url: role === "comment" ? null : `https://example.test/${role}/${order}`,
  media_kind: media,
  trim_start_seconds: null,
});
const SOURCE = {
  items: [
    sourceItem("main", 0, "video"),
    ...[0, 1, 2, 3].map((order) => sourceItem("footage", order, "video")),
    sourceItem("comment", 0, "none"),
  ],
  unsupported: [{ field: "profile", role: "main", order: 0, reason: "Profile cards are not supported" }],
} satisfies StudioSourceProjection;

const mediaItem = (itemId: string, role: "main" | "footage", order: number, label: string): StudioImportItem => ({
  item_id: itemId,
  role,
  order,
  label,
  platform: "tiktok",
  media_kind: "video",
  scene_id: `scene_00${order + (role === "main" ? 1 : 2)}`,
  reason: null,
  disposition: "unresolved",
  asset_id: null,
});
const ITEMS: StudioImportItem[] = [
  mediaItem("main_000", "main", 0, "Neon Nights"),
  mediaItem("footage_000", "footage", 0, "City loop"),
  mediaItem("footage_001", "footage", 1, "React closeup"),
  mediaItem("footage_002", "footage", 2, "Skyline drone"),
  mediaItem("footage_003", "footage", 3, "Crowd pan"),
  {
    item_id: "unsupported_000",
    role: "main",
    order: 0,
    label: "profile",
    platform: null,
    media_kind: "none",
    scene_id: null,
    reason: "Profile cards are not supported",
    disposition: "unresolved",
    asset_id: null,
  },
];
const DRAFTS = [
  { document_id: "edoc_003", source_key: SOURCE_KEY, revision: 3, created_at: "2026-09-24T18:02:00Z" },
  { document_id: "edoc_001", source_key: SOURCE_KEY, revision: 1, created_at: "2026-09-23T09:14:00Z" },
];
const INSPECTION: StudioSourceInspection = {
  project_id: "project_001",
  source_key: SOURCE_KEY,
  items: ITEMS,
  drafts: DRAFTS,
  more_drafts: false,
};
const inventoryOf = (documentId: string, revision = 1, items = ITEMS): StudioImportInventory => ({
  document_id: documentId,
  source_key: SOURCE_KEY,
  revision,
  items,
});
const asset = (assetId: string, kind: EditorAsset["kind"], state: EditorAsset["validation_state"] = "ready") =>
  ({
    asset_id: assetId,
    project_id: "project_001",
    kind,
    media_type: kind === "image" ? "image/png" : "video/mp4",
    has_audio: false,
    validation_state: state,
  }) as EditorAsset;

function fakeClient(overrides: Partial<StudioImportClient> = {}) {
  return {
    inspectStudioImport: mock(async () => INSPECTION),
    createStudioImport: mock(async () => ({ ...DRAFTS[0]!, document_id: "edoc_new", revision: 1 })),
    listStudioImportDrafts: mock(async () => ({ source_key: SOURCE_KEY, drafts: DRAFTS, more_drafts: false })),
    getStudioImportInventory: mock(async (_projectId: string, documentId: string) => inventoryOf(documentId)),
    resolveStudioImportItem: mock(async () => inventoryOf("edoc_003", 2)),
    uploadEditorAsset: mock(async () => asset("asset_uploaded", "video")),
    listEditorAssets: mock(async () => ({
      assets: [asset("asset_clip", "video"), asset("asset_still", "image"), asset("asset_pending", "video", "pending")],
      next_cursor: null,
    })),
    ...overrides,
  } satisfies StudioImportClient;
}

function renderGate(client = fakeClient(), source: StudioSourceProjection = SOURCE) {
  const onOpen = mock((_documentId: string) => {});
  const onClose = mock(() => {});
  const view = render(
    <StudioImportGate client={client} projectId="project_001" source={source} onOpen={onOpen} onClose={onClose} />,
  );
  return { client, onOpen, onClose, view, user: userEvent.setup() };
}

async function resumeNewest(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("radio", { name: /revision 3/ }));
  await user.click(screen.getByRole("button", { name: "Resume" }));
  return screen.findByRole("list", { name: "Source inventory" });
}

const row = (label: string) => within(screen.getByRole("listitem", { name: label }));

test("opening only inspects: nothing is created, not even on remount", async () => {
  const { client, view } = renderGate();
  expect(await screen.findByRole("radio", { name: /revision 3/ })).toBeDefined();
  expect(client.inspectStudioImport).toHaveBeenCalledTimes(1);
  expect(client.inspectStudioImport).toHaveBeenCalledWith("project_001", SOURCE);

  view.unmount();
  renderGate(client);
  await screen.findByRole("radio", { name: /revision 3/ });
  expect(client.createStudioImport).toHaveBeenCalledTimes(0);
  expect(screen.getByRole("dialog", { name: "Open in Studio — Neon Nights" })).toBeDefined();
});

test("Resume opens the selected existing draft without creating one", async () => {
  const { client, onOpen, user } = renderGate();
  await resumeNewest(user);

  expect(client.getStudioImportInventory).toHaveBeenCalledWith("project_001", "edoc_003");
  await user.click(screen.getByRole("button", { name: "Continue in Studio" }));
  expect(onOpen).toHaveBeenCalledWith("edoc_003");
  expect(client.createStudioImport).toHaveBeenCalledTimes(0);
});

test("a draft is chosen and resumed from the keyboard", async () => {
  const { client, user } = renderGate();
  const first = await screen.findByRole("radio", { name: /revision 3/ });
  await waitFor(() => expect(globalThis.document.activeElement).toBe(first));

  await user.keyboard(" ");
  await user.keyboard("{Enter}");

  expect(await screen.findByRole("list", { name: "Source inventory" })).toBeDefined();
  expect(client.getStudioImportInventory).toHaveBeenCalledWith("project_001", "edoc_003");
});

test("Create sends one request per click and an explicit retry reuses its key", async () => {
  let attempts = 0;
  const createStudioImport = mock(async () => {
    attempts += 1;
    if (attempts === 1) throw new StudioImportRequestError(null);
    return { ...DRAFTS[0]!, document_id: "edoc_new", revision: 1 };
  });
  const { client, onOpen, user } = renderGate(fakeClient({ createStudioImport }));
  await user.click(await screen.findByRole("button", { name: "Create new draft" }));

  expect(createStudioImport).toHaveBeenCalledTimes(1);
  expect((await screen.findByRole("alert")).textContent).toContain("Offline");
  await user.click(screen.getByRole("button", { name: "Retry create" }));

  expect(createStudioImport).toHaveBeenCalledTimes(2);
  const [first, second] = createStudioImport.mock.calls as unknown as [string, unknown, string][];
  expect(first).toEqual(["project_001", { source: SOURCE, source_key: SOURCE_KEY }, expect.any(String)]);
  expect(second![2]).toBe(first![2]);
  await screen.findByRole("list", { name: "Source inventory" });
  expect(client.getStudioImportInventory).toHaveBeenCalledWith("project_001", "edoc_new");
  await user.click(screen.getByRole("button", { name: "Continue in Studio" }));
  expect(onOpen).toHaveBeenCalledWith("edoc_new");
});

test("a source with no drafts offers Create as the only choice", async () => {
  renderGate(fakeClient({ inspectStudioImport: mock(async () => ({ ...INSPECTION, drafts: [] })) }));
  expect(await screen.findByText("No drafts for this source yet.")).toBeDefined();
  expect(screen.queryByRole("button", { name: "Resume" }) === null).toBe(true);
  expect(screen.getByRole("button", { name: "Create new draft" })).toBeDefined();
});

test("an offline inspection keeps the dialog open with its choices disabled", async () => {
  let online = false;
  const inspectStudioImport = mock(async () => {
    if (!online) throw new StudioImportRequestError(null);
    return INSPECTION;
  });
  const { user } = renderGate(fakeClient({ inspectStudioImport }));
  expect(await screen.findByText("Offline — reconnect to list drafts.")).toBeDefined();
  expect((screen.getByRole("button", { name: "Create new draft" }) as HTMLButtonElement).disabled).toBe(true);

  online = true;
  await user.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByRole("radio", { name: /revision 3/ })).toBeDefined();
  expect(inspectStudioImport).toHaveBeenCalledTimes(2);
});

test("a draft that is gone refreshes the list instead of creating a replacement", async () => {
  const listStudioImportDrafts = mock(async () => ({ source_key: SOURCE_KEY, drafts: [DRAFTS[1]!], more_drafts: false }));
  const { client, user } = renderGate(
    fakeClient({
      getStudioImportInventory: mock(async () => {
        throw new StudioImportRequestError(404);
      }),
      listStudioImportDrafts,
    }),
  );
  await user.click(await screen.findByRole("radio", { name: /revision 3/ }));
  await user.click(screen.getByRole("button", { name: "Resume" }));

  expect((await screen.findByRole("alert")).textContent).toContain("no longer available");
  expect(listStudioImportDrafts).toHaveBeenCalledWith("project_001", SOURCE_KEY);
  await waitFor(() => expect(screen.queryByRole("radio", { name: /revision 3/ }) === null).toBe(true));
  expect(screen.getByRole("radio", { name: /revision 1/ })).toBeDefined();
  expect(client.createStudioImport).toHaveBeenCalledTimes(0);
});

test("the inventory lists every footage item and unsupported field with a route to resolve it", async () => {
  const { user } = renderGate();
  const inventory = await resumeNewest(user);

  expect(within(inventory).getAllByRole("listitem")).toHaveLength(6);
  for (const label of ["Neon Nights", "City loop", "React closeup", "Skyline drone", "Crowd pan"]) {
    expect(row(label).getByRole("button", { name: "Attach…" })).toBeDefined();
    expect(row(label).getByRole("button", { name: "Exclude from Studio edit" })).toBeDefined();
    expect(row(label).getByText("Unresolved")).toBeDefined();
  }
  expect(row("profile").getByText("Profile cards are not supported")).toBeDefined();
  expect(row("profile").queryByRole("button", { name: "Attach…" }) === null).toBe(true);
  expect(row("profile").getByRole("button", { name: "Exclude from Studio edit" })).toBeDefined();
  expect(screen.getByText("6 of 6 items unresolved")).toBeDefined();
  expect(screen.getByText("1 more item opens as a text scene.")).toBeDefined();
});

test("an exclusion is saved on the draft and stays listed", async () => {
  const excluded = ITEMS.map((item) =>
    item.item_id === "footage_001" ? { ...item, disposition: "excluded" as const } : item,
  );
  const resolveStudioImportItem = mock(async () => inventoryOf("edoc_003", 2, excluded));
  const { user } = renderGate(fakeClient({ resolveStudioImportItem }));
  await resumeNewest(user);

  await user.click(row("React closeup").getByRole("button", { name: "Exclude from Studio edit" }));

  expect(resolveStudioImportItem).toHaveBeenCalledWith("project_001", "edoc_003", "footage_001", {
    base_revision: 1,
    decision: { kind: "exclude" },
  });
  expect(await row("React closeup").findByText("Excluded")).toBeDefined();
  expect(row("React closeup").queryByRole("button", { name: "Attach…" }) === null).toBe(true);
  expect(screen.getByText("5 of 6 items unresolved")).toBeDefined();
});

test("a ready asset of the item's kind can be attached", async () => {
  const attached = ITEMS.map((item) =>
    item.item_id === "footage_000" ? { ...item, disposition: "attached" as const, asset_id: "asset_clip" } : item,
  );
  const resolveStudioImportItem = mock(async () => inventoryOf("edoc_003", 2, attached));
  const { client, user } = renderGate(fakeClient({ resolveStudioImportItem }));
  await resumeNewest(user);

  await user.click(row("City loop").getByRole("button", { name: "Attach…" }));
  const choice = (await row("City loop").findByLabelText("Ready asset")) as HTMLSelectElement;
  expect([...choice.options].map((option) => option.value)).toEqual(["asset_clip"]);
  await user.click(row("City loop").getByRole("button", { name: "Attach selected asset" }));

  expect(client.listEditorAssets).toHaveBeenCalledWith("project_001", undefined, 50);
  expect(resolveStudioImportItem).toHaveBeenCalledWith("project_001", "edoc_003", "footage_000", {
    base_revision: 1,
    decision: { kind: "attach_asset", asset_id: "asset_clip" },
  });
  expect(await row("City loop").findByText("Attached · asset_clip")).toBeDefined();
});

test("an uploaded file is attached to the item it was chosen for", async () => {
  const { client, user } = renderGate();
  await resumeNewest(user);
  const file = new File(["frames"], "city.mp4", { type: "video/mp4" });

  await user.click(row("City loop").getByRole("button", { name: "Attach…" }));
  await user.upload(row("City loop").getByLabelText("Upload file"), file);

  expect(client.uploadEditorAsset).toHaveBeenCalledWith("project_001", file);
  await waitFor(() =>
    expect(client.resolveStudioImportItem).toHaveBeenCalledWith("project_001", "edoc_003", "footage_000", {
      base_revision: 1,
      decision: { kind: "attach_asset", asset_id: "asset_uploaded" },
    }),
  );
});

test("a failed upload keeps the inventory and the open attach choice", async () => {
  const { client, user } = renderGate(
    fakeClient({
      uploadEditorAsset: mock(async () => {
        throw new StudioImportRequestError(413, "upload_too_large");
      }),
    }),
  );
  await resumeNewest(user);

  await user.click(row("City loop").getByRole("button", { name: "Attach…" }));
  await user.upload(row("City loop").getByLabelText("Upload file"), new File(["x"], "big.mp4", { type: "video/mp4" }));

  expect((await screen.findByRole("alert")).textContent).toContain("too large");
  expect(client.resolveStudioImportItem).toHaveBeenCalledTimes(0);
  expect(row("City loop").getByText("Unresolved")).toBeDefined();
  expect(row("City loop").getByLabelText("Upload file")).toBeDefined();
});

test("a decision on a stale revision refreshes the inventory", async () => {
  const getStudioImportInventory = mock(async (_projectId: string, documentId: string) => inventoryOf(documentId));
  const { user } = renderGate(
    fakeClient({
      getStudioImportInventory,
      resolveStudioImportItem: mock(async () => {
        throw new StudioImportRequestError(409, "document_revision_conflict");
      }),
    }),
  );
  await resumeNewest(user);

  await user.click(row("Crowd pan").getByRole("button", { name: "Exclude from Studio edit" }));

  expect((await screen.findByRole("alert")).textContent).toContain("changed elsewhere");
  expect(getStudioImportInventory).toHaveBeenCalledTimes(2);
});

test("a main post without media is stated, not hidden", async () => {
  const source = { ...SOURCE, items: [sourceItem("main", 0, "none"), ...SOURCE.items.slice(1)] };
  const items = ITEMS.filter((item) => item.item_id !== "main_000");
  const { user } = renderGate(
    fakeClient({
      inspectStudioImport: mock(async () => ({ ...INSPECTION, items })),
      getStudioImportInventory: mock(async (_projectId: string, documentId: string) =>
        inventoryOf(documentId, 1, items),
      ),
    }),
    source,
  );
  await resumeNewest(user);
  expect(screen.getByText("The main post has no media. It opens as a text scene.")).toBeDefined();
});

test("no source address or local path reaches the dialog or the console", async () => {
  const logs = (["log", "info", "warn", "error"] as const).map((level) => spyOn(console, level));
  const { user } = renderGate();
  await resumeNewest(user);
  await user.click(row("City loop").getByRole("button", { name: "Attach…" }));

  const text = globalThis.document.body.textContent ?? "";
  for (const leak of ["https://", "example.test", "C:\\", "/mnt/"]) expect(text).not.toContain(leak);
  for (const spy of logs) {
    expect(JSON.stringify(spy.mock.calls)).not.toContain("example.test");
    spy.mockRestore();
  }
});

test("Escape closes the dialog without creating anything", async () => {
  const { client, onClose, user } = renderGate();
  await screen.findByRole("radio", { name: /revision 3/ });
  await user.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(client.createStudioImport).toHaveBeenCalledTimes(0);
});

test("reopening a draft from Studio goes straight to its inventory and creates nothing", async () => {
  const client = fakeClient();
  const onOpen = mock((_documentId: string) => {});
  render(
    <StudioImportGate
      client={client}
      projectId="project_001"
      source={SOURCE}
      resumeDocumentId="edoc_003"
      onOpen={onOpen}
      onClose={() => {}}
    />,
  );

  expect(await screen.findByRole("list", { name: "Source inventory" })).toBeDefined();
  expect(client.getStudioImportInventory).toHaveBeenCalledWith("project_001", "edoc_003");
  expect(client.createStudioImport).not.toHaveBeenCalled();
  await userEvent.setup().click(screen.getByRole("button", { name: "Continue in Studio" }));
  expect(onOpen).toHaveBeenCalledWith("edoc_003");
});
