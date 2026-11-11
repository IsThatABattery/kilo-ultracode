import { describe, expect, test } from "bun:test"
import { WorkflowEffort } from "../../../src/kilocode/workflow/effort"

// Key sets mirror what ProviderTransform.variants / reasoningVariants produce for real model families.
const anthropic = ["low", "medium", "high", "xhigh", "max"]
const anthropic46 = ["low", "medium", "high", "max"]
const budget = ["high", "max"]
const openai = ["none", "minimal", "low", "medium", "high", "xhigh"]
const gemini3 = ["low", "high"]
const toggle = ["none", "thinking"]

describe("WorkflowEffort.pick", () => {
  const table: Array<[string | undefined, string[], string | undefined]> = [
    // exact keys always win
    ["low", anthropic, "low"],
    ["xhigh", anthropic, "xhigh"],
    ["max", anthropic, "max"],
    ["high", budget, "high"],
    ["low", openai, "low"],
    // Claude Code: the highest supported level at or below the request ("xhigh runs as high on Opus 4.6")
    ["xhigh", anthropic46, "high"],
    ["max", openai, "xhigh"],
    ["max", ["low", "medium", "high"], "high"],
    ["medium", gemini3, "low"],
    ["high", ["none", "low"], "low"],
    ["max", ["high"], "high"],
    // never escalated: nothing at or below the request means the provider default
    ["low", ["none", "minimal", "medium", "high"], undefined],
    ["low", budget, undefined],
    ["medium", budget, undefined],
    ["low", ["high"], undefined],
    // none/minimal never stand in for a request: they turn reasoning off
    ["low", ["minimal"], undefined],
    ["high", ["none"], undefined],
    // {none, thinking} toggles: thinking for medium and above only
    ["medium", toggle, "thinking"],
    ["max", toggle, "thinking"],
    ["low", toggle, undefined],
    // nothing to map onto, arbitrary keys, unknown efforts
    ["high", [], undefined],
    ["high", ["fast", "smart"], undefined],
    ["ultra", anthropic, undefined],
    ["none", openai, undefined],
    ["minimal", openai, undefined],
    [undefined, anthropic, undefined],
  ]

  for (const [effort, keys, expected] of table) {
    test(`${effort ?? "(none)"} on [${keys.join(", ")}] -> ${expected ?? "provider default"}`, () => {
      expect(WorkflowEffort.pick(effort, keys)).toBe(expected)
    })
  }
})

describe("WorkflowEffort.valid", () => {
  test("accepts exactly the agent() effort levels", () => {
    expect(WorkflowEffort.LEVELS.filter((level) => WorkflowEffort.valid(level))).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ])
    expect(
      ["none", "minimal", "ultra", "", "HIGH", 3, null, undefined].some((value) => WorkflowEffort.valid(value)),
    ).toBe(false)
  })
})
