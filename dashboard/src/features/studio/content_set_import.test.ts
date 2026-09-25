/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import { projectStudioSource, StudioSourceError } from "./content_set_import";

const footage = (index: number) => ({
  platform: "youtube",
  url: `https://www.youtube.com/shorts/clip${index}?feature=share&sig=secret${index}#t=4`,
  title: `Footage ${index}`,
  snippet: "search snippet",
  source: "youtube",
  published: "2026-09-01",
  thumbnail: `https://i.ytimg.com/vi/clip${index}/hq.jpg?sqp=signed`,
  is_video: true,
  duration_sec: 30,
  views: 1000,
  query: "topic",
  description: `What footage ${index} shows`,
  relevance: "match",
  image_path: "",
  ocr_status: "complete",
  trim_start: index === 1 ? 2.5 : 0,
  mute_audio: false,
  subtitle_blur: [],
});

const contentSetWithFourFootageItems = {
  main: {
    url: "https://www.tiktok.com/@creator/video/7000000000000000001?is_from_webapp=1&x-signature=abc",
    platform: "tiktok",
    title: "Main title",
    description: "Main caption",
    is_video: true,
    duration_sec: 42,
    image_path: "",
    profile: {
      name: "Creator",
      handle: "@creator",
      followers: 1000,
      avatar_url: "https://p16-sign.tiktokcdn.com/avatar.jpeg?x-expires=1&x-signature=abc",
      image_path: "C:\\Users\\operator\\scout\\profile.png",
    },
    ocr_status: "complete",
    ocr_valid_frames: 3,
    trim_start: 1.5,
    mute_audio: true,
    subtitle_blur: [{ x: 0.1, y: 0.8, w: 0.8, h: 0.1, start: 0, end: 3 }],
  },
  main_footage: {
    mode: "forced",
    package_manifest: "C:\\Users\\operator\\out\\main_footage\\manifest.json",
    coverage_target: 0.8,
  },
  footage: [
    footage(1),
    footage(2),
    footage(3),
    {
      platform: "x",
      url: "https://x.com/someone/status/1?s=20",
      title: "Cropped post",
      is_video: false,
      image_path: "C:\\Users\\operator\\scout\\crop_4.png",
    },
  ],
  comments: [
    {
      author: "viewer_one",
      text: "First comment",
      likes: 1200,
      avatar_url: "https://cdn.example/a.jpg?sig=x",
      image_path: "C:\\Users\\operator\\scout\\comment_1.png",
      context: "sarcastic agreement",
    },
    { author: "viewer_two", text: "Second comment", likes: 0, avatar_url: "", image_path: "", context: "" },
  ],
  figures: [],
  references: [{ term: "slang", kind: "meme", summary: "A meme", source_url: "https://example.com/r" }],
  discourse: { audience_stance: "", themes: [], narration_guidance: "" },
  unknown_creative_field: { color: "red" },
};

test("keeps every first-mode source item in stable role order", async () => {
  const projection = await projectStudioSource(contentSetWithFourFootageItems);
  expect(projection.items.filter((item) => item.role === "footage")).toHaveLength(4);
  expect(projection.items.some((item) => item.role === "main_footage")).toBe(true);
  expect(projection.unsupported.map((item) => item.field)).toContain("unknown_creative_field");

  expect(projection.items.map((item) => [item.role, item.order])).toEqual([
    ["main", 0],
    ["main_footage", 0],
    ["footage", 0],
    ["footage", 1],
    ["footage", 2],
    ["footage", 3],
    ["comment", 0],
    ["comment", 1],
  ]);
  expect(projection.items[0]).toEqual({
    role: "main",
    order: 0,
    title: "Main title",
    text: "Main caption",
    platform: "tiktok",
    source_url: "https://www.tiktok.com/@creator/video/7000000000000000001",
    media_kind: "video",
    trim_start_seconds: 1.5,
  });
  expect(projection.items[2]).toMatchObject({ title: "Footage 1", text: "What footage 1 shows", trim_start_seconds: 2.5 });
  expect(projection.items[5]).toMatchObject({ title: "Cropped post", media_kind: "image", source_url: "https://x.com/someone/status/1" });
  expect(projection.items[6]).toMatchObject({ title: "viewer_one", text: "First comment", media_kind: "image" });
  expect(projection.items[7]).toMatchObject({ title: "viewer_two", media_kind: "none" });
});

test("reports every creative field Studio cannot represent", async () => {
  const { unsupported } = await projectStudioSource(contentSetWithFourFootageItems);
  expect(unsupported.map((item) => [item.role, item.order, item.field])).toEqual([
    ["main", 0, "profile"],
    ["main", 0, "mute_audio"],
    ["main", 0, "subtitle_blur"],
    ["main_footage", 0, "mode"],
    ["main_footage", 0, "package_manifest"],
    ["main_footage", 0, "coverage_target"],
    ["comment", 0, "likes"],
    ["comment", 0, "avatar_url"],
    ["comment", 0, "context"],
    [null, null, "references"],
    [null, null, "unknown_creative_field"],
  ]);
  expect(unsupported.every((item) => item.reason.length > 0)).toBe(true);
});

test("never carries a host path or signed query into the projection", async () => {
  const serialized = JSON.stringify(await projectStudioSource(contentSetWithFourFootageItems));
  for (const secret of ["C:\\", "operator", "manifest.json", "x-signature", "sig=", "sqp=", "#t=", "?"]) {
    expect(serialized.includes(secret)).toBe(false);
  }
});

test("drops a non-web source address instead of passing a path through", async () => {
  const content = { main: { url: "C:\\Users\\operator\\main.mp4", title: "Local", is_video: true } };
  expect((await projectStudioSource(content)).items[0]).toMatchObject({ source_url: null, media_kind: "video" });
});

test("reports an overlong caption instead of truncating it", async () => {
  const long = "x".repeat(2001);
  const projection = await projectStudioSource({ main: { url: "https://example.com/v", title: "T", description: long } });
  expect(projection.items[0]!.text).toBeNull();
  expect(projection.unsupported).toEqual([
    { field: "description", role: "main", order: 0, reason: "Longer than 2000 characters", value_digest: expect.stringMatching(/^[0-9a-f]{64}$/) },
  ]);
});

test("fails closed on malformed or oversize input", async () => {
  for (const bad of [
    null,
    [],
    "text",
    {},
    { main: "not an object" },
    { main: { title: 3 } },
    { main: { title: "T" }, footage: "nope" },
    { main: { title: "T" }, footage: [null] },
    { main: { title: "T" }, comments: [{ author: "a", text: 5 }] },
    { main: { title: "T" }, footage: Array.from({ length: 401 }, () => ({ title: "F" })) },
  ]) {
    await expect(projectStudioSource(bad)).rejects.toThrow(StudioSourceError);
  }
});

test("gives distinct main footage choices distinct projections without naming their paths", async () => {
  const choose = (main_footage: Record<string, unknown>) =>
    projectStudioSource({ ...contentSetWithFourFootageItems, main_footage });
  const base = { mode: "forced_url_pool", package_manifest: "C:\\Users\\operator\\out\\pkg_a\\manifest.json", coverage_target: 0.8 };
  const variants = await Promise.all([
    choose(base),
    choose({ ...base, package_manifest: "C:\\Users\\operator\\out\\pkg_b\\manifest.json" }),
    choose({ ...base, coverage_target: 0.5 }),
    choose({ ...base, mode: "forced" }),
  ]);
  const serialized = variants.map((projection) => JSON.stringify(projection));
  expect(new Set(serialized).size).toBe(4);
  for (const text of serialized) expect(text.includes("pkg_") || text.includes("operator")).toBe(false);
});

test("reports main footage package details as unsupported instead of mapped", async () => {
  const { unsupported } = await projectStudioSource(contentSetWithFourFootageItems);
  const footage = unsupported.filter((item) => item.role === "main_footage");
  expect(footage.map((item) => item.field)).toEqual(["mode", "package_manifest", "coverage_target"]);
  expect(footage.every((item) => /not supported/.test(item.reason) && /^[0-9a-f]{64}$/.test(item.value_digest))).toBe(true);
});
