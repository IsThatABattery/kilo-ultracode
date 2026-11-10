// kilocode_change - new file
// Built-in skills that ship inside the CLI binary.
// Content is inlined at compile time via Bun's static import of .md files.
// Registered before all discovery phases so user skills with the same name override.

import KILO_CONFIG from "./kilo-config.md" with { type: "text" }
import WORKFLOW_AUTHORING from "./workflow-authoring.md" with { type: "text" }
import { KiloWorkflowEnabled } from "../workflow/enabled"

export interface BuiltinSkill {
  name: string
  description: string
  content: string
}

const WORKFLOW = "workflow-authoring"

export const BUILTIN_SKILLS: BuiltinSkill[] = [
  {
    name: "kilo-config",
    description:
      "Guide for Kilo configuration: config paths, kilo.json fields, commands, agents, skills, permissions, MCPs, providers, TUI settings, plus Agent Manager worktree setup/run scripts, workflows, and state. Use for Kilo config questions, locating loaded config, changing settings, or Agent Manager questions about run/setup scripts, worktree setup/workflows, apply/merge/PR/conflicts, missing sessions/worktrees, and agent-manager.json recovery.",
    content: KILO_CONFIG,
  },
  {
    name: WORKFLOW,
    description:
      "Reference for writing a Workflow tool script (script API and gotchas, resume, quality patterns, worked examples). Load before authoring a script for a workflow the user already opted into; it does not itself authorize running one.",
    content: WORKFLOW_AUTHORING,
  },
]

/**
 * Remove built-in skills whose feature is turned off (workflow-authoring when dynamic workflows are disabled).
 * Only the seeded built-in entry (location "builtin") is removed; a user skill with the same name stays.
 */
export function gate(
  skills: Record<string, { location: string }>,
  cfg: Parameters<typeof KiloWorkflowEnabled.enabled>[0],
  flags: Parameters<typeof KiloWorkflowEnabled.enabled>[1],
) {
  if (KiloWorkflowEnabled.enabled(cfg, flags)) return
  if (skills[WORKFLOW]?.location === "builtin") delete skills[WORKFLOW]
}
