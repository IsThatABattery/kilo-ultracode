import { expect, test } from "bun:test"
import type { ToolPart, WorkflowRunInfo } from "@kilocode/sdk/v2"
import { testRender } from "@opentui/solid"
import { onMount } from "solid-js"
import { TuiConfigProvider } from "../../src/config"
import { KVProvider } from "../../src/context/kv"
import { ThemeProvider } from "../../src/context/theme"
import { WorkflowCard } from "../../src/kilocode/workflow-tool"
import { BlockTool, toolDisplay } from "../../src/routes/session"
import { tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

const script = [
  "export const meta = {",
  '  name: "review-pr",',
  '  description: "Review the PR from three angles",',
  "}",
  'await agent("SECRET PROMPT that must never be dumped")',
].join("\n")

const meta = {
  runID: "wf_0000abcd-123",
  name: "review-pr",
  description: "Review the PR from three angles",
  phases: [{ title: "Scan" }],
  dir: "/data/workflow/ses_parent/wf_0000abcd-123",
  script: "/data/workflow/ses_parent/wf_0000abcd-123/script.js",
}

const run: WorkflowRunInfo = {
  id: meta.runID,
  sessionID: "ses_parent",
  name: meta.name,
  description: meta.description,
  status: "paused",
  phases: [
    { title: "Scan", total: 2, running: 1, done: 1, error: 0, skipped: 0 },
    { title: "Fix", total: 1, running: 0, done: 0, error: 0, skipped: 0 },
  ],
  agents: 3,
  running: 1,
  done: 1,
  error: 0,
  skipped: 0,
  cached: 0,
  tokens: 12_345,
  tools: 7,
  size: "medium",
  started: 1_000,
  dir: meta.dir,
  script: meta.script,
}

function part(state: ToolPart["state"]): ToolPart {
  return {
    id: "prt_workflow",
    sessionID: "ses_parent",
    messageID: "msg_workflow",
    callID: "call_workflow",
    type: "tool",
    tool: "workflow",
    state,
  }
}

function completed(metadata: Record<string, unknown> = meta) {
  return part({
    status: "completed",
    input: { script },
    output: "Workflow launched in background. Run ID: wf_0000abcd-123",
    title: meta.description,
    metadata,
    time: { start: 1, end: 2 },
  })
}

function Fixture(props: { part: ToolPart; run?: WorkflowRunInfo; loaded?: boolean; ready: () => void }) {
  onMount(props.ready)
  return <WorkflowCard part={props.part} block={BlockTool} run={props.run} loaded={props.loaded} now={81_000} />
}

async function render(input: { part: ToolPart; run?: WorkflowRunInfo; loaded?: boolean }) {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, JSON.stringify({ animations_enabled: false }))
  const config = createTuiResolvedConfig()
  const ready = Promise.withResolvers<void>()
  const app = await testRender(
    () => (
      <TestTuiContexts paths={{ state: tmp.path }}>
        <KVProvider>
          <TuiConfigProvider config={config}>
            <ThemeProvider mode="dark" source={{ discover: async () => ({}) }}>
              <Fixture {...input} ready={() => ready.resolve()} />
            </ThemeProvider>
          </TuiConfigProvider>
        </KVProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 20 },
  )
  try {
    await ready.promise
    await app.flush()
    return app
      .captureCharFrame()
      .split("\n")
      .map((line) => line.replace(/^┃/, "").trim())
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
  } finally {
    app.renderer.destroy()
  }
}

test("the workflow tool uses its dedicated renderer", () => {
  expect(toolDisplay("workflow")).toBe("workflow")
})

test("a launched run shows its name, description, live status, progress and phases", async () => {
  const frame = await render({ part: completed(), run })
  expect(frame).toContain("◆ Workflow review-pr — Review the PR from three angles")
  expect(frame).toContain("paused · 1/3 agents · 12k tok · 1m20s")
  expect(frame).toContain("Scan 1/2 · Fix 0/1")
  expect(frame).not.toContain("SECRET PROMPT")
  expect(frame).not.toContain("Workflow launched in background")
})

test("a call awaiting launch shows the meta name without dumping the script", async () => {
  const frame = await render({ part: part({ status: "running", input: { script }, time: { start: 1 } }) })
  expect(frame).toContain("Workflow review-pr — Review the PR from three angles")
  expect(frame).toContain("Preparing workflow…")
  expect(frame).not.toContain("SECRET PROMPT")
  expect(frame).not.toContain("export const meta")
})

test("a failed call shows the tool error", async () => {
  const frame = await render({
    part: part({
      status: "error",
      input: { name: "triage" },
      error: 'Unknown saved workflow "triage".',
      time: { start: 1, end: 2 },
    }),
  })
  expect(frame).toContain("◆ Workflow triage")
  expect(frame).toContain('Unknown saved workflow "triage".')
})

test("a run the server no longer tracks says so after loading", async () => {
  expect(await render({ part: completed() })).toContain("Background run wf_0000abcd-123")
  expect(await render({ part: completed(), loaded: true })).toContain("Run wf_0000abcd-123 is no longer tracked")
})

test("a failed run shows its error message", async () => {
  const frame = await render({
    part: completed(),
    run: { ...run, status: "error", error_message: "agent() threw: boom" },
  })
  expect(frame).toContain("error · 1/3 agents")
  expect(frame).toContain("agent() threw: boom")
})
