export namespace KiloInstance {
  /**
   * Whether a `server.instance.disposed` event is for this TUI's own instance. The event filter passes every
   * directory of the project, and workflow agents with `isolation: "worktree"` dispose their worktree's instance when
   * they finish, so without this check each isolated agent would reset this directory's state. Until the directory is
   * known every disposal counts.
   */
  export function own(disposed: string, directory: string | undefined) {
    return !directory || disposed === directory
  }
}
