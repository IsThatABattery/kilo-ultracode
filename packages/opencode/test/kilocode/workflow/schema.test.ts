import { describe, expect, test } from "bun:test"
import type { Provider } from "../../../src/provider/provider"
import { WorkflowSchema } from "../../../src/kilocode/workflow/schema"

const person = {
  type: "object",
  properties: {
    name: { type: "string" },
    age: { type: "integer", minimum: 0 },
    role: { enum: ["admin", "user"] },
  },
  required: ["name"],
  additionalProperties: false,
}

describe("WorkflowSchema.check", () => {
  test("accepts an object schema whose required names are declared", () => {
    expect(WorkflowSchema.check(person)).toBeUndefined()
    expect(WorkflowSchema.check({ type: "object", properties: {} })).toBeUndefined()
  })

  test("rejects a root that is not {type: 'object', properties: {...}}", () => {
    const root = "schema must have {type: 'object', properties: {...}} at its root"
    expect(WorkflowSchema.check(undefined)).toBe(root)
    expect(WorkflowSchema.check("object")).toBe(root)
    expect(WorkflowSchema.check([])).toBe(root)
    expect(WorkflowSchema.check({ type: "array", items: { type: "string" } })).toBe(root)
    expect(WorkflowSchema.check({ type: "object" })).toBe(root)
    expect(WorkflowSchema.check({ type: "object", properties: [] })).toBe(root)
    expect(WorkflowSchema.check({ properties: { a: { type: "string" } } })).toBe(root)
  })

  test("rejects required names missing from properties", () => {
    expect(WorkflowSchema.check({ type: "object", properties: { a: {} }, required: ["a", "b", "c"] })).toBe(
      "schema.required lists properties missing from schema.properties: b, c",
    )
    expect(WorkflowSchema.check({ type: "object", properties: { a: {} }, required: "a" })).toBe(
      "schema.required must be an array of property names",
    )
  })

  test("reports schemas ajv cannot compile", () => {
    const error = WorkflowSchema.check({ type: "object", properties: { a: { type: "nope" } } })
    expect(error).toStartWith("invalid schema: ")
    expect(error).toContain("type")
  })

  test("compiles the dialect a schema declares", () => {
    const tuple = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { pair: { type: "array", prefixItems: [{ type: "string" }, { type: "number" }], items: false } },
    }
    expect(WorkflowSchema.check(tuple)).toBeUndefined()
    expect(WorkflowSchema.validate(tuple, { pair: ["a", 1] })).toBeUndefined()
    expect(WorkflowSchema.validate(tuple, { pair: ["a", "b"] })).toContain("/pair/1")
    expect(WorkflowSchema.validate(tuple, { pair: ["a", 1, 2] })).toBeDefined()

    const draft7 = {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: { pair: { type: "array", items: [{ type: "string" }, { type: "number" }] } },
    }
    expect(WorkflowSchema.check(draft7)).toBeUndefined()
    expect(WorkflowSchema.validate(draft7, { pair: ["a", 1] })).toBeUndefined()
    expect(WorkflowSchema.validate(draft7, { pair: [1, 1] })).toContain("/pair/0")
  })
})

describe("WorkflowSchema.validate", () => {
  test("accepts conforming values", () => {
    expect(WorkflowSchema.validate(person, { name: "Ada" })).toBeUndefined()
    expect(WorkflowSchema.validate(person, { name: "Ada", age: 36, role: "admin" })).toBeUndefined()
  })

  test("describes every violation with its location", () => {
    expect(WorkflowSchema.validate(person, {})).toBe("(root) must have required property 'name'")
    expect(WorkflowSchema.validate(person, { name: 1 })).toBe("/name must be string")
    expect(WorkflowSchema.validate(person, { name: "Ada", extra: true })).toBe(
      "(root) must NOT have additional properties 'extra'",
    )
    expect(WorkflowSchema.validate(person, { name: "Ada", role: "root" })).toBe(
      '/role must be equal to one of the allowed values ["admin","user"]',
    )
    const all = WorkflowSchema.validate(person, { age: -1, role: "x" })
    expect(all?.split("; ")).toHaveLength(3)
    expect(WorkflowSchema.validate(person, "Ada")).toBe("(root) must be object")
    expect(WorkflowSchema.validate(person, null)).toBe("(root) must be object")
  })

  test("does not enforce string formats", () => {
    const schema = { type: "object", properties: { at: { type: "string", format: "date-time" } } }
    expect(WorkflowSchema.validate(schema, { at: "yesterday" })).toBeUndefined()
  })
})

describe("WorkflowSchema.portable", () => {
  test("sanitises a copy for the provider and leaves the original for validation", () => {
    const model = { providerID: "moonshotai", api: { id: "kimi-k2", npm: "@ai-sdk/openai-compatible" } }
    const schema = {
      type: "object",
      properties: { pair: { type: "array", items: [{ type: "string" }, { type: "number" }] } },
    }
    const sent = WorkflowSchema.portable(model as unknown as Provider.Model, schema)
    expect(sent).toEqual({ type: "object", properties: { pair: { type: "array", items: { type: "string" } } } })
    expect(schema.properties.pair.items).toHaveLength(2)
    expect(WorkflowSchema.validate(schema, { pair: ["a", "b"] })).toContain("/pair/1")
  })
})
