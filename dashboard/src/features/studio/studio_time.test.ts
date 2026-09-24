/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import { formatSceneSeconds, parseSceneSeconds } from "./studio_time";

test("shows whole and fractional scene durations in seconds", () => {
  expect(formatSceneSeconds(150, 30)).toBe("5");
  expect(formatSceneSeconds(151, 30)).toBe("5.033");
});

test("round-trips an explicit fractional duration to its frame", () => {
  expect(parseSceneSeconds("5.033", 30)).toBe(151);
  expect(parseSceneSeconds(formatSceneSeconds(151, 30), 30)).toBe(151);
});

test("rejects empty, non-numeric, non-positive, and sub-frame durations", () => {
  expect(parseSceneSeconds("", 30)).toBeNull();
  expect(parseSceneSeconds("  ", 30)).toBeNull();
  expect(parseSceneSeconds("abc", 30)).toBeNull();
  expect(parseSceneSeconds("Infinity", 30)).toBeNull();
  expect(parseSceneSeconds("0", 30)).toBeNull();
  expect(parseSceneSeconds("-1", 30)).toBeNull();
  expect(parseSceneSeconds("0.001", 30)).toBeNull();
});
