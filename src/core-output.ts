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
   * The instance payload is built inside Studio, so the per-instance shape stays
   * open. The wrapper fields below are the server's own and are exact: `cursor`
   * for pagination, `snapshot` for the `since` short-circuit, `source_file` for
   * the Rojo sourcemap annotation.
   */
  read: objectResult({
    instances: { type: "array" },
    children: { type: "array" },
    camera: { type: "object" },
    cursor: { type: "string" },
    snapshot: { type: "string" },
    unchanged: { type: "boolean" },
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
   * `applied` and `results` come from the plugin. `level`, `summary`,
   * `retry_with` and `lint` are the server's own gate and lint output.
   */
  mutate: objectResult({
    applied: { type: "number" },
    results: { type: "array" },
    lint: { type: "array" },
    level: { type: "string", enum: ["none", "soft", "hard", "nuclear"] },
    summary: { type: "string" },
    detail: { type: "array" },
    uncertain: { type: "boolean" },
    retry_with: { type: "object" },
  }),

  /** Whatever the Luau returned, under one known wrapper field. */
  run_code: objectResult({ result: {} }),
};
