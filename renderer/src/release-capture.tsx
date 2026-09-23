/**
 * Paired capture: one projection, two surfaces, the same frames.
 *
 * The preview surface is the Studio's Player on a loopback page; the render
 * surface is the renderer's own `renderStill`. Both are handed the same frozen
 * request, so neither can be drawn with props or geometry the other never saw,
 * and each captured frame is written only where the run says it may be.
 */

import { Buffer } from "node:buffer";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

import type { TemplateReleaseRun } from "./artifact-root";
import { loadReleaseCapsule, releaseIdentityOf, type ReleaseCapsule } from "./release-capsule";
import {
  COMPOSITION_ENTRY_POINT,
  RENDER_CHROMIUM_OPTIONS,
  assertCompositionGeometry,
  compositionInputProps,
  rendererWebpackOverride,
  toCancelSignal,
} from "./remotion-adapter";

/** A frame that was asked for and did not arrive whole. */
export class CaptureIncomplete extends Error {}

/** The reference environment could reach something it is not allowed to reach. */
export class NetworkNotIsolated extends Error {}

export type SurfaceRequest = {
  readonly publicDir: string;
  readonly compositionId: string;
  readonly inputProps: {
    readonly document: Record<string, unknown>;
    readonly previewSources: Record<string, string>;
  };
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly durationInFrames: number;
};

export type CaptureSurface = {
  capture(frame: number, output: string): Promise<void>;
  close(): Promise<void>;
};

/**
 * The two surfaces, injected so the ordering and completeness rules below can be
 * tested without a browser. Nothing else about a capture is replaceable.
 */
export type CaptureDeps = {
  openPreview(request: SurfaceRequest, signal: AbortSignal): Promise<CaptureSurface>;
  openRender(request: SurfaceRequest, signal: AbortSignal): Promise<CaptureSurface>;
};

/** A resource a surface took, and the one call that gives it back. */
type Release = () => Promise<void>;

/**
 * Open a surface out of steps that each take a resource, or take none at all.
 *
 * A browser, a page, a server, and a temporary directory are taken one after
 * another, and any of them can fail with the earlier ones already held. Each
 * step hands back the call that gives its resource up, so a failure halfway
 * through is given back in full, newest first, and a surface that opened gives
 * the same resources back when it is closed.
 */
export async function assembleSurface(
  build: (keep: (release: Release) => void) => Promise<CaptureSurface["capture"]>,
): Promise<CaptureSurface> {
  const taken: Release[] = [];
  const giveBack = async (): Promise<void> => {
    for (const release of taken.reverse()) {
      await release().catch(() => undefined);
    }
    taken.length = 0;
  };

  try {
    const capture = await build((release) => void taken.push(release));
    return { capture, close: giveBack };
  } catch (error) {
    await giveBack();
    throw error;
  }
}

export type CapturedFrame = {
  readonly frame: number;
  readonly preview: string;
  readonly render: string;
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_END = Buffer.from("IEND");
const LOOPBACK = "127.0.0.1";
/** Routable, and answers: an address that fails here is a network that is closed. */
const OUTSIDE = "http://1.1.1.1/";
const OUTSIDE_TIMEOUT_MS = 4000;
const READY_TIMEOUT_MS = 90_000;
const POLL_MS = 50;
const PROPS_PATH = "/release-props.json";
const STATIC_PREFIX = "/public";
const PREVIEW_ENTRY_POINT = resolve(import.meta.dir, "release-preview-entry.tsx");

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Capture every declared frame from both surfaces, in the capsule's order.
 *
 * The assets are staged once into a directory both surfaces serve from, so the
 * two never disagree about what a source is, and the staging is taken away again
 * however the capture ends.
 */
export async function captureReleaseFrames(options: {
  capsule: ReleaseCapsule;
  // The two paths it writes, and nothing else a run knows: the capture happens
  // in a child process that was handed those and never opened an artifact root.
  run: Pick<TemplateReleaseRun, "previewFrame" | "renderFrame">;
  deps?: CaptureDeps;
  signal?: AbortSignal;
}): Promise<readonly CapturedFrame[]> {
  const { capsule, run, deps = remotionCaptureDeps() } = options;
  const signal = options.signal ?? new AbortController().signal;
  const publicDir = await mkdtemp(join(tmpdir(), "thoth-release-public-"));
  const opened: CaptureSurface[] = [];

  try {
    signal.throwIfAborted();
    for (const asset of capsule.assets) {
      await copyFile(asset.path, join(publicDir, basename(asset.file)));
    }

    const canvas = capsule.document.canvas as {
      width: number;
      height: number;
      fps: number;
      duration_in_frames: number;
    };
    const request: SurfaceRequest = Object.freeze({
      publicDir,
      compositionId: capsule.composition_id,
      inputProps: compositionInputProps({
        document: capsule.document,
        assets: capsule.assets.map((asset) => ({
          asset_id: asset.asset_id,
          relative_name: asset.file,
        })),
      }),
      width: canvas.width,
      height: canvas.height,
      fps: canvas.fps,
      durationInFrames: canvas.duration_in_frames,
    });

    const preview = await deps.openPreview(request, signal);
    opened.push(preview);
    const render = await deps.openRender(request, signal);
    opened.push(render);

    const captured: CapturedFrame[] = [];
    for (const frame of capsule.frames) {
      signal.throwIfAborted();
      const pair = {
        frame,
        preview: run.previewFrame(frame),
        render: run.renderFrame(frame),
      };
      await captureOne(preview, frame, pair.preview);
      await captureOne(render, frame, pair.render);
      captured.push(pair);
    }
    return captured;
  } finally {
    for (const surface of opened.reverse()) {
      await surface.close().catch(() => undefined);
    }
    await rm(publicDir, { recursive: true, force: true });
  }
}

/**
 * Take one frame, and prove it arrived.
 *
 * A surface that answered without writing a whole image has not captured the
 * frame, whatever it reported, so a stale or half-written file fails here rather
 * than being compared later as if it were the frame.
 */
async function captureOne(surface: CaptureSurface, frame: number, output: string): Promise<void> {
  await surface.capture(frame, output);
  const bytes = await readFile(output).catch(() => undefined);
  if (
    bytes === undefined ||
    !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ||
    bytes.lastIndexOf(PNG_END) < 0
  ) {
    throw new CaptureIncomplete(`frame ${frame} was not captured whole`);
  }
}

/**
 * Prove this process can serve itself and reach nothing else.
 *
 * Both halves are attempted: a probe that only shows the outside is unreachable
 * would pass just as well inside a container with no working loopback, where no
 * capture could have happened at all.
 */
export async function assertIsolatedNetwork(
  fetchImpl: FetchLike = fetch,
  loopbackOrigin?: string,
): Promise<void> {
  const own =
    loopbackOrigin === undefined
      ? Bun.serve({ hostname: LOOPBACK, port: 0, fetch: () => new Response("ok") })
      : undefined;
  const origin = loopbackOrigin ?? `http://${LOOPBACK}:${own?.port}`;

  try {
    const local = await fetchImpl(`${origin}/`).catch(() => undefined);
    if (local === undefined || !local.ok) {
      throw new NetworkNotIsolated("the local preview origin is not reachable");
    }
    const outside = await fetchImpl(OUTSIDE, {
      signal: AbortSignal.timeout(OUTSIDE_TIMEOUT_MS),
    }).catch(() => undefined);
    if (outside !== undefined) {
      throw new NetworkNotIsolated("an address outside this container answered");
    }
  } finally {
    own?.stop(true);
  }
}

/**
 * What the reference image can prove about itself, printed as its identity.
 *
 * This is the image's own command: it runs with the network disabled, so every
 * line of it is a claim the container has just demonstrated.
 */
export async function selfCheck(): Promise<void> {
  await assertIsolatedNetwork();
  const capsule = await loadReleaseCapsule(releaseIdentityOf("vertical_text_story-v1"));

  const { openBrowser } = await import("@remotion/renderer");
  const browser = await openBrowser("chrome", {
    chromiumOptions: RENDER_CHROMIUM_OPTIONS,
    forceDeviceScaleFactor: 1,
    logLevel: "error",
  });
  try {
    const page = await newParityPage(browser, 320, 240);
    const agent = await page.evaluate(() => navigator.userAgent);
    console.log(
      JSON.stringify({
        base_digest: process.env.THOTH_F1_BASE_DIGEST ?? null,
        image_id: process.env.THOTH_F1_IMAGE_ID ?? null,
        renderer_version: process.env.THOTH_RENDERER_VERSION ?? null,
        browser: typeof agent === "string" ? agent : null,
        release: capsule.identity,
        frames: capsule.frames.length,
        network: "isolated",
      }),
    );
  } finally {
    await browser.close({ silent: true });
  }
}

type ParityBrowser = Awaited<ReturnType<typeof import("@remotion/renderer").openBrowser>>;
type ParityPage = Awaited<ReturnType<ParityBrowser["newPage"]>>;

async function newParityPage(
  browser: ParityBrowser,
  width: number,
  height: number,
): Promise<ParityPage> {
  const page = await browser.newPage({
    context: null as never,
    logLevel: "error",
    indent: false,
    pageIndex: 0,
    onBrowserLog: null,
    onLog: () => undefined,
  });
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  return page;
}

/** The real pair: the Studio's Player on loopback, and Remotion's own still. */
export function remotionCaptureDeps(): CaptureDeps {
  return { openPreview, openRender };
}

async function openRender(request: SurfaceRequest, signal: AbortSignal): Promise<CaptureSurface> {
  const { bundle } = await import("@remotion/bundler");
  const { renderStill, selectComposition } = await import("@remotion/renderer");

  return assembleSurface(async (keep) => {
    const outDir = await mkdtemp(join(tmpdir(), "thoth-release-render-"));
    keep(() => rm(outDir, { recursive: true, force: true }));

    const serveUrl = await bundle({
      entryPoint: COMPOSITION_ENTRY_POINT,
      outDir,
      publicDir: request.publicDir,
      publicPath: "/",
      webpackOverride: rendererWebpackOverride as never,
    });
    const composition = await selectComposition({
      serveUrl,
      id: request.compositionId,
      inputProps: request.inputProps,
      timeoutInMilliseconds: READY_TIMEOUT_MS,
    });
    assertCompositionGeometry(composition, request);

    return async (frame: number, output: string): Promise<void> => {
      await renderStill({
        composition,
        serveUrl,
        inputProps: request.inputProps,
        output,
        frame,
        imageFormat: "png",
        scale: 1,
        chromiumOptions: RENDER_CHROMIUM_OPTIONS,
        logLevel: "error",
        timeoutInMilliseconds: READY_TIMEOUT_MS,
        // The same stop the run was given, in the token Remotion cancels on.
        cancelSignal: toCancelSignal(signal),
      });
    };
  });
}

async function openPreview(request: SurfaceRequest, signal: AbortSignal): Promise<CaptureSurface> {
  const { openBrowser } = await import("@remotion/renderer");

  return assembleSurface(async (keep) => {
    const outDir = await mkdtemp(join(tmpdir(), "thoth-release-preview-"));
    keep(() => rm(outDir, { recursive: true, force: true }));

    await buildPreviewPage(outDir);
    const server = servePreview(outDir, request);
    keep(async () => void server.stop(true));

    const browser = await openBrowser("chrome", {
      chromiumOptions: RENDER_CHROMIUM_OPTIONS,
      forceDeviceScaleFactor: 1,
      logLevel: "error",
    });
    keep(() => browser.close({ silent: true }).then(() => undefined));

    const page = await newParityPage(browser, request.width, request.height);
    keep(() => page.close());

    return async (frame: number, output: string): Promise<void> => {
      signal.throwIfAborted();
      await page.goto({
        url: `http://${LOOPBACK}:${server.port}/?frame=${frame}`,
        timeout: READY_TIMEOUT_MS,
      });
      await waitForPreview(page, frame, signal);
      await Bun.write(output, await screenshot(page, request));
    };
  });
}

/** Bundle the page with this service's own bundler: no second toolchain. */
async function buildPreviewPage(outDir: string): Promise<void> {
  const built = await Bun.build({
    entrypoints: [PREVIEW_ENTRY_POINT],
    outdir: outDir,
    target: "browser",
    publicPath: "/",
    naming: { entry: "entry.js", chunk: "[name]-[hash].js", asset: "[name]-[hash].[ext]" },
  });
  if (!built.success) {
    throw new CaptureIncomplete("the preview page could not be built");
  }
  await Bun.write(
    join(outDir, "index.html"),
    '<!doctype html><html><head><meta charset="utf-8">' +
      "<style>html,body{margin:0;padding:0;overflow:hidden}</style></head>" +
      '<body><script type="module" src="/entry.js"></script></body></html>',
  );
}

/**
 * Serve the page, its assets, and the props, on loopback and nowhere else.
 *
 * The two roots are the only things reachable, and a request that climbs out of
 * either is refused rather than resolved.
 */
function servePreview(bundleDir: string, request: SurfaceRequest) {
  const roots = { bundle: resolve(bundleDir), public: resolve(request.publicDir) };
  return Bun.serve({
    hostname: LOOPBACK,
    port: 0,
    async fetch(incoming: Request): Promise<Response> {
      const path = new URL(incoming.url).pathname;
      if (path === PROPS_PATH) {
        return Response.json(request.inputProps);
      }
      const inPublic = path.startsWith(`${STATIC_PREFIX}/`);
      const root = inPublic ? roots.public : roots.bundle;
      const name = inPublic ? path.slice(STATIC_PREFIX.length + 1) : path.slice(1) || "index.html";
      const file = resolve(root, name);
      if (file !== root && !file.startsWith(root + sep)) {
        return new Response(null, { status: 403 });
      }
      const body = Bun.file(file);
      return (await body.exists()) ? new Response(body) : new Response(null, { status: 404 });
    },
  });
}

async function waitForPreview(
  page: ParityPage,
  frame: number,
  signal: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    signal.throwIfAborted();
    const state = await page.evaluate(() => {
      return (window as unknown as Record<string, string | undefined>).__thothPreviewState;
    });
    if (state === "ready") return;
    if (typeof state === "string") {
      throw new CaptureIncomplete(`frame ${frame} was not previewed: ${state}`);
    }
    if (Date.now() > deadline) {
      throw new CaptureIncomplete(`frame ${frame} was not previewed in time`);
    }
    await Bun.sleep(POLL_MS);
  }
}

/**
 * The same screenshot the renderer takes, with the same parameters.
 *
 * Remotion drives `Page.captureScreenshot` itself but does not export the call,
 * so the clip, the surface, and the scale are mirrored here rather than guessed.
 */
async function screenshot(page: ParityPage, request: SurfaceRequest): Promise<Buffer> {
  await page._client().send("Target.activateTarget", { targetId: page.target()._targetId });
  const { value } = await page._client().send("Page.captureScreenshot", {
    format: "png",
    clip: { x: 0, y: 0, width: request.width, height: request.height, scale: 1 },
    captureBeyondViewport: true,
    optimizeForSpeed: true,
    fromSurface: true,
  });
  return Buffer.from(value.data, "base64");
}
