import { expect, test } from "bun:test"
import { RGBA, SyntaxStyle, type TextareaRenderable } from "@opentui/core"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { createSignal, onCleanup } from "solid-js"
import { UltracodeKeyword } from "../../src/kilocode/ultracode-keyword"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../src/keymap"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

test("finds the keywords the server honors, in prompt display offsets", () => {
  expect(UltracodeKeyword.ranges("ultracode: audit the routes")).toEqual([{ start: 0, end: 9 }])
  expect(UltracodeKeyword.ranges("don't use UltraCode here, or ultracode")).toEqual([
    { start: 10, end: 19 },
    { start: 29, end: 38 },
  ])
  // Wide characters count as two columns, newlines as one.
  expect(UltracodeKeyword.ranges("界\nultracode")).toEqual([{ start: 3, end: 12 }])
  expect(UltracodeKeyword.ranges("ultracodes and preultracode")).toEqual([])
  expect(UltracodeKeyword.ranges("  /ultracode off")).toEqual([])
})

test("stamps a dismissed prompt's text part, keeping other metadata", () => {
  const part: { type: "text"; text: string; metadata?: Record<string, unknown> } = {
    type: "text",
    text: "ultracode",
    metadata: { kind: "steer", kilo: { reminder: "x" } },
  }
  const plain: typeof part = { type: "text", text: "x" }
  expect(UltracodeKeyword.stamp(part, false)).toBe(part)
  expect(UltracodeKeyword.stamp(part, true)).toEqual({
    type: "text",
    text: "ultracode",
    metadata: { kind: "steer", kilo: { reminder: "x", noUltracode: true } },
  })
  expect(UltracodeKeyword.stamp(plain, true).metadata).toEqual({ kilo: { noUltracode: true } })
})

test("highlights keywords in a textarea; Alt+W or backspace after one dismisses them until they are gone", async () => {
  const refs: { keyword?: ReturnType<typeof UltracodeKeyword.create>; input?: TextareaRenderable } = {}
  const [active, setActive] = createSignal(true)
  const syntax = SyntaxStyle.create()

  function Field() {
    const [target, setTarget] = createSignal<TextareaRenderable>()
    const [tick, setTick] = createSignal(0)
    const keyword = UltracodeKeyword.create({
      input: () => target(),
      target,
      tick,
      syntax: () => syntax,
      color: () => RGBA.fromHex("#ff00ff"),
      active,
    })
    refs.keyword = keyword
    return (
      <textarea
        focused
        ref={(item: TextareaRenderable) => {
          refs.input = item
          setTarget(item)
        }}
        onContentChange={() => {
          keyword.mark()
          setTick((value) => value + 1)
        }}
        onCursorChange={() => setTick((value) => value + 1)}
      />
    )
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    onCleanup(registerOpencodeKeymap(keymap, renderer, createTuiResolvedConfig()))
    return (
      <OpencodeKeymapProvider keymap={keymap}>
        <Field />
      </OpencodeKeymapProvider>
    )
  }

  const app = await testRender(() => <Harness />, { width: 60, height: 4 })
  const marks = () => {
    const input = refs.input
    const type = input?.extmarks.getTypeId("ultracode-keyword")
    return input && type != null ? input.extmarks.getAllForTypeId(type).map((item) => [item.start, item.end]) : []
  }
  const text = () => refs.input?.plainText
  try {
    await app.mockInput.typeText("please ultracode this")
    await app.renderOnce()
    expect(marks()).toEqual([[7, 16]])
    expect(syntax.getStyleId("extmark.ultracode")).not.toBeNull()

    // Backspace away from the keyword edits as usual; right after it, it only dismisses.
    app.mockInput.pressBackspace()
    expect(text()).toBe("please ultracode thi")
    for (const _ of "thi ") app.mockInput.pressArrow("left")
    await app.renderOnce()
    app.mockInput.pressBackspace()
    expect(text()).toBe("please ultracode thi")
    expect(marks()).toEqual([])
    expect(refs.keyword?.dismissed()).toBe(true)
    const part: { text: string; metadata?: Record<string, unknown> } = { text: "x" }
    expect(refs.keyword?.stamp(part).metadata).toEqual({ kilo: { noUltracode: true } })
    // Now the keyword is dismissed, backspace edits again.
    app.mockInput.pressBackspace()
    await app.renderOnce()
    expect(text()).toBe("please ultracod thi")
    // Without the keyword the dismissal ends: retyping it highlights again, and Alt+W dismisses.
    expect(refs.keyword?.dismissed()).toBe(false)
    await app.mockInput.typeText("e")
    await app.renderOnce()
    expect(marks()).toEqual([[7, 16]])
    app.mockInput.pressKey("w", { meta: true })
    await app.renderOnce()
    expect(marks()).toEqual([])
    expect(text()).toBe("please ultracode thi")

    // Nothing is highlighted, and the keys stay ordinary, while inactive (workflows off, shell mode, subagent view).
    refs.input?.setText("")
    setActive(false)
    await app.mockInput.typeText("ultracode")
    await app.renderOnce()
    expect(marks()).toEqual([])
    setActive(true)
    await app.renderOnce()
    expect(marks()).toEqual([[0, 9]])
  } finally {
    app.renderer.destroy()
    syntax.destroy()
  }
})
