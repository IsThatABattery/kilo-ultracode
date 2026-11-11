import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import type { WorkflowAgentInfo, WorkflowRunDetail, WorkflowRunInfo } from "@kilocode/sdk/v2"
import { onCleanup, onMount } from "solid-js"
import { DialogWorkflows } from "@/kilocode/cli/cmd/tui/component/dialog-workflows"
import { TuiConfigProvider } from "../../src/config"
import { KVProvider } from "../../src/context/kv"
import { ProjectProvider, useProject } from "../../src/context/project"
import { RouteProvider, useRoute } from "../../src/context/route"
import { SDKProvider } from "../../src/context/sdk"
import { ThemeProvider } from "../../src/context/theme"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../src/keymap"
import { DialogProvider, useDialog } from "../../src/ui/dialog"
import { ToastProvider } from "../../src/ui/toast"
import { tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "../fixture/tui-sdk"

async function wait(fn: () => boolean, timeout = 5000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

function info(input: Partial<WorkflowRunInfo> & Pick<WorkflowRunInfo, "id" | "name">): WorkflowRunInfo {
  return {
    sessionID: "ses_parent",
    description: `${input.name} description`,
    status: "running",
    phases: [],
    agents: 0,
    running: 0,
    done: 0,
    error: 0,
    skipped: 0,
    cached: 0,
    tokens: 0,
    tools: 0,
    size: "medium",
    started: Date.now() - 80_000,
    dir: `/data/workflow/ses_parent/${input.id}`,
    script: `/data/workflow/ses_parent/${input.id}/script.js`,
    ...input,
  }
}

function agent(input: Partial<WorkflowAgentInfo> & Pick<WorkflowAgentInfo, "id" | "label">): WorkflowAgentInfo {
  return {
    index: 0,
    status: "completed",
    agentType: "workflow-subagent",
    tokens: 1_200,
    tools: 2,
    prompt: `${input.label} prompt`,
    ...input,
  }
}

function detail(run: WorkflowRunInfo, list: WorkflowAgentInfo[], logs: string[] = []): WorkflowRunDetail {
  return { ...run, logs, list }
}

const review = info({
  id: "wf_review",
  name: "review-pr",
  agents: 3,
  running: 1,
  done: 1,
  tokens: 12_345,
  phases: [
    { title: "Scan", total: 2, running: 1, done: 1, error: 0, skipped: 0 },
    { title: "Fix", total: 1, running: 0, done: 0, error: 0, skipped: 0 },
  ],
})

const agents = [
  agent({ id: "a0", label: "scan api", phase: "Scan", status: "running", sessionID: "ses_scan", model: "test/fast" }),
  agent({ id: "a1", label: "scan web", phase: "Scan", result: "found 2 issues", sessionID: "ses_web" }),
  agent({ id: "a2", label: "fix issues", phase: "Fix", status: "queued" }),
]

async function mount(server: { runs: WorkflowRunInfo[]; details: Record<string, WorkflowRunDetail> }) {
  const tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, JSON.stringify({ animations_enabled: false }))
  const posts: string[] = []
  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname === "/kilocode/workflow") {
      const session = url.searchParams.get("sessionID")
      return json(server.runs.filter((run) => !session || run.sessionID === session))
    }
    const match = /^\/kilocode\/workflow\/([^/]+)(\/.*)?$/.exec(url.pathname)
    if (!match) return undefined
    const runID = match[1] ?? ""
    if (!match[2]) {
      const found = server.details[runID]
      return found ? json(found) : json({}, { status: 404 })
    }
    posts.push(`${runID}${match[2]}`)
    if (match[2] === "/save") return json({ path: `/repo/.kilo/workflows/${runID}.js` })
    if (match[2].startsWith("/agent/")) return json(true)
    return json(server.runs.find((run) => run.id === runID))
  }, events)
  const refs: { route?: ReturnType<typeof useRoute>; dialog?: ReturnType<typeof useDialog> } = {}
  const ready = Promise.withResolvers<void>()

  function Opener() {
    const dialog = useDialog()
    const project = useProject()
    refs.route = useRoute()
    refs.dialog = dialog
    onMount(async () => {
      await project.sync()
      dialog.replace(() => <DialogWorkflows sessionID="ses_parent" />)
      ready.resolve()
    })
    return <box />
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig({ leader_timeout: 1000 })
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <TestTuiContexts directory={directory} paths={{ state: tmp.path }}>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={config}>
            <KVProvider>
              <ThemeProvider mode="dark" source={{ discover: async () => ({}) }}>
                <ToastProvider>
                  <SDKProvider url="http://test" directory={directory} events={events.source} fetch={calls.fetch}>
                    <ProjectProvider>
                      <RouteProvider initialRoute={{ type: "session", sessionID: "ses_parent" }}>
                        <DialogProvider>
                          <Opener />
                        </DialogProvider>
                      </RouteProvider>
                    </ProjectProvider>
                  </SDKProvider>
                </ToastProvider>
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { width: 120, height: 40 })
  await ready.promise
  const frame = () => app.captureCharFrame()
  const until = async (fn: (text: string) => boolean) => {
    await wait(() => {
      app.renderer.requestRender()
      return fn(frame())
    })
  }
  return {
    app,
    frame,
    until,
    posts,
    refs,
    emit: (event: Parameters<typeof events.emit>[0]) => events.emit(event),
    async [Symbol.asyncDispose]() {
      app.renderer.destroy()
      await tmp[Symbol.asyncDispose]()
    },
  }
}

test("a single run opens directly; Enter drills into a phase, Esc goes back, x/p act on the run", async () => {
  await using ctx = await mount({
    runs: [review],
    details: { wf_review: detail(review, agents, ["scanning files", "found 3 targets"]) },
  })
  await ctx.until((text) => text.includes("review-pr") && text.includes("Scan") && text.includes("Fix"))
  const run = ctx.frame()
  expect(run).toContain("1/3 agents · 12k tok · 1m2")
  expect(run).toContain("› found 3 targets")
  expect(run).toContain("1/2 · 1 running")
  expect(run).not.toContain("Workflows (current session)")

  ctx.app.mockInput.pressEnter()
  await ctx.until((text) => text.includes("review-pr › Scan"))
  const phase = ctx.frame()
  expect(phase).toContain("scan api")
  expect(phase).toContain("scan web")
  expect(phase).toContain("test/fast")
  expect(phase).toContain("Prompt: scan api prompt")
  expect(phase).toContain("running · 2 tools · 1.2k tok")
  expect(phase).not.toContain("fix issues")

  ctx.app.mockInput.pressKey("x")
  await wait(() => ctx.posts.includes("wf_review/agent/a0/stop"))

  ctx.app.mockInput.pressEscape()
  await ctx.until((text) => !text.includes("review-pr › Scan") && text.includes("Fix"))
  expect(ctx.refs.dialog?.stack.length).toBe(1)

  ctx.app.mockInput.pressKey("p")
  await wait(() => ctx.posts.includes("wf_review/pause"))
  ctx.app.mockInput.pressKey("x")
  await wait(() => ctx.posts.includes("wf_review/stop"))

  ctx.app.mockInput.pressEscape()
  await wait(() => ctx.refs.dialog?.stack.length === 0)
})

test("an open run view marks the run stopped when the server instance is disposed", async () => {
  const server = { runs: [review], details: { wf_review: detail(review, agents) } as Record<string, WorkflowRunDetail> }
  await using ctx = await mount(server)
  await ctx.until((text) => text.includes("review-pr running") && text.includes("Scan"))
  server.runs = []
  delete server.details.wf_review
  ctx.emit({
    directory,
    project: "proj_test",
    payload: { id: "evt_disposed", type: "server.instance.disposed", properties: { directory } },
  })
  await ctx.until((text) => text.includes("review-pr stopped") && text.includes("no longer tracked by the server"))
  expect(ctx.frame()).not.toContain("review-pr running")
})

test("Enter on an agent opens its child session transcript", async () => {
  await using ctx = await mount({ runs: [review], details: { wf_review: detail(review, agents) } })
  await ctx.until((text) => text.includes("Scan") && text.includes("Fix"))
  ctx.app.mockInput.pressArrow("right")
  await ctx.until((text) => text.includes("review-pr › Scan"))
  ctx.app.mockInput.pressArrow("down")
  await ctx.until((text) => text.includes("Result: found 2 issues"))
  ctx.app.mockInput.pressEnter()
  await wait(() => ctx.refs.route?.data.type === "session" && ctx.refs.route.data.sessionID === "ses_web")
  await wait(() => ctx.refs.dialog?.stack.length === 0)
})

test("several runs list newest first, update live, and Esc returns from a run to the list", async () => {
  const older = info({
    id: "wf_older",
    name: "triage",
    status: "completed",
    agents: 2,
    done: 2,
    started: 1_000,
    ended: 61_000,
  })
  const server = {
    runs: [older, review],
    details: { wf_review: detail(review, agents), wf_older: detail(older, []) } as Record<string, WorkflowRunDetail>,
  }
  await using ctx = await mount(server)
  await ctx.until((text) => text.includes("Workflows (current session)") && text.includes("triage"))
  const list = ctx.frame()
  expect(list.indexOf("review-pr")).toBeLessThan(list.indexOf("triage"))
  expect(list).toContain("completed · 2/2 agents · 0 tok · 1m00s")

  const done = { ...review, status: "completed" as const, running: 0, done: 3, ended: Date.now() }
  server.runs = [older, done]
  server.details.wf_review = detail(done, agents)
  ctx.emit({
    directory,
    project: "proj_test",
    payload: { id: "evt_wf", type: "workflow.run.updated", properties: { run: done } },
  })
  await ctx.until((text) => text.includes("completed · 3/3 agents"))

  ctx.app.mockInput.pressEnter()
  await ctx.until((text) => text.includes("review-pr completed") && !text.includes("Workflows (current session)"))
  ctx.app.mockInput.pressEscape()
  await ctx.until((text) => text.includes("Workflows (current session)") && text.includes("triage"))
  expect(ctx.refs.dialog?.stack.length).toBe(1)

  // A newer run is prepended; the highlighted row stays on review-pr and → opens that run, not the new one.
  const newer = info({ id: "wf_newer", name: "audit", started: Date.now() })
  server.runs = [older, done, newer]
  server.details.wf_newer = detail(newer, [])
  ctx.emit({
    directory,
    project: "proj_test",
    payload: { id: "evt_wf_newer", type: "workflow.run.updated", properties: { run: newer } },
  })
  await ctx.until((text) => text.includes("audit"))
  ctx.app.mockInput.pressArrow("right")
  await ctx.until((text) => text.includes("review-pr completed") && !text.includes("Workflows (current session)"))
  ctx.app.mockInput.pressArrow("left")
  await ctx.until((text) => text.includes("Workflows (current session)") && text.includes("audit"))

  // Back on a fresh list the newest run is selected again; s saves it.
  ctx.app.mockInput.pressKey("s")
  await ctx.until((text) => text.includes('Save workflow "audit"'))
  ctx.app.mockInput.pressEnter()
  await wait(() => ctx.posts.includes("wf_newer/save"))
  await ctx.until((text) => text.includes("Workflows (current session)"))
})
