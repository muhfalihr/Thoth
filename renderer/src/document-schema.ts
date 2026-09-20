/**
 * Runtime validation of the saved document, from the control plane's contract.
 *
 * The schema beside this file is generated from `python/openapi.json`, so the
 * renderer checks the same shape Python already enforced without keeping a
 * second handwritten copy of it. Nothing about a rejection is reported: the
 * caller raises its own fixed code, and the offending value never escapes.
 */

import Ajv2020 from "ajv/dist/2020";

import schema from "./generated/edit-document.schema.json" with { type: "json" };

// `strict` is off because the control plane's schema carries OpenAPI's own
// annotations, and formats are unused, so no rule here depends on either.
const validate = new Ajv2020({ strict: false, allErrors: false, validateFormats: false }).compile(
  schema,
);

export function isEditDocumentV2(value: unknown): boolean {
  return validate(value) === true;
}
