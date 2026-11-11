import { describe, expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { JSX } from "solid-js"
import fs from "node:fs"
import path from "node:path"
import type { Part, WorkflowAgentInfo, WorkflowPhaseInfo, WorkflowRunInfo } from "@kilocode/sdk/v2"
import { WorkflowView } from "@/kilocode/cli/cmd/tui/workflow-view"
import type { TuiPluginApi } from "@kilocode/plugin/tui"
import Workflows, { owner, permission, root, source, ultracode } from "@/kilocode/plugins/workflows"
import { MemoryPermissionRegistry } from "@/kilocode/cli/cmd/tui/routes/session/memory-permission"
import { UltracodeKeyword } from "@tui/kilocode/ultracode-keyword"

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(5)
  }
}

const plugin = path.resolve(import.meta.dir, "../../../src/kilocode/plugins/workflows.tsx")

function run(input: Partial<WorkflowRunInfo> = {}): WorkflowRunInfo {
  return {
    id: "wf_00000001-001",
    sessionID: "ses_parent",
    name: "review",
    description: "Review the change",
    status: "running",
    phases: [],
    agents: 10,
    running: 2,
    done: 3,
    error: 0,
    skipped: 0,
    cached: 0,
    tokens: 12_345,
    tools: 4,
    size: "medium",
    started: 1_000,
    dir: "/data/workflow/ses_parent/wf_00000001-001",
    script: "/data/workflow/ses_parent/wf_00000001-001/script.js",
    ...input,
  }
}

function agent(input: Partial<WorkflowAgentInfo> & Pick<WorkflowAgentInfo, "id">): WorkflowAgentInfo {
  return {
    index: 0,
    label: input.id,
    status: "completed",
    agentType: "workflow-subagent",
    tokens: 0,
    tools: 0,
    prompt: "",
    ...input,
  }
}

function phase(input: Partial<WorkflowPhaseInfo> & Pick<WorkflowPhaseInfo, "title">): WorkflowPhaseInfo {
  return { total: 0, running: 0, done: 0, error: 0, skipped: 0, ...input }
}

describe("WorkflowView formatting", () => {
  test("formats tokens compactly", () => {
    expect(WorkflowView.tokens(0)).toBe("0 tok")
    expect(WorkflowView.tokens(850)).toBe("850 tok")
    expect(WorkflowView.tokens(1_000)).toBe("1k tok")
    expect(WorkflowView.tokens(1_240)).toBe("1.2k tok")
    expect(WorkflowView.tokens(12_345)).toBe("12k tok")
    expect(WorkflowView.tokens(999_600)).toBe("1M tok")
    expect(WorkflowView.tokens(1_500_000)).toBe("1.5M tok")
  })

  test("formats elapsed time compactly", () => {
    expect(WorkflowView.elapsed(-5)).toBe("0s")
    expect(WorkflowView.elapsed(45_900)).toBe("45s")
    expect(WorkflowView.elapsed(80_000)).toBe("1m20s")
    expect(WorkflowView.elapsed(65_000)).toBe("1m05s")
    expect(WorkflowView.elapsed(3_900_000)).toBe("1h05m")
  })

  test("summarizes a run as agents, tokens and elapsed time", () => {
    expect(WorkflowView.summary(run(), 81_000)).toBe("3/10 agents · 12k tok · 1m20s")
    expect(WorkflowView.summary(run({ ended: 31_000 }), 999_999)).toBe("3/10 agents · 12k tok · 30s")
    expect(WorkflowView.summary(run({ agents: 1, done: 1, tokens: 0, started: Number.NaN }), 5)).toBe(
      "1/1 agent · 0 tok",
    )
  })

  test("summarizes phase progress", () => {
    expect(WorkflowView.progress(phase({ title: "a", total: 5, done: 2 }))).toBe("2/5")
    expect(WorkflowView.progress(phase({ title: "a", total: 5, done: 2, running: 1, error: 1, skipped: 1 }))).toBe(
      "2/5 · 1 running · 1 failed · 1 skipped",
    )
  })

  test("maps statuses to tones and themes", () => {
    expect(WorkflowView.runTone("running")).toBe("success")
    expect(WorkflowView.runTone("paused")).toBe("warning")
    expect(WorkflowView.runTone("error")).toBe("error")
    expect(WorkflowView.runTone("stopped")).toBe("muted")
    expect(WorkflowView.agentTone("cached")).toBe("primary")
    expect(WorkflowView.phaseTone(phase({ title: "a", total: 2, done: 1, skipped: 1 }))).toBe("primary")
    expect(WorkflowView.phaseTone(phase({ title: "a", total: 2, running: 1 }))).toBe("success")
    expect(WorkflowView.phaseTone(phase({ title: "a", total: 0 }))).toBe("muted")
    const theme = { success: "g", warning: "y", error: "r", primary: "b", textMuted: "m" }
    expect(WorkflowView.paint(theme, "muted")).toBe("m")
    expect(WorkflowView.paint(theme, "error")).toBe("r")
  })
})

describe("WorkflowView state", () => {
  test("reads the ultracode toggle with the config default as fallback", () => {
    expect(WorkflowView.ultracode(undefined, false)).toBe(false)
    expect(WorkflowView.ultracode(undefined, true)).toBe(true)
    expect(WorkflowView.ultracode({ "kilo.ultracode": { enabled: true } }, false)).toBe(true)
    expect(WorkflowView.ultracode({ "kilo.ultracode": { enabled: false } }, true)).toBe(false)
    expect(WorkflowView.ultracode({ "kilo.ultracode": "yes" }, false)).toBe(false)
    expect(WorkflowView.ultracode({ "kilo.goal": { text: "x" } }, true)).toBe(true)
  })

  test("upserts runs by id in launch order and lets event copies win a merge", () => {
    const first = run({ id: "wf_a", started: 1 })
    const second = run({ id: "wf_b", started: 2 })
    expect(WorkflowView.upsert([second], first).map((item) => item.id)).toEqual(["wf_a", "wf_b"])
    const updated = WorkflowView.upsert([first, second], { ...first, done: 9 })
    expect(updated.map((item) => [item.id, item.done])).toEqual([
      ["wf_a", 9],
      ["wf_b", 3],
    ])
    const merged = WorkflowView.merge([first, second], [{ ...second, status: "completed" }])
    expect(merged.map((item) => [item.id, item.status])).toEqual([
      ["wf_a", "running"],
      ["wf_b", "completed"],
    ])
    expect(WorkflowView.active("running") && WorkflowView.active("paused")).toBe(true)
    expect(WorkflowView.active("completed")).toBe(false)
  })

  test("groups agents by nested group, then phase, with a loose bucket for the rest", () => {
    const phases = [phase({ title: "Scan", total: 1, done: 1 }), phase({ title: "▸ child", total: 1, running: 1 })]
    const list = [
      agent({ id: "a0", phase: "Scan" }),
      agent({ id: "a1", phase: "Scan", group: "▸ child", status: "running" }),
      agent({ id: "a2", status: "error" }),
      agent({ id: "a3", phase: "unknown", status: "skipped" }),
    ]
    const shown = WorkflowView.phases(phases, list)
    expect(shown.map((item) => item.title)).toEqual(["Scan", "▸ child", WorkflowView.LOOSE])
    expect(shown.at(-1)).toMatchObject({ total: 2, error: 1, skipped: 1, done: 0, running: 0 })
    expect(WorkflowView.members("Scan", phases, list).map((item) => item.id)).toEqual(["a0"])
    expect(WorkflowView.members("▸ child", phases, list).map((item) => item.id)).toEqual(["a1"])
    expect(WorkflowView.members(WorkflowView.LOOSE, phases, list).map((item) => item.id)).toEqual(["a2", "a3"])
    expect(WorkflowView.phases(phases, list.slice(0, 2))).toHaveLength(2)
  })

  test("previews only the meta name and description of an inline script", () => {
    const script = [
      "export const meta = {",
      '  name: "review-pr",',
      "  description: 'Review the PR from \\'three\\' angles',",
      "}",
      'const secret = agent("do not show this prompt")',
    ].join("\n")
    expect(WorkflowView.preview(script)).toEqual({
      name: "review-pr",
      description: "Review the PR from 'three' angles",
    })
    expect(WorkflowView.preview(undefined)).toEqual({})
    expect(WorkflowView.basename("/repo/.kilo/workflows/triage.js")).toBe("triage")
    expect(WorkflowView.basename("C:\\work\\flow.js")).toBe("flow")
    expect(WorkflowView.basename("")).toBeUndefined()
  })
})

describe("WorkflowView large-run warning", () => {
  test("flags more than 25 agents under the default guideline, or an explicit guideline's count", () => {
    expect(WorkflowView.large(run({ agents: 25, done: 0, tokens: 0 }), { ultracode: false })).toBe(false)
    expect(WorkflowView.large(run({ agents: 26, done: 0, tokens: 0 }), { ultracode: false })).toBe(true)
    // `medium` chosen in config: its count (10) replaces 25.
    expect(
      WorkflowView.large(run({ agents: 11, done: 0, tokens: 0 }), { configured: "medium", ultracode: false }),
    ).toBe(true)
    // A non-default size can only come from config.
    expect(WorkflowView.large(run({ size: "large", agents: 49, done: 0, tokens: 0 }), { ultracode: false })).toBe(false)
    expect(WorkflowView.large(run({ size: "large", agents: 51, done: 0, tokens: 0 }), { ultracode: false })).toBe(true)
    expect(WorkflowView.large(run({ size: "small", agents: 6, done: 0, tokens: 0 }), { ultracode: false })).toBe(true)
    // `unrestricted` has no count, so 25 stays.
    expect(
      WorkflowView.large(run({ size: "unrestricted", agents: 26, done: 0, tokens: 0 }), { ultracode: false }),
    ).toBe(true)
    expect(
      WorkflowView.large(run({ size: "unrestricted", agents: 20, done: 0, tokens: 0 }), { ultracode: false }),
    ).toBe(false)
  })

  test("flags a projected token total past 1.5M, scaled from fresh finished agents", () => {
    // 4 fresh agents spent 400k: 20 scheduled project to 2M.
    const big = run({ agents: 20, done: 4, cached: 0, tokens: 400_000 })
    expect(WorkflowView.projected(big)).toBe(2_000_000)
    expect(WorkflowView.large(big, { ultracode: false })).toBe(true)
    // Cached replays cost nothing: 2 fresh of 4 done spent 100k, 18 fresh scheduled project to 900k.
    const replay = run({ agents: 20, done: 4, cached: 2, tokens: 100_000 })
    expect(WorkflowView.projected(replay)).toBe(900_000)
    expect(WorkflowView.large(replay, { ultracode: false })).toBe(false)
    expect(WorkflowView.projected(run({ agents: 5, done: 0, tokens: 1_600_000 }))).toBe(1_600_000)
  })

  test("never warns with ultracode on", () => {
    expect(WorkflowView.large(run({ agents: 900, tokens: 9_000_000 }), { ultracode: true })).toBe(false)
  })

  test("finds the root session through a lookup and survives a cycle", () => {
    const parents: Record<string, string> = { a: "b", b: "c", x: "y", y: "x" }
    expect(WorkflowView.root((id) => parents[id], "a")).toBe("c")
    expect(WorkflowView.root((id) => parents[id], "c")).toBe("c")
    expect(["x", "y"]).toContain(WorkflowView.root((id) => parents[id], "x"))
  })
})

describe("workflows TUI plugin", () => {
  const state = (sessions: Record<string, { parentID?: string; metadata?: Record<string, unknown> }>, cfg = false) =>
    ({
      state: {
        config: { experimental: { ultracode: cfg } },
        session: { get: (id: string) => sessions[id] },
      },
    }) as unknown as Parameters<typeof ultracode>[0]

  test("reads the session toggle, else the experimental.ultracode default", () => {
    const api = state({ ses_on: { metadata: { "kilo.ultracode": { enabled: true } } }, ses_plain: {} })
    expect(ultracode(api, "ses_on")).toBe(true)
    expect(ultracode(api, "ses_plain")).toBe(false)
    expect(ultracode(api, undefined)).toBe(false)
    expect(ultracode(state({ ses_plain: {} }, true), "ses_plain")).toBe(true)
  })

  test("shows a workflow agent's launching session runs", () => {
    const api = state({
      ses_agent: { parentID: "ses_parent", metadata: { "kilo.workflow": { runID: "wf_1" } } },
      ses_task: { parentID: "ses_parent" },
    })
    expect(owner(api, "ses_agent")).toBe("ses_parent")
    expect(owner(api, "ses_task")).toBe("ses_task")
    expect(owner(api, "ses_parent")).toBe("ses_parent")
  })

  test("/ultracode and /workflows stay hidden until the server reports workflows, then toggle the session", async () => {
    const hidden = await mount({ workflows: false })
    expect(hidden.command("session.toggle.ultracode").hidden).toBe(true)
    expect(hidden.command("workflow.list").hidden).toBe(true)

    const ctx = await mount({ workflows: true })
    const toggle = ctx.command("session.toggle.ultracode")
    expect(toggle.slashName).toBe("ultracode")
    expect(ctx.command("workflow.list").slashName).toBe("workflows")
    expect(toggle.hidden).toBe(false)
    expect(toggle.title).toBe("Enable ultracode")

    await toggle.run?.()
    expect(ctx.sets).toEqual([{ sessionID: "ses_parent", enabled: true }])
    expect(ctx.toasts).toEqual(["Ultracode on"])

    ctx.sessions.ses_parent = { metadata: { "kilo.ultracode": { enabled: true } } }
    expect(toggle.title).toBe("Disable ultracode")
    await toggle.run?.()
    expect(ctx.sets.at(-1)).toEqual({ sessionID: "ses_parent", enabled: false })
    expect(ctx.toasts.at(-1)).toBe("Ultracode off")
  })

  test("/ultracode in a child session toggles its root session, routed to the root's workspace", async () => {
    const ctx = await mount({ workflows: true, session: "ses_agent" })
    ctx.sessions.ses_agent = { parentID: "ses_task", metadata: { "kilo.workflow": { runID: "wf_1" } } }
    ctx.sessions.ses_task = { parentID: "ses_parent" }
    ctx.sessions.ses_parent = { workspaceID: "wrk_1", metadata: { "kilo.ultracode": { enabled: true } } }
    const toggle = ctx.command("session.toggle.ultracode")
    expect(toggle.title).toBe("Disable ultracode")
    await toggle.run?.()
    expect(ctx.sets).toEqual([{ sessionID: "ses_parent", enabled: false, workspace: "wrk_1" }])
    expect(ctx.toasts).toEqual(["Ultracode off"])
  })

  test("finds the root session and survives a parent cycle", () => {
    const api = state({ ses_a: { parentID: "ses_b" }, ses_b: { parentID: "ses_a" }, ses_c: { parentID: "ses_d" } })
    expect(root(api, "ses_c")).toBe("ses_d")
    expect(root(api, "ses_d")).toBe("ses_d")
    expect(["ses_a", "ses_b"]).toContain(root(api, "ses_a"))
  })

  test("the workflow permission prompt shows the meta name, description, phases and the script file", async () => {
    const request = {
      metadata: {
        name: "review-pr",
        description: "Review the PR from three angles",
        phases: [{ title: "Scan" }, { title: "Fix", detail: "apply fixes" }, { nope: true }],
        script: "/repo/.kilo/workflows/review-pr.js",
      },
      patterns: ["review-pr"],
    }
    expect(permission(request)).toEqual({
      title: 'Run workflow "review-pr"',
      lines: ["Review the PR from three angles", "Phases: Scan · Fix"],
    })
    expect(permission({ metadata: {}, patterns: ["triage"] })).toEqual({ title: 'Run workflow "triage"', lines: [] })
    expect(permission({ metadata: {}, patterns: [] }).title).toBe("Run workflow")

    await mount({ workflows: true })
    const seen: { title?: string; icon?: string } = {}
    const app = await testRender(
      () => {
        const shown = MemoryPermissionRegistry.render("workflow", {
          id: "per_1",
          sessionID: "ses_parent",
          permission: "workflow",
          always: ["review-pr"],
          ...request,
        })
        seen.title = shown?.title
        seen.icon = shown?.icon
        return shown?.body
      },
      { width: 60, height: 4 },
    )
    try {
      await app.renderOnce()
      const frame = app.captureCharFrame()
      expect(frame).toContain("Review the PR from three angles")
      expect(frame).toContain("Phases: Scan · Fix")
      expect(frame).toContain("Script: /repo/.kilo/workflows/review-pr.js")
      expect(frame).not.toContain("view raw script")
    } finally {
      app.renderer.destroy()
    }
    expect(seen).toEqual({ title: 'Run workflow "review-pr"', icon: "◆" })
  })

  test("an inline script stays hidden until `v` opens the raw script view", async () => {
    const script = 'export const meta = { name: "audit", description: "Audit" }\nawait agent("SECRET STEP")'
    const ctx = await mount({ workflows: true })
    ctx.parts.msg_1 = [
      {
        id: "prt_1",
        sessionID: "ses_parent",
        messageID: "msg_1",
        type: "tool",
        callID: "call_1",
        tool: "workflow",
        state: { status: "running", input: { script }, time: { start: 1 } },
      },
    ]
    const request = {
      id: "per_2",
      sessionID: "ses_parent",
      permission: "workflow",
      patterns: ["audit"],
      always: ["audit"],
      metadata: { name: "audit", description: "Audit", phases: [] },
      tool: { messageID: "msg_1", callID: "call_1" },
    }
    expect(source(ctx.api, request)).toEqual({ script })
    expect(source(ctx.api, { ...request, tool: undefined })).toEqual({})
    expect(source(ctx.api, { ...request, metadata: { script: "/tmp/flow.js" } })).toEqual({ file: "/tmp/flow.js" })

    const app = await testRender(() => MemoryPermissionRegistry.render("workflow", request)?.body, {
      width: 80,
      height: 12,
    })
    try {
      await app.renderOnce()
      expect(app.captureCharFrame()).toContain("v view raw script")
      expect(app.captureCharFrame()).not.toContain("SECRET STEP")
      const binding = ctx.bindings().find((item) => item.key === "v")
      if (typeof binding?.cmd !== "function") throw new Error("the raw script binding is not registered")
      binding.cmd()
      await app.renderOnce()
      const frame = app.captureCharFrame()
      expect(frame).toContain("v hide raw script")
      expect(frame).toContain('await agent("SECRET STEP")')
    } finally {
      app.renderer.destroy()
    }
  })

  test("refetches capabilities for this directory's instance disposal only, and tells the prompt keyword", async () => {
    const ctx = await mount({ workflows: true })
    expect(UltracodeKeyword.available()).toBe(true)
    const before = ctx.capabilities()
    ctx.emit("server.instance.disposed", { properties: { directory: "/repo/.kilo/worktrees/agent-1" } })
    await Bun.sleep(20)
    expect(ctx.capabilities()).toBe(before)
    ctx.emit("server.instance.disposed", { properties: { directory: "/repo" } })
    await wait(() => ctx.capabilities() > before)
    ctx.dispose()
    expect(UltracodeKeyword.available()).toBe(false)
  })

  test("keeps the prompt keyword inert while experimental.ultracode_keyword is off", async () => {
    const ctx = await mount({ workflows: true })
    const experimental = ctx.api.state.config.experimental
    if (!experimental) throw new Error("the mounted config has no experimental block")
    expect(UltracodeKeyword.available()).toBe(true)
    experimental.ultracode_keyword = false
    expect(UltracodeKeyword.available()).toBe(false)
    experimental.ultracode_keyword = true
    expect(UltracodeKeyword.available()).toBe(true)
    ctx.dispose()
    const off = await mount({ workflows: false })
    expect(UltracodeKeyword.available()).toBe(false)
    off.dispose()
  })

  test("listens for event stream reconnects from an always-mounted app slot", async () => {
    // Reconnect itself is exercised against a real SDK provider in packages/tui/test/kilocode/workflow-reconnect.test.tsx
    // (another test here mocks @tui/context/sdk for the whole process).
    const ctx = await mount({ workflows: true })
    expect(typeof ctx.slot("app")).toBe("function")
    expect(fs.readFileSync(plugin, "utf8")).not.toContain('api.event.on("server.connected"')
  })

  test("/ultracode on the home screen creates a session first", async () => {
    const ctx = await mount({ workflows: true, home: true })
    await ctx.command("session.toggle.ultracode").run?.()
    expect(ctx.routes).toEqual([{ name: "session", params: { sessionID: "ses_new" } }])
    expect(ctx.sets).toEqual([{ sessionID: "ses_new", enabled: true }])
  })

  test("the prompt indicator shows the root session's ultracode, only while workflows are available", async () => {
    const draw = async (workflows: boolean) => {
      const ctx = await mount({ workflows, session: "ses_agent" })
      ctx.sessions.ses_agent = { parentID: "ses_parent", metadata: { "kilo.workflow": { runID: "wf_1" } } }
      ctx.sessions.ses_parent = { metadata: { "kilo.ultracode": { enabled: true } } }
      const view = ctx.slot("session_prompt_right")
      const app = await testRender(() => view({}, { session_id: "ses_agent" }), { width: 20, height: 1 })
      try {
        await app.renderOnce()
        return app.captureCharFrame().trim()
      } finally {
        app.renderer.destroy()
      }
    }
    expect(await draw(true)).toBe("ultracode")
    expect(await draw(false)).toBe("")
  })

  test("keeps the prompt indicator and sidebar section mounted through plugin slots", () => {
    const content = fs.readFileSync(plugin, "utf8")
    expect(content).toContain("session_prompt_right")
    expect(content).toContain("sidebar_content")
    expect(content).toContain('{shown() ? "ultracode" : ""}')
    expect(content).toContain("<text fg={theme().warning}>{WorkflowView.LARGE}</text>")
  })
})

type Slot = (ctx: unknown, props: { session_id: string }) => JSX.Element
type Command = { name: string; title?: string; hidden?: boolean; slashName?: string; run?: () => unknown }
type Binding = { key: string; cmd?: unknown }
type Handler = (event: { properties: Record<string, unknown> }) => void
type Sessions = Record<string, { parentID?: string; workspaceID?: string; metadata?: Record<string, unknown> }>

/** The real plugin against a minimal plugin API: the server answers capabilities and ultracode.set. */
async function mount(opts: { workflows: boolean; home?: boolean; session?: string }) {
  const commands: Command[] = []
  const sets: { sessionID: string; enabled: boolean; workspace?: string }[] = []
  const toasts: string[] = []
  const routes: { name: string; params?: Record<string, unknown> }[] = []
  const slots: Record<string, Slot> = {}
  const sessions: Sessions = {}
  const parts: Record<string, Part[]> = {}
  const layers: { bindings?: Binding[] }[] = []
  const handlers: Record<string, Handler[]> = {}
  const disposers: (() => void)[] = []
  const fetched = { count: 0 }
  const capabilities = Promise.withResolvers<void>()
  const api = {
    route: {
      current: opts.home ? { name: "home" } : { name: "session", params: { sessionID: opts.session ?? "ses_parent" } },
      navigate: (name: string, params?: Record<string, unknown>) => routes.push({ name, params }),
    },
    state: {
      config: { experimental: { ultracode: false } },
      path: { state: "", config: "", worktree: "/repo", directory: "/repo" },
      session: { get: (id: string) => sessions[id] },
      part: (id: string) => parts[id] ?? [],
    },
    client: {
      experimental: {
        capabilities: {
          get: async () => {
            fetched.count++
            queueMicrotask(() => capabilities.resolve())
            return { data: { backgroundSubagents: true, workflows: opts.workflows } }
          },
        },
      },
      ultracode: {
        set: async (input: { sessionID: string; enabled: boolean; workspace?: string }) => {
          sets.push(input)
          return { data: { enabled: input.enabled } }
        },
      },
      session: { create: async () => ({ data: { id: "ses_new" } }) },
    },
    event: {
      on: (type: string, handler: Handler) => {
        ;(handlers[type] ??= []).push(handler)
        return () => {}
      },
    },
    theme: {
      current: {
        text: RGBA.fromHex("#ffffff"),
        textMuted: RGBA.fromHex("#888888"),
        accent: RGBA.fromHex("#ff00ff"),
        warning: RGBA.fromHex("#ffaa00"),
      },
    },
    lifecycle: {
      onDispose: (fn: () => void) => {
        disposers.push(fn)
        return () => {}
      },
    },
    keymap: {
      registerLayer: (layer: { commands?: Command[]; bindings?: Binding[] }) => {
        commands.push(...(layer.commands ?? []))
        layers.push(layer)
        return () => {}
      },
    },
    slots: {
      register: (input: { slots: Record<string, Slot> }) => {
        Object.assign(slots, input.slots)
        return "slot"
      },
    },
    ui: {
      toast: (input: { message: string }) => toasts.push(input.message),
      dialog: { clear() {}, replace() {}, setSize() {} },
    },
  } as unknown as TuiPluginApi
  await Workflows.tui(api, undefined, {} as Parameters<typeof Workflows.tui>[2])
  await capabilities.promise
  const command = (name: string) => {
    const found = commands.find((item) => item.name === name)
    if (!found) throw new Error(`command ${name} is not registered`)
    return found
  }
  const slot = (name: string) => {
    const found = slots[name]
    if (!found) throw new Error(`slot ${name} is not registered`)
    return found
  }
  return {
    api,
    command,
    slot,
    sets,
    toasts,
    routes,
    sessions,
    parts,
    capabilities: () => fetched.count,
    bindings: () => layers.flatMap((layer) => layer.bindings ?? []),
    emit: (type: string, event: { properties: Record<string, unknown> }) => {
      for (const handler of handlers[type] ?? []) handler(event)
    },
    dispose: () => {
      for (const fn of disposers) fn()
    },
  }
}
