// `agent(prompt, { isolation: 'worktree' })`: run one workflow agent in a fresh detached git worktree.
//
// The worktree lives under the upstream default `<data>/worktree/<projectID>/` (not `.kilo/worktrees/`,
// which the VS Code Agent Manager reconciles as its own). It is removed afterwards when the agent left
// it unchanged; otherwise it is kept, put on a `kilo/wf/<runID>-<index>` branch, and reported back.
// `create` and `finish` run in the launching (parent) instance; the agent itself runs inside
// `InstanceStore.provide({ directory: path })`, which the spawn layer arranges.

import { Effect, Semaphore } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { InstanceState } from "@/effect/instance-state"
import { Git } from "@/git"
import { InstanceStore } from "@/project/instance-store"
import { Project } from "@/project/project"
import { Worktree } from "@/worktree"
import type { WorktreeResult } from "./types"

const log = Log.create({ service: "workflow.worktree" })

export namespace WorkflowWorktree {
  export const NOT_GIT = "isolation: 'worktree' requires a git repository"

  /** How long to wait for checkout, instance boot and the project's start script. */
  const TIMEOUT = "10 minutes"

  // `git worktree add` and Worktree's name probing are check-then-act, so creations are serialized.
  const lock = Semaphore.makeUnsafe(1)

  export type Handle = {
    /** Worktree root the agent runs in. */
    path: string
    /** The launching instance's checkout. */
    main: string
    /** Commit the worktree was created from. */
    base: string
  }

  function listen(directory: string) {
    const ready = Promise.withResolvers<string | undefined>()
    const handler = (event: GlobalEvent) => {
      if (event.directory !== directory) return
      const type = event.payload?.type
      if (type === Worktree.Event.SetupReady.type) ready.resolve(undefined)
      if (type === Worktree.Event.Failed.type)
        ready.resolve(event.payload?.properties?.message ?? "worktree setup failed")
    }
    GlobalBus.on("event", handler)
    return { promise: ready.promise, off: () => GlobalBus.off("event", handler) }
  }

  /** Create and wait for a detached worktree of the current checkout's HEAD; fails with a message. */
  export const create = Effect.fn("WorkflowWorktree.create")(function* (name: string) {
    const ctx = yield* InstanceState.context
    if (ctx.project.vcs !== "git") return yield* Effect.fail(NOT_GIT)
    const git = yield* Git.Service
    const worktree = yield* Worktree.Service
    // Precheck only: HEAD can move before the worktree is added, so the base is read from the worktree itself.
    const head = yield* git.run(["rev-parse", "HEAD"], { cwd: ctx.worktree })
    if (head.exitCode !== 0) return yield* Effect.fail(`${NOT_GIT} with at least one commit`)

    // `git worktree add` is brief and leaves a registered worktree behind, so it is not interrupted midway.
    const started = yield* lock
      .withPermits(1)(
        Effect.gen(function* () {
          const info = yield* worktree.makeWorktreeInfo({ name, detached: true })
          // Subscribe before creating: boot runs forked and can report readiness at any point after.
          const wait = listen(info.directory)
          yield* worktree.createFromInfo(info).pipe(Effect.onError(() => Effect.sync(wait.off)))
          // HEAD is set right away, even though the checkout itself runs later (--no-checkout).
          const made = yield* git.run(["rev-parse", "HEAD"], { cwd: info.directory })
          return { info, wait, base: made.exitCode === 0 ? made.text().trim() : head.text().trim() }
        }),
      )
      .pipe(
        Effect.uninterruptible,
        Effect.mapError((err) => (err._tag === "WorktreeNotGitError" ? NOT_GIT : `worktree: ${err.message}`)),
      )
    const handle = { path: started.info.directory, main: ctx.worktree, base: started.base } satisfies Handle

    const failure = yield* Effect.promise(() => started.wait.promise).pipe(
      Effect.timeoutOrElse({
        duration: TIMEOUT,
        orElse: () => Effect.succeed("timed out waiting for the worktree to finish setting up"),
      }),
      Effect.ensuring(Effect.sync(started.wait.off)),
      // Stopped while the checkout or start script was still running: nothing of the agent's to keep.
      Effect.onInterrupt(() => discard(handle)),
    )
    if (failure === undefined) return handle
    // A worktree that never finished checking out holds no agent work: always discard it.
    yield* discard(handle)
    return yield* Effect.fail(`worktree: ${failure}`)
  })

  /** Remove the worktree and its project sandbox registration; failures are logged, never raised. */
  const discard = Effect.fnUntraced(function* (handle: Handle) {
    const ctx = yield* InstanceState.context
    const worktree = yield* Worktree.Service
    const project = yield* Project.Service
    yield* worktree.remove({ directory: handle.path }).pipe(
      Effect.andThen(project.removeSandbox(ctx.project.id, handle.path)),
      Effect.catch((err) =>
        Effect.sync(() => log.error("failed to remove workflow worktree", { path: handle.path, err })),
      ),
    )
  })

  /**
   * Inspect a finished agent's worktree from the parent instance: remove it when unchanged, otherwise
   * keep it on a branch named `branch` (or the branch the agent switched to) and free its instance.
   */
  export const finish = Effect.fn("WorkflowWorktree.finish")(function* (handle: Handle, branch: string) {
    const git = yield* Git.Service
    const run = (args: string[]) => git.run(args, { cwd: handle.path })
    const status = yield* run(["-c", "core.fsmonitor=false", "status", "--porcelain=v1"])
    const ahead = yield* run(["rev-list", "--count", `${handle.base}..HEAD`])
    // Anything we cannot inspect is kept: never discard work on an ambiguous signal.
    const changed =
      status.exitCode !== 0 || status.text().trim() !== "" || ahead.exitCode !== 0 || ahead.text().trim() !== "0"

    if (!changed) {
      yield* discard(handle)
      return { path: handle.path, changed: false } satisfies WorktreeResult
    }

    const current = yield* run(["symbolic-ref", "--quiet", "--short", "HEAD"])
    const name = current.exitCode === 0 ? current.text().trim() : yield* attach(run, branch)
    const store = yield* InstanceStore.Service
    yield* store.disposeDirectory(handle.path)
    return { path: handle.path, ...(name ? { branch: name } : {}), changed: true } satisfies WorktreeResult
  })

  /** Put the detached worktree on a new branch, keeping uncommitted changes; undefined when git refuses. */
  const attach = Effect.fnUntraced(function* (run: (args: string[]) => Effect.Effect<Git.Result>, branch: string) {
    // A resumed run reuses its run id, so an earlier kept worktree may already own the name.
    for (const name of [branch, ...Array.from({ length: 9 }, (_, i) => `${branch}-${i + 2}`)]) {
      const exists = yield* run(["show-ref", "--verify", "--quiet", `refs/heads/${name}`])
      if (exists.exitCode === 0) continue
      const made = yield* run(["checkout", "-b", name])
      if (made.exitCode === 0) return name
      log.error("failed to create workflow worktree branch", { name, error: made.stderr.toString("utf8") })
      return undefined
    }
    return undefined
  })
}
