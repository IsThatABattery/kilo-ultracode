---
title: "Dynamic Workflows and Ultracode"
description: "Let the agent orchestrate many subagents from a script, and turn on ultracode for exhaustive multi-agent work"
platform: new
---

# Dynamic Workflows and Ultracode

A dynamic workflow is a short JavaScript script the agent writes to coordinate many subagents. The script decides what fans out, what gets verified, and what gets combined, so loops, fan-out, and checks run the same way every time instead of depending on the model. Workflows run in the background: you keep working in the session, and Kilo posts the result to the conversation when the run finishes.

Ultracode is a per-session switch. While it is on, the agent plans and runs a workflow for every substantive task, aiming for the most thorough and correct answer instead of the fastest or cheapest one.

Workflows work with any provider and model you have configured in Kilo.

{% callout type="warning" title="Workflows can use many tokens" %}
A single workflow can start dozens or hundreds of agents, and each one is a full model session. Ultracode tells the agent that token cost is not a constraint. Watch token usage in the progress view, and use the [size guideline and token budgets](#controlling-cost) to keep runs in proportion.
{% /callout %}

## When to use a workflow

| Aspect | Subagent (`task` tool) | Dynamic workflow (`workflow` tool) |
|---|---|---|
| Scale | One focused delegate at a time | Dozens to hundreds of agents per run |
| Control flow | The model decides each step | A script defines loops, fan-out, and verification |
| Runs | In the foreground or background | Always in the background, with a live progress view |
| Results | Returned to the parent session | A combined result, plus per-agent results on disk |
| Recovery | Resume a single task | Resume a run and replay unchanged agents from cache |

Workflows fit work that is too broad for one context or that benefits from independent checks:

- **Reviews and audits**: review a change along several dimensions, then have separate agents try to refute each finding
- **Migrations**: find every call site, transform each one in parallel, then verify the result
- **Research**: search the codebase or the web in several ways at once, read the best sources in depth, and synthesize
- **Design**: generate several independent approaches and score them with a panel of judges

For a single lookup or a small edit, a plain message or one subagent is faster and cheaper.

## Starting a workflow

The agent runs a workflow only when you opt in explicitly. Any of these counts:

- Turn on [ultracode](#ultracode) for the session
- Include the word `ultracode` in your message, which opts in for that message only
- Ask for one in your own words, such as "use a workflow" or "fan out agents for this"
- Run a [saved workflow](#saved-workflows), or a command or skill whose instructions call the `workflow` tool

Otherwise, the agent works as usual. When a task looks like a good fit, it may describe the workflow it could run and its rough cost, and ask whether to start it.

```text
Review the uncommitted changes for bugs and security issues, ultracode
```

Before a workflow starts, Kilo asks for the `workflow` permission. The prompt shows the workflow's name, description, and phases. In the CLI, press `v` to view a script the agent wrote, and a script file or saved workflow shows its path.

**Allow always** is offered only when the agent runs a [saved workflow](#saved-workflows) by name, and it covers that workflow in the current project only. A script the agent writes for the task asks every time, unless your [config](#configuration) allows it.

`kilo run` rejects permission prompts unless you pass `--auto`, so allow the permission in config for workflows you trust. With `--auto`, `kilo run` also approves the permission prompts of workflow agents, including agents that run in their own worktree.

The read-only [Ask and Plan agents](/docs/code-with-ai/agents/using-agents) cannot start workflows.

### Token budgets

Add a token target such as `+500k` or `+1.5m` to your message to set a budget for the turn. It counts output tokens from the main conversation and from every workflow agent launched in that turn. Scripts can read the target to scale their work, and once it is spent, workflows cannot start more agents.

```text
Audit the API routes for missing authorization checks +500k
```

## Ultracode

While ultracode is on, every turn includes a reminder that tells the agent to use a workflow for every substantive task and to aim for the most exhaustive, correct answer. Conversational and trivial turns are still answered directly. When you turn ultracode off, the agent is told once that it is off and returns to the opt-in rule above.

Ultracode is stored on the session, so it survives reloads and restarts. It applies only to the main conversation, never to subagents or workflow agents.

{% tabs %}
{% tab label="VS Code" %}

1. Open the reasoning effort selector next to the model selector in the prompt area
2. Turn on the **Ultracode** switch

The switch is available even when the selected model has no reasoning effort variants. While ultracode is on, the selector shows **· Ultracode** after the effort level.

You can also type `/ultracode` in the prompt to toggle it. The New Worktree dialog in Agent Manager has the same switch, so new worktree sessions can start with ultracode on.

{% /tab %}
{% tab label="CLI" %}

Type `/ultracode` to toggle ultracode for the current session. On the home screen, the command creates a session first. While ultracode is on, the prompt shows an `ultracode` indicator.

{% /tab %}
{% /tabs %}

To turn ultracode on by default, set `experimental.ultracode` to `true`. The default applies to every session whose switch you have not changed, and a session's own switch always wins.

Ultracode has no effect while the Ask or Plan agent is selected, because those agents cannot start workflows.

The ultracode switch and `/ultracode` are hidden when dynamic workflows are turned off.

### The `ultracode` keyword

Typing the word `ultracode` anywhere in a message opts in for that message only, without changing the session switch. Only text you type counts: slash commands such as `/ultracode`, command templates, and text Kilo adds to the conversation do not. Neither does a prompt passed to `kilo run` or a GitHub comment that the Kilo GitHub action relays.

In the CLI and VS Code, the keyword is highlighted in the prompt. To send the message without opting in, press `Alt+W` (`Option+W` on macOS), or `Backspace` right after the keyword. The highlight goes away and the keyword no longer counts for that message.

To stop the keyword from opting in at all, set `experimental.ultracode_keyword` to `false`. The ultracode switch and `/ultracode` keep working.

## Watching and controlling runs

{% tabs %}
{% tab label="VS Code" %}

The workflow card in the chat shows the workflow's name and description with live progress: status, completed and total agents, and tokens. Expand the card to see each phase with its completed, running, and failed agents, and the list of agents.

- **Stop** on the card stops the whole run. **Stop** on a running agent stops only that agent
- **Pause** and **Resume** hold and release new agents
- Select an agent to open its session and read its transcript

Type `/workflows` to scroll to the session's latest workflow card and expand it.

{% /tab %}
{% tab label="CLI" %}

Type `/workflows` to open the run list for the current session. Each row shows the run's status, name, elapsed time, completed and total agents, and tokens. When the session has only one run, the dialog opens it directly.

A run's view lists its phases. Open a phase to see its agents with their status, model, tokens, and elapsed time, and select an agent to open its session and read its transcript. From the dialog you can stop the run or a single agent, pause or resume the run, and save its script as a [saved workflow](#saved-workflows). The available keys are listed at the bottom of the dialog.

The session sidebar has a **Workflows** section with one line per running or paused run. Select a line to open that run.

In the chat, the workflow tool call shows the workflow's name, description, status, agent progress, and phases instead of the script.

{% /tab %}
{% /tabs %}

A running or paused run shows a **Large workflow** warning when it has more agents than the [size guideline](#controlling-cost) you set (25 when you have not set one or chose `unrestricted`), or is on track to use more than 1.5 million tokens. The warning never appears while ultracode is on, because ultracode asks for large runs.

How the controls behave:

| Action | Effect |
|---|---|
| Stop the run | Running agents are cancelled and the script ends. The agent is told the run was stopped |
| Stop one agent | That agent is cancelled and the script receives `null` for it. The rest of the run continues |
| Pause | Running agents finish, but no new agents start until you resume. The agent is told the run is paused |
| Resume | New agents start again |

Interrupting the main conversation does not stop a running workflow. Stop it from `/workflows` or the workflow card instead.

When a run completes, fails, is stopped, or is paused, Kilo adds a notification to the conversation with the result and usage counts, and the agent continues from there. `kilo run` waits until its workflows finish or are paused before it exits.

## Saved workflows

Save a run's script to reuse it later. In the CLI, open the run in `/workflows`, choose save, and pick a scope:

| Scope | Location |
|---|---|
| Project | `.kilo/workflows/<name>.js`, in the closest existing `.kilo/workflows/` folder between the current directory and the project root, otherwise at the project root |
| Global | `~/.config/kilo/workflows/<name>.js` |

You can also write or edit these files yourself. Kilo also reads `.js` workflows from `.kilocode/workflows/`, `~/.kilo/workflows/`, and `~/.kilocode/workflows/`, and from Claude Code's `.claude/workflows/` and `~/.claude/workflows/`, so workflows saved in Claude Code run here too. Kilo's own folders win over `.claude` at the same level. Set `KILO_DISABLE_CLAUDE_CODE=1` to skip the `.claude` folders.

{% callout type="note" %}
`.md` files in a `workflows/` folder are legacy [slash-command workflows](/docs/customize/workflows), which Kilo converts to commands. Only `.js` files are dynamic workflows.
{% /callout %}

Each saved workflow becomes a slash command named after its `meta.name`. The agent passes anything you type after the command to the script as `args`:

```text
/review-changes src/api
```

You can also ask the agent to run a saved workflow by name. When two saved workflows share a name, the one in the nearest project folder wins, and project workflows win over global ones. A command, MCP prompt, or skill with the same name keeps the slash command, but the agent can still run the workflow by name. If `meta.name` contains spaces, the file name is used as the command name. Names with characters other than letters, numbers, spaces, `.`, `_`, `:`, and `-` get no slash command.

Kilo refuses to save a workflow through a symlink: a symlinked project `.kilo` or `.kilo/workflows` folder, or a symlinked workflow file.

## Writing workflow scripts

The agent writes and runs scripts for you. Before writing one, it loads the built-in `workflow-authoring` skill, which documents the script API, common patterns, and pitfalls. You can read or edit a run's script and ask the agent to run it again.

A script starts with a `meta` block, followed by plain JavaScript that calls the workflow functions:

```js
export const meta = {
  name: "review-changes",
  description: "Review changed files across dimensions and verify each finding",
  phases: [{ title: "Review" }, { title: "Verify" }],
}

const FINDINGS = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: { title: { type: "string" }, file: { type: "string" } },
        required: ["title", "file"],
      },
    },
  },
  required: ["findings"],
}

const VERDICT = {
  type: "object",
  properties: { real: { type: "boolean" }, reason: { type: "string" } },
  required: ["real"],
}

const results = await pipeline(
  ["bugs", "security", "performance"],
  (dimension) =>
    agent(`Review the uncommitted changes for ${dimension} issues.`, {
      label: `review:${dimension}`,
      phase: "Review",
      schema: FINDINGS,
    }),
  (review) =>
    parallel(
      review.findings.map((finding) => () =>
        agent(`Try to refute this finding: ${finding.title} in ${finding.file}`, {
          label: `verify:${finding.file}`,
          phase: "Verify",
          schema: VERDICT,
        }).then((verdict) => ({ ...finding, verdict })),
      ),
    ),
)

return results.flat().filter(Boolean).filter((item) => item.verdict?.real)
```

The `meta` block must be a plain literal with a `name` and a one-line `description`. `phases` lists the progress groups, and `whenToUse` is optional.

| Function | What it does |
|---|---|
| `agent(prompt, options)` | Starts one agent and returns its final text, or a validated object when `schema` is set. Returns `null` if the agent is stopped or fails on a provider error |
| `pipeline(items, ...stages)` | Runs each item through the stages independently, with no waiting between stages. A stage that throws turns that item into `null` |
| `parallel(thunks)` | Runs functions concurrently and waits for all of them. A function that throws resolves to `null` |
| `phase(title)` | Groups the agents that follow under a phase in the progress view |
| `log(message)` | Shows a progress message in the progress view. `console.log()` does the same |
| `args` | The input passed to the workflow, such as the text after a saved workflow's slash command |
| `budget` | The turn's token target: `budget.total`, `budget.spent()`, and `budget.remaining()` |
| `workflow(nameOrRef, args)` | Runs a saved workflow or `{ scriptPath }` as a step. Nesting is limited to one level |

| `agent()` option | What it does |
|---|---|
| `label` | Name shown in the progress view. Defaults to the start of the prompt |
| `phase` | Phase to group the agent under |
| `schema` | JSON Schema for a structured result. The root must be `{ type: "object", properties: {...} }` |
| `model` | Model for this agent, as `provider/model`. Defaults to the subagent model (see [Models and providers](#models-and-providers)) |
| `effort` | Reasoning effort: `low`, `medium`, `high`, `xhigh`, or `max` |
| `isolation` | `"worktree"` runs the agent in its own git worktree |
| `agentType` | A subagent to use instead of the default workflow agent, such as `general` or `explore` |

Scripts run in a sandbox:

- Scripts are JavaScript, not TypeScript, and cannot import modules
- There is no file system, network, or process access. Agents do the work; the script coordinates them
- `Date.now()`, `Math.random()`, and `new Date()` without arguments throw, because they would break [resume](#resuming-a-run). Pass timestamps in through `args`

Workflow agents use the tools their agent allows, including MCP tools connected to the session, and follow your permission rules and `AGENTS.md` instructions. They cannot ask you questions, start subagents, start workflows of their own, or read the [run files](#resuming-a-run).

### Worktree isolation

With `isolation: "worktree"`, an agent runs in a fresh git worktree so parallel agents can edit files without conflicts. The worktree starts from the current commit, so it does not include uncommitted changes. If the agent changes nothing, Kilo removes the worktree. If it makes changes, Kilo keeps the worktree on a `kilo/wf/<run-id>-<index>` branch for you to review. Worktree isolation requires a git repository with at least one commit, and each worktree adds setup time and disk usage.

## Models and providers

Workflows do not depend on a specific provider:

- **Model**: agents pick a model the same way as `task` subagents: the agent type's configured model, then [`subagent_model`](/docs/code-with-ai/agents/model-selection) if set, otherwise the model and reasoning variant of the turn that launched the workflow. If an agent's `model` option cannot be resolved, it falls back to that default and the run's log shows a warning
- **Effort**: `effort` maps to the agent model's reasoning variant of the same name, otherwise to the highest variant below it, and is ignored for models without variants. Without `effort`, an agent gets the reasoning variant a `task` subagent would get, usually that of the turn that launched the workflow
- **Structured results**: an agent with a `schema` returns its answer by calling a `StructuredOutput` tool. Kilo validates the answer against the schema and, if it is missing or invalid, sends the validation error back and asks again, up to 5 attempts in total. If every attempt fails, the `agent()` call throws. Schemas use JSON Schema draft-07 unless they declare draft 2019-09 or 2020-12 with `$schema`

The cost of workflow agents is added to the session's cost.

## Resuming a run

Each run is saved in Kilo's data directory, under `~/.local/share/kilo/workflow/<session-id>/<run-id>/` by default:

| File | Contents |
|---|---|
| `script.js` | The script that ran |
| `journal.jsonl` | One line per completed agent, with its full result |
| `run.json` | Run details, including each agent's session ID |
| `output.json` | The summary, logs, and final result |

Only the main conversation can read and edit these files. Subagents and workflow agents cannot.

Runs stay on disk, so the progress views still list a session's runs after Kilo restarts. A run that was still running when its Kilo process exited shows as stopped.

To fix a script or retry after a stop or failure, ask the agent to edit the run's `script.js` and resume the run. Agents whose prompt and options did not change return their journaled results instantly, and changing only an agent's `label` or `phase` keeps its cached result. From the first agent that is new, changed, or failed in the earlier run, every later agent runs live. Agents that were still running when you stopped the run start over, and later unchanged agents still return their cached results.

You can resume only runs from the same session, and only after the run has ended. Stop a running or paused run first.

## Limits

| Limit | Value |
|---|---|
| Concurrent agents per run | The number of CPU cores minus 2, between 1 and 16. Extra agents wait for a free slot |
| Agents per run, nested workflows included | 1000 |
| Items per `parallel()` or `pipeline()` call | 4096 |
| Nested workflows | One level |
| Structured result attempts per agent | 5 |
| Script that stops responding, such as a busy loop | Stopped after 60 seconds |

## Controlling cost

- **Size guideline**: `experimental.workflow_size` tells the agent how large to make workflows. The default, `medium`, aims for fewer than 10 agents. It is a guideline, so the agent can go beyond it when your request calls for a larger run
- **Token budget**: add `+500k` or a similar target to your message. Once the turn reaches it, workflows cannot start more agents
- **Approval**: keep the `workflow` permission on `ask` so you approve each workflow before it starts
- **Live controls**: pause or stop a run from `/workflows` or the workflow card when it grows beyond what you need

## Configuration

Set these keys in `kilo.jsonc`:

| Key | Default | Description |
|---|---|---|
| `experimental.workflows` | `true` | Set to `false` to turn off dynamic workflows: the `workflow` tool, the `workflow-authoring` skill, saved workflow commands, and ultracode |
| `experimental.ultracode` | `false` | Start every session with ultracode on |
| `experimental.ultracode_keyword` | `true` | Set to `false` so the word `ultracode` in a message no longer opts in to a workflow |
| `experimental.workflow_size` | `"medium"` | Size guideline: `small` (fewer than 5 agents), `medium` (fewer than 10), `large` (fewer than 50), or `unrestricted` (no guideline) |
| `permission.workflow` | `"ask"` | Whether starting a workflow asks for approval, runs without asking, or is blocked. See [Permission patterns](#permission-patterns) |

```jsonc
{
  "experimental": {
    "ultracode": true,
    "workflow_size": "large"
  },
  "permission": {
    "workflow": {
      "*": "ask",
      "review-changes@*": "allow"
    }
  }
}
```

In VS Code, the `experimental` switches are also under **Settings** > **Experimental**, and the `workflow` permission under **Settings** > **Auto-Approve**.

These environment variables tune workflows for one process:

| Variable | Description |
|---|---|
| `KILO_DISABLE_WORKFLOWS` | Set to `1` to turn off dynamic workflows, overriding config |
| `KILO_WORKFLOW_MAX_CONCURRENT_AGENTS` | Concurrent agents per run, from 1 to 256 |
| `KILO_WORKFLOW_PREFIX_STAGGER_MS` | How long an agent waits for a sibling with the same model and options to start responding, so the provider can reuse its prompt cache. Defaults to 5000. Set to `0` to turn it off |
| `KILO_MAX_STRUCTURED_OUTPUT_RETRIES` | Total attempts for a structured result per agent. Defaults to 5 |
| `KILO_WORKFLOW_MAX_RSS_MB` | Memory ceiling in MB for the Kilo process while a workflow script runs. Scripts run inside the Kilo process, and a run that pushes it past the ceiling is stopped. Defaults to half of the machine's or container's memory |

### Permission patterns

Each `workflow` permission request carries one pattern:

| Launch | Pattern |
|---|---|
| A saved workflow the agent runs by name, including through its slash command | `<name>@<project path>`, such as `review-changes@/home/me/app` |
| A script the agent wrote, or a script file | `script:<name>` |

The project path is the root of the git repository, or the working directory outside one. **Allow always** saves the saved workflow's exact pattern, so the approval applies only in that project. In config, `"review-changes@*": "allow"` allows the saved workflow in every project, a plain `"review-changes"` rule matches nothing, and `"workflow": "allow"` allows every workflow.

## Related

- [Tools](/docs/automate/tools) for the `task` tool and other built-in tools
- [Agent Permissions](/docs/customize/agent-permissions) for permission rules and patterns
- [Model Selection](/docs/code-with-ai/agents/model-selection) for models and reasoning effort
- [Workflows (slash commands)](/docs/customize/workflows) for Markdown command workflows
