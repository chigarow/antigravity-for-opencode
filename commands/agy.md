---
description: Delegate a task to agy (Antigravity / Gemini sub-agent)
---
Delegate this task to the `agy` tool (runs Antigravity/Gemini in headless mode as a sub-agent):

$ARGUMENTS

Guidelines:
- Choose one of the eleven versioned tiers: `flash-3.8-med` (default), `flash-3.8-hi`, `flash-3.8-lo`, `flash-3.7-hi`, `flash-3.7-med`, `flash-3.7-lo`, `flash-3.6-hi`, `flash-3.6-med`, `flash-3.6-lo`, `pro-3.1-hi`, or `pro-3.1-lo`, based on task complexity. Removed names (`flash-3.5`, `flash-3.5-hi`, `flash-3.5-med`, `flash-3.5-lo`, `pro-3.1`, `flash-3.6` unsuffixed, older bare names) have no aliases.
- Use `sandbox: true` only when the task can run without full filesystem or shell access.
- Use `project: "<name>"` to scope the task to a specific Google Cloud project (`--project <value>`).
- Use `yolo: true` only for deliberate, reviewed branch or worktree work, not as the default for merges.
- Use `continue: true` or `conversation: <id>` to resume previous agy work.
- After agy returns, you (the main agent) MUST inspect, verify, and if needed fix or iterate on the result.
- Never assume agy output is perfect — always review diffs, run tests, etc.
- If task content starts with `/` or follows a leading newline/tab, Agy 1.1.13 may expand it as a slash command or skill; restructure the prompt if you need literal slash-prefixed content.

The `agy` tool is provided by the opencode-agy plugin.
