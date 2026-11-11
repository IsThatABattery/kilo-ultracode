// The `ultracode` keyword in the prompt, as in the CLI: the keyword is highlighted while it would opt the message in
// to a workflow, and Alt+W (Option+W) or Backspace right after a highlighted keyword dismisses it for that message.
// A dismissed message is sent with `noUltracode`, so the backend does not treat it as an opt-in.

import type { PromptSegment } from "./prompt-input-utils"

const KEYWORD = /\bultracode\b/gi

export type KeywordRange = { start: number; end: number }

/** Text offsets of each keyword the backend would honor. Text that is itself a slash command never counts. */
export function keywordRanges(text: string): KeywordRange[] {
  if (text.trimStart().startsWith("/")) return []
  return [...text.matchAll(KEYWORD)].map((match) => ({ start: match.index, end: match.index + match[0].length }))
}

/** Split plain segments so each keyword range renders as its own `ultracode` segment. */
export function markKeyword(segments: PromptSegment[], ranges: KeywordRange[]): PromptSegment[] {
  if (ranges.length === 0) return segments
  const result: PromptSegment[] = []
  let offset = 0
  for (const seg of segments) {
    const start = offset
    offset += seg.text.length
    if (seg.kind !== "plain") {
      result.push(seg)
      continue
    }
    let cursor = start
    for (const range of ranges) {
      if (range.end <= cursor || range.start >= offset) continue
      const from = Math.max(range.start, cursor)
      const to = Math.min(range.end, offset)
      if (from > cursor) result.push({ text: seg.text.slice(cursor - start, from - start), kind: "plain" })
      result.push({ text: seg.text.slice(from - start, to - start), kind: "ultracode" })
      cursor = to
    }
    if (cursor < offset) result.push({ text: seg.text.slice(cursor - start), kind: "plain" })
  }
  return result
}

/**
 * Whether a keydown dismisses the highlighted keyword: Alt+W (matched by key code, since Option+W types a
 * character on macOS), or a plain Backspace with the caret right after a keyword.
 */
export function dismissKey(
  e: Pick<KeyboardEvent, "key" | "code" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey">,
  caret: { start: number; end: number },
  ranges: KeywordRange[],
) {
  if (ranges.length === 0) return false
  if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === "KeyW") return true
  if (e.key !== "Backspace" || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return false
  return caret.start === caret.end && ranges.some((range) => range.end === caret.start)
}
