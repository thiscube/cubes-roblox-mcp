/**
 * Declared result shapes for the five always-visible core tools (PLAN.md #5).
 *
 * Kept out of `output-schema.ts` because these are hand-written against the
 * handlers in `server.ts` and `vision.ts`, and the test suite calls each one and
 * validates the real payload against what is declared here. Same two rules as
 * the shared module: declare only what is known, and never mark a field
 * required, because any handler can return the error envelope instead.
 */

import { objectResult, RESULT_ENVELOPE, type JsonSchema } from "./output-schema.js";

export { RESULT_ENVELOPE };

export const CORE_OUTPUT_SCHEMAS: Record<string, JsonSchema> = {
  /** Server-owned end to end, so this is exact. */
  search_tools: objectResult({
    unlocked: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          category: { type: "string" },
          description: { type: "string" },
        },
      },
    },
    message: { type: "string" },
  }),

  /**
   * `handleRead` returns the plugin's object verbatim. The only field this
   * server touches is `items`, where it annotates scripts with their Rojo
   * source file — and even that it does in place, on whatever the plugin sent.
   *
   * So the honest schema names the fields a caller will see and types NONE of
   * them. An earlier version typed six fields as arrays and objects; a plugin
   * whose `read` returned `cursor` as a number would have had its result
   * rejected at a validating client over a shape this server never controlled.
   * Naming without typing still helps the model know what to look for.
   */
  read: objectResult({
    items: {},
    instances: {},
    children: {},
    camera: {},
    cursor: {},
    snapshot: {},
    unchanged: {},
  }),

  /**
   * Ships the PNG as an image content block and this metadata as
   * structuredContent, so a structured client still gets the capture's
   * provenance without parsing the text block.
   */
  screenshot: objectResult({
    sizeBytes: { type: "number" },
    region: { type: "string" },
    platform: { type: "string" },
    requested: { type: "string" },
    downscaled: { type: "string" },
    warning: { type: "string" },
    source: { type: "string" },
    savedTo: { type: "string" },
    limitBytes: { type: "number" },
  }),

  /**
   * Typed fields are the ones THIS server writes, and only those: the
   * destructiveness gate's output (`level`, `summary`, `detail`, `uncertain`,
   * `retry_with`), the selene `lint` array, and `appliedLevel`, which
   * `handleMutate` stamps on every successful batch.
   *
   * `applied` and `results` come back from the plugin untouched, so they are
   * named and left untyped. The first version had this exactly inverted: it
   * typed the two plugin-owned fields and did not declare the server-owned one
   * at all.
   */
  mutate: objectResult({
    applied: {},
    // `changes` is the documented contract (DESIGN.md "Diff response") and the
    // field `suggestNext`, `applyAutoUnlock` and the history summary all read.
    // `results` is listed because the earlier schema named it and a plugin may
    // still send it — but it came from this repo's own test fixture, not from the
    // design, which is how a fixture becomes the oracle for a wire format.
    changes: {},
    results: {},
    // Always set by handleMutate on the success path, so they can be typed.
    lint: { type: "array" },
    appliedLevel: { type: "string", enum: ["none", "soft", "hard", "nuclear"] },
    // The gate's own fields. They are server-written on the REFUSAL path, but
    // this same schema also validates a plugin's success object, and a plugin
    // that happens to use one of these names with a different shape would have
    // its result rejected at the client over something we do not control.
    level: {},
    summary: {},
    detail: {},
    uncertain: {},
    retry_with: {},
  }),

  /** Whatever the Luau returned, under one known wrapper field. */
  run_code: objectResult({ result: {} }),
};
