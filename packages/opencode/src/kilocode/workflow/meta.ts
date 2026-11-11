import * as acorn from "acorn"
import type { Meta, Phase } from "./types"

export namespace WorkflowMeta {
  export class ParseError extends Error {
    override name = "WorkflowParseError"
    constructor(
      message: string,
      readonly line?: number,
      readonly column?: number,
    ) {
      super(message)
    }
  }

  export type Parsed = {
    meta: Meta
    /** Executable script body: `export const meta` rewritten in place (same line/column offsets), CRLF normalised. */
    body: string
  }

  const HEADER = "Workflow scripts must begin with `export const meta = { name, description, phases }`"
  const LITERAL =
    "`meta` must be a pure literal (no variables, calls, spreads, computed keys or template interpolation)"

  type Spot = { start: number; loc?: acorn.SourceLocation | null }

  // acorn reports 0-based columns; messages use 1-based "line:col" like editors and stack traces.
  const fail = (message: string, node?: Spot): never => {
    const pos = node?.loc?.start
    if (!pos) throw new ParseError(message)
    throw new ParseError(`${message} (${pos.line}:${pos.column + 1})`, pos.line, pos.column + 1)
  }

  const syntax = (err: unknown): never => {
    if (!(err instanceof SyntaxError)) throw err
    const pos = (err as SyntaxError & { loc?: acorn.Position }).loc
    const text = err.message.replace(/\s*\(\d+:\d+\)$/, "")
    const hint = "(workflow scripts are plain JavaScript; TypeScript syntax is not supported)"
    if (!pos) throw new ParseError(`SyntaxError: ${text} ${hint}`)
    throw new ParseError(`SyntaxError: ${text} (${pos.line}:${pos.column + 1}) ${hint}`, pos.line, pos.column + 1)
  }

  const read = (source: string) => {
    try {
      return acorn.parse(source, {
        ecmaVersion: "latest",
        sourceType: "module",
        allowAwaitOutsideFunction: true,
        allowReturnOutsideFunction: true,
        locations: true,
      })
    } catch (err) {
      return syntax(err)
    }
  }

  /** Evaluate a pure literal AST into a plain value without running any code. */
  const literal = (node: acorn.AnyNode): unknown => {
    if (node.type === "Literal") {
      if (node.regex || node.bigint !== undefined) return fail(LITERAL, node)
      return node.value
    }
    if (node.type === "TemplateLiteral") {
      if (node.expressions.length) return fail(LITERAL, node)
      return node.quasis.map((item) => item.value.cooked ?? item.value.raw).join("")
    }
    if (node.type === "UnaryExpression" && (node.operator === "-" || node.operator === "+")) {
      const value = node.argument.type === "Literal" ? node.argument.value : undefined
      if (typeof value !== "number") return fail(LITERAL, node)
      return node.operator === "-" ? -value : value
    }
    if (node.type === "ArrayExpression") {
      return node.elements.map((item) => {
        if (!item) return null
        if (item.type === "SpreadElement") return fail(LITERAL, item)
        return literal(item)
      })
    }
    if (node.type === "ObjectExpression") {
      return Object.fromEntries(
        node.properties.map((prop) => {
          if (prop.type === "SpreadElement") return fail(LITERAL, prop)
          if (prop.computed || prop.shorthand || prop.method || prop.kind !== "init") return fail(LITERAL, prop)
          const key =
            prop.key.type === "Identifier"
              ? prop.key.name
              : prop.key.type === "Literal" &&
                  (typeof prop.key.value === "string" || typeof prop.key.value === "number")
                ? String(prop.key.value)
                : fail(LITERAL, prop.key)
          return [key, literal(prop.value)]
        }),
      )
    }
    return fail(LITERAL, node)
  }

  const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value)

  const need = (value: unknown, field: string, node: Spot) => {
    if (typeof value === "string" && value.trim()) return value
    return fail(`meta.${field} must be a non-empty string`, node)
  }

  const maybe = (value: unknown, field: string, node: Spot) => {
    if (value === undefined || typeof value === "string") return value
    return fail(`meta.${field} must be a string`, node)
  }

  const validate = (value: unknown, node: Spot): Meta => {
    if (!record(value)) return fail("`meta` must be an object literal", node)
    const name = need(value.name, "name", node)
    const description = need(value.description, "description", node)
    const when = maybe(value.whenToUse, "whenToUse", node)
    const list =
      value.phases === undefined
        ? []
        : Array.isArray(value.phases)
          ? value.phases
          : fail("meta.phases must be an array of { title, detail? }", node)
    const phases = list.map((item: unknown, index: number): Phase => {
      if (!record(item)) return fail(`meta.phases[${index}] must be an object like { title, detail? }`, node)
      const title = need(item.title, `phases[${index}].title`, node)
      const detail = maybe(item.detail, `phases[${index}].detail`, node)
      const model = maybe(item.model, `phases[${index}].model`, node)
      return {
        title,
        ...(detail === undefined ? {} : { detail }),
        ...(model === undefined ? {} : { model }),
      }
    })
    return {
      name,
      description,
      ...(when === undefined ? {} : { whenToUse: when }),
      phases,
    }
  }

  /** Reject module syntax anywhere in the body; workflow scripts cannot load code. */
  const scan = (program: acorn.Program, header: acorn.Node) => {
    const stack: unknown[] = [program]
    while (stack.length) {
      const node = stack.pop()
      if (Array.isArray(node)) {
        stack.push(...node)
        continue
      }
      if (typeof node !== "object" || node === null || typeof (node as acorn.Node).type !== "string") continue
      const item = node as acorn.AnyNode
      if (item.type === "ImportExpression") fail("dynamic import() is not available in workflow scripts", item)
      if (item.type === "ImportDeclaration") fail("import declarations are not available in workflow scripts", item)
      if (item.type === "MetaProperty" && item.meta.name === "import")
        fail("import.meta is not available in workflow scripts", item)
      if (
        (item.type === "ExportNamedDeclaration" ||
          item.type === "ExportDefaultDeclaration" ||
          item.type === "ExportAllDeclaration") &&
        item !== header
      )
        fail("only `export const meta` may be exported from a workflow script", item)
      for (const [key, child] of Object.entries(item)) {
        if (key === "loc") continue
        if (typeof child === "object" && child !== null) stack.push(child)
      }
    }
  }

  /**
   * Parse and validate a workflow script (contract owned by the sandbox unit).
   * - The first statement must be `export const meta = <pure object literal>` with string `name` and `description`,
   *   optional string `whenToUse`, optional `phases: [{ title, detail?, model? }]`.
   * - Rejects any other import/export, dynamic `import()`, and TypeScript syntax, with a message naming line:column.
   */
  export function parse(script: string): Parsed {
    const source = script.replace(/^﻿/, "").replace(/\r\n?/g, "\n")
    const program = read(source)
    const first = program.body[0]
    if (!first) return fail(HEADER)
    if (
      first.type !== "ExportNamedDeclaration" ||
      first.declaration?.type !== "VariableDeclaration" ||
      first.declaration.kind !== "const" ||
      first.declaration.declarations.length !== 1
    )
      return fail(HEADER, first)
    const decl = first.declaration.declarations[0]
    if (decl.id.type !== "Identifier" || decl.id.name !== "meta" || !decl.init) return fail(HEADER, first)
    const meta = validate(literal(decl.init), decl.init)
    scan(program, first)
    // Blank out `export` (and a hashbang) so the body runs as a plain function body with unchanged offsets.
    const body =
      source.slice(0, first.start) + " ".repeat("export".length) + source.slice(first.start + "export".length)
    return { meta, body: body.startsWith("#!") ? "//" + body.slice(2) : body }
  }
}
