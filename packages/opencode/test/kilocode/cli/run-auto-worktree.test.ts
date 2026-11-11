// `kilo run` and workflow agents with isolation: 'worktree': their sessions live in the worktree's instance, so their
// session.created and permission.asked events never reach the run's directory-scoped stream. These tests drive the
// in-process server (as `kilo run` does) with a second directory standing in for the worktree.

import { afterEach, describe, expect, test } from "bun:test"
import { Cause, Exit } from "effect"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { GlobalBus } from "../../../src/bus/global"
import { AppRuntime } from "../../../src/effect/app-runtime"
import { KiloRunAuto } from "../../../src/kilocode/cli/run-auto"
import { KiloRunDrain } from "../../../src/kilocode/cli/run-drain"
import { KiloHeadless } from "../../../src/kilocode/permission/headless"
import { WorkflowSpawn } from "../../../src/kilocode/workflow/spawn"
import { Permission } from "../../../src/permission"
import { InstanceStore } from "../../../src/project/instance-store"
import { Server } from "../../../src/server/server"
import { SessionID } from "../../../src/session/schema"
import { disposeAllInstances, tmpdir } from "../../fixture/fixture"

afterEach(async () => {
  await disposeAllInstances()
})

function sdk(directory: string) {
  return KiloRunDrain.client({
    baseUrl: "http://kilo.internal",
    fetch: Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => Server.Default().app.fetch(new Request(input, init)),
      { preconnect: () => {} },
    ),
    directory,
  })
}

/** Ask for a permission from `sessionID` inside `directory`'s instance, as a tool call there would. */
function ask(directory: string, sessionID: string, id: string) {
  return AppRuntime.runPromiseExit(
    InstanceStore.Service.use((store) =>
      store.provide(
        { directory },
        Permission.Service.use((permission) =>
          permission.ask({
            id: PermissionV1.ID.make(id),
            sessionID: SessionID.make(sessionID),
            permission: "bash",
            patterns: ["git status"],
            metadata: {},
            always: [],
            ruleset: [],
          }),
        ),
      ),
    ),
  )
}

async function until(check: () => boolean | Promise<boolean>, label: string, ms = 10_000) {
  const deadline = performance.now() + ms
  while (!(await check())) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await Bun.sleep(10)
  }
}

/** A root session in `main` and a workflow agent session of it in `worktree`, with a global watcher running. */
async function setup(main: string, worktree: string, approve: boolean) {
  const client = sdk(main)
  const root = (await client.session.create({})).data
  if (!root) throw new Error("root session was not created")
  const state = KiloRunAuto.create(root.id)
  const warnings: string[] = []
  const abort = new AbortController()
  const listeners = GlobalBus.listenerCount("event")
  const watched = KiloRunAuto.global(client, {
    state,
    directory: main,
    approve,
    signal: abort.signal,
    warn: (text) => void warnings.push(text),
  })
  await until(() => GlobalBus.listenerCount("event") > listeners, "the global event stream")
  const agent = (
    await client.session.create({
      directory: worktree,
      parentID: root.id,
      title: "isolated (@workflow-subagent subagent)",
      metadata: { [WorkflowSpawn.METADATA]: { runID: "wf_00000000-000", agentID: "a0", index: 0, label: "isolated" } },
    })
  ).data
  if (!agent) throw new Error("workflow agent session was not created")
  expect(agent.directory).toBe(worktree)
  await until(() => KiloRunAuto.allowed(state, agent.id), "the workflow agent session to be tracked")
  return {
    client,
    root,
    agent,
    state,
    warnings,
    stop: async () => {
      abort.abort()
      await watched
    },
  }
}

describe("kilo run with worktree workflow agents", () => {
  test("--auto approves a tracked worktree agent's ask through the worktree's directory", async () => {
    await using main = await tmpdir({ git: true })
    await using worktree = await tmpdir({ git: true })
    const run = await setup(main.path, worktree.path, true)

    const exit = await ask(worktree.path, run.agent.id, "permission_wt_auto")
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(run.state.rejected).toBe(false)
    expect(run.warnings).toEqual([])
    await run.stop()
  })

  test("without --auto the ask is rejected and the run is marked as failed", async () => {
    await using main = await tmpdir({ git: true })
    await using worktree = await tmpdir({ git: true })
    const run = await setup(main.path, worktree.path, false)

    const exit = await ask(worktree.path, run.agent.id, "permission_wt_reject")
    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBeInstanceOf(PermissionV1.RejectedError)
    expect(run.state.rejected).toBe(true)
    expect(run.warnings).toEqual(["subagent permission requested: bash (git status); auto-rejecting"])
    await run.stop()
  })

  test("asks from untracked sessions in other directories stay pending", async () => {
    await using main = await tmpdir({ git: true })
    await using worktree = await tmpdir({ git: true })
    const run = await setup(main.path, worktree.path, true)
    const other = (await run.client.session.create({ directory: worktree.path })).data
    if (!other) throw new Error("unrelated session was not created")

    const asking = ask(worktree.path, other.id, "permission_wt_other")
    await until(
      async () =>
        ((await run.client.permission.list({ directory: worktree.path })).data ?? []).some(
          (item) => item.id === "permission_wt_other",
        ),
      "the unrelated ask to be pending",
    )
    // The watcher handles events in order: once the tracked ask after it is answered, the unrelated one was skipped.
    expect(Exit.isSuccess(await ask(worktree.path, run.agent.id, "permission_wt_tracked"))).toBe(true)
    expect(KiloRunAuto.allowed(run.state, other.id)).toBe(false)
    expect(
      ((await run.client.permission.list({ directory: worktree.path })).data ?? []).map((item) => item.id),
    ).toEqual(["permission_wt_other"])
    await run.client.permission.reply({ requestID: "permission_wt_other", directory: worktree.path, reply: "reject" })
    expect(Exit.isFailure(await asking)).toBe(true)
    await run.stop()
  })

  test("plain kilo run denies a worktree workflow agent's ask before it is published", async () => {
    await using main = await tmpdir({ git: true })
    await using worktree = await tmpdir({ git: true })
    const client = sdk(main.path)
    const root = (await client.session.create({})).data
    if (!root) throw new Error("root session was not created")
    const agent = (
      await client.session.create({
        directory: worktree.path,
        parentID: root.id,
        metadata: {
          [WorkflowSpawn.METADATA]: { runID: "wf_00000000-001", agentID: "a0", index: 0, label: "isolated" },
        },
      })
    ).data
    if (!agent) throw new Error("workflow agent session was not created")
    KiloHeadless.mark(root.id)
    const exit = await ask(worktree.path, agent.id, "permission_wt_headless").finally(() => KiloHeadless.clear(root.id))
    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBeInstanceOf(PermissionV1.DeniedError)
    expect((await client.permission.list({ directory: worktree.path })).data ?? []).toEqual([])
  })
})
