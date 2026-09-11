import { expect, test } from "bun:test";

import { buildContentSetImportRequest } from "./domain";

test("projects only approved text fields from a legacy content set", () => {
  const result = buildContentSetImportRequest({
    main: {
      title: "Main",
      description: "Summary",
      url: "https://private.example/main",
      image_path: "C:\\private\\main.png",
      profile: { token: "secret" },
    },
    footage: [
      { title: "One", platform: "tiktok", url: "https://private.example/one" },
      { title: "Two", platform: "youtube", thumbnail: "/home/mfr/two.png" },
      { title: "Three", platform: "instagram", comments: ["private"] },
      { title: "Four", platform: "x" },
    ],
    comments: [{ text: "private" }],
    references: [{ term: "private" }],
  });

  expect(result).toEqual({
    main: { title: "Main", description: "Summary" },
    footage: [
      { title: "One", platform: "tiktok" },
      { title: "Two", platform: "youtube" },
      { title: "Three", platform: "instagram" },
    ],
  });
  const serialized = JSON.stringify(result);
  for (const forbidden of ["http", "C:\\", "/home/", "token", "comments", "profile", "references"]) {
    expect(serialized).not.toContain(forbidden);
  }
});

test("returns an empty safe projection for malformed or blank input", () => {
  expect(buildContentSetImportRequest(null)).toEqual({ main: {}, footage: [] });
  expect(
    buildContentSetImportRequest({ main: { title: "   " }, footage: [{ title: 7, platform: "x" }] }),
  ).toEqual({ main: {}, footage: [] });
});
