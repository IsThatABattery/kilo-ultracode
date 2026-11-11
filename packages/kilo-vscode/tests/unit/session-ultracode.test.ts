import { describe, expect, it } from "bun:test"
import path from "node:path"
import { createSessionUltracode } from "../../webview-ui/src/context/session-ultracode"

function setup(input: { session?: string; stored?: Record<string, boolean>; fallback?: boolean; available?: boolean }) {
  const posted: Array<{ type: string; sessionID: string; enabled: boolean }> = []
  const state = { available: input.available ?? true, fallback: input.fallback, session: input.session ?? "composer" }
  const ultra = createSessionUltracode({
    session: () => state.session,
    stored: (id) => input.stored?.[id],
    fallback: () => state.fallback,
    available: () => state.available,
    draft: (id) => id === "composer" || id.startsWith("pending:"),
    post: (message) => posted.push(message),
  })
  return { ultra, posted, state }
}

describe("session ultracode", () => {
  it("prefers the local choice, then the stored session value, then the config default", () => {
    const state = setup({ session: "ses_a", stored: { ses_b: true }, fallback: false })
    expect(state.ultra.current()).toBe(false)
    expect(state.ultra.current("ses_b")).toBe(true)
    state.state.fallback = true
    expect(state.ultra.current()).toBe(true)
    state.ultra.select(false, "ses_b")
    expect(state.ultra.current("ses_b")).toBe(false)
  })

  it("is off and sends nothing while the backend lacks workflows", () => {
    const state = setup({ session: "ses_a", stored: { ses_a: true }, fallback: true, available: false })
    expect(state.ultra.current()).toBe(false)
    state.ultra.select(true)
    expect(state.ultra.request()).toBeUndefined()
    expect(state.posted).toEqual([])
  })

  it("persists a real session's choice right away but keeps draft and cloud preview choices local", () => {
    const state = setup({ session: "ses_a" })
    expect(state.ultra.toggle()).toBe(true)
    expect(state.posted).toEqual([{ type: "setUltracode", sessionID: "ses_a", enabled: true }])
    state.ultra.toggle("pending:1")
    state.ultra.toggle("cloud:abc")
    // The UUID draft a no-session send mints before the backend creates the session.
    state.ultra.toggle("0b9f6c1e-3c1d-4f0e-9a51-2f3e8c9d7a10")
    expect(state.posted).toHaveLength(1)
    expect(state.ultra.current("pending:1")).toBe(true)
    expect(state.ultra.current("cloud:abc")).toBe(true)
  })

  it("only sends an explicit choice with a prompt", () => {
    const state = setup({ session: "ses_a", stored: { ses_a: true }, fallback: true })
    expect(state.ultra.current()).toBe(true)
    expect(state.ultra.request()).toBeUndefined()
    expect(state.ultra.body()).toEqual({})
    state.ultra.select(false)
    expect(state.ultra.request()).toBe(false)
    expect(state.ultra.body()).toEqual({ ultracode: false })
  })

  it("moves a draft's choice to the created session", () => {
    const state = setup({})
    state.ultra.toggle("composer")
    state.ultra.transfer("composer", "pending:1")
    expect({ ...state.ultra.selections() }).toEqual({ "pending:1": true })
    state.ultra.transfer("pending:1", "ses_new")
    expect({ ...state.ultra.selections() }).toEqual({ ses_new: true })
    expect(state.ultra.request("ses_new")).toBe(true)
    expect(state.ultra.current("composer")).toBe(false)
  })

  it("leaves the target alone when the source has no choice, and forgets deleted sessions", () => {
    const state = setup({})
    state.ultra.select(true, "ses_new")
    state.ultra.transfer("pending:2", "ses_new")
    expect({ ...state.ultra.selections() }).toEqual({ ses_new: true })
    state.ultra.forget("ses_new")
    expect({ ...state.ultra.selections() }).toEqual({})
  })

  it("lets the stored value win once it changes after a local choice", () => {
    const stored: Record<string, boolean> = {}
    const state = setup({ session: "ses_a", stored, fallback: false })
    expect(state.ultra.toggle()).toBe(true)
    expect(state.ultra.request()).toBe(true)
    // The backend's echo of this choice.
    stored.ses_a = true
    expect(state.ultra.current()).toBe(true)
    expect(state.ultra.request()).toBeUndefined()
    // Another client (the TUI's /ultracode) turns it off.
    stored.ses_a = false
    expect(state.ultra.current()).toBe(false)
    expect(state.ultra.toggle()).toBe(true)
    expect(state.ultra.request()).toBe(true)
    expect(state.posted.map((item) => item.enabled)).toEqual([true, true])
  })

  it("keeps a transferred draft choice until the new session stores it", () => {
    const stored: Record<string, boolean> = {}
    const state = setup({ stored, fallback: true })
    state.ultra.select(false, "pending:1")
    state.ultra.transfer("pending:1", "ses_new")
    expect(state.ultra.current("ses_new")).toBe(false)
    expect(state.ultra.request("ses_new")).toBe(false)
    stored.ses_new = false
    expect(state.ultra.current("ses_new")).toBe(false)
    expect(state.ultra.request("ses_new")).toBeUndefined()
  })

  it("notifies readers when the stored value or the choice changes", () => {
    const child = Bun.spawnSync(
      [
        process.execPath,
        "--conditions=browser",
        "-e",
        `
        import { strict as assert } from "node:assert"
        import { createMemo, createRoot } from "solid-js"
        import { createStore } from "solid-js/store"
        import { createSessionUltracode } from "./webview-ui/src/context/session-ultracode"

        createRoot((dispose) => {
          const [sessions, setSessions] = createStore({})
          const ultra = createSessionUltracode({
            session: () => "ses_a",
            stored: (id) => sessions[id]?.ultracode,
            fallback: () => false,
            available: () => true,
            draft: () => false,
            post: () => {},
          })
          const shown = createMemo(() => ultra.current())
          ultra.select(true)
          assert.equal(shown(), true)
          setSessions("ses_a", { ultracode: true })
          assert.equal(shown(), true)
          setSessions("ses_a", { ultracode: false })
          assert.equal(shown(), false)
          // The same value as the stale choice, made against the newer stored value.
          ultra.select(true)
          assert.equal(shown(), true)
          dispose()
        })
      `,
      ],
      { cwd: path.resolve(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe" },
    )
    expect(child.exitCode, child.stdout.toString() + child.stderr.toString()).toBe(0)
  })
})
