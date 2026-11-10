import type { Meta } from "./types"

export namespace WorkflowSaved {
  export type Entry = Meta & { path: string; scope: "project" | "global" }

  /**
   * Discover saved workflows (`<dir>/workflows/*.js`) across Kilo config directories (Config.directories() order:
   * nearest project dir first … global last). Project beats global; closest to the working directory wins.
   * Contract owned by the ultracode/saved unit.
   */
  export async function list(input: { directories: string[]; directory: string }): Promise<Entry[]> {
    return input.directories.length ? [] : []
  }

  export async function find(input: { directories: string[]; directory: string; name: string }) {
    return (await list(input)).find((item) => item.name === input.name)
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
    throw new Error(`unimplemented: ${input.name}`)
  }
}
