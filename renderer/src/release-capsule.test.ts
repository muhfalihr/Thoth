import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

/**
 * What the golden files below address to, computed here rather than imported,
 * so the parser's own idea of the name is checked against an independent one.
 */
function goldenAddress(): string {
  const hash = createHash("sha256");
  for (const frame of [0, 30, 60, 89]) {
    hash.update(`${frame} ${digest("preview")} ${digest("render")}\n`);
  }
  return `sha256-${hash.digest("hex")}`;
}

function writeManifest(value: unknown, set = goldenAddress()): void {
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
    golden_set: goldenAddress(),
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

  test("carries the exact bytes of the document it read", async () => {
    writeCapsule();
    const capsule = await load();
    const bytes = readFileSync(join(root, IDENTITY, "document.json"));

    expect(capsule.document_sha256).toBe(
      `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    );

    // The same document with one value changed is a different capsule identity,
    // even though every other declared fact about it is unchanged.
    writeCapsule({ document: capsuleDocument({ revision: 2 }) });
    expect((await load()).document_sha256).not.toBe(capsule.document_sha256);
  });

  test("parses and hashes the document from one identical read", async () => {
    writeCapsule();
    const documentPath = join(root, IDENTITY, "document.json");
    const approved = readFileSync(documentPath);
    // What a second read could hand back: a document nobody validated.
    const swapped = Buffer.from(JSON.stringify(capsuleDocument({ revision: 2 })));

    const served: Buffer[] = [];
    const capsule = await loadReleaseCapsule(IDENTITY, {
      releaseRoot: root,
      readBytes: async (path: string) => {
        if (path !== documentPath) {
          return readFileSync(path);
        }
        const bytes = served.length === 0 ? approved : swapped;
        served.push(bytes);
        return bytes;
      },
    });

    // One read, so the bytes that were parsed are the bytes that were hashed.
    expect(served).toHaveLength(1);
    expect(capsule.document.revision).toBe(1);
    expect(capsule.document_sha256).toBe(
      `sha256:${createHash("sha256").update(approved).digest("hex")}`,
    );
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

    expect(capsule.goldens?.golden_set).toBe(goldenAddress());
    expect(capsule.goldens?.directory).toBe(
      join(root, IDENTITY, "golden-sets", goldenAddress()),
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
    rmSync(join(root, IDENTITY, "golden-sets", goldenAddress(), "frame-000030-render.png"));
    await expect(load()).rejects.toBeInstanceOf(ReleaseCapsuleInvalid);
  });

  test("refuses an approved golden file that was rewritten under its own name", async () => {
    writeCapsule();
    writeManifest(goldenManifest());
    writeFileSync(
      join(root, IDENTITY, "golden-sets", goldenAddress(), "frame-000030-render.png"),
      "render-but-not-quite",
    );
    await expect(load()).rejects.toBeInstanceOf(ReleaseCapsuleInvalid);
  });

  test("refuses a golden set holding a file nobody approved", async () => {
    writeCapsule();
    writeManifest(goldenManifest());
    writeFileSync(
      join(root, IDENTITY, "golden-sets", goldenAddress(), "frame-000030-extra.png"),
      "render",
    );
    await expect(load()).rejects.toBeInstanceOf(ReleaseCapsuleInvalid);
  });

  test("refuses approved pixels kept under a name that is not their address", async () => {
    writeCapsule();
    const renamed = `sha256-${"c".repeat(64)}`;
    writeManifest(goldenManifest({ golden_set: renamed }), renamed);
    await expect(load()).rejects.toBeInstanceOf(ReleaseCapsuleInvalid);
  });

  test("refuses a link beside the approved golden files", async () => {
    writeCapsule();
    writeManifest(goldenManifest());
    const outside = join(root, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "render.png"), "render");
    symlinkSync(outside, join(root, IDENTITY, "golden-sets", goldenAddress(), "linked"), "junction");
    await expect(load()).rejects.toBeInstanceOf(ReleaseCapsuleInvalid);
  });

  test("refuses an approved golden file reached through a link", async () => {
    writeCapsule();
    writeManifest(goldenManifest());
    const outside = join(root, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "render.png"), "render");
    const path = join(root, IDENTITY, "golden-sets", goldenAddress(), "frame-000030-render.png");
    rmSync(path);
    try {
      symlinkSync(join(outside, "render.png"), path, "file");
    } catch {
      // A file symlink is a Windows privilege, not a capability this check
      // depends on: the linked directory above walks the same guard everywhere.
      return;
    }
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

/**
 * The capsule this repository actually ships, read from where it really lives.
 *
 * Every other case writes a capsule to prove the parser; this one proves the
 * tracked fixture is a capsule, because a release that stops loading is a
 * release nobody can compare a render against.
 */
describe("the tracked release capsule", () => {
  test("loads from the canonical release root with its approved golden set", async () => {
    const capsule = await loadReleaseCapsule(IDENTITY);

    expect(capsule.identity).toBe(IDENTITY);
    expect(capsule.composition_id).toBe("advanced-timeline-v1");
    expect(capsule.directory).toBe(join(canonicalReleaseRoot(), IDENTITY));
    expect(capsule.assets.length).toBeGreaterThan(0);
    // The ends of the timeline are where a one-frame drift shows, so both are
    // compared: the first frame and the last one the canvas has.
    const duration = (capsule.document.canvas as { duration_in_frames: number }).duration_in_frames;
    expect(capsule.frames.at(0)).toBe(0);
    expect(capsule.frames.at(-1)).toBe(duration - 1);
    expect(capsule.frames.length).toBeGreaterThan(2);
    // A tracked golden set is an operator's approval, not a build product: it
    // covers every declared frame, under the name its own pixels address.
    const manifest = JSON.parse(readFileSync(join(capsule.directory, "golden-manifest.json"), "utf8"));
    expect(capsule.goldens?.golden_set).toBe(manifest.golden_set);
    expect(capsule.goldens?.frames.map((entry) => entry.frame)).toEqual([...capsule.frames]);
  });

  test("names no source the composition would have to fetch", async () => {
    const capsule = await loadReleaseCapsule(IDENTITY);
    const declared = readFileSync(join(capsule.directory, "release.json"), "utf8");
    const document = JSON.stringify(capsule.document);

    for (const text of [declared, document]) {
      expect(text).not.toMatch(/https?:|\/\/|data:|blob:|file:/);
    }
  });

  test("draws content a renderer must hide, mute, and lay over", async () => {
    const capsule = await loadReleaseCapsule(IDENTITY);
    const tracks = capsule.document.tracks as { hidden?: boolean; muted?: boolean }[];
    const clips = capsule.document.clips as { kind: string; hidden?: boolean }[];

    expect(tracks.some((track) => track.hidden === true)).toBe(true);
    expect(tracks.some((track) => track.muted === true)).toBe(true);
    expect(clips.some((clip) => clip.hidden === true)).toBe(true);
    // Both weights, both media kinds, and both timed lanes are worth comparing.
    expect(new Set(clips.map((clip) => clip.kind))).toEqual(
      new Set(["text", "video", "overlay", "caption", "audio"]),
    );
  });
});
