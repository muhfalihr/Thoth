/**
 * The only component in this service allowed to compose or touch a path.
 *
 * Layout below the artifact root the control plane also owns::
 *
 *     work/<render_job_id>/assets/   staged inputs, written by the control plane
 *     temp/<render_job_id>/bundle/   this render's webpack bundle
 *     temp/<render_job_id>/output.mp4  this render, before it is published
 *
 * Identities become path segments only after validation, and every component of
 * a resolved target is re-checked for containment and for symlinks, junctions,
 * and other reparse points immediately before it is read, written, or deleted.
 * The renderer never publishes: it writes one temporary file and reports facts.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, rm, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import type { RenderBundleAsset } from "./contracts";

export class ArtifactPathInvalid extends Error {
  constructor() {
    super("render artifact path invalid");
    this.name = "ArtifactPathInvalid";
  }
}

export class ArtifactUnavailable extends Error {
  constructor() {
    super("render artifact unavailable");
    this.name = "ArtifactUnavailable";
  }
}

/** Identical to the control plane's `OpaqueId`: one safe segment, never a path. */
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
const OUTPUT_NAME = "output.mp4";

/** What the container's own ffprobe reports about a finished render. */
export type MediaProbe = {
  readonly container: string;
  readonly codec: string;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly durationSeconds: number;
  readonly hasAudio: boolean;
  readonly audioCodec: string | null;
};

/** The bounded media facts the control plane persists and publishes. */
export type OutputFacts = {
  readonly media_type: "video/mp4";
  readonly size_bytes: number;
  readonly checksum: string;
  readonly codec: "h264";
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly duration_seconds: number;
  readonly has_audio: boolean;
};

export type ExpectedOutput = {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly durationInFrames: number;
  /** Whether the trusted composition actually produces sound for this document. */
  readonly hasAudio: boolean;
};

/** The one audio codec the standard vertical MP4 preset emits. */
const AUDIO_CODEC = "aac";

export type ProbeMedia = (path: string) => Promise<MediaProbe>;

/** Encoding rounds the last frame, so allow a frame either way, never a scene. */
function durationTolerance(fps: number): number {
  return Math.max(0.5, 2 / fps);
}

async function isLink(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isSymbolicLink();
  } catch {
    return false;
  }
}

async function digestOf(path: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return `sha256:${hash.digest("hex")}`;
}

export class RendererArtifactRoot {
  readonly #root: string;
  readonly #probe: ProbeMedia;

  constructor(root: string, options: { probe: ProbeMedia }) {
    this.#root = resolve(root);
    this.#probe = options.probe;
  }

  assetsDirectory(renderJobId: string): string {
    return this.#contained("work", this.#identifier(renderJobId), "assets");
  }

  bundleDirectory(renderJobId: string): string {
    return this.#contained("temp", this.#identifier(renderJobId), "bundle");
  }

  temporaryOutput(renderJobId: string): string {
    return this.#contained("temp", this.#identifier(renderJobId), OUTPUT_NAME);
  }

  /** Give this render an empty bundle directory and no output to inherit. */
  async prepare(renderJobId: string): Promise<void> {
    const bundle = this.bundleDirectory(renderJobId);
    await this.#assertLinkFree(bundle);
    await rm(bundle, { recursive: true, force: true });
    await mkdir(bundle, { recursive: true });
    await this.removeTemporaryOutput(renderJobId);
  }

  /** Confirm every staged input is still exactly the file the bundle describes. */
  async verifyStagedAssets(
    renderJobId: string,
    assets: readonly RenderBundleAsset[],
  ): Promise<void> {
    const directory = this.assetsDirectory(renderJobId);
    for (const asset of assets) {
      const name = asset.relative_name.slice("assets/".length);
      const path = join(directory, name);
      await this.#assertLinkFree(path);
      let info: Awaited<ReturnType<typeof stat>>;
      try {
        info = await stat(path);
      } catch {
        throw new ArtifactUnavailable();
      }
      if (!info.isFile() || info.size !== asset.size_bytes) {
        throw new ArtifactUnavailable();
      }
      if ((await digestOf(path)) !== asset.checksum) {
        throw new ArtifactUnavailable();
      }
    }
  }

  /** Remove this render's temporary output, whether or not one exists. */
  async removeTemporaryOutput(renderJobId: string): Promise<void> {
    const path = this.temporaryOutput(renderJobId);
    await this.#assertLinkFree(path);
    await rm(path, { force: true });
  }

  /** Measure the finished render, refusing anything the preset did not promise. */
  async verifyTemporaryOutput(
    renderJobId: string,
    expected: ExpectedOutput,
  ): Promise<OutputFacts> {
    const path = this.temporaryOutput(renderJobId);
    await this.#assertLinkFree(path);
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(path);
    } catch {
      throw new ArtifactUnavailable();
    }
    if (!info.isFile() || info.size <= 0) {
      throw new ArtifactUnavailable();
    }

    const probe = await this.#probe(path);
    const expectedSeconds = expected.durationInFrames / expected.fps;
    if (
      probe.container !== "mp4" ||
      probe.codec !== "h264" ||
      probe.width !== expected.width ||
      probe.height !== expected.height ||
      probe.fps !== expected.fps ||
      Math.abs(probe.durationSeconds - expectedSeconds) > durationTolerance(expected.fps)
    ) {
      throw new ArtifactUnavailable();
    }
    // A document with audible content must arrive as AAC, and one without must
    // carry no audio track at all: a silent track is as wrong as a missing one.
    if (probe.hasAudio !== expected.hasAudio) {
      throw new ArtifactUnavailable();
    }
    if (expected.hasAudio && probe.audioCodec !== AUDIO_CODEC) {
      throw new ArtifactUnavailable();
    }

    return {
      media_type: "video/mp4",
      size_bytes: info.size,
      checksum: await digestOf(path),
      codec: "h264",
      width: probe.width,
      height: probe.height,
      fps: probe.fps,
      duration_seconds: probe.durationSeconds,
      has_audio: probe.hasAudio,
    };
  }

  #identifier(value: string): string {
    if (typeof value !== "string" || !IDENTIFIER.test(value)) {
      throw new ArtifactPathInvalid();
    }
    return value;
  }

  /** Join validated segments and prove the result stays below the root. */
  #contained(...segments: string[]): string {
    const candidate = join(this.#root, ...segments);
    if (candidate !== this.#root && !candidate.startsWith(this.#root + sep)) {
      throw new ArtifactPathInvalid();
    }
    return candidate;
  }

  /** Refuse a target reached through a link at any level below the root. */
  async #assertLinkFree(path: string): Promise<void> {
    const relative = path.slice(this.#root.length + 1);
    let current = this.#root;
    for (const segment of relative.split(sep)) {
      current = join(current, segment);
      if (await isLink(current)) {
        throw new ArtifactPathInvalid();
      }
    }
  }
}

/** Read the container's own ffprobe, the only media authority this service has. */
export const probeWithFfprobe: ProbeMedia = async (path: string) => {
  const process = Bun.spawn(
    [
      "ffprobe",
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      path,
    ],
    { stdout: "pipe", stderr: "ignore" },
  );
  const [text, code] = await Promise.all([new Response(process.stdout).text(), process.exited]);
  if (code !== 0) {
    throw new ArtifactUnavailable();
  }

  let parsed: {
    format?: { format_name?: string; duration?: string };
    streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; avg_frame_rate?: string }[];
  };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ArtifactUnavailable();
  }

  const streams = parsed.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.find((stream) => stream.codec_type === "audio");
  if (!video || video.width === undefined || video.height === undefined) {
    throw new ArtifactUnavailable();
  }
  const [numerator, denominator] = (video.avg_frame_rate ?? "0/1").split("/").map(Number);
  if (!numerator || !denominator) {
    throw new ArtifactUnavailable();
  }

  return {
    // ffprobe reports a family such as "mov,mp4,m4a,3gp,3g2,mj2" for MP4.
    container: (parsed.format?.format_name ?? "").split(",").includes("mp4") ? "mp4" : "unknown",
    codec: video.codec_name ?? "unknown",
    width: video.width,
    height: video.height,
    fps: numerator / denominator,
    durationSeconds: Number(parsed.format?.duration ?? "0"),
    hasAudio: audio !== undefined,
    audioCodec: audio?.codec_name ?? null,
  };
};
