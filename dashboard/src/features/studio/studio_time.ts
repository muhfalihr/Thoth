/** Seconds for display, to the millisecond, without trailing zeros. */
export function formatSceneSeconds(frames: number, fps: number): string {
  return Number((frames / fps).toFixed(3)).toString();
}

/** Whole frames for typed seconds, or null for anything that is not at least one frame. */
export function parseSceneSeconds(value: string, fps: number): number | null {
  if (!value.trim()) return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const frames = Math.round(seconds * fps);
  return frames > 0 ? frames : null;
}
