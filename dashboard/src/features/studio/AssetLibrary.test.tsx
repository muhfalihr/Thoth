/// <reference types="bun-types" />

import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { EditorAsset, EditorAssetPage } from "@/api/control-plane";
import { ASSET_PAGE_LIMIT, AssetLibrary } from "./AssetLibrary";

afterEach(cleanup);

const asset = (overrides: Partial<EditorAsset> = {}): EditorAsset => ({
  asset_id: "asset_video",
  project_id: "project_001",
  kind: "video",
  media_type: "video/mp4",
  has_audio: true,
  validation_state: "ready",
  duration_in_frames: 120,
  ...overrides,
});

const page = (overrides: Partial<EditorAssetPage> = {}): EditorAssetPage => ({
  assets: [asset(), asset({ asset_id: "asset_pending", validation_state: "pending" })],
  next_cursor: "cursor_2",
  ...overrides,
});

function mount(
  listEditorAssets: ReturnType<typeof mock>,
  createEditorPreviewCapability: ReturnType<typeof mock> = mock(async () => ({
    preview_url: "/api/v1/projects/project_001/editor-assets/asset_video/preview",
    expires_at: "2026-09-20T00:00:00Z",
  })),
  generationRef = { current: 0 },
) {
  const added: EditorAsset[] = [];
  const sources: [string, string][] = [];
  const loaded: EditorAsset[][] = [];
  render(
    <AssetLibrary
      client={{
        listEditorAssets: listEditorAssets as never,
        createEditorPreviewCapability: createEditorPreviewCapability as never,
      }}
      projectId="project_001"
      generationRef={generationRef}
      onAssets={(assets) => loaded.push(assets)}
      onAdd={(value) => added.push(value)}
      onPreviewSource={(assetId, url) => sources.push([assetId, url])}
    />,
  );
  return { added, sources, loaded, createEditorPreviewCapability, generationRef };
}

test("loads one bounded page and shows only assets that are ready", async () => {
  const listEditorAssets = mock(async () => page());
  const { loaded } = mount(listEditorAssets);

  expect(await screen.findByText(/asset_video/)).toBeDefined();
  expect(listEditorAssets).toHaveBeenCalledWith("project_001", undefined, ASSET_PAGE_LIMIT);
  expect(ASSET_PAGE_LIMIT).toBeLessThanOrEqual(50);
  expect(screen.queryByText(/asset_pending/)).toBeNull();
  // Pending assets still reach the reducer: operations resolve against them.
  expect(loaded[0]?.map((value) => value.asset_id)).toEqual(["asset_video", "asset_pending"]);
});

test("asks for the next page only when the reader asks for it", async () => {
  let call = 0;
  const listEditorAssets = mock(async () =>
    call++ === 0
      ? page({ assets: [asset()], next_cursor: "cursor_2" })
      : page({ assets: [asset({ asset_id: "asset_second" })], next_cursor: null }),
  );
  mount(listEditorAssets);

  fireEvent.click(await screen.findByRole("button", { name: "Load more assets" }));
  await waitFor(() => expect(listEditorAssets).toHaveBeenCalledTimes(2));
  expect(listEditorAssets).toHaveBeenLastCalledWith("project_001", "cursor_2", ASSET_PAGE_LIMIT);
});

test("adds a ready asset to the timeline", async () => {
  const { added } = mount(mock(async () => page({ next_cursor: null })));
  fireEvent.click(await screen.findByRole("button", { name: "Add asset_video to timeline" }));
  expect(added.map((value) => value.asset_id)).toEqual(["asset_video"]);
});

test("requests a preview capability on demand and never shows a locator", async () => {
  const { sources, createEditorPreviewCapability } = mount(mock(async () => page()));
  await screen.findByText(/asset_video/);
  expect(createEditorPreviewCapability).toHaveBeenCalledTimes(0);

  fireEvent.click(screen.getByRole("button", { name: "Preview asset_video" }));
  await waitFor(() => expect(sources).toHaveLength(1));
  expect(sources[0]).toEqual([
    "asset_video",
    "/api/v1/projects/project_001/editor-assets/asset_video/preview",
  ]);
  expect(document.body.textContent).not.toContain("editor-assets");
});

test("drops a capability that arrives after the document moved on", async () => {
  let release: (value: { preview_url: string; expires_at: string }) => void = () => {};
  const capability = mock(
    () =>
      new Promise<{ preview_url: string; expires_at: string }>((resolve) => {
        release = resolve;
      }),
  );
  const generationRef = { current: 0 };
  const { sources } = mount(mock(async () => page()), capability, generationRef);

  fireEvent.click(await screen.findByRole("button", { name: "Preview asset_video" }));
  generationRef.current += 1;
  release({ preview_url: "/api/v1/projects/p/editor-assets/a/preview", expires_at: "2026-09-20" });

  await waitFor(() => expect(capability).toHaveBeenCalledTimes(1));
  expect(sources).toEqual([]);
});

test("explains an unavailable library and retries on request", async () => {
  const listEditorAssets = mock(async () => {
    throw new Error("offline");
  });
  mount(listEditorAssets);

  expect((await screen.findByRole("alert")).textContent).toContain("Assets are unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Retry loading assets" }));
  await waitFor(() => expect(listEditorAssets).toHaveBeenCalledTimes(2));
});
