import { useCallback, useEffect, useRef } from "react";

/** The slice of Remotion's PlayerRef the timeline actually drives. */
export type PlayerTimelineRef = {
  // Method syntax on purpose: it keeps Remotion's narrowly typed event callbacks
  // assignable to this structural subset.
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
  getCurrentFrame(): number;
  seekTo(frame: number): void;
  play(): void;
  pause(): void;
};

type FrameEvent = { detail?: { frame?: number } };

/**
 * Keep the timeline and the Player in step.
 *
 * The caller passes the Player that React actually committed, so replacing the
 * Player re-runs this effect: listeners follow the live instance instead of
 * feeding frames into one that is already gone.
 */
export function usePlayerTimeline(
  player: PlayerTimelineRef | null,
  onFrameChange: (frame: number) => void,
  onPlayingChange?: (playing: boolean) => void,
) {
  // Listeners read the newest callbacks through a ref so a re-render with fresh
  // inline handlers never detaches and re-attaches the player.
  const handlers = useRef({ onFrameChange, onPlayingChange });
  handlers.current = { onFrameChange, onPlayingChange };

  useEffect(() => {
    if (!player) return;

    const frame = (event: unknown) =>
      handlers.current.onFrameChange(
        (event as FrameEvent).detail?.frame ?? player.getCurrentFrame(),
      );
    const playing = (value: boolean) => () => handlers.current.onPlayingChange?.(value);
    const listeners: [string, (event: unknown) => void][] = [
      ["frameupdate", frame],
      ["seeked", frame],
      ["play", playing(true)],
      ["pause", playing(false)],
    ];

    for (const [type, listener] of listeners) player.addEventListener(type, listener);
    return () => {
      for (const [type, listener] of listeners) player.removeEventListener(type, listener);
    };
  }, [player]);

  const seekTo = useCallback((frame: number) => player?.seekTo(frame), [player]);
  const play = useCallback(() => player?.play(), [player]);
  const pause = useCallback(() => player?.pause(), [player]);

  return { seekTo, play, pause };
}
