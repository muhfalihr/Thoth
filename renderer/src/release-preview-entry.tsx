/**
 * The Studio's Player, alone on a page, held at one frame.
 *
 * This page exists so the browser surface a creator approves can be captured the
 * same way the renderer captures a still. It adds no chrome, no controls, and no
 * props of its own: everything it draws comes from the shared projection, and the
 * frame it settles on comes from the URL the harness opened.
 */

import { Player, type PlayerRef } from "@remotion/player";
import { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";

import {
  loadCompositionFonts,
  playerConfig,
  timelineComposition,
  type EditDocumentV2,
} from "@thoth/remotion-composition";

/** The props the harness serves beside this page: the renderer's, unchanged. */
type ReleasePreviewProps = {
  readonly document: EditDocumentV2;
  readonly previewSources: Record<string, string>;
};

/** Where the page publishes its own readiness, and the only thing it publishes. */
const STATE = "__thothPreviewState";
const READY_TIMEOUT_MS = 60_000;
const POLL_MS = 25;

function publish(state: string): void {
  (window as unknown as Record<string, string>)[STATE] = state;
}

/**
 * Wait until this frame is actually on screen.
 *
 * A preview ignores `delayRender`, so nothing else holds the page: every image
 * and every media element has to have its data, the Player has to be standing on
 * the frame that was asked for, and the page has to have painted it twice.
 */
async function settle(player: PlayerRef, frame: number): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    const media = Array.from(document.querySelectorAll("video, audio"));
    const images = Array.from(document.querySelectorAll("img"));
    const pending =
      media.filter((node) => (node as HTMLMediaElement).readyState < 2).length +
      images.filter((node) => !(node as HTMLImageElement).complete).length;

    if (pending === 0 && player.getCurrentFrame() === frame && document.fonts.status === "loaded") {
      break;
    }
    if (Date.now() > deadline) {
      throw new Error("the preview did not settle");
    }
    await new Promise((resume) => setTimeout(resume, POLL_MS));
  }
  await new Promise((resume) => requestAnimationFrame(() => requestAnimationFrame(resume)));
}

function ReleaseFrame({
  document: timeline,
  previewSources,
  frame,
}: ReleasePreviewProps & { frame: number }) {
  const player = useRef<PlayerRef>(null);
  const config = playerConfig(timeline);

  useEffect(() => {
    const instance = player.current;
    if (instance === null) {
      publish("the Player did not mount");
      return;
    }
    instance.pause();
    instance.seekTo(frame);
    settle(instance, frame).then(
      () => publish("ready"),
      (error: unknown) => publish(error instanceof Error ? error.message : "the preview failed"),
    );
  }, [frame]);

  return (
    <Player
      ref={player}
      {...(timelineComposition(timeline, previewSources) as {
        component: never;
        inputProps: never;
      })}
      {...config}
      initialFrame={frame}
      autoPlay={false}
      clickToPlay={false}
      doubleClickToFullscreen={false}
      spaceKeyToPlayOrPause={false}
      style={{ width: config.compositionWidth, height: config.compositionHeight }}
    />
  );
}

async function main(): Promise<void> {
  const frame = Number(new URL(window.location.href).searchParams.get("frame"));
  if (!Number.isInteger(frame) || frame < 0) {
    throw new Error("no frame was asked for");
  }

  const response = await fetch("/release-props.json");
  const props = (await response.json()) as ReleasePreviewProps;
  // The page waits for its own glyphs: only a render is held by `delayRender`.
  await loadCompositionFonts();

  const container = document.createElement("div");
  document.body.append(container);
  createRoot(container).render(<ReleaseFrame {...props} frame={frame} />);
}

main().catch((error: unknown) => {
  publish(error instanceof Error ? error.message : "the preview page failed");
});
