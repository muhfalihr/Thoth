/**
 * The typography the composition draws with, carried in this package.
 *
 * A composition that borrows whatever font the host happens to have installed
 * draws one thing in a browser and another in a container, so both surfaces are
 * handed the same bytes under a name no host can already own.
 */

import { useEffect, useState } from "react";
import { useDelayRender } from "remotion";

import regularFont from "./typeface/Poppins-Regular.ttf";
import boldFont from "./typeface/Poppins-Bold.ttf";

/** Private on purpose: a host font called Poppins is not this font. */
export const COMPOSITION_FONT_FAMILY = "ThothComposition";

/** The weights the composition draws: the regular body and the heading bold. */
const FONT_FACES = [
  { weight: "400", url: regularFont },
  { weight: "700", url: boldFont },
] as const;

/**
 * Register both weights with the page, or fail.
 *
 * Nothing is added until a face has actually loaded, so a caller that sees this
 * settle knows the glyphs are available rather than pending.
 */
export async function loadCompositionFonts(): Promise<void> {
  await Promise.all(
    FONT_FACES.map(async ({ weight, url }) => {
      const face = new FontFace(COMPOSITION_FONT_FAMILY, `url(${JSON.stringify(url)})`, { weight });
      await face.load();
      document.fonts.add(face);
    }),
  );
}

/**
 * Hold the render until the composition can draw its own glyphs.
 *
 * The handle is taken while rendering rather than from the effect, because a
 * still is captured from the frame React commits and a delay registered after
 * that paint would arrive too late to hold it. A preview ignores the delay by
 * design, so a preview capture waits on the page's own font set instead.
 */
export function useCompositionFonts(): void {
  const { delayRender, continueRender, cancelRender } = useDelayRender();
  const [handle] = useState(() => delayRender("composition fonts"));

  useEffect(() => {
    loadCompositionFonts().then(() => continueRender(handle), cancelRender);
  }, [cancelRender, continueRender, handle]);
}
