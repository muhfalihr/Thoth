import { useCallback, useEffect, useRef, type RefObject } from "react";

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
 * Every listener is attached once and removed again when the player changes or
 * the view unmounts, so a swapped composition can never keep feeding frames
 * into a stale callback.
 */
export function usePlayerTimeline(
  playerRef: RefObject<PlayerTimelineRef | null>,
  onFrameChange: (frame: number) => void,
  onPlayingChange?: (playing: boolean) => void,
) {
  // Listeners read the newest callbacks through a ref so a re-render with fresh
  // inline handlers never detaches and re-attaches the player.
  const handlers = useRef({ onFrameChange, onPlayingChange });
  handlers.current = { onFrameChange, onPlayingChange };

  // Read during render only as a change signal; the effect uses the committed ref.
  const attached = playerRef.current;

  useEffect(() => {
    const player = playerRef.current;
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
  }, [attached, playerRef]);

  const seekTo = useCallback(
    (frame: number) => playerRef.current?.seekTo(frame),
    [playerRef],
  );
  const play = useCallback(() => playerRef.current?.play(), [playerRef]);
  const pause = useCallback(() => playerRef.current?.pause(), [playerRef]);

  return { seekTo, play, pause };
}
