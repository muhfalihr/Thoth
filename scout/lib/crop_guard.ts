// crop_guard.ts — reject a captured card that is visually blank.
//
// A CDP `captureClip` over a not-yet-painted / uncomposited region (X's virtualised
// timeline, an off-screen `beyondViewport` node) yields a SOLID BLACK png. The old
// `buf.length >= 2048` floor let those through: a flat region compresses to a tiny png
// no matter how large — a 1224×620 black card is still ~3.6 KB, comfortably over 2 KB,
// so it shipped into the video as a black box. Bytes-per-pixel is the dimension-
// independent version of the same test: a real card (text + avatar) runs ~0.09–0.15
// B/px; a flat black clip is ~0.005 B/px. Threshold 0.02 sits with an 18× margin.
export function okCrop(buf: Buffer | null | undefined): boolean {
  if (!buf || buf.length < 2048) return false; // tiny / empty
  // PNG? (8-byte sig, then the IHDR chunk type at offset 12) → judge by pixel density.
  if (buf.length >= 24 && buf.readUInt32BE(12) === 0x49484452) {
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
    if (w > 0 && h > 0) return buf.length / (w * h) >= 0.02;
  }
  return true; // not a PNG / no dims: the 2 KB floor above is the best we can do
}
