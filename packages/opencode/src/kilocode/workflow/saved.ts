import fs from "fs/promises"
import { constants } from "fs"
import path from "path"
import { Effect } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import * as Log from "@opencode-ai/core/util/log"
import type { Command } from "@/command"
import type { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import type { Meta } from "./types"
import { WorkflowMeta } from "./meta"
import { KiloWorkflowEnabled } from "./enabled"

const log = Log.create({ service: "workflow.saved" })

export namespace WorkflowSaved {
  export type Entry = Meta & { path: string; scope: "project" | "global" }

  type Scope = Entry["scope"]

  /** Config directories that belong to the user rather than a project (mirrors ConfigPaths.directories). */
  function globals() {
    const home = Global.Path.home
    return new Set(
      [
        Global.Path.config,
        path.join(home, ".kilocode"),
        path.join(home, ".kilo"),
        ...(Flag.KILO_CONFIG_DIR ? [Flag.KILO_CONFIG_DIR] : []),
      ].map((dir) => path.resolve(dir)),
    )
  }

  function inside(child: string, parent: string) {
    const rel = path.relative(parent, child)
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
  }

  /**
   * Search order, highest precedence first. Project directories come first, nearest to the working directory
   * winning (a linked worktree's own `.kilo` beats the primary checkout's fallback, `.kilo` beats `.kilocode` at the
   * same level). Global directories follow in config precedence: KILO_CONFIG_DIR, `~/.kilo`, `~/.kilocode`, then
   * the global config dir.
   */
  export function order(input: { directories: string[]; directory: string }) {
    const global = globals()
    const dirs = [...new Set(input.directories.map((dir) => path.resolve(dir)))]
    const rank = (dir: string) => {
      const base = path.dirname(dir)
      return {
        near: inside(input.directory, base) ? 1 : 0,
        depth: base.split(path.sep).length,
        kilo: path.basename(dir) === ".kilo" ? 1 : 0,
      }
    }
    const project = dirs
      .filter((dir) => !global.has(dir))
      .map((dir) => ({ dir, rank: rank(dir) }))
      .toSorted((a, b) => b.rank.near - a.rank.near || b.rank.depth - a.rank.depth || b.rank.kilo - a.rank.kilo)
      .map((item) => ({ dir: item.dir, scope: "project" as Scope }))
    const user = dirs
      .filter((dir) => global.has(dir))
      .toReversed()
      .map((dir) => ({ dir, scope: "global" as Scope }))
    return [...project, ...user]
  }

  function parse(file: string, text: string) {
    try {
      return WorkflowMeta.parse(text).meta
    } catch (err) {
      log.warn("skipping saved workflow", { file, err })
      return undefined
    }
  }

  async function scan(dir: string, scope: Scope): Promise<Entry[]> {
    const root = path.join(dir, "workflows")
    const items = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
    const files = items
      .filter((item) => (item.isFile() || item.isSymbolicLink()) && item.name.endsWith(".js"))
      .map((item) => path.join(root, item.name))
      .toSorted()
    const result: Entry[] = []
    for (const file of files) {
      const text = await Bun.file(file)
        .text()
        .catch((err) => {
          log.warn("unreadable saved workflow", { file, err })
          return undefined
        })
      if (text === undefined) continue
      const meta = parse(file, text)
      if (!meta) continue
      result.push({ ...meta, name: meta.name.trim() || path.basename(file, ".js"), path: file, scope })
    }
    return result
  }

  /**
   * Discover saved workflows (`<dir>/workflows/*.js`) across Kilo config directories (the caller passes
   * Config.directories()). One entry per name: the nearest project directory wins, and project beats global.
   * Files whose `meta` does not parse are skipped.
   */
  export async function list(input: { directories: string[]; directory: string }): Promise<Entry[]> {
    const found = await Promise.all(order(input).map((item) => scan(item.dir, item.scope)))
    const seen = new Set<string>()
    return found.flat().filter((item) => {
      if (seen.has(item.name)) return false
      seen.add(item.name)
      return true
    })
  }

  /** Resolve a saved workflow by `meta.name`, falling back to the file name without `.js`. */
  export async function find(input: { directories: string[]; directory: string; name: string }) {
    const items = await list(input)
    return (
      items.find((item) => item.name === input.name) ??
      items.find((item) => path.basename(item.path, ".js") === input.name)
    )
  }

  /** File name for a saved workflow: the meta name with anything outside `[A-Za-z0-9._-]` replaced. */
  export function file(name: string) {
    const slug = name
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^[.-]+/, "")
    if (!slug) throw new Error(`Cannot derive a file name from workflow name "${name}"`)
    return `${slug}.js`
  }

  async function link(target: string) {
    const stat = await fs.lstat(target).catch(() => undefined)
    return stat?.isSymbolicLink() === true
  }

  async function directory(target: string) {
    const stat = await fs.stat(target).catch(() => undefined)
    return stat?.isDirectory() === true
  }

  /** Closest existing `.kilo/workflows/` from `directory` up to the project root, else `<root>/.kilo/workflows/`. */
  async function project(input: { directory: string; worktree: string }) {
    const root = input.worktree === "/" || !inside(input.directory, input.worktree) ? input.directory : input.worktree
    const walk = (dir: string): string[] => {
      if (dir === root || !inside(dir, root) || path.dirname(dir) === dir) return [dir]
      return [dir, ...walk(path.dirname(dir))]
    }
    const bases = walk(path.resolve(input.directory))
    const found = await Promise.all(bases.map((base) => directory(path.join(base, ".kilo", "workflows"))))
    const index = found.indexOf(true)
    const kilo = path.join(index === -1 ? root : bases[index], ".kilo")
    for (const item of [kilo, path.join(kilo, "workflows")]) {
      if (await link(item)) throw new Error(`Refusing to save a workflow through a symlink: ${item}`)
    }
    return path.join(kilo, "workflows")
  }

  let saves = 0

  /** Bumped on every save so cached command lists know to pick up the new workflow. */
  export function revision() {
    return saves
  }

  /** Save a run's script as a saved workflow. Refuses to write through symlinks. Returns the written path. */
  export async function save(input: {
    script: string
    name: string
    scope: "project" | "global"
    directory: string
    worktree: string
    global: string
  }): Promise<string> {
    const dir = input.scope === "global" ? path.join(input.global, "workflows") : await project(input)
    const target = path.join(dir, file(input.name))
    await fs.mkdir(dir, { recursive: true })
    if (await link(target)) throw new Error(`Refusing to save a workflow through a symlink: ${target}`)
    // O_NOFOLLOW closes the gap between the check above and the write.
    const handle = await fs.open(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0),
      0o644,
    )
    await handle.writeFile(input.script).finally(() => handle.close())
    saves++
    return target
  }

  /** Slash-command template for a saved workflow. Never contains the script itself. */
  export function template(name: string) {
    return `Run the saved workflow "${name}" by calling the workflow tool with name "${name}". If the user supplied input below, pass it as the tool's \`args\` (as structured JSON when the workflow expects a list or object):\n\n$ARGUMENTS`
  }

  const SAFE = /^[\p{L}\p{N}_. :-]+$/u

  /**
   * Slash-command name for a saved workflow: its `meta.name`, or the file name when the meta name contains
   * whitespace (a slash command cannot). The template still refers to the meta name the tool resolves.
   */
  export function command(item: Pick<Entry, "name" | "path">) {
    if (/\s/.test(item.name)) return path.basename(item.path, ".js")
    return item.name
  }

  /** Command entries for saved workflows; empty when dynamic workflows are disabled. */
  export const commands = Effect.fn("WorkflowSaved.commands")(function* (input: {
    cfg: Parameters<typeof KiloWorkflowEnabled.enabled>[0]
    flags: Parameters<typeof KiloWorkflowEnabled.enabled>[1]
    directories: string[]
    directory: string
  }) {
    if (!KiloWorkflowEnabled.enabled(input.cfg, input.flags)) return []
    const items = yield* Effect.promise(() => list(input))
    // The name lands in a command template, where `!`…``, `$N` and `@path` expand; such names stay tool-only.
    return items
      .filter((item) => SAFE.test(item.name))
      .map((item) => ({
        name: command(item),
        description: item.description,
        source: "command" as const,
        template: template(item.name),
        hints: ["$ARGUMENTS"],
      }))
  })

  /** Revision each command map was built at; keyed by the map, so the Command state keeps upstream's shape. */
  const built = new WeakMap<object, number>()

  /**
   * Register saved workflows in a Command state's map, under names no other source claimed (partial command
   * overrides applied afterwards may still target them), and stamp the map with the revision it was read at.
   */
  export const register = Effect.fn("WorkflowSaved.register")(function* (
    map: Record<string, Command.Info>,
    input: {
      config: Pick<Config.Interface, "get" | "directories">
      flags: Parameters<typeof KiloWorkflowEnabled.enabled>[1]
      directory: string
    },
  ) {
    const rev = revision()
    const cfg = yield* input.config.get()
    const directories = yield* input.config.directories()
    for (const item of yield* commands({ cfg, flags: input.flags, directories, directory: input.directory })) {
      map[item.name] ??= item
    }
    built.set(map, rev)
  })

  /**
   * The instance's Command state, rebuilt when a workflow was saved after `register` stamped it. Only this state is
   * rebuilt: disposing the instance instead would stop its running workflows.
   */
  export function current<A extends { commands: object }, E, R>(state: InstanceState.InstanceState<A, E, R>) {
    return Effect.gen(function* () {
      const value = yield* InstanceState.get(state)
      if (built.get(value.commands) === revision()) return value
      yield* InstanceState.invalidate(state)
      return yield* InstanceState.get(state)
    })
  }
}
