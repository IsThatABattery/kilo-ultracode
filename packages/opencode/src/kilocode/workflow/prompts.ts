// Prompt texts for dynamic workflows and ultracode.
//
// These follow Claude Code's prompts as closely as possible (public mirror:
// github.com/Piebald-AI/claude-code-system-prompts, system-prompts/*workflow*.md and
// system-reminder-ultracode-enabled.md). Only Kilo-specific substitutions differ: tool names,
// the StructuredOutput tool name, and dropping references to tools Kilo does not have
// (SendUserMessage) or harness notes it does not use (the auto-mode task-authority note).

import type { Size } from "./types"
import { KiloWorkflowEnabled } from "./enabled"

export namespace WorkflowPrompts {
  export const STRUCTURED_OUTPUT_TOOL = "StructuredOutput"

  /** System prompt for the default workflow subagent when the script expects plain text. */
  export const SUBAGENT_TEXT = [
    "You are a subagent spawned by a workflow orchestration script. Use the tools available to complete the task.",
    "",
    "CRITICAL: Your final text response is returned **verbatim** as a string to the calling script — it is your return value, not a message to a human.",
    '- Output the literal result (data, JSON, text). Do NOT output confirmations like "Done." or "Sent."',
    "- If asked for JSON, return ONLY the raw JSON — no code fences, no prose, no markdown.",
    "- Be concise. The script will parse your output.",
  ].join("\n")

  /** System prompt for the default workflow subagent when the script passed a schema. */
  export const SUBAGENT_STRUCTURED = [
    "You are a subagent spawned by a workflow orchestration script. Use the tools available to complete the task.",
    "",
    `CRITICAL: You MUST call the ${STRUCTURED_OUTPUT_TOOL} tool exactly once to return your final answer. The tool's input schema defines the required shape.`,
    `- Do your work (Read files, run commands, etc.), then call ${STRUCTURED_OUTPUT_TOOL} with your answer.`,
    `- Do NOT put your answer in a text response. The script reads ONLY the ${STRUCTURED_OUTPUT_TOOL} tool call.`,
    `- If the schema validation fails, read the error and call ${STRUCTURED_OUTPUT_TOOL} again with a corrected shape.`,
    `- After calling ${STRUCTURED_OUTPUT_TOOL} successfully, end your turn. No acknowledgment needed.`,
  ].join("\n")

  /** Appended to a custom agentType's system prompt when the script expects plain text. */
  export const NOTE_TEXT = [
    "",
    "",
    "---",
    "",
    'NOTE: You are running inside a workflow script. Your final text response is returned verbatim as a string to the calling script — it is your return value, not a message to a human. Output the literal result; do not output confirmations like "Done." Be concise — the script will parse your output.',
  ].join("\n")

  /** Appended to a custom agentType's system prompt when the script passed a schema. */
  export const NOTE_STRUCTURED = [
    "",
    "",
    "---",
    "",
    `NOTE: You are running inside a workflow script. You MUST return your final answer by calling the ${STRUCTURED_OUTPUT_TOOL} tool exactly once — the tool's input schema defines the required shape. Do your work, then call ${STRUCTURED_OUTPUT_TOOL}; do NOT put your answer in a text response (the script reads ONLY the tool call). If validation fails, read the error and call ${STRUCTURED_OUTPUT_TOOL} again with a corrected shape.`,
  ].join("\n")

  /** Appended to the subagent's system prompt when it runs with isolation: 'worktree'. */
  export function worktree(input: { path: string; main: string }) {
    return [
      "",
      "",
      "---",
      `You are running in an isolated git worktree at \`${input.path}\` (a separate working copy of the repo). Changes you make here do NOT affect the main working directory (\`${input.main}\`) or other agents. Work normally — the worktree will be cleaned up automatically if you made no changes, or preserved for review if you did.`,
    ].join("\n")
  }

  /** Re-prompt sent to a subagent whose structured output was missing or failed validation. */
  export function retry(error: string) {
    return `Your final answer did not pass validation: ${error}\nCall the ${STRUCTURED_OUTPUT_TOOL} tool again with a corrected shape.`
  }

  /** Session reminder while ultracode is on (Claude Code: "System Reminder: Ultracode enabled"). */
  export const ULTRACODE_ON =
    "Ultracode is on: optimize for the most exhaustive, correct answer — not the fastest or cheapest. Use the Workflow tool on every substantive task; token cost is not a constraint. See the **Ultracode** section and quality patterns in the workflow authoring reference. Solo only on conversational/trivial turns."

  /** Reminder after ultracode is switched off mid-session (the authoring reference refers to it). */
  export const ULTRACODE_OFF =
    "Ultracode is off: revert to the opt-in rule in the Workflow tool description."

  /** One-turn opt-in when a human-typed prompt contains the keyword. */
  export const ULTRACODE_KEYWORD =
    'The user included the keyword "ultracode" in their prompt: this is an explicit opt-in to multi-agent orchestration for this task. Use the Workflow tool for it — see the **Ultracode** section and quality patterns in the workflow authoring reference.'

  /** Size-guideline paragraph appended to the workflow tool description. */
  export function size(input: { size: Size; explicit: boolean }) {
    if (input.size === "unrestricted") return ""
    const limit = KiloWorkflowEnabled.LIMITS[input.size]
    const kind = input.explicit ? "" : "default "
    return `This session has the ${kind}workflow size guideline: ${input.size} — keep workflows under ${limit} agents. This is a guideline, not a hard limit — follow it unless the user's prompt calls for a different scale. The user can raise or remove it with the \`experimental.workflow_size\` setting.`
  }

  export function wrap(text: string) {
    return `<system-reminder>\n${text}\n</system-reminder>`
  }
}
