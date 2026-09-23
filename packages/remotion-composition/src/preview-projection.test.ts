/// <reference types="bun-types" />

import { expect, test } from "bun:test";

import { AdvancedTimelineComposition } from "./AdvancedTimelineComposition";
import { COMPOSITION_FONT_FAMILY, loadCompositionFonts } from "./fonts";
import { playerConfig, timelineComposition } from "./preview-projection";
import type { EditDocumentV2 } from "./timeline";

const document = {
  schema_version: 2,
  document_id: "doc_001",
  project_id: "project_001",
  revision: 1,
  canvas: { width: 1080, height: 1920, fps: 30, duration_in_frames: 300 },
  template: { template_id: "vertical_text_story", version: 1 },
  scenes: [],
  tracks: [],
  clips: [],
  asset_refs: [],
} as unknown as EditDocumentV2;

type RegisteredFace = { family: string; source: string; weight: string | undefined };

/**
 * A browser's font registry, for a runtime that has none.
 *
 * `FontFace` and `document.fonts` are the browser seam the loader is written
 * against; the test runner has neither, so the two are installed here and taken
 * away again. Nothing else about the loader is replaced.
 */
function stubFontRegistry(outcome: "loads" | "fails") {
  const registered: RegisteredFace[] = [];
  const added: unknown[] = [];
  const scope = globalThis as unknown as Record<string, unknown>;
  const previousFontFace = scope.FontFace;
  const previousDocument = scope.document;

  scope.FontFace = class {
    constructor(family: string, source: string, descriptors?: { weight?: string }) {
      registered.push({ family, source, weight: descriptors?.weight });
    }
    load() {
      return outcome === "loads"
        ? Promise.resolve(this)
        : Promise.reject(new Error("font unavailable"));
    }
  };
  scope.document = { fonts: { add: (face: unknown) => added.push(face) } };

  return {
    registered,
    added,
    restore() {
      scope.FontFace = previousFontFace;
      scope.document = previousDocument;
    },
  };
}

test("derives only finite Player timing and geometry from a document's canvas", () => {
  expect(playerConfig(document)).toEqual({
    durationInFrames: 300,
    fps: 30,
    compositionWidth: 1080,
    compositionHeight: 1920,
  });

  for (const broken of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const invalid = {
      ...document,
      canvas: { ...document.canvas, fps: broken },
    } as unknown as EditDocumentV2;
    expect(() => playerConfig(invalid)).toThrow();
  }
});

test("pairs the trusted composition with the document and its preview sources", () => {
  const sources = { asset_still: "/public/still.png" };
  const unavailable: string[] = [];
  const chosen = timelineComposition(document, sources, (assetId) => unavailable.push(assetId));

  expect(chosen.component).toBe(AdvancedTimelineComposition);
  expect(chosen.inputProps.document).toBe(document);
  expect(chosen.inputProps.previewSources).toBe(sources);
  chosen.inputProps.onPreviewUnavailable?.("asset_still");
  expect(unavailable).toEqual(["asset_still"]);
});

test("draws with one private family both surfaces carry their own bytes for", async () => {
  const fonts = stubFontRegistry("loads");
  try {
    expect(COMPOSITION_FONT_FAMILY).toBe("ThothComposition");
    await loadCompositionFonts();

    expect(fonts.registered.map((face) => face.weight)).toEqual(["400", "700"]);
    expect(fonts.added).toHaveLength(2);
    for (const face of fonts.registered) {
      expect(face.family).toBe(COMPOSITION_FONT_FAMILY);
      // A remote face would make the drawn glyphs depend on a network the
      // renderer is not allowed to reach and the preview happens to have.
      expect(face.source).not.toMatch(/https?:|\/\/|data:|blob:/);
    }
  } finally {
    fonts.restore();
  }
});

test("a font that will not load fails instead of drawing a substitute", async () => {
  const fonts = stubFontRegistry("fails");
  try {
    await expect(loadCompositionFonts()).rejects.toThrow();
    expect(fonts.added).toHaveLength(0);
  } finally {
    fonts.restore();
  }
});
