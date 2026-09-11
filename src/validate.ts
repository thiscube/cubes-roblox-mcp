/**
 * Minimal JSON Schema validation for tool arguments.
 *
 * The low-level MCP `Server` does NOT check `arguments` against a tool's declared
 * `inputSchema` — it hands them through untouched. Every handler in this project
 * then did a bare cast. That is what let a string reach a field declared
 * `type: "number"` and land inside a PowerShell script (AUDIT.md #3), and what let
 * `instance_duplicate` take an unbounded `count` (AUDIT.md #14).
 *
 * This covers the subset of JSON Schema the tool definitions actually use:
 * type, enum, required, properties, items, oneOf, minimum/maximum. It is
 * deliberately small — a full validator is a dependency we don't need, and an
 * unsupported keyword is ignored rather than guessed at.
 */

export interface ValidationError {
  path: string;
  message: string;
}

type Schema = Record<string, any>;

const TYPE_CHECKS: Record<string, (v: unknown) => boolean> = {
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number" && Number.isFinite(v),
  integer: (v) => typeof v === "number" && Number.isInteger(v),
  boolean: (v) => typeof v === "boolean",
  object: (v) => v !== null && typeof v === "object" && !Array.isArray(v),
  array: (v) => Array.isArray(v),
  null: (v) => v === null,
};

function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function check(value: unknown, schema: Schema, path: string, errors: ValidationError[]): void {
  if (!schema || typeof schema !== "object") return;

  // oneOf: valid if any branch validates.
  if (Array.isArray(schema.oneOf)) {
    const anyOk = schema.oneOf.some((branch: Schema) => {
      const sub: ValidationError[] = [];
      check(value, branch, path, sub);
      return sub.length === 0;
    });
    if (!anyOk) {
      errors.push({ path, message: `does not match any allowed shape` });
    }
    return;
  }

  if (typeof schema.type === "string") {
    const fn = TYPE_CHECKS[schema.type];
    if (fn && !fn(value)) {
      errors.push({ path, message: `expected ${schema.type}, got ${typeName(value)}` });
      return; // no point checking deeper against the wrong type
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value as never)) {
    errors.push({ path, message: `must be one of ${schema.enum.map((e: unknown) => JSON.stringify(e)).join(", ")}` });
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push({ path, message: `must be >= ${schema.minimum}` });
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push({ path, message: `must be <= ${schema.maximum}` });
    }
  }

  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => check(item, schema.items, `${path}[${i}]`, errors));
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (obj[key] === undefined) {
          errors.push({ path: path ? `${path}.${key}` : key, message: "is required" });
        }
      }
    }
    if (schema.properties && typeof schema.properties === "object") {
      for (const [key, sub] of Object.entries(schema.properties as Record<string, Schema>)) {
        if (obj[key] === undefined) continue;
        check(obj[key], sub, path ? `${path}.${key}` : key, errors);
      }
    }
  }
}

/** Validate `args` against `schema`. Returns [] when valid. */
export function validateArgs(args: unknown, schema: unknown): ValidationError[] {
  const errors: ValidationError[] = [];
  check(args ?? {}, (schema ?? {}) as Schema, "", errors);
  return errors;
}

/** Build the structured payload a tool returns when its arguments don't validate. */
export function invalidArgsPayload(tool: string, errors: ValidationError[]) {
  return {
    error: "invalid_arguments",
    tool,
    problems: errors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message)),
    hint: "Fix the arguments to match the tool's inputSchema and retry.",
  };
}
