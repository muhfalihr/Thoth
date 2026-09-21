import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ArtifactPathInvalid,
  ArtifactUnavailable,
  RendererArtifactRoot,
  type MediaProbe,
} from "./artifact-root";

const EXPECTED = { width: 1080, height: 1920, fps: 30, durationInFrames: 300, hasAudio: false };
/** What the same render looks like when the document really does have sound. */
const EXPECTED_AUDIBLE = { ...EXPECTED, hasAudio: true };
const AAC = { hasAudio: true, audioCodec: "aac" };

const PROBE: MediaProbe = {
  container: "mp4",
  codec: "h264",
  width: 1080,
  height: 1920,
  fps: 30,
  durationSeconds: 10,
  hasAudio: false,
  audioCodec: null,
};

let root: string;

function checksum(payload: string): string {
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}

function artifacts(probe: MediaProbe = PROBE): RendererArtifactRoot {
  return new RendererArtifactRoot(root, { probe: async () => probe });
}

function stageAsset(job: string, name: string, payload: string): void {
  mkdirSync(join(root, "work", job, "assets"), { recursive: true });
  writeFileSync(join(root, "work", job, "assets", name), payload);
}

function writeTemporaryOutput(job: string, payload: string): void {
  mkdirSync(join(root, "temp", job), { recursive: true });
  writeFileSync(join(root, "temp", job, "output.mp4"), payload);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "thoth-renderer-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("RendererArtifactRoot", () => {
  test("addresses only the canonical E1 locations", () => {
    const local = artifacts();
    expect(local.assetsDirectory("rj_001")).toBe(join(root, "work", "rj_001", "assets"));
    expect(local.bundleDirectory("rj_001")).toBe(join(root, "temp", "rj_001", "bundle"));
    expect(local.temporaryOutput("rj_001")).toBe(join(root, "temp", "rj_001", "output.mp4"));
  });

  test("refuses an identity that could leave the root", () => {
    const local = artifacts();
    const unsafe = ["../escape", "/absolute", "rj/001", `rj${String.fromCharCode(92)}001`, "", "."];
    for (const identity of unsafe) {
      expect(() => local.temporaryOutput(identity)).toThrow(ArtifactPathInvalid);
      expect(() => local.assetsDirectory(identity)).toThrow(ArtifactPathInvalid);
    }
  });

  test("prepare creates the bundle directory and clears a stale output", async () => {
    writeTemporaryOutput("rj_001", "stale");
    const local = artifacts();
    await local.prepare("rj_001");
    expect(await Bun.file(local.temporaryOutput("rj_001")).exists()).toBe(false);
    expect(await Bun.file(join(local.bundleDirectory("rj_001"), ".keep")).exists()).toBe(false);
    writeFileSync(join(local.bundleDirectory("rj_001"), "probe"), "ok");
    expect(await Bun.file(join(local.bundleDirectory("rj_001"), "probe")).exists()).toBe(true);
  });

  test("accepts staged assets whose bytes match the bundle checksums", async () => {
    stageAsset("rj_001", "asset_1.mp4", "payload");
    await artifacts().verifyStagedAssets("rj_001", [
      {
        asset_id: "asset_1",
        relative_name: "assets/asset_1.mp4",
        size_bytes: 7,
        checksum: checksum("payload"),
      },
    ]);
  });

  test("refuses a staged asset that is missing, resized, or rewritten", async () => {
    const local = artifacts();
    const asset = {
      asset_id: "asset_1",
      relative_name: "assets/asset_1.mp4",
      size_bytes: 7,
      checksum: checksum("payload"),
    };
    await expect(local.verifyStagedAssets("rj_001", [asset])).rejects.toBeInstanceOf(
      ArtifactUnavailable,
    );
    stageAsset("rj_001", "asset_1.mp4", "tampered");
    await expect(local.verifyStagedAssets("rj_001", [asset])).rejects.toBeInstanceOf(
      ArtifactUnavailable,
    );
  });

  test("refuses a staged asset reached through a link", async () => {
    const outside = join(root, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "asset_1.mp4"), "payload");
    mkdirSync(join(root, "work", "rj_001"), { recursive: true });
    symlinkSync(outside, join(root, "work", "rj_001", "assets"), "junction");

    await expect(
      artifacts().verifyStagedAssets("rj_001", [
        {
          asset_id: "asset_1",
          relative_name: "assets/asset_1.mp4",
          size_bytes: 7,
          checksum: checksum("payload"),
        },
      ]),
    ).rejects.toBeInstanceOf(ArtifactPathInvalid);
  });

  test("claims a dispatch once, below the root, and replays every repeat", async () => {
    const local = artifacts();
    expect(await local.claimDispatch("rj_001", "dsp_001")).toBe("claimed");
    expect(await local.claimDispatch("rj_001", "dsp_001")).toBe("replay");
    // A different dispatch of the same job, and the same dispatch identifier
    // under another job, are both genuinely new work.
    expect(await local.claimDispatch("rj_001", "dsp_002")).toBe("claimed");
    expect(await local.claimDispatch("rj_002", "dsp_001")).toBe("claimed");

    expect(
      await Bun.file(join(root, "temp", "rj_001", "claims", "dsp_001.claimed")).exists(),
    ).toBe(true);
  });

  test("a claim outlives the process that wrote it", async () => {
    expect(await artifacts().claimDispatch("rj_001", "dsp_001")).toBe("claimed");
    // A restarted renderer is a new object over the same artifact root, and
    // remembers nothing but what the filesystem kept for it.
    expect(await artifacts().claimDispatch("rj_001", "dsp_001")).toBe("replay");
  });

  test("exactly one of two concurrent claims of one identity wins", async () => {
    const local = artifacts();
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () => local.claimDispatch("rj_001", "dsp_001")),
    );
    expect(outcomes.filter((outcome) => outcome === "claimed")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === "replay")).toHaveLength(7);
  });

  test("refuses an identity that could leave the root, and a claim that is not a file", async () => {
    const local = artifacts();
    for (const identity of ["../escape", "/absolute", "rj/001", `x${String.fromCharCode(92)}y`, ""]) {
      await expect(local.claimDispatch("rj_001", identity)).rejects.toBeInstanceOf(
        ArtifactPathInvalid,
      );
      await expect(local.claimDispatch(identity, "dsp_001")).rejects.toBeInstanceOf(
        ArtifactPathInvalid,
      );
    }

    // A directory, and a link pointing anywhere, are both refused rather than
    // read as somebody else's claim.
    mkdirSync(join(root, "temp", "rj_002", "claims", "dsp_001.claimed"), { recursive: true });
    await expect(local.claimDispatch("rj_002", "dsp_001")).rejects.toBeInstanceOf(
      ArtifactPathInvalid,
    );

    const outside = join(root, "outside");
    mkdirSync(outside, { recursive: true });
    mkdirSync(join(root, "temp", "rj_003", "claims"), { recursive: true });
    symlinkSync(outside, join(root, "temp", "rj_003", "claims", "dsp_001.claimed"), "junction");
    await expect(local.claimDispatch("rj_003", "dsp_001")).rejects.toBeInstanceOf(
      ArtifactPathInvalid,
    );

    // A reparse point standing in for the claims directory itself is refused
    // before anything is created inside it.
    mkdirSync(join(root, "temp", "rj_005"), { recursive: true });
    symlinkSync(outside, join(root, "temp", "rj_005", "claims"), "junction");
    await expect(local.claimDispatch("rj_005", "dsp_001")).rejects.toBeInstanceOf(
      ArtifactPathInvalid,
    );
  });

  test("a claim that cannot be written fails closed with nothing to leak", async () => {
    const local = artifacts();
    // The claims directory cannot be created because a file already occupies
    // the job's temp directory, so no dispatch may be declared started.
    mkdirSync(join(root, "temp"), { recursive: true });
    writeFileSync(join(root, "temp", "rj_004"), "not a directory");

    const failure = await local.claimDispatch("rj_004", "dsp_001").catch((error) => error);
    expect(failure).toBeInstanceOf(ArtifactUnavailable);
    expect(String(failure)).not.toContain(root);
    expect(String(failure)).not.toContain("ENOTDIR");
  });

  test("preparing a render and clearing its output both leave the claim alone", async () => {
    const local = artifacts();
    expect(await local.claimDispatch("rj_001", "dsp_001")).toBe("claimed");
    writeTemporaryOutput("rj_001", "partial");

    await local.prepare("rj_001");
    await local.removeTemporaryOutput("rj_001");

    expect(await local.claimDispatch("rj_001", "dsp_001")).toBe("replay");
  });

  test("removes a partial output and stays quiet when there is nothing to remove", async () => {
    const local = artifacts();
    writeTemporaryOutput("rj_001", "partial");
    await local.removeTemporaryOutput("rj_001");
    expect(await Bun.file(local.temporaryOutput("rj_001")).exists()).toBe(false);
    await local.removeTemporaryOutput("rj_001");
    await local.removeTemporaryOutput("rj_002");
  });

  test("describes a verified output with the facts the control plane publishes", async () => {
    writeTemporaryOutput("rj_001", "rendered-bytes");
    const facts = await artifacts().verifyTemporaryOutput("rj_001", EXPECTED);
    expect(facts).toEqual({
      media_type: "video/mp4",
      size_bytes: 14,
      checksum: checksum("rendered-bytes"),
      codec: "h264",
      width: 1080,
      height: 1920,
      fps: 30,
      duration_seconds: 10,
      has_audio: false,
    });
  });

  test("refuses an output whose media facts contradict the bundle", async () => {
    writeTemporaryOutput("rj_001", "rendered-bytes");
    const contradictions: Partial<MediaProbe>[] = [
      { container: "webm" },
      { codec: "vp9" },
      { width: 720 },
      { height: 1280 },
      { fps: 24 },
      { durationSeconds: 60 },
    ];
    for (const contradiction of contradictions) {
      await expect(
        artifacts({ ...PROBE, ...contradiction }).verifyTemporaryOutput("rj_001", EXPECTED),
      ).rejects.toBeInstanceOf(ArtifactUnavailable);
    }
  });

  test("requires an AAC track exactly when the document has audible content", async () => {
    writeTemporaryOutput("rj_001", "rendered-bytes");

    const audible = await artifacts({ ...PROBE, ...AAC }).verifyTemporaryOutput(
      "rj_001",
      EXPECTED_AUDIBLE,
    );
    expect(audible.has_audio).toBe(true);

    const contradictions: [Partial<MediaProbe>, typeof EXPECTED][] = [
      // Audible content, but the encoder wrote no audio or the wrong codec.
      [{}, EXPECTED_AUDIBLE],
      [{ hasAudio: true, audioCodec: "mp3" }, EXPECTED_AUDIBLE],
      [{ hasAudio: true, audioCodec: null }, EXPECTED_AUDIBLE],
      // Nothing audible, yet the file carries a track anyway.
      [AAC, EXPECTED],
    ];
    for (const [contradiction, expected] of contradictions) {
      await expect(
        artifacts({ ...PROBE, ...contradiction }).verifyTemporaryOutput("rj_001", expected),
      ).rejects.toBeInstanceOf(ArtifactUnavailable);
    }
  });

  test("refuses an output that is empty or absent", async () => {
    const local = artifacts();
    await expect(local.verifyTemporaryOutput("rj_001", EXPECTED)).rejects.toBeInstanceOf(
      ArtifactUnavailable,
    );
    writeTemporaryOutput("rj_001", "");
    await expect(local.verifyTemporaryOutput("rj_001", EXPECTED)).rejects.toBeInstanceOf(
      ArtifactUnavailable,
    );
  });
});
