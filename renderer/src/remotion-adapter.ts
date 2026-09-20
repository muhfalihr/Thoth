/**
 * The seam between this service and Remotion 4's server rendering.
 *
 * Remotion's current sequence is `bundle()` to build a serve URL,
 * `selectComposition()` to resolve the one allowlisted composition against the
 * validated input props, and `renderMedia()` to encode it, with progress and
 * cancellation delivered through `onProgress` and `cancelSignal`. Those shapes
 * stay behind this module so the execution contract never learns them.
 *
 * Assets are not fetched by the renderer: the control plane already staged them
 * inside the job workspace, and that directory is handed to `bundle()` as its
 * public directory, so Remotion serves each one at the static path the shared
 * composition is willing to load.
 */

import { resolve } from "node:path";

import type { RenderBundle } from "./contracts";
import type { EngineRequest, RenderEngine } from "./server";

/**
 * The one server-owned preset, `standard_vertical_mp4_v1`. Frame geometry comes
 * from the saved document; everything else is fixed here, so no browser input
 * can reach a codec, a bitrate, a browser flag, an output name, or a path.
 */
export const RENDER_PRESET = Object.freeze({
  codec: "h264",
  audioCodec: "aac",
  pixelFormat: "yuv420p",
  imageFormat: "jpeg",
  // AAC is only written when the composition actually has audio.
  enforceAudioTrack: false,
  muted: false,
} as const);

/** Where `bundle()` publishes the staged public directory it copied. */
const STATIC_BASE = "/public";

export function assetSourceUrl(relativeName: string): string {
  return `${STATIC_BASE}/${relativeName.slice("assets/".length)}`;
}

export function compositionInputProps(bundle: RenderBundle): {
  document: Record<string, unknown>;
  previewSources: Record<string, string>;
} {
  const previewSources: Record<string, string> = {};
  for (const asset of bundle.assets) {
    previewSources[asset.asset_id] = assetSourceUrl(asset.relative_name);
  }
  return { document: bundle.document, previewSources };
}

export type BundlerConfig = Record<string, unknown> & {
  resolve?: { alias?: Record<string, string>; modules?: string[] };
};

export type ResolvedBundlerConfig = Record<string, unknown> & {
  resolve: { alias: Record<string, string>; modules: string[] };
};

const COMPOSITION_SOURCE = resolve(import.meta.dir, "../../packages/remotion-composition/src");
const SERVICE_MODULES = resolve(import.meta.dir, "../node_modules");

/**
 * The shared composition ships source only, so the bundler must be told where
 * it lives and where this service's single copy of React and Remotion is.
 */
export function rendererWebpackOverride(config: BundlerConfig): ResolvedBundlerConfig {
  const existing = config.resolve ?? {};
  return {
    ...config,
    resolve: {
      ...existing,
      alias: { ...(existing.alias ?? {}), "@thoth/remotion-composition": COMPOSITION_SOURCE },
      modules: [...(existing.modules ?? []), SERVICE_MODULES, "node_modules"],
    },
  };
}

/**
 * Build this job's bundle, select the trusted composition, and encode it.
 *
 * Remotion is imported here rather than at module load so the dispatch surface
 * and its tests never pay for the renderer's native binaries.
 */
export function createRemotionEngine(): RenderEngine {
  return {
    async render(request: EngineRequest): Promise<void> {
      const { bundle } = await import("@remotion/bundler");
      const { renderMedia, selectComposition } = await import("@remotion/renderer");

      const serveUrl = await bundle({
        entryPoint: request.entryPoint,
        outDir: request.outDir,
        publicDir: request.publicDir,
        // An absolute public path keeps `staticFile()` on one origin, which is
        // the shape the shared composition is willing to load.
        publicPath: "/",
        webpackOverride: rendererWebpackOverride as never,
      });

      const composition = await selectComposition({
        serveUrl,
        id: request.compositionId,
        inputProps: request.inputProps,
      });
      if (
        composition.width !== request.expected.width ||
        composition.height !== request.expected.height ||
        composition.fps !== request.expected.fps ||
        composition.durationInFrames !== request.expected.durationInFrames
      ) {
        throw new Error("composition geometry does not match the authorized bundle");
      }

      await renderMedia({
        composition,
        serveUrl,
        inputProps: request.inputProps,
        outputLocation: request.outputPath,
        codec: RENDER_PRESET.codec,
        audioCodec: RENDER_PRESET.audioCodec,
        pixelFormat: RENDER_PRESET.pixelFormat,
        imageFormat: RENDER_PRESET.imageFormat,
        enforceAudioTrack: RENDER_PRESET.enforceAudioTrack,
        muted: RENDER_PRESET.muted,
        // Containers run Chromium without a session bus; this is Remotion's
        // documented Docker setting.
        chromiumOptions: { enableMultiProcessOnLinux: true },
        cancelSignal: toCancelSignal(request.signal),
        onProgress: ({ progress }) => request.onProgress(Math.round(progress * 100)),
      });
    },
  };
}

/** Bridge the platform `AbortSignal` this service owns to Remotion's own token. */
function toCancelSignal(signal: AbortSignal): (callback: () => void) => void {
  return (callback: () => void) => {
    if (signal.aborted) {
      callback();
      return;
    }
    signal.addEventListener("abort", () => callback(), { once: true });
  };
}
