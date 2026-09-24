import { useSyncExternalStore } from "react";

export type StudioViewport = "phone" | "tablet" | "compact_desktop" | "full_desktop";
export type StudioPane = "scenes" | "preview" | "edit" | "prompts" | "review" | "renders";
export type StudioJob = "edit" | "prompt" | "review" | "render";
export type StudioEditPane = "scenes" | "preview" | "controls";

// CSS viewport widths, not device detection: orientation and zoom change the surface.
export function studioViewportAt(width: number): StudioViewport {
  return width < 768 ? "phone" : width < 1024 ? "tablet" : width < 1440 ? "compact_desktop" : "full_desktop";
}

function subscribe(onChange: () => void) {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

export function useStudioViewport(): StudioViewport {
  return useSyncExternalStore(
    subscribe,
    () => studioViewportAt(window.innerWidth),
    () => "full_desktop",
  );
}
