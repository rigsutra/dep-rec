// Argument validation and JSON Schema generation from one declaration, so
// what `tools/list` publishes and what `tools/call` enforces can never drift.
// This replaces zod, which was only ever used for these three tool inputs.
//
// The rules are deliberately strict about types and deliberately lenient
// about unknown keys: a model that sends an extra field should have its call
// answered, not rejected, but a model that sends a string where a number
// belongs must be told rather than silently coerced.

export type FieldSpec =
  | { type: "string"; description: string; required?: boolean; enum?: readonly string[] }
  | { type: "integer"; description: string; required?: boolean; min?: number; max?: number };

export interface JsonSchema {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  required: string[];
}

export function toJsonSchema(fields: Record<string, FieldSpec>): JsonSchema {
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];

  for (const [name, spec] of Object.entries(fields)) {
    const prop: Record<string, unknown> = { description: spec.description };
    if (spec.type === "string") {
      prop.type = "string";
      if (spec.enum) prop.enum = [...spec.enum];
    } else {
      prop.type = "integer";
      if (spec.min !== undefined) prop.minimum = spec.min;
      if (spec.max !== undefined) prop.maximum = spec.max;
    }
    properties[name] = prop;
    if (spec.required) required.push(name);
  }

  return { type: "object", properties, required };
}

export type Validation =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; errors: string[] };

// Caller-controlled objects can own keys named `constructor`, `__proto__`,
// `toString` and so on. Plain member access on such an object returns the
// inherited built-in when the key is absent, which is how a payload shaped
// like { constructor: { prototype: {} } } ends up confusing a type check
// somewhere downstream and surfacing as a protocol-level internal error
// instead of a plain "bad argument". hasOwnProperty is the fix, and the
// result object is null-prototyped so nothing we hand onwards can inherit
// anything either.
function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

export function validateArgs(fields: Record<string, FieldSpec>, args: Record<string, unknown>): Validation {
  const errors: string[] = [];
  const value: Record<string, unknown> = Object.create(null);

  for (const [name, spec] of Object.entries(fields)) {
    if (!hasOwn(args, name)) {
      if (spec.required) errors.push(`\`${name}\` is required`);
      continue;
    }

    const raw = args[name];

    // An explicit null for an optional field is treated as "not supplied"
    // rather than an error; models emit it routinely for absent values.
    if (raw === null && !spec.required) continue;

    if (spec.type === "string") {
      if (typeof raw !== "string") {
        errors.push(`\`${name}\` must be a string, received ${typeName(raw)}`);
        continue;
      }
      if (spec.enum && !spec.enum.includes(raw)) {
        errors.push(`\`${name}\` must be one of ${spec.enum.map((e) => `"${e}"`).join(", ")}, received "${raw}"`);
        continue;
      }
      value[name] = raw;
      continue;
    }

    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      errors.push(`\`${name}\` must be a number, received ${typeof raw === "number" ? String(raw) : typeName(raw)}`);
      continue;
    }
    if (!Number.isInteger(raw)) {
      errors.push(`\`${name}\` must be a whole number, received ${raw}`);
      continue;
    }
    if (spec.min !== undefined && raw < spec.min) {
      errors.push(`\`${name}\` must be at least ${spec.min}, received ${raw}`);
      continue;
    }
    if (spec.max !== undefined && raw > spec.max) {
      errors.push(`\`${name}\` must be at most ${spec.max}, received ${raw}`);
      continue;
    }
    value[name] = raw;
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}
