/// <reference types="bun-types" />

import { afterEach, expect, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { useRef } from "react";

import { FakePlayer } from "./timeline-test-fixtures";
import { usePlayerTimeline, type PlayerTimelineRef } from "./usePlayerTimeline";

afterEach(cleanup);

type HarnessProps = {
  player: FakePlayer | null;
  onFrameChange: (frame: number) => void;
  onPlayingChange?: (playing: boolean) => void;
};

let controls: ReturnType<typeof usePlayerTimeline> | undefined;

function Harness({ player, onFrameChange, onPlayingChange }: HarnessProps) {
  const ref = useRef<PlayerTimelineRef | null>(player);
  ref.current = player;
  controls = usePlayerTimeline(ref, onFrameChange, onPlayingChange);
  return <div />;
}

test("forwards frame updates and seeks from the player", () => {
  const player = new FakePlayer();
  const frames: number[] = [];
  render(<Harness player={player} onFrameChange={(frame) => frames.push(frame)} />);

  act(() => player.emit("frameupdate", { detail: { frame: 12 } }));
  player.frame = 40;
  act(() => player.emit("seeked", { detail: { frame: 40 } }));
  expect(frames).toEqual([12, 40]);
});

test("reports play and pause transitions", () => {
  const player = new FakePlayer();
  const playing: boolean[] = [];
  render(
    <Harness
      player={player}
      onFrameChange={() => {}}
      onPlayingChange={(value) => playing.push(value)}
    />,
  );

  act(() => player.emit("play"));
  act(() => player.emit("pause"));
  expect(playing).toEqual([true, false]);
});

test("exposes seek, play, and pause controls that reach the player", () => {
  const player = new FakePlayer();
  render(<Harness player={player} onFrameChange={() => {}} />);

  act(() => controls?.seekTo(75));
  act(() => controls?.play());
  act(() => controls?.pause());
  expect(player.seeks).toEqual([75]);
  expect(player.calls).toEqual(["play", "pause"]);
});

test("re-rendering never duplicates listeners", () => {
  const player = new FakePlayer();
  const { rerender } = render(<Harness player={player} onFrameChange={() => {}} />);
  const afterFirst = player.listenerCount;
  rerender(<Harness player={player} onFrameChange={() => {}} />);
  rerender(<Harness player={player} onFrameChange={() => {}} />);
  expect(player.listenerCount).toBe(afterFirst);
});

test("switching players and unmounting detach every listener and silence callbacks", () => {
  const first = new FakePlayer();
  const second = new FakePlayer();
  const frames: number[] = [];
  const { rerender, unmount } = render(
    <Harness player={first} onFrameChange={(frame) => frames.push(frame)} />,
  );

  rerender(<Harness player={second} onFrameChange={(frame) => frames.push(frame)} />);
  expect(first.listenerCount).toBe(0);
  act(() => first.emit("frameupdate", { detail: { frame: 99 } }));
  expect(frames).toEqual([]);

  act(() => second.emit("frameupdate", { detail: { frame: 5 } }));
  expect(frames).toEqual([5]);

  unmount();
  expect(second.listenerCount).toBe(0);
  act(() => second.emit("frameupdate", { detail: { frame: 7 } }));
  expect(frames).toEqual([5]);
});

test("a missing player is inert rather than a crash", () => {
  render(<Harness player={null} onFrameChange={() => {}} />);
  expect(() => controls?.seekTo(10)).not.toThrow();
  expect(() => controls?.play()).not.toThrow();
});
