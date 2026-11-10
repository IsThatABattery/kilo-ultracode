import type { Meta } from "./types"

export namespace WorkflowMeta {
  export class ParseError extends Error {
    override name = "WorkflowParseError"
  }

  export type Parsed = {
    meta: Meta
    /** Executable script body: `export const meta` rewritten in place (same line/column offsets), CRLF normalised. */
    body: string
  }

  /**
   * Parse and validate a workflow script (contract owned by the sandbox unit).
   * - The first statement must be `export const meta = <pure object literal>` with string `name` and `description`,
   *   optional string `whenToUse`, optional `phases: [{ title, detail?, model? }]`.
   * - Rejects any other import/export, dynamic `import()`, and TypeScript syntax, with a message naming line:column.
   */
  export function parse(script: string): Parsed {
    throw new ParseError(`unimplemented: ${script.length}`)
  }
}
