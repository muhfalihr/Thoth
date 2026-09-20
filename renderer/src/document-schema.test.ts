import { describe, expect, test } from "bun:test";

import { SOURCE, extractDocumentSchema } from "../scripts/extract-document-schema";
import { isEditDocumentV2 } from "./document-schema";
import checkedIn from "./generated/edit-document.schema.json" with { type: "json" };

describe("the generated document schema", () => {
  test("still matches the contract the control plane publishes", async () => {
    const openapi = (await Bun.file(SOURCE).json()) as Record<string, unknown>;
    expect(checkedIn as Record<string, unknown>).toEqual(extractDocumentSchema(openapi));
  });

  test("carries the whole reference closure, with no OpenAPI-only keyword left", () => {
    const definitions = (checkedIn as { $defs: Record<string, unknown> }).$defs;
    expect(Object.keys(definitions)).toContain("TimelineVideoClip");
    const serialized = JSON.stringify(checkedIn);
    expect(serialized).not.toContain("discriminator");
    expect(serialized).not.toContain("#/components/schemas/");
  });

  test("accepts nothing that is not an object with the document's required fields", () => {
    for (const value of [null, [], "document", 2, {}]) {
      expect(isEditDocumentV2(value)).toBe(false);
    }
  });
});
