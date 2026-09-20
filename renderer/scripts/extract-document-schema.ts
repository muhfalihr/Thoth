/**
 * Derive the renderer's runtime document contract from the control plane's own.
 *
 * The saved document is Python's schema, published as OpenAPI 3.1 (which is
 * JSON Schema 2020-12). Rather than keep a second handwritten copy that could
 * drift, this lifts `EditDocumentV2` and everything it references into one
 * self-contained schema the renderer validates against at run time.
 *
 * Regenerate with `bun run scripts/extract-document-schema.ts`; the drift test
 * in `src/document-schema.test.ts` fails if the checked-in copy falls behind.
 */

import { resolve } from "node:path";

const REPOSITORY = resolve(import.meta.dir, "../..");
const SOURCE = resolve(REPOSITORY, "python/openapi.json");
const TARGET = resolve(import.meta.dir, "../src/generated/edit-document.schema.json");
const ROOT = "EditDocumentV2";
const PREFIX = "#/components/schemas/";

type Schema = Record<string, unknown>;

/**
 * Rewrite one node for a standalone schema: component references become local
 * definitions, and OpenAPI's `discriminator` is dropped because its `mapping`
 * is not the 2020-12 keyword of the same name and would only narrow what the
 * `oneOf` beside it already decides.
 */
function rewrite(node: unknown, referenced: Set<string>): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => rewrite(item, referenced));
  }
  if (typeof node !== "object" || node === null) {
    return node;
  }
  const result: Schema = {};
  for (const [key, value] of Object.entries(node as Schema)) {
    if (key === "discriminator") {
      continue;
    }
    if (key === "$ref" && typeof value === "string") {
      if (!value.startsWith(PREFIX)) {
        throw new Error("unexpected reference outside the component schemas");
      }
      const name = value.slice(PREFIX.length);
      referenced.add(name);
      result.$ref = `#/$defs/${name}`;
      continue;
    }
    result[key] = rewrite(value, referenced);
  }
  return result;
}

export function extractDocumentSchema(openapi: Schema): Schema {
  const components = (openapi.components as Schema | undefined)?.schemas as
    | Record<string, Schema>
    | undefined;
  if (!components?.[ROOT]) {
    throw new Error(`${ROOT} is not published by the control plane`);
  }

  const $defs: Record<string, unknown> = {};
  const pending = [ROOT];
  while (pending.length > 0) {
    const name = pending.pop()!;
    if (name in $defs) {
      continue;
    }
    const schema = components[name];
    if (!schema) {
      throw new Error("a referenced component schema is missing");
    }
    const referenced = new Set<string>();
    $defs[name] = rewrite(schema, referenced);
    pending.push(...referenced);
  }

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $ref: `#/$defs/${ROOT}`,
    // Sorted so a regeneration only changes what the control plane changed.
    $defs: Object.fromEntries(Object.entries($defs).sort(([a], [b]) => (a < b ? -1 : 1))),
  };
}

if (import.meta.main) {
  const openapi = (await Bun.file(SOURCE).json()) as Schema;
  await Bun.write(TARGET, `${JSON.stringify(extractDocumentSchema(openapi), null, 2)}\n`);
}

export { SOURCE, TARGET };
