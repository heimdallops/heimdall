---
name: create-subagent
description: >
  Scaffold and write a Claude Code subagent definition file from scratch. Use this skill
  whenever the user wants to create a new subagent, define a custom AI agent, add an agent
  to .claude/agents/, configure a specialized Claude worker, or asks how to delegate tasks
  to a focused AI agent with specific tools or a custom system prompt. Trigger even if the
  user just says "make me an agent that does X" or "I want an agent for Y".
---

# Create a Claude Code Subagent

Subagents are specialized AI assistants that run in their own context window with a custom system prompt, specific tool access, and independent permissions. Use them to:

- Keep verbose output (logs, search results, test runs) out of the main conversation
- Enforce tool restrictions (e.g. read-only reviewer, SQL-only analyst)
- Reuse a specialized workflow across many tasks

## Decision checklist

Before writing the file, confirm these with the user:

1. **Name** — lowercase letters and hyphens (e.g. `code-reviewer`, `db-analyst`)
2. **Scope** — where to save:
   - `.claude/agents/` — project-specific, check into git so teammates share it
   - `~/.claude/agents/` — personal, available in all projects
3. **What it does** — one focused capability. Design each subagent to excel at one task.
4. **Tools needed** — the minimal set required (see list below)
5. **Model** — `haiku` (fast/cheap), `sonnet` (balanced), `opus` (most capable), `inherit`
6. **System prompt** — what expertise, workflow steps, and output format to use

## File format

Subagents are Markdown files with YAML frontmatter. Only `name` and `description` are required; all other fields are optional.

```markdown
---
name: my-agent
description: What this agent does and when Claude should delegate to it
tools: Read, Grep, Glob, Bash
model: sonnet
---

You are a [role]. When invoked:
1. [First step]
2. [Second step]

[Describe expertise, focus areas, and output format]
```

## Frontmatter field reference

| Field            | Values / notes                                                                                    |
|------------------|---------------------------------------------------------------------------------------------------|
| `name`           | **Required.** Unique ID: lowercase letters and hyphens                                            |
| `description`    | **Required.** Claude reads this to decide when to delegate — be specific about when to use it     |
| `tools`          | Allowlist of tools (see below). Omit to inherit all tools from the session                        |
| `disallowedTools`| Denylist — inherits everything except these. If both set, denylist applied first                  |
| `model`          | `haiku`, `sonnet`, `opus`, a full model ID like `claude-sonnet-4-6`, or `inherit` (default)       |
| `permissionMode` | `default`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`, `plan`                          |
| `maxTurns`       | Integer. Cap agentic turns to prevent runaway agents                                              |
| `skills`         | List of skill names to inject into the subagent's context at startup                             |
| `mcpServers`     | MCP servers to connect (inline definition or string reference to an already-configured server)    |
| `hooks`          | Lifecycle hooks scoped to this subagent (`PreToolUse`, `PostToolUse`, `Stop`)                     |
| `memory`         | `user`, `project`, or `local` — enables a persistent memory directory across conversations        |
| `background`     | `true` to always run as a background task (non-blocking)                                          |
| `effort`         | `low`, `medium`, `high`, `xhigh`, `max` — overrides session effort for this agent                |
| `isolation`      | `worktree` — gives the agent an isolated git worktree; auto-cleaned if no changes made            |
| `color`          | `red`, `blue`, `green`, `yellow`, `purple`, `orange`, `pink`, `cyan` — UI display color          |
| `initialPrompt`  | Auto-submitted as the first user turn when agent runs as the main session (via `--agent`)         |

## Available tools

Internal tools you can list in `tools`:
`Read`, `Write`, `Edit`, `MultiEdit`, `Bash`, `Glob`, `Grep`, `LS`, `WebFetch`, `WebSearch`,
`TodoWrite`, `NotebookEdit`, `Agent`, `AskUserQuestion`, `ExitPlanMode`

MCP tools inherit automatically unless restricted. Use `Agent(name1, name2)` syntax in `tools` to limit which subagent types this agent can spawn (only relevant when running as the main session via `--agent`).

## Description writing tips

The `description` field is the primary triggering mechanism — Claude reads it to decide whether to delegate a task. Write it so it's clear both *what* the agent does and *when* to use it. Mention the kinds of requests that should trigger it:

```yaml
# Too vague:
description: Reviews code

# Better — explains when to use it:
description: >
  Expert code reviewer. Use proactively after writing or modifying any code to check
  for quality issues, security problems, and best practices violations.
```

## Common patterns

### Read-only specialist

```markdown
---
name: code-reviewer
description: Reviews code for quality and security. Use proactively after any code changes.
tools: Read, Grep, Glob, Bash
model: sonnet
---

You are a senior code reviewer. When invoked, run `git diff` to see recent changes,
then review modified files for:
- Clarity and naming
- Error handling
- Security (no secrets, input validation)
- Test coverage

Return feedback as: **Critical** / **Warnings** / **Suggestions**.
```

### Read-write specialist

```markdown
---
name: debugger
description: Debugging specialist. Use proactively when encountering errors or test failures.
tools: Read, Edit, Bash, Grep, Glob
---

You are an expert debugger. When invoked:
1. Capture the error and stack trace
2. Identify reproduction steps
3. Isolate the failure location
4. Implement a minimal fix
5. Verify the fix

Explain the root cause and provide prevention recommendations.
```

### Restricted by hook (fine-grained control)

When you need to allow a tool but block specific operations within it, use a `PreToolUse` hook instead of (or alongside) the `tools` field:

```markdown
---
name: db-reader
description: Execute read-only database queries for analysis and reporting.
tools: Bash
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "./scripts/validate-readonly-query.sh"
---

You have read-only database access. Execute SELECT queries to answer analytical questions.
Explain that you cannot INSERT, UPDATE, DELETE, or modify schema.
```

The hook script receives the Bash command via JSON on stdin. Exit 2 to block, exit 0 to allow.

### Agent with persistent memory

```markdown
---
name: code-reviewer
description: Reviews code and remembers patterns it discovers over time.
tools: Read, Grep, Glob, Bash
memory: project
---

You are a code reviewer. Before starting, check your memory for known patterns and
recurring issues in this codebase. After each review, update your memory with any
new patterns, conventions, or recurring problems you find.
```

Memory scopes:
- `user` → `~/.claude/agent-memory/<name>/` (cross-project)
- `project` → `.claude/agent-memory/<name>/` (shareable via git, recommended default)
- `local` → `.claude/agent-memory-local/<name>/` (project-specific, not committed)

### Isolated worktree agent

```markdown
---
name: refactorer
description: Refactors code in an isolated worktree so the main checkout is unaffected.
tools: Read, Edit, MultiEdit, Bash, Grep, Glob
isolation: worktree
---

You are a refactoring specialist. Work in the isolated worktree. Make targeted, focused
improvements and explain each change. The worktree is cleaned up automatically if you
make no changes.
```

## After writing the file

- Run `/agents` in Claude Code to load the new agent immediately (no session restart needed)
- Or restart the session — subagents load at session start
- Test it: `Use the <name> agent to <task>`
- Or @-mention it: `@agent-<name> <task>`
- Check available agents from the CLI: `claude agents`

## Priority / override rules

When multiple agents share the same name, higher-priority location wins:

1. Managed settings (org-wide, highest)
2. `--agents` CLI flag (current session only)
3. `.claude/agents/` (project)
4. `~/.claude/agents/` (user / personal)
5. Plugin's `agents/` directory (lowest)
