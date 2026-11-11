// JSON Schema handling for `agent(prompt, { schema })`.
//
// The schema is checked before the agent starts (an unsatisfiable schema makes the agent() call throw),
// the subagent's StructuredOutput call is validated locally — the AI SDK tool does not enforce the
// schema and OpenAI-family tools run with strict: false — and a provider-portable copy is what gets
// sent to the model. Validation always runs against the script's original schema; when the portable
// copy retyped values (Gemini sends numeric enums as strings) the answer is coerced back to it first.

import Ajv, { type ErrorObject, type ValidateFunction } from "ajv"
import Ajv2019 from "ajv/dist/2019"
import Ajv2020 from "ajv/dist/2020"
import type { JSONSchema7 } from "@ai-sdk/provider"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"

type Schema = Record<string, unknown>

export namespace WorkflowSchema {
  const options = {
    allErrors: true,
    strict: false,
    validateFormats: false,
    addUsedSchema: false,
    logger: false,
  } as const

  const engines = {
    draft7: new Ajv(options),
    draft2019: new Ajv2019(options),
    draft2020: new Ajv2020(options),
  }

  const loose = {
    draft7: new Ajv({ ...options, coerceTypes: true }),
    draft2019: new Ajv2019({ ...options, coerceTypes: true }),
    draft2020: new Ajv2020({ ...options, coerceTypes: true }),
  }

  const cache = new Map<string, ValidateFunction>()
  const LIMIT = 256

  function record(value: unknown): value is Schema {
    return typeof value === "object" && value !== null && !Array.isArray(value)
  }

  /** Engine for the schema's declared `$schema` dialect; anything else is validated as draft-07. */
  function engine(schema: Schema, set: typeof engines) {
    const dialect = typeof schema.$schema === "string" ? schema.$schema : ""
    if (dialect.includes("2020-12")) return { ajv: set.draft2020, schema }
    if (dialect.includes("2019-09")) return { ajv: set.draft2019, schema }
    const { $schema: _, ...rest } = schema
    return { ajv: set.draft7, schema: rest }
  }

  /** Compiled validator for `schema`, or the compile error message. `coerce` compiles with type coercion. */
  function compile(schema: Schema, coerce = false): ValidateFunction | string {
    const key = (coerce ? "coerce:" : "") + JSON.stringify(schema)
    const hit = cache.get(key)
    if (hit) return hit
    const picked = engine(schema, coerce ? loose : engines)
    const result = (() => {
      try {
        return picked.ajv.compile(picked.schema)
      } catch (err) {
        return err instanceof Error ? err.message : String(err)
      }
    })()
    if (typeof result === "string") return result
    if (cache.size >= LIMIT) cache.clear()
    cache.set(key, result)
    return result
  }

  function describe(errors: ErrorObject[] | null | undefined) {
    if (!errors?.length) return "value does not match the schema"
    return errors
      .map((error) => {
        const where = error.instancePath || "(root)"
        const extra =
          error.keyword === "additionalProperties" && typeof error.params.additionalProperty === "string"
            ? ` '${error.params.additionalProperty}'`
            : error.keyword === "enum" && Array.isArray(error.params.allowedValues)
              ? ` ${JSON.stringify(error.params.allowedValues)}`
              : ""
        return `${where} ${error.message ?? "is invalid"}${extra}`
      })
      .join("; ")
  }

  /** Why `schema` cannot be used for an agent() call, or undefined when it can. */
  export function check(schema: unknown): string | undefined {
    if (!record(schema) || schema.type !== "object" || !record(schema.properties)) {
      return "schema must have {type: 'object', properties: {...}} at its root"
    }
    if (schema.required !== undefined) {
      if (!Array.isArray(schema.required) || schema.required.some((item) => typeof item !== "string")) {
        return "schema.required must be an array of property names"
      }
      const properties = schema.properties
      const missing = schema.required.filter((item: string) => !Object.hasOwn(properties, item))
      if (missing.length)
        return `schema.required lists properties missing from schema.properties: ${missing.join(", ")}`
    }
    const compiled = compile(schema)
    if (typeof compiled === "string") return `invalid schema: ${compiled}`
    return undefined
  }

  /** Validation error for `value` against `schema`, or undefined when it conforms. */
  export function validate(schema: Schema, value: unknown): string | undefined {
    const run = compile(schema)
    if (typeof run === "string") return `invalid schema: ${run}`
    if (run(value)) return undefined
    return describe(run.errors)
  }

  /**
   * A copy of `schema` where every `enum` without a `type` whose values all share one JSON type gets that type, so
   * type coercion also applies to it (Ajv coerces at the `type` keyword, before `enum` is checked).
   */
  function typed(node: unknown): unknown {
    if (Array.isArray(node)) return node.map(typed)
    if (!record(node)) return node
    const out = Object.fromEntries(Object.entries(node).map((entry) => [entry[0], typed(entry[1])]))
    if (out.type !== undefined || !Array.isArray(node.enum) || node.enum.length === 0) return out
    const values = node.enum as unknown[]
    const type = values.every((item) => Number.isInteger(item))
      ? "integer"
      : values.every((item) => typeof item === "number")
        ? "number"
        : values.every((item) => typeof item === "boolean")
          ? "boolean"
          : undefined
    return type ? { ...out, type } : out
  }

  /**
   * Validate `value` against `schema` after coercing primitives to the types it declares (e.g. "2" → 2), for
   * answers given against a provider copy that retyped them. Returns the coerced value; `value` is not mutated.
   */
  export function coerce(schema: Schema, value: unknown): { error?: string; value: unknown } {
    const run = compile(typed(schema) as Schema, true)
    if (typeof run === "string") return { error: `invalid schema: ${run}`, value }
    const copy = structuredClone(value)
    if (run(copy)) return { value: copy }
    return { error: describe(run.errors), value }
  }

  /** The schema as sent to `model`'s provider (provider-specific sanitising); never used for validation. */
  export function portable(model: Provider.Model, schema: Schema): Schema {
    return ProviderTransform.schema(model, structuredClone(schema) as JSONSchema7) as Schema
  }
}
