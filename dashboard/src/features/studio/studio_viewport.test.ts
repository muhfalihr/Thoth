/// <reference types="bun-types" />

import { afterEach, expect, spyOn, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { studioViewportAt, useStudioViewport } from "./studio_viewport";

const initialWidth = window.innerWidth;

afterEach(() => {
  cleanup();
  resize(initialWidth);
});

function resize(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  window.dispatchEvent(new Event("resize"));
}

test("maps CSS viewport widths to Studio surfaces at each breakpoint", () => {
  expect(studioViewportAt(375)).toBe("phone");
  expect(studioViewportAt(767)).toBe("phone");
  expect(studioViewportAt(768)).toBe("tablet");
  expect(studioViewportAt(1023)).toBe("tablet");
  expect(studioViewportAt(1024)).toBe("compact_desktop");
  expect(studioViewportAt(1439)).toBe("compact_desktop");
  expect(studioViewportAt(1440)).toBe("full_desktop");
});

test("follows window resizes and stops listening after unmount", () => {
  resize(1440);
  const added = spyOn(window, "addEventListener");
  const removed = spyOn(window, "removeEventListener");
  try {
    const { result, unmount } = renderHook(() => useStudioViewport());
    expect(result.current).toBe("full_desktop");

    act(() => resize(375));
    expect(result.current).toBe("phone");
    act(() => resize(900));
    expect(result.current).toBe("tablet");

    unmount();
    const resizeCalls = (spy: typeof added) => spy.mock.calls.filter(([type]) => type === "resize");
    expect(resizeCalls(added)).toHaveLength(1);
    expect(resizeCalls(removed)).toHaveLength(1);
    expect(resizeCalls(removed)[0]![1]).toBe(resizeCalls(added)[0]![1]);
  } finally {
    added.mockRestore();
    removed.mockRestore();
  }
});

test("renders a deterministic desktop surface on the server", () => {
  function Probe() {
    return createElement("span", null, useStudioViewport());
  }
  resize(375);
  expect(renderToString(createElement(Probe))).toBe("<span>full_desktop</span>");
});
