// Token budget for workflow scripts (`budget.total` / `budget.spent()`), from a "+500k"-style directive in the
// user's latest message.

import type { SessionV1 } from "@opencode-ai/core/v1/session"

export namespace WorkflowBudget {
  // "+500k", "+1.5m", "+2M": a plus sign at a word start, a number, then k or m.
  const DIRECTIVE = /(?:^|[\s(])\+(\d+(?:\.\d+)?)\s?([km])(?![a-z0-9])/i

  /** Token target of the first directive in `text`, or null. */
  export function parse(text: string) {
    const match = DIRECTIVE.exec(text)
    if (!match) return null
    const scale = match[2].toLowerCase() === "m" ? 1_000_000 : 1_000
    const value = Math.round(Number(match[1]) * scale)
    return value > 0 ? value : null
  }

  /** Text the user typed: not synthetic (background results, reminders) and not ignored. */
  function typed(message: SessionV1.WithParts) {
    return message.parts
      .flatMap((part) => (part.type === "text" && !part.synthetic && !part.ignored ? [part.text] : []))
      .join("\n")
  }

  /**
   * The turn's budget: the directive in the latest human message (null when absent), the main loop's output tokens
   * spent since that message, and the message id (runs launched for one turn share a token pool).
   */
  export function from(messages: ReadonlyArray<SessionV1.WithParts>) {
    const human = messages.findLast((message) => message.info.role === "user" && typed(message).trim().length > 0)
    if (!human) return { total: null, main: 0 }
    const main = messages
      .slice(messages.indexOf(human) + 1)
      .filter((message) => message.info.role === "assistant")
      .flatMap((message) => message.parts)
      .reduce((sum, part) => (part.type === "step-finish" ? sum + part.tokens.output + part.tokens.reasoning : sum), 0)
    return { total: parse(typed(human)), main, turn: human.info.id }
  }
}
