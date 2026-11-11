import { describe, expect, it } from "bun:test"
import { keywordMetadata } from "../../src/kilo-provider/prompt-options"
import { buildPromptSegments } from "../../webview-ui/src/components/chat/prompt-input-utils"
import { dismissKey, keywordRanges, markKeyword } from "../../webview-ui/src/components/chat/ultracode-keyword"

const key = (init: Partial<KeyboardEvent>) => ({
  key: "",
  code: "",
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...init,
})

describe("keywordRanges", () => {
  it("finds every whole-word keyword, case-insensitively", () => {
    expect(keywordRanges("ultracode: fix it, then ULTRACODE again")).toEqual([
      { start: 0, end: 9 },
      { start: 24, end: 33 },
    ])
  })

  it("ignores partial words and slash-command text", () => {
    expect(keywordRanges("ultracoder ultracodes")).toEqual([])
    expect(keywordRanges("  /review ultracode")).toEqual([])
  })
})

describe("markKeyword", () => {
  it("splits plain segments around the keyword and leaves mentions and pastes alone", () => {
    const text = "@a.ts ultracode this"
    const segments = buildPromptSegments(text, new Set(["a.ts"]), [])
    expect(markKeyword(segments, keywordRanges(text))).toEqual([
      { text: "@a.ts", kind: "mention" },
      { text: " ", kind: "plain" },
      { text: "ultracode", kind: "ultracode" },
      { text: " this", kind: "plain" },
    ])
  })

  it("keeps the rendered text identical to the prompt", () => {
    const text = "ultracode one ultracode"
    const marked = markKeyword(buildPromptSegments(text, new Set(), []), keywordRanges(text))
    expect(marked.map((seg) => seg.text).join("")).toBe(text)
    expect(marked.filter((seg) => seg.kind === "ultracode")).toHaveLength(2)
  })

  it("returns the segments unchanged without a keyword", () => {
    const segments = buildPromptSegments("plain text", new Set(), [])
    expect(markKeyword(segments, [])).toBe(segments)
  })
})

describe("dismissKey", () => {
  const ranges = keywordRanges("try ultracode now")

  it("dismisses on Alt+W by key code (Option+W types a character on macOS)", () => {
    expect(dismissKey(key({ altKey: true, code: "KeyW", key: "∑" }), { start: 0, end: 0 }, ranges)).toBe(true)
    expect(dismissKey(key({ altKey: true, ctrlKey: true, code: "KeyW" }), { start: 0, end: 0 }, ranges)).toBe(false)
  })

  it("dismisses on Backspace only with the caret right after a keyword", () => {
    expect(dismissKey(key({ key: "Backspace" }), { start: 13, end: 13 }, ranges)).toBe(true)
    expect(dismissKey(key({ key: "Backspace" }), { start: 12, end: 12 }, ranges)).toBe(false)
    expect(dismissKey(key({ key: "Backspace" }), { start: 4, end: 13 }, ranges)).toBe(false)
    expect(dismissKey(key({ key: "Backspace", ctrlKey: true }), { start: 13, end: 13 }, ranges)).toBe(false)
  })

  it("does nothing while no keyword is highlighted", () => {
    expect(dismissKey(key({ altKey: true, code: "KeyW" }), { start: 0, end: 0 }, [])).toBe(false)
  })
})

describe("keywordMetadata", () => {
  it("flags the text part only when the keyword was dismissed, keeping other kilo metadata", () => {
    const base = { review: true, kilo: { injected: { title: "Fix" } } }
    expect(keywordMetadata(base, false)).toBe(base)
    expect(keywordMetadata(undefined, undefined)).toBeUndefined()
    expect(keywordMetadata(base, true)).toEqual({
      review: true,
      kilo: { injected: { title: "Fix" }, noUltracode: true },
    })
    expect(keywordMetadata(undefined, true)).toEqual({ kilo: { noUltracode: true } })
  })
})
