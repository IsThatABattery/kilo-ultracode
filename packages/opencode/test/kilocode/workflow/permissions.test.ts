import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { Agent } from "../../../src/agent/agent"
import { deriveSubagentSessionPermission } from "../../../src/agent/subagent-permissions"
import { RuntimeFlags } from "../../../src/effect/runtime-flags"
import { KiloStructured } from "../../../src/kilocode/session/structured"
import { KiloTask } from "../../../src/kilocode/tool/task"
import { MCP } from "../../../src/mcp"
import { Permission } from "../../../src/permission"
import { InstanceBootstrap } from "../../../src/project/bootstrap-service"
import { InstanceBootstrap as InstanceBootstrapNode } from "../../../src/project/bootstrap"
import { disposeAllInstances } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"

process.env["KILO_CLIENT"] = "cli"

const it = testEffect(
  AppNodeBuilder.build(Agent.node, [
    [MCP.node, Layer.mock(MCP.Service)({})],
    [RuntimeFlags.node, RuntimeFlags.layer({})],
    [
      InstanceBootstrapNode.node,
      Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
    ],
  ]),
)

const agent = (name: string) =>
  Agent.Service.use((svc) => svc.get(name)).pipe(
    Effect.flatMap((info) => (info ? Effect.succeed(info) : Effect.die(new Error(`missing agent ${name}`)))),
  )

const action = (info: Agent.Info, permission: string, pattern = "*") =>
  Permission.evaluate(permission, pattern, info.permission).action

const run = path.join(Global.Path.data, "workflow", "ses_parent", "wf_0123abcd-abc", "script.js")

afterEach(async () => {
  await disposeAllInstances()
})

describe("workflow-subagent", () => {
  it.instance("is a hidden native subagent that cannot delegate, nest workflows or ask the user", () =>
    Effect.gen(function* () {
      const info = yield* agent("workflow-subagent")
      expect(info.mode).toBe("subagent")
      expect(info.hidden).toBe(true)
      expect(info.native).toBe(true)
      expect(info.prompt).toBeUndefined()
      expect(info.description).toBe("Internal subagent for workflow script orchestration.")
      for (const permission of ["task", "workflow", "question", "todowrite"]) {
        expect(action(info, permission)).toBe("deny")
      }
      const general = yield* agent("general")
      for (const permission of ["edit", "read", "glob", "grep", "bash"]) {
        expect(action(info, permission)).toBe(action(general, permission))
      }
    }),
  )

  it.instance(
    "keeps its hard denies over a permissive user config",
    () =>
      Effect.gen(function* () {
        const info = yield* agent("workflow-subagent")
        expect(action(info, "task")).toBe("deny")
        expect(action(info, "workflow")).toBe("deny")
        expect(action(info, "question")).toBe("deny")
        expect(action(info, "edit")).toBe("allow")
      }),
    { config: { permission: { "*": "allow", task: "allow", workflow: "allow", question: "allow" } } },
  )

  it.instance("is not a task target for primary agents, and subagents keep their default task deny", () =>
    Effect.gen(function* () {
      const code = yield* agent("code")
      expect(action(code, "task", "workflow-subagent")).toBe("deny")
      expect(action(code, "task", "general")).not.toBe("deny")
      expect(Permission.disabled(["task"], code.permission).size).toBe(0)
      // Modes whose task tool is off entirely must stay off (the deny is not appended after their catch-all).
      expect(Permission.disabled(["task"], (yield* agent("ask")).permission)).toEqual(new Set(["task"]))
      const general = yield* agent("general")
      expect(general.permission.some((rule) => rule.permission === "task")).toBe(false)
      expect(deriveSubagentSessionPermission({ parentSessionPermission: [], subagent: general })).toContainEqual({
        permission: "task",
        pattern: "*",
        action: "deny",
      })
    }),
  )
})

describe("workflow permission defaults", () => {
  it.instance("the main agent asks before launching and may read and edit run files", () =>
    Effect.gen(function* () {
      const code = yield* agent("code")
      expect(action(code, "workflow", "deep-review")).toBe("ask")
      expect(action(code, "external_directory", run)).toBe("allow")
      expect(action(code, "external_directory", path.join(Global.Path.data, "other", "file"))).toBe("ask")
    }),
  )

  it.instance(
    "a user allow skips the prompt in writable modes but never unlocks read-only modes",
    () =>
      Effect.gen(function* () {
        expect(action(yield* agent("code"), "workflow", "deep-review")).toBe("allow")
        expect(action(yield* agent("plan"), "workflow", "deep-review")).toBe("deny")
        expect(action(yield* agent("ask"), "workflow", "deep-review")).toBe("deny")
      }),
    { config: { permission: { workflow: "allow" } } },
  )

  test("task subagent sessions never start workflows", () => {
    expect(KiloTask.permissions([], true)).toContainEqual({ permission: "workflow", pattern: "*", action: "deny" })
    expect(KiloTask.permissions([], false)).toContainEqual({ permission: "workflow", pattern: "*", action: "deny" })
  })
})

describe("KiloStructured.choice", () => {
  test("workflow agent sessions use auto tool choice; everything else stays forced", () => {
    expect(KiloStructured.choice({ metadata: { "kilo.workflow": { runID: "wf_1" } } })).toBe("auto")
    expect(KiloStructured.choice({ metadata: { "kilo.goal": {} } })).toBe("required")
    expect(KiloStructured.choice({})).toBe("required")
  })
})
