import { describe, it, expect } from "bun:test"
import {
  describePatterns,
  displaySkillCommand,
  savedRuleStates,
  workflowPhases,
} from "../../webview-ui/src/components/chat/permission-dock-utils"

describe("displaySkillCommand", () => {
  it("leaves ordinary commands, including astral characters, untouched", () => {
    expect(displaySkillCommand("git status && printf 'hi 😀'")).toBe("git status && printf 'hi 😀'")
  })

  it("escapes whitespace controls with readable shorthands", () => {
    expect(displaySkillCommand("a\nb\rc\td")).toBe("a\\nb\\rc\\td")
  })

  it("escapes bidi/format controls so the visible text can't be reordered", () => {
    // U+202E (RLO) would otherwise reverse the trailing text in the prompt.
    expect(displaySkillCommand("rm \u202Etxt.exe")).toBe("rm \\u202etxt.exe")
  })

  it("uses \\x for C0/C1 controls and \\u for higher code points", () => {
    expect(displaySkillCommand("\u0000\u009f\u2066")).toBe("\\x00\\x9f\\u2066")
  })
})

describe("savedRuleStates", () => {
  it("returns empty map when rule is undefined", () => {
    expect(savedRuleStates(["npm *", "git *"], undefined)).toEqual({})
  })

  it("returns empty map when rules array is empty", () => {
    expect(savedRuleStates([], { "npm *": "allow" })).toEqual({})
  })

  it("populates approved entries from config", () => {
    const result = savedRuleStates(["npm *", "git *", "rm *"], { "npm *": "allow", "rm *": "allow" })
    expect(result).toEqual({ 0: "approved", 2: "approved" })
  })

  it("populates denied entries from config", () => {
    const result = savedRuleStates(["npm *", "rm *"], { "rm *": "deny" })
    expect(result).toEqual({ 1: "denied" })
  })

  it("populates mixed approved and denied", () => {
    const result = savedRuleStates(["npm *", "git *", "rm *"], {
      "npm *": "allow",
      "git *": "deny",
    })
    expect(result).toEqual({ 0: "approved", 1: "denied" })
  })

  it("skips ask entries (they stay pending)", () => {
    const result = savedRuleStates(["npm *", "git *"], { "npm *": "ask", "git *": "allow" })
    expect(result).toEqual({ 1: "approved" })
  })

  it("handles scalar rule with wildcard in rules array", () => {
    const result = savedRuleStates(["*"], "allow")
    expect(result).toEqual({ 0: "approved" })
  })

  it("handles scalar rule with non-wildcard patterns (all pending)", () => {
    const result = savedRuleStates(["npm *", "git *"], "allow")
    expect(result).toEqual({})
  })

  it("returns empty map for scalar ask with wildcard", () => {
    const result = savedRuleStates(["*"], "ask")
    expect(result).toEqual({})
  })

  it("returns denied for scalar deny with wildcard", () => {
    const result = savedRuleStates(["*"], "deny")
    expect(result).toEqual({ 0: "denied" })
  })

  it("returns pending for patterns not in config object", () => {
    const result = savedRuleStates(["npm *", "git *"], { "npm *": "allow" })
    expect(result).toEqual({ 0: "approved" })
  })

  it("returns empty map for empty config object", () => {
    const result = savedRuleStates(["npm *"], {})
    expect(result).toEqual({})
  })
})

describe("workflowPhases", () => {
  it("lists a workflow launch's planned phases with their details", () => {
    const args = { name: "review", phases: [{ title: "Find", detail: "one agent per file" }, { title: "Verify" }] }
    expect(workflowPhases(args)).toEqual([
      { title: "Find", detail: "one agent per file" },
      { title: "Verify", detail: undefined },
    ])
  })

  it("drops malformed entries from the script's metadata", () => {
    const args = { phases: [null, "Find", { title: "" }, { title: 3 }, { title: "Fix", detail: 7 }] }
    expect(workflowPhases(args)).toEqual([{ title: "Fix", detail: undefined }])
    expect(workflowPhases({ phases: "Find" })).toEqual([])
    expect(workflowPhases({})).toEqual([])
  })

  it("labels the launch with the workflow's name", () => {
    const t = (key: string) => (key === "ui.permission.toolLabel.workflow" ? "Workflow" : key)
    expect(describePatterns("workflow", ["review"], t)).toEqual({ kind: "single", text: "Workflow review" })
  })
})
