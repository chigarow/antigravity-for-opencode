---
description: Delegate a task to agy (Antigravity / Gemini sub-agent)
---
Delegate this task to the `agy` tool (runs Antigravity/Gemini in headless mode as a sub-agent):

$ARGUMENTS

Guidelines:
- Choose one of the twelve versioned tiers, based on task complexity: `flash-3.8-med` (default), `flash-3.8-hi`, `flash-3.8-lo`, `claude-sonnet-5-5-hi`, `claude-sonnet-5-5-med`, `claude-sonnet-5-5-lo`, `claude-opus-5-5-hi`, `claude-opus-5-5-med`, `claude-opus-5-5-lo`, `argon-4-hi`, `argon-4-med`, `argon-4-lo`.
- Account availability: `flash-3.8-*` and `claude-*-5-5-*` tiers work on Pro and Ultra accounts. `argon-4-*` needs a paid Pro or Ultra plan on agy 1.4.2+; Pro trial, student, and partner-bundled plans still return `MODEL_NOT_FOUND`. Run `agy models` to list what the signed-in account may use.
- Dropped tiers (`flash-3.6-*`, `flash-3.7-*`, `pro-3.1-*`, and older names like `flash-3.5*`) have no aliases and return `INVALID_TIER`.
- `dir` must resolve inside the workspace root (default: the current project). Pointing it outside returns `DIR_NOT_ALLOWED`; pick a directory you genuinely need instead.
- Use `sandbox: true` for tasks that can run without full filesystem or shell access.
- `yolo: true` requires `sandbox: true` and host consent; without both it returns `YOLO_NOT_APPROVED`. Use it only for deliberate, reviewed branch or worktree work, not as the default for merges.
- Use `project: "<name>"` to scope the task to a specific Google Cloud project (`--project <value>`).
- Use `continue: true` or `conversation: <id>` to resume previous agy work.
- After agy returns, you (the main agent) MUST inspect, verify, and if needed fix or iterate on the result.
- Never assume agy output is perfect — always review diffs, run tests, etc.
- If task content starts with `/` or follows a leading newline/tab, Agy 1.3.5 may expand it as a slash command or skill; restructure the prompt if you need literal slash-prefixed content.

The `agy` tool is provided by the opencode-agy plugin.
