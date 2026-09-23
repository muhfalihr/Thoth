/// <reference types="bun-types" />

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { playerConfig } from "@thoth/remotion-composition";

import { RendererArtifactRoot, type TemplateReleaseRun } from "./artifact-root";
import {
  CaptureIncomplete,
  NetworkNotIsolated,
  assertIsolatedNetwork,
  captureReleaseFrames,
  type SurfaceRequest,
} from "./release-capture";
import { loadReleaseCapsule, type ReleaseCapsule } from "./release-capsule";

let root: string;
let run: TemplateReleaseRun;
let capsule: ReleaseCapsule;
let png: Buffer;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "thoth-capture-"));
  run = await new RendererArtifactRoot(root, {
    probe: async () => {
      throw new Error("no media is probed while capturing frames");
    },
  }).createTemplateReleaseRun("vertical_text_story-v1", "run_capture");
  capsule = await loadReleaseCapsule("vertical_text_story-v1");
  png = readFileSync(capsule.assets.find((asset) => asset.file.endsWith(".png"))!.path);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

type Recorded = {
  readonly calls: string[];
  readonly requests: SurfaceRequest[];
  readonly closed: string[];
  readonly staged: string[][];
};

/**
 * Two surfaces that behave: each writes the image bytes it was asked for.
 *
 * `behaviour` replaces what one surface does at one frame, which is the only
 * way to reach the failures a real browser produces without running one.
 */
function fakeDeps(
  behaviour: Partial<Record<string, (output: string) => void | Promise<void>>> = {},
) {
  const recorded: Recorded = { calls: [], requests: [], closed: [], staged: [] };

  const surface = (name: string) => async (request: SurfaceRequest) => {
    recorded.requests.push(request);
    recorded.staged.push(readdirSync(request.publicDir).sort());
    return {
      async capture(frame: number, output: string) {
        recorded.calls.push(`${name}:${frame}`);
        const custom = behaviour[`${name}:${frame}`];
        if (custom !== undefined) {
          await custom(output);
          return;
        }
        writeFileSync(output, png);
      },
      async close() {
        recorded.closed.push(name);
      },
    };
  };

  return { recorded, deps: { openPreview: surface("preview"), openRender: surface("render") } };
}

test("hands both surfaces the one projection the Studio draws with", async () => {
  const { recorded, deps } = fakeDeps();
  await captureReleaseFrames({ capsule, run, deps });

  // Identity, not equality: two requests built apart can drift a pixel apart.
  expect(recorded.requests).toHaveLength(2);
  expect(recorded.requests[0]).toBe(recorded.requests[1]!);

  const request = recorded.requests[0]!;
  expect(request.compositionId).toBe(capsule.composition_id);
  expect(request.inputProps.document).toBe(capsule.document);
  expect({
    durationInFrames: request.durationInFrames,
    fps: request.fps,
    compositionWidth: request.width,
    compositionHeight: request.height,
  }).toEqual(playerConfig(capsule.document as never));

  for (const asset of capsule.assets) {
    expect(request.inputProps.previewSources[asset.asset_id]).toBe(`/public/${basename(asset.file)}`);
  }
});

test("captures the declared frames in order, both surfaces at each one", async () => {
  const { recorded, deps } = fakeDeps();
  const captured = await captureReleaseFrames({ capsule, run, deps });

  expect(capsule.frames.length).toBeGreaterThan(1);
  expect(recorded.calls).toEqual(capsule.frames.flatMap((frame) => [`preview:${frame}`, `render:${frame}`]));
  expect(captured.map((frame) => frame.frame)).toEqual([...capsule.frames]);
  for (const frame of captured) {
    expect(frame.preview).toBe(run.previewFrame(frame.frame));
    expect(frame.render).toBe(run.renderFrame(frame.frame));
    expect(readFileSync(frame.preview).length).toBeGreaterThan(0);
  }
  expect(recorded.closed.sort()).toEqual(["preview", "render"]);
});

test("serves both surfaces the capsule's own assets and nothing else", async () => {
  const { recorded, deps } = fakeDeps();
  await captureReleaseFrames({ capsule, run, deps });

  const expected = capsule.assets.map((asset) => basename(asset.file)).sort();
  expect(recorded.staged).toEqual([expected, expected]);
  // Staging is the harness's own scratch space, not an artifact of the run.
  expect(readdirSync(run.directory).sort()).toEqual(["diff", "preview", "render"]);
});

test("a surface that wrote no frame cannot finish one", async () => {
  const { recorded, deps } = fakeDeps({ "render:30": () => {} });

  await expect(captureReleaseFrames({ capsule, run, deps })).rejects.toBeInstanceOf(CaptureIncomplete);
  expect(recorded.closed.sort()).toEqual(["preview", "render"]);
});

test("a surface that wrote half a frame cannot finish one", async () => {
  const { deps } = fakeDeps({
    "preview:60": (output) => writeFileSync(output, png.subarray(0, 4)),
  });

  await expect(captureReleaseFrames({ capsule, run, deps })).rejects.toBeInstanceOf(CaptureIncomplete);
});

test("closes both surfaces when a capture fails outright", async () => {
  const { recorded, deps } = fakeDeps({
    "render:0": () => {
      throw new Error("the browser went away");
    },
  });

  await expect(captureReleaseFrames({ capsule, run, deps })).rejects.toThrow("the browser went away");
  expect(recorded.calls).toEqual(["preview:0", "render:0"]);
  expect(recorded.closed.sort()).toEqual(["preview", "render"]);
});

test("takes its staging directory away again, however the capture ended", async () => {
  const { recorded, deps } = fakeDeps({
    "preview:0": () => {
      throw new Error("the browser went away");
    },
  });
  const staged: string[] = [];
  const watched = {
    openPreview: async (request: SurfaceRequest) => {
      staged.push(request.publicDir);
      return deps.openPreview(request);
    },
    openRender: deps.openRender,
  };

  await expect(captureReleaseFrames({ capsule, run, deps: watched })).rejects.toThrow();
  expect(staged).toHaveLength(1);
  expect(existsSync(staged[0]!)).toBe(false);
  expect(recorded.closed.sort()).toEqual(["preview", "render"]);
});

/** A loopback origin that answers once, so "loopback works" is not a mock. */
async function loopback(): Promise<{ origin: string; stop(): void }> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
  return { origin: `http://127.0.0.1:${server.port}`, stop: () => void server.stop(true) };
}

test("an isolated network serves loopback and reaches nothing else", async () => {
  const served = await loopback();
  const attempted: string[] = [];
  try {
    await assertIsolatedNetwork(async (url) => {
      attempted.push(String(url));
      if (String(url).startsWith(served.origin)) return await fetch(url);
      throw new Error("network is unreachable");
    }, served.origin);
  } finally {
    served.stop();
  }

  // Both halves were actually attempted: a probe that skipped one proves nothing.
  expect(attempted).toHaveLength(2);
  expect(attempted[0]).toStartWith(served.origin);
  expect(attempted[1]).not.toStartWith("http://127.");
});

test("a reachable outside is not an isolated network", async () => {
  const served = await loopback();
  try {
    await expect(
      assertIsolatedNetwork(async () => new Response("reachable"), served.origin),
    ).rejects.toBeInstanceOf(NetworkNotIsolated);
  } finally {
    served.stop();
  }
});

test("a loopback the harness cannot use is not an isolated network", async () => {
  await expect(
    assertIsolatedNetwork(async () => {
      throw new Error("network is unreachable");
    }, "http://127.0.0.1:1"),
  ).rejects.toBeInstanceOf(NetworkNotIsolated);
});
