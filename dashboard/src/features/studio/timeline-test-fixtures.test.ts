/// <reference types="bun-types" />

import { expect, test } from "bun:test";

import { typedTimelineDocument } from "./timeline-test-fixtures";

/**
 * The typed fixture is shared preview evidence, so it has to be a document the
 * Python domain would accept, not merely one TypeScript's types allow.
 */
test("the typed fixture keeps a contiguous scene strip inside its canvas", () => {
  const document = typedTimelineDocument();
  expect(document.scenes.length).toBeGreaterThan(0);

  let expectedStart = 0;
  for (const scene of document.scenes) {
    expect(scene.start_frame).toBe(expectedStart);
    expect(scene.duration_in_frames).toBeGreaterThan(0);
    expectedStart += scene.duration_in_frames;
  }
  expect(expectedStart).toBeLessThanOrEqual(document.canvas.duration_in_frames);
});

test("every typed scene names one existing clip that stays inside it", () => {
  const document = typedTimelineDocument();
  const clips = document.clips ?? [];

  for (const scene of document.scenes) {
    expect(scene.clip_ids).toHaveLength(1);
    const named = clips.find((clip) => clip.clip_id === scene.clip_ids[0]);
    expect(named).toBeDefined();
    expect(named?.scene_id).toBe(scene.scene_id);

    for (const clip of clips.filter((entry) => entry.scene_id === scene.scene_id)) {
      expect(clip.from_frame).toBeGreaterThanOrEqual(scene.start_frame);
      expect(clip.from_frame + clip.duration_in_frames).toBeLessThanOrEqual(
        scene.start_frame + scene.duration_in_frames,
      );
    }
  }
});
