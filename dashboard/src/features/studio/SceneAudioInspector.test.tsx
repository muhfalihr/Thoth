/// <reference types="bun-types" />

import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { EditDocumentOperation, EditDocumentV2, EditorAsset } from "@/api/control-plane";
import { SceneAudioInspector } from "./SceneAudioInspector";
import { typedTimelineDocument } from "./timeline-test-fixtures";

afterEach(() => cleanup());

const voice: EditorAsset = {
  asset_id: "asset_voice",
  project_id: "project_001",
  kind: "audio",
  media_type: "audio/mpeg",
  has_audio: true,
  validation_state: "ready",
  duration_in_frames: 400,
};

/** Two ten-second scenes: the fixture's music clip plays under the first only. */
function twoSceneDocument(): EditDocumentV2 {
  const document = typedTimelineDocument();
  document.scenes = [
    { scene_id: "scene_001", role: "source", start_frame: 0, duration_in_frames: 300, clip_ids: ["clip_a"] },
    { scene_id: "scene_002", role: "source", start_frame: 300, duration_in_frames: 300, clip_ids: [] },
  ];
  return document;
}

function renderInspector(document = twoSceneDocument(), sceneId = "scene_001", assets: EditorAsset[] = [voice]) {
  const onOperation = mock((_operation: EditDocumentOperation) => {});
  render(
    <SceneAudioInspector
      document={document}
      selectedSceneId={sceneId}
      assets={assets}
      onOperation={onOperation}
      disabled={false}
    />,
  );
  return onOperation;
}

test("audio under the scene can change volume and mute its lane", () => {
  const onOperation = renderInspector();
  const clip = within(screen.getByRole("group", { name: "Music 0.0s–5.0s" }));
  const volume = clip.getByLabelText("Volume") as HTMLInputElement;
  expect(volume.value).toBe("0.4");

  fireEvent.change(volume, { target: { value: "0.7" } });
  fireEvent.click(clip.getByLabelText("Mute Music lane"));

  expect(onOperation.mock.calls.map(([operation]) => operation)).toEqual([
    { kind: "set_clip_volume", operation_id: expect.any(String), clip_id: "clip_audio", volume: 0.7 },
    { kind: "set_track_muted", operation_id: expect.any(String), track_id: "track_music", muted: true },
  ]);
});

test("a ready audio asset is attached to the scene on the chosen lane", () => {
  const onOperation = renderInspector(twoSceneDocument(), "scene_002");
  expect(screen.getByText("No audio in this scene.")).toBeDefined();
  expect((screen.getByLabelText("Audio lane") as HTMLSelectElement).value).toBe("track_music");

  fireEvent.click(screen.getByRole("button", { name: "Add audio to scene" }));

  expect(onOperation.mock.calls[0]![0]).toEqual({
    kind: "add_clip_from_asset",
    operation_id: expect.any(String),
    clip_id: expect.stringMatching(/^clip_/),
    track_id: "track_music",
    asset_id: "asset_voice",
    scene_id: "scene_002",
    from_frame: 300,
    duration_in_frames: 300,
    source_from_frame: 0,
  });
});

test("audio that is not ready or not audio is never offered", () => {
  renderInspector(twoSceneDocument(), "scene_002", [
    { ...voice, asset_id: "asset_pending", validation_state: "pending" },
    { ...voice, asset_id: "asset_clip", kind: "video", media_type: "video/mp4" },
  ]);
  expect(screen.getByText("No ready audio in this project yet.")).toBeDefined();
  expect(screen.queryByRole("button", { name: "Add audio to scene" }) === null).toBe(true);
});

test("an asset the draft refuses is reported instead of sent", () => {
  const onOperation = renderInspector(twoSceneDocument(), "scene_002", [{ ...voice, project_id: "project_other" }]);

  fireEvent.click(screen.getByRole("button", { name: "Add audio to scene" }));

  expect(onOperation).toHaveBeenCalledTimes(0);
  expect(screen.getByRole("alert").textContent).toContain("asset belongs to another project");
});

test("a locked audio lane is read-only and says why", () => {
  const document = twoSceneDocument();
  document.tracks.find((track) => track.track_id === "track_music")!.locked = true;
  renderInspector(document);

  const clip = within(screen.getByRole("group", { name: "Music 0.0s–5.0s" }));
  expect((clip.getByLabelText("Volume") as HTMLInputElement).disabled).toBe(true);
  expect((clip.getByLabelText("Mute Music lane") as HTMLInputElement).disabled).toBe(true);
  expect(clip.getByText("This audio is locked. Unlock it on a desktop timeline to edit.")).toBeDefined();
  expect(screen.getByText("No unlocked audio lane. Unlock one on a desktop timeline to add audio.")).toBeDefined();
});

test("a failed asset load is reported instead of an empty project", () => {
  render(
    <SceneAudioInspector
      document={twoSceneDocument()}
      selectedSceneId="scene_002"
      assets={[]}
      loadFailed
      onOperation={() => {}}
      disabled={false}
    />,
  );
  expect(screen.getByText("Project audio could not be loaded. Reopen Studio to try again.")).toBeDefined();
  expect(screen.queryByText("No ready audio in this project yet.") === null).toBe(true);
});
