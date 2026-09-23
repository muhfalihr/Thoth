import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ReleaseCapsuleInvalid,
  canonicalReleaseRoot,
  loadReleaseCapsule,
  releaseIdentityOf,
  type ReleaseIdentity,
} from "./release-capsule";

const IDENTITY: ReleaseIdentity = "vertical_text_story-v1";
const IMAGE = "image-bytes";
const VIDEO = "video-bytes";

let root: string;

function digest(payload: string): string {
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}

function capsuleDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 2,
    document_id: "doc_release",
    project_id: "project_release",
    revision: 1,
    canvas: { width: 1080, height: 1920, fps: 30, duration_in_frames: 90 },
    template: { template_id: "vertical_text_story", version: 1 },
    scenes: [
      {
        scene_id: "scene_001",
        role: "source",
        start_frame: 0,
        duration_in_frames: 90,
        clip_ids: ["clip_main"],
      },
    ],
    asset_refs: [
      {
        asset_id: "asset_image",
        project_id: "project_release",
        kind: "image",
        has_audio: false,
        validation_state: "ready",
      },
      {
        asset_id: "asset_video",
        project_id: "project_release",
        kind: "video",
        has_audio: false,
        validation_state: "ready",
      },
    ],
    tracks: [
      {
        track_id: "track_main",
        kind: "main_video",
        label: "Main video",
        order: 0,
        hidden: false,
        muted: false,
        locked: false,
        clip_ids: ["clip_main", "clip_still"],
      },
    ],
    clips: [
      {
        kind: "video",
        clip_id: "clip_main",
        track_id: "track_main",
        asset_id: "asset_video",
        from_frame: 0,
        duration_in_frames: 45,
        source_from_frame: 0,
        ownership: "ai_managed",
        hidden: false,
        locked: false,
        fit: "cover",
      },
      {
        kind: "video",
        clip_id: "clip_still",
        track_id: "track_main",
        asset_id: "asset_image",
        from_frame: 45,
        duration_in_frames: 45,
        source_from_frame: 0,
        ownership: "ai_managed",
        hidden: false,
        locked: false,
        fit: "cover",
      },
    ],
    ...overrides,
  };
}

function release(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    template_id: "vertical_text_story",
    template_version: 1,
    composition_id: "advanced-timeline-v1",
    document: "document.json",
    assets: [
      { asset_id: "asset_image", file: "assets/image.png", sha256: digest(IMAGE) },
      { asset_id: "asset_video", file: "assets/video.mp4", sha256: digest(VIDEO) },
    ],
    frames: [0, 30, 60, 89],
    ...overrides,
  };
}

/** One complete capsule below a temporary canonical release root. */
function writeCapsule(options: {
  release?: Record<string, unknown>;
  document?: Record<string, unknown>;
  identity?: string;
} = {}): void {
  const directory = join(root, options.identity ?? IDENTITY);
  // Start from nothing, so one case's tampering cannot mask the next case's.
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(join(directory, "assets"), { recursive: true });
  writeFileSync(join(directory, "release.json"), JSON.stringify(options.release ?? release()));
  writeFileSync(
    join(directory, "document.json"),
    JSON.stringify(options.document ?? capsuleDocument()),
  );
  writeFileSync(join(directory, "assets", "image.png"), IMAGE);
  writeFileSync(join(directory, "assets", "video.mp4"), VIDEO);
}

function writeManifest(value: unknown, set = `sha256-${"a".repeat(64)}`): void {
  const directory = join(root, IDENTITY);
  const setDirectory = join(directory, "golden-sets", set);
  mkdirSync(setDirectory, { recursive: true });
  for (const frame of [0, 30, 60, 89]) {
    const name = String(frame).padStart(6, "0");
    writeFileSync(join(setDirectory, `frame-${name}-preview.png`), "preview");
    writeFileSync(join(setDirectory, `frame-${name}-render.png`), "render");
  }
  writeFileSync(join(directory, "golden-manifest.json"), JSON.stringify(value));
}

function goldenManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    golden_set: `sha256-${"a".repeat(64)}`,
    frames: [0, 30, 60, 89].map((frame) => {
      const name = String(frame).padStart(6, "0");
      return {
        frame,
        preview: `frame-${name}-preview.png`,
        render: `frame-${name}-render.png`,
      };
    }),
    ...overrides,
  };
}

function load() {
  return loadReleaseCapsule(IDENTITY, { releaseRoot: root });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "thoth-release-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("loadReleaseCapsule", () => {
  test("reads the one allowlisted capsule and its resolved inputs", async () => {
    writeCapsule();
    const capsule = await load();

    expect(capsule.identity).toBe(IDENTITY);
    expect(capsule.template_id).toBe("vertical_text_story");
    expect(capsule.template_version).toBe(1);
    expect(capsule.composition_id).toBe("advanced-timeline-v1");
    expect(capsule.frames).toEqual([0, 30, 60, 89]);
    expect(capsule.directory).toBe(join(root, IDENTITY));
    expect(capsule.assets.map((asset) => asset.asset_id)).toEqual(["asset_image", "asset_video"]);
    expect(capsule.assets[0]!.path).toBe(join(root, IDENTITY, "assets", "image.png"));
    expect(capsule.document.document_id).toBe("doc_release");
    // No golden manifest has been promoted yet, and that is not a parse failure.
    expect(capsule.goldens).toBeNull();
  });

  test("derives its canonical root from the repository, not from the environment", () => {
    const canonical = canonicalReleaseRoot();
    expect(canonical.endsWith(join("packages", "remotion-composition", "releases"))).toBe(true);

    // Nothing a process is handed can move the production lookup.
    const previous = process.env.THOTH_RELEASE_ROOT;
    process.env.THOTH_RELEASE_ROOT = join(root, "attacker");
    expect(canonicalReleaseRoot()).toBe(canonical);
    if (previous === undefined) delete process.env.THOTH_RELEASE_ROOT;
    else process.env.THOTH_RELEASE_ROOT = previous;
  });

  test("accepts only the allowlisted release identity", async () => {
    writeCapsule();
    const hostile = [
      "..",
      "../vertical_text_story-v1",
      "/etc",
      "vertical_text_story-v2",
      "vertical_text_story",
      "",
      ".",
      `vertical_text_story-v1${String.fromCharCode(92)}..`,
      "vertical_text_story-v1/../../etc",
    ];
    for (const identity of hostile) {
      expect(() => releaseIdentityOf(identity)).toThrow(ReleaseCapsuleInvalid);
      await expect(
        loadReleaseCapsule(identity as ReleaseIdentity, { releaseRoot: root }),
      ).rejects.toBeInstanceOf(ReleaseCapsuleInvalid);
    }
    expect(releaseIdentityOf(IDENTITY)).toBe(IDENTITY);
  });

  test("refuses a release.json carrying an unknown or missing field", async () => {
    writeCapsule({ release: { ...release(), unexpected: true } });
    await expect(load()).rejects.toBeInstanceOf(ReleaseCapsuleInvalid);

    const { frames: _omitted, ...withoutFrames } = release();
    writeCapsule({ release: withoutFrames });
    await expect(load()).rejects.toBeInstanceOf(ReleaseCapsuleInvalid);
  });

  test("refuses a release whose identity contradicts the capsule or the composition", async () => {
    const contradictions: Record<string, unknown>[] = [
      { schema_version: 2 },
      { template_id: "another_template" },
      { template_version: 2 },
      { composition_id: "some-other-composition" },
    ];
    for (const contradiction of contradictions) {
      writeCapsule({ release: { ...release(), ...contradiction } });
      await expect(load()).rejects.toBeInstanceOf(ReleaseCapsuleInvalid);
    }
  });

  test("refuses a document that contradicts the released template", async () => {
    writeCapsule({
      document: capsuleDocument({ template: { template_id: "other_story", version: 1 } }),
    });
    await expect(load()).rejects.toBeInstanceOf(ReleaseCapsuleInvalid);

    // Anything the control plane's own schema would reject is rejected here too.
    writeCapsule({ document: capsuleDocument({ schema_version: 1 }) });
    await expect(load()).rejects.toBeInstanceOf(ReleaseCapsuleInvalid);
  });

  test("refuses an absolute, traversing, or nested capsule-relative name", async () => {
    const hostile = [
      "/etc/passwd",
      "../../etc/passwd",
      "assets/../../escape.png",
      `assets${String.fromCharCode(92)}image.png`,
      "assets/nested/image.png",
      "image.png",
      "",
    ];
    for (const file of hostile) {
      writeCapsule({
        release: {
          ...release(),
          assets: [{ asset_id: "asset_image", file, sha256: digest(IMAGE) }],
        },
      });
      await expect(load()).rejects.toBeInstanceOf(ReleaseCapsuleInvalid);
    }

    for (const document of ["/etc/passwd", "../document.json", "nested/document.json"]) {
      writeCapsule({ release: { ...release(), document } });
      await expect(load()).rejects.toBeInstanceOf(ReleaseCapsuleInvalid);
    }
  });

  test("refuses an input reached through a linked directory", async () => {
    writeCapsule();
    const outside = join(root, "outside");
    mkdirSync(outside, { recursive: true });
    // The linked directory holds exactly the declared assets, byte for byte, so
    // only the link itself can be the reason this capsule is refused.
    writeFileSync(join(outside, "image.png"), IMAGE);
    writeFileSync(join(outside, "video.mp4"), VIDEO);
    rmSync(join(root, IDENTITY, "assets"), { recursive: true, force: true });
    symlinkSync(outside, join(root, IDENTITY, "assets"), "junction");
    await expect(load()).rejects.toBeInstanceOf(ReleaseCapsuleInvalid);
  });

  test("refuses an input reached through a linked file", async () => {
    writeCapsule();
    const outside = join(root, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "image.png"), IMAGE);
    const path = join(root, IDENTITY, "assets", "image.png");
    rmSync(path);
    try {
      symlinkSync(join(outside, "image.png"), path, "file");
    } catch {
      // Creating a file symlink is a privilege on Windows, not a capability the
      // parser depends on. The linked-directory case above covers the same walk
      // everywhere, and this case runs in the Linux reference image and in CI.
      return;
    }
    await expect(load()).rejects.toBeInstanceOf(ReleaseCapsuleInvalid);
  });

  test("refuses a missing, extra, resized, or rewritten asset", async () => {
    writeCapsule();
    rmSync(join(root, IDENTITY, "assets", "video.mp4"));
    await expect(load()).rejects.toBeInstanceOf(ReleaseCapsuleInvalid);

    // A file the capsule never declared is a rejection, not an ignored extra.
    writeCapsule();
    writeFileSync(join(root, IDENTITY, "assets", "stowaway.png"), "stowaway");
    await expect(load()).rejects.toBeInstanceOf(ReleaseCapsuleInvalid);

    writeCapsule();
    writeFileSync(join(root, IDENTITY, "assets", "image.png"), "tampered");
    await expect(load()).rejects.toBeInstanceOf(ReleaseCapsuleInvalid);
  });

  test("refuses a checksum that is not one lowercase sha256 digest", async () => {
    for (const sha256 of [
      digest(IMAGE).toUpperCase(),
      digest(IMAGE).slice("sha256:".length),
      `md5:${"a".repeat(32)}`,
      `sha256:${"a".repeat(63)}`,
      "",
    ]) {
      writeCapsule({
        release: {
          ...release(),
          assets: [{ asset_id: "asset_image", file: "assets/image.png", sha256 }],
        },
      });
      await expect(load()).rejects.toBeInstanceOf(ReleaseCapsuleInvalid);
    }
  });

  test("refuses a frame list that is empty, unordered, duplicated, or out of range", async () => {
    for (const frames of [[], [30, 0], [0, 0], [0, 90], [-1], [1.5], [0, 30, "60"]]) {
      writeCapsule({ release: { ...release(), frames } });
      await expect(load()).rejects.toBeInstanceOf(ReleaseCapsuleInvalid);
    }
  });

  test("reads a promoted golden manifest and binds it to one immutable set", async () => {
    writeCapsule();
    writeManifest(goldenManifest());
    const capsule = await load();

    expect(capsule.goldens?.golden_set).toBe(`sha256-${"a".repeat(64)}`);
    expect(capsule.goldens?.directory).toBe(
      join(root, IDENTITY, "golden-sets", `sha256-${"a".repeat(64)}`),
    );
    expect(capsule.goldens?.frames.map((entry) => entry.frame)).toEqual([0, 30, 60, 89]);
  });

  test("refuses a manifest that escapes its capsule or names an unknown set", async () => {
    for (const golden_set of [
      "../../escape",
      "/etc",
      `..${String.fromCharCode(92)}escape`,
      `sha256-${"a".repeat(64)}/nested`,
      "sha256-not-a-digest",
      `sha256-${"b".repeat(64)}`,
    ]) {
      writeCapsule();
      writeManifest(goldenManifest({ golden_set }));
      await expect(load()).rejects.toBeInstanceOf(ReleaseCapsuleInvalid);
    }
  });

  test("refuses a manifest whose frame set does not match the release", async () => {
    const complete = goldenManifest().frames as { frame: number }[];
    const cases: unknown[] = [
      goldenManifest({ frames: complete.slice(0, 3) }),
      goldenManifest({
        frames: [...complete, { frame: 89, preview: "x-preview.png", render: "x-render.png" }],
      }),
      goldenManifest({ schema_version: 2 }),
      goldenManifest({ unexpected: true }),
      goldenManifest({
        frames: complete.map((entry) => ({ ...entry, preview: "../escape.png" })),
      }),
    ];
    for (const manifest of cases) {
      writeCapsule();
      writeManifest(manifest);
      await expect(load()).rejects.toBeInstanceOf(ReleaseCapsuleInvalid);
    }
  });

  test("refuses a manifest whose declared golden file is missing", async () => {
    writeCapsule();
    writeManifest(goldenManifest());
    rmSync(join(root, IDENTITY, "golden-sets", `sha256-${"a".repeat(64)}`, "frame-000030-render.png"));
    await expect(load()).rejects.toBeInstanceOf(ReleaseCapsuleInvalid);
  });

  test("never repeats an offending value in its failure", async () => {
    writeCapsule({
      release: { ...release(), document: "/etc/shadow-secret-value" },
    });
    const failure = await load().catch((error) => error);
    expect(failure).toBeInstanceOf(ReleaseCapsuleInvalid);
    expect(String(failure)).not.toContain("shadow-secret-value");
    expect(String(failure)).not.toContain(root);
  });
});
