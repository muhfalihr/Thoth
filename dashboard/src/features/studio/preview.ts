import type { EditDocument } from "@/api/control-plane";

export function getPlayerConfig(document: EditDocument) {
  const { width, height, fps, duration_in_frames: durationInFrames } = document.canvas;
  if (![width, height, fps, durationInFrames].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error("invalid Studio preview timing");
  }
  return { durationInFrames, fps, compositionWidth: width, compositionHeight: height };
}

export function getOrderedTextClips(document: EditDocument) {
  return [...document.clips].sort((left, right) => left.start_frame - right.start_frame);
}
