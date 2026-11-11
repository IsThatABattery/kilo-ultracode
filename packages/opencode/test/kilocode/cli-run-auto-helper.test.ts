// kilocode_change - new file
import { describe, expect, test } from "bun:test"
import { KiloRunAuto } from "../../src/kilocode/cli/run-auto"
import { WorkflowSpawn } from "../../src/kilocode/workflow/spawn"

describe("KiloRunAuto", () => {
  test("tracks task child sessions without allowing unrelated sessions", () => {
    const state = KiloRunAuto.create("ses_root")

    expect(KiloRunAuto.allowed(state, "ses_root")).toBe(true)
    expect(KiloRunAuto.allowed(state, "ses_child")).toBe(false)

    KiloRunAuto.track(state, {
      type: "tool",
      tool: "task",
      sessionID: "ses_root",
      state: {
        metadata: {
          sessionId: "ses_child",
        },
      },
    })

    expect(KiloRunAuto.allowed(state, "ses_child")).toBe(true)
    KiloRunAuto.track(state, {
      type: "tool",
      tool: "task",
      sessionID: "ses_child",
      state: { metadata: { sessionId: "ses_grandchild" } },
    })
    expect(KiloRunAuto.allowed(state, "ses_grandchild")).toBe(true)
    expect(KiloRunAuto.allowed(state, "ses_other")).toBe(false)
  })

  test("ignores malformed or untrusted task metadata", () => {
    const state = KiloRunAuto.create("ses_root")

    KiloRunAuto.track(state, {
      type: "tool",
      tool: "task",
      sessionID: "ses_root",
      state: {
        metadata: {
          sessionId: "",
        },
      },
    })
    KiloRunAuto.track(state, {
      type: "tool",
      tool: "task",
      sessionID: "ses_other",
      state: {
        metadata: {
          sessionId: "ses_wrong",
        },
      },
    })
    KiloRunAuto.track(state, {
      type: "text",
      sessionID: "ses_root",
      state: {},
    })

    expect(KiloRunAuto.allowed(state, "ses_wrong")).toBe(false)
    expect(KiloRunAuto.allowed(state, "")).toBe(false)
  })

  test("tracks workflow agent sessions of tracked sessions from session.created", () => {
    const state = KiloRunAuto.create("ses_root")
    const mark = { [WorkflowSpawn.METADATA]: { runID: "wf_1", agentID: "a0", index: 0, label: "agent" } }
    expect(KiloRunAuto.WORKFLOW).toBe(WorkflowSpawn.METADATA)

    KiloRunAuto.session(state, { id: "ses_agent", parentID: "ses_root", metadata: mark })
    expect(KiloRunAuto.allowed(state, "ses_agent")).toBe(true)

    // A plain child (no workflow metadata) is not a workflow agent; Task children are tracked from their tool part.
    KiloRunAuto.session(state, { id: "ses_plain", parentID: "ses_root", metadata: {} })
    KiloRunAuto.session(state, { id: "ses_bare", parentID: "ses_root" })
    // Workflow agents of an unrelated session stay unanswered.
    KiloRunAuto.session(state, { id: "ses_foreign", parentID: "ses_other", metadata: mark })
    KiloRunAuto.session(state, { id: "ses_flag", parentID: "ses_root", metadata: { [WorkflowSpawn.METADATA]: true } })
    for (const id of ["ses_plain", "ses_bare", "ses_foreign", "ses_flag"])
      expect(KiloRunAuto.allowed(state, id)).toBe(false)
  })
})
