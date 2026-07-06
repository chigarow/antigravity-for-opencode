---
description: Delegate a task to agy (Antigravity / Gemini sub-agent)
---
Delegate this task to the `agy` tool (runs Antigravity/Gemini in headless mode as a sub-agent):

$ARGUMENTS

Guidelines:
- Choose tier (flash = fast/cheap default, flash-lo = low-cost, pro = stronger) based on task complexity.
- Use `sandbox: true` only when the task can run without full filesystem or shell access.
- Use `project: "<name>"` to scope the task to a specific Google Cloud project (`--project <value>`).
- Use `yolo: true` only for deliberate, reviewed branch or worktree work, not as the default for merges.
- Use `continue: true` or `conversation: <id>` to resume previous agy work.
- After agy returns, you (the main agent) MUST inspect, verify, and if needed fix or iterate on the result.
- Never assume agy output is perfect — always review diffs, run tests, etc.

The `agy` tool is provided by the opencode-agy plugin.
