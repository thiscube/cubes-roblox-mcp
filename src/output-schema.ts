/**
 * Declared result shapes (PLAN.md #5).
 *
 * Every tool in `tools/list` carries an `outputSchema`, and every result carries
 * `structuredContent` that validates against it. Before this, everything came
 * back as a JSON blob inside a text block and the client had to string-match.
 *
 * TWO RULES, BOTH ABOUT HONESTY
 * -----------------------------
 * 1. **Declare only what is actually known.** Most specialist tools ship
 *    generated Luau to the plugin and hand back whatever Studio returned, so the
 *    real shape is produced on the other side of the bridge and cannot be
 *    verified from here. Those tools declare the fields this server adds and
 *    stay open (`additionalProperties: true`) about the rest. Tools implemented
 *    server-side declare their exact shape, and the test suite calls them and
 *    validates the real payload against it. A schema that lies is worse than no
 *    schema, because clients reject results that do not match it.
 *
 * 2. **Never mark a field required.** Any handler can return the error envelope
 *    instead of its success shape, so a `required` list would make every error
 *    result fail validation at the client.
 *
 * COST
 * ----
 * These schemas are re-sent on every turn, same as input schemas, and the
 * catalog is on a budget (test/unit/catalog-budget.test.mjs). So the envelope
 * fields that appear on every single result — `error`, `hint`, `next_likely`,
 * `auto_unlocked` — are NOT repeated into 63 schemas. They are documented once,
 * in the `cubes://schema/result` resource. Per-tool schemas carry only what is
 * specific to that tool.
 */

export type JsonSchema = Record<string, unknown>;

/**
 * An object result carrying `properties`, open about everything else.
 *
 * Open rather than strict because the server merges envelope fields into every
 * payload after the handler returns. Openness is the JSON Schema default, so
 * `additionalProperties: true` is deliberately NOT emitted — it would mean
 * exactly the same thing and cost 27 characters on every tool, every turn.
 */
export function objectResult(properties?: Record<string, JsonSchema>): JsonSchema {
  return properties && Object.keys(properties).length > 0
    ? { type: "object", properties }
    : { type: "object" };
}

/** The shape of the envelope the server can add to any result. Documented as a resource. */
export const RESULT_ENVELOPE: JsonSchema = {
  type: "object",
  properties: {
    error: { type: "string" },
    hint: { type: "string" },
    message: { type: "string" },
    next_likely: { type: "array", items: { type: "string" } },
    auto_unlocked: { type: "array", items: { type: "string" } },
    unchanged: { type: "boolean" },
  },
};

/** Plugin-owned shape: the tool returns whatever Studio gave it. */
export const OPAQUE_RESULT: JsonSchema = objectResult();

/**
 * `evalTool` wraps the plugin's answer as `{ result }`, so that one field is
 * known even though its contents are not.
 */
export const EVAL_RESULT: JsonSchema = objectResult({ result: {} });

/**
 * A mutate batch.
 *
 * Only the fields this server writes are typed: the destructiveness gate's
 * output and the selene lint array. `applied` and `results` come from the plugin
 * and are named but untyped, per Rule 1 above.
 */
export const MUTATE_RESULT: JsonSchema = objectResult({
  applied: {},
  results: {},
  lint: { type: "array" },
  appliedLevel: { type: "string", enum: ["none", "soft", "hard", "nuclear"] },
  level: { type: "string", enum: ["none", "soft", "hard", "nuclear"] },
  summary: { type: "string" },
  retry_with: { type: "object" },
});
