// Tool choice for structured-output (`format: json_schema`) turns.
//
// Anthropic rejects a forced tool choice while (adaptive) thinking is on, and some
// openai-compatible backends ignore or reject "required". Workflow agent sessions therefore run
// with "auto": their system prompt tells them to call StructuredOutput, and the workflow spawn
// layer re-prompts (up to its attempt limit) when the call is missing or fails validation.
// Every other session keeps upstream's forced "required".

export namespace KiloStructured {
  export function choice(session: { metadata?: Record<string, unknown> }): "auto" | "required" {
    if (session.metadata?.["kilo.workflow"] != null) return "auto"
    return "required"
  }
}
