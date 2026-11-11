import { describe, expect, test } from "bun:test"
import { WorkflowMeta } from "../../../src/kilocode/workflow/meta"

const HEADER = "export const meta = { name: 'scan', description: 'Scan the repo' }"

const error = (script: string) => {
  try {
    WorkflowMeta.parse(script)
  } catch (err) {
    if (err instanceof WorkflowMeta.ParseError) return err
    throw err
  }
  throw new Error("expected a ParseError")
}

describe("WorkflowMeta.parse", () => {
  test("reads name, description, whenToUse and phases", () => {
    const parsed = WorkflowMeta.parse(`export const meta = {
  name: 'review-changes',
  "description": \`Review changed files\`,
  whenToUse: 'after a refactor',
  phases: [{ title: 'Review', detail: 'one agent per file' }, { title: 'Verify', model: 'anthropic/claude-haiku-4-5' }],
  extra: { retries: -1, ratio: +0.5, nothing: null, list: [1, 'two', true] },
}
const x = await agent('hi')
return x`)
    expect(parsed.meta).toEqual({
      name: "review-changes",
      description: "Review changed files",
      whenToUse: "after a refactor",
      phases: [
        { title: "Review", detail: "one agent per file" },
        { title: "Verify", model: "anthropic/claude-haiku-4-5" },
      ],
    })
  })

  test("defaults phases to an empty list", () => {
    expect(WorkflowMeta.parse(HEADER).meta).toEqual({ name: "scan", description: "Scan the repo", phases: [] })
  })

  test("blanks only the export keyword so offsets are unchanged", () => {
    const script = `${HEADER}\nreturn 1`
    const parsed = WorkflowMeta.parse(script)
    expect(parsed.body.length).toBe(script.length)
    expect(parsed.body).toBe(`       const meta = { name: 'scan', description: 'Scan the repo' }\nreturn 1`)
  })

  test("keeps leading comments in place", () => {
    const script = `// header comment\n/* block */ ${HEADER}\nreturn 1`
    const parsed = WorkflowMeta.parse(script)
    expect(parsed.body.split("\n")[1]).toBe(
      `/* block */        const meta = { name: 'scan', description: 'Scan the repo' }`,
    )
  })

  test("normalises CRLF and strips a BOM", () => {
    const parsed = WorkflowMeta.parse(`﻿${HEADER}\r\nconst a = 1\r\nreturn a`)
    expect(parsed.body).not.toContain("\r")
    expect(parsed.body.startsWith("       const meta")).toBe(true)
    expect(parsed.body.split("\n")).toHaveLength(3)
  })

  test("comments out a hashbang line", () => {
    const parsed = WorkflowMeta.parse(`#!/usr/bin/env kilo\n${HEADER}\nreturn 1`)
    expect(parsed.body.startsWith("///usr/bin/env kilo\n       const meta")).toBe(true)
  })

  test("allows top-level await and return", () => {
    expect(() =>
      WorkflowMeta.parse(`${HEADER}\nconst a = await agent('x')\nif (!a) return null\nreturn a`),
    ).not.toThrow()
  })

  test("does not reject mentions of Date.now or Math.random in strings and comments", () => {
    const script = `${HEADER}
// never call Date.now() or Math.random() here
const note = "Date.now() and Math.random() are unavailable"
return note`
    expect(() => WorkflowMeta.parse(script)).not.toThrow()
  })

  test("requires the meta export to be the first statement", () => {
    expect(error("const a = 1\n" + HEADER).message).toContain("must begin with `export const meta")
    expect(error("").message).toContain("must begin with `export const meta")
    expect(error("export let meta = { name: 'a', description: 'b' }").message).toContain("export const meta")
    expect(error("export const other = { name: 'a', description: 'b' }").message).toContain("export const meta")
    expect(error("export const meta = { name: 'a', description: 'b' }, x = 1").message).toContain("export const meta")
  })

  test.each([
    ["identifier", "{ name: NAME, description: 'b' }"],
    ["call", "{ name: make(), description: 'b' }"],
    ["spread", "{ ...base, name: 'a', description: 'b' }"],
    ["computed key", "{ ['name']: 'a', description: 'b' }"],
    ["template interpolation", "{ name: `a${1}`, description: 'b' }"],
    ["shorthand", "{ name, description: 'b' }"],
    ["method", "{ name: 'a', description: 'b', run() {} }"],
    ["getter", "{ name: 'a', description: 'b', get x() { return 1 } }"],
    ["array spread", "{ name: 'a', description: 'b', phases: [...p] }"],
    ["regex", "{ name: 'a', description: 'b', re: /x/ }"],
    ["binary expression", "{ name: 'a' + 'b', description: 'b' }"],
  ])("rejects a non-literal meta (%s)", (_, literal) => {
    const err = error(`export const meta = ${literal}`)
    expect(err.message).toContain("pure literal")
    expect(err.line).toBe(1)
    expect(err.message).toMatch(/\(1:\d+\)/)
  })

  test.each([
    ["missing name", "{ description: 'b' }", "meta.name"],
    ["empty name", "{ name: '  ', description: 'b' }", "meta.name"],
    ["missing description", "{ name: 'a' }", "meta.description"],
    ["numeric description", "{ name: 'a', description: 3 }", "meta.description"],
    ["non-string whenToUse", "{ name: 'a', description: 'b', whenToUse: 1 }", "meta.whenToUse"],
    ["phases not an array", "{ name: 'a', description: 'b', phases: 'x' }", "meta.phases"],
    ["phase not an object", "{ name: 'a', description: 'b', phases: ['x'] }", "meta.phases[0]"],
    ["phase without title", "{ name: 'a', description: 'b', phases: [{ detail: 'x' }] }", "meta.phases[0].title"],
    [
      "non-string detail",
      "{ name: 'a', description: 'b', phases: [{ title: 'x', detail: 2 }] }",
      "meta.phases[0].detail",
    ],
    ["meta not an object", "['a']", "object literal"],
  ])("validates fields (%s)", (_, literal, field) => {
    expect(error(`export const meta = ${literal}`).message).toContain(field)
  })

  test("rejects import declarations", () => {
    const err = error(`${HEADER}\nimport fs from 'node:fs'`)
    expect(err.message).toContain("import declarations")
    expect(err.line).toBe(2)
    expect(err.column).toBe(1)
  })

  test("rejects further exports", () => {
    expect(error(`${HEADER}\nexport const other = 1`).message).toContain("only `export const meta`")
    expect(error(`${HEADER}\nexport default 1`).message).toContain("only `export const meta`")
    expect(error(`${HEADER}\nexport * from './x.js'`).message).toContain("only `export const meta`")
  })

  test("rejects dynamic import anywhere, including nested functions", () => {
    const err = error(
      `${HEADER}\nconst load = async () => {\n  if (args) {\n    return await import('node:fs')\n  }\n}`,
    )
    expect(err.message).toContain("dynamic import()")
    expect(err.line).toBe(4)
    expect(err.column).toBe(18)
  })

  test("rejects import.meta", () => {
    expect(error(`${HEADER}\nreturn import.meta.url`).message).toContain("import.meta")
  })

  test("reports TypeScript syntax as a syntax error with line:col", () => {
    const err = error(`${HEADER}\nconst files: string[] = []`)
    expect(err.message).toContain("SyntaxError")
    expect(err.message).toContain("(2:")
    expect(err.message).toContain("TypeScript syntax is not supported")
    expect(err.line).toBe(2)
    expect(err.column).toBeGreaterThan(1)
  })

  test("reports syntax errors in the meta literal", () => {
    const err = error("export const meta = { name: 'a' description: 'b' }")
    expect(err.message).toContain("SyntaxError")
    expect(err.line).toBe(1)
  })

  test("ParseError is an Error with a stable name", () => {
    const err = error("nope")
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe("WorkflowParseError")
  })
})
