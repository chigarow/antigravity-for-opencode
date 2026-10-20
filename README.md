<div align="center">

# opencode-agy

**Delegate scoped work to the Antigravity CLI (`agy` / Gemini) from OpenCode, in headless mode**

[![npm version](https://img.shields.io/npm/v/opencode-agy)](https://www.npmjs.com/package/opencode-agy)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![OpenCode](https://img.shields.io/badge/OpenCode-1.x%20%7C%202.x-blue)

[Features](#features) • [Installation](#installation) • [Usage](#usage) • [Model tiers](#model-tiers) • [Safety](#safety--isolation) • [Development](#development)

</div>

A thin, non-intrusive OpenCode plugin that spawns the official `agy` CLI as a safe sub-agent. It provides exactly two surfaces:

- **Tool `agy`** — the main agent calls it to delegate scoped work.
- **Slash command `/agy`** — type `/agy your task` directly in the TUI.

## Features

- 🤖 **One tool, one command** — minimal surface: a single `agy` tool, a single `/agy` slash command, one config hook
- 🧠 **12 model tiers** — Gemini 3.8 Flash, Claude Sonnet 5.5, Claude Opus 5.5, and Gemini 4 Argon, each with low / medium / high reasoning effort
- 🔁 **Resumable** — resume any agy conversation by ID or with `continue`, so long tasks survive timeouts
- 🛡️ **Failures are data** — timeouts, quota, auth errors, and crashes are returned as structured text; the host agent never crashes
- 🔌 **OpenCode 1.x & 2.x** — one default export exposing both the v1 `server` hook and the v2 `setup` hook, plus subprocess cancellation on abort (2.x)

> [!NOTE]
> **Will this get my Antigravity account banned?** No. The plugin spawns the official `agy` CLI in headless mode — the same binary you would run from your terminal, with the same authentication, rate limits, and quota checks enforced by Google's servers. It adds **zero additional calls** beyond what you would make manually.

## Prerequisites

- The **Antigravity CLI** (`agy`): installed, on your `PATH`, and signed in (run `agy` once interactively to authenticate)
- **OpenCode** 1.x or 2.x

## Installation

### OpenCode 2.x

Add the plugin to `"plugins"` in your `opencode.json` (or `.opencode/config.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-agy@latest"]
}
```

### OpenCode 1.x

OpenCode 1.x uses the singular `"plugin"` key in `~/.config/opencode/opencode.json` (or your project's `opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-agy@latest"]
}
```

Restart OpenCode. The `agy` tool and `/agy` slash command are loaded automatically from npm — no manual copy steps.

> [!TIP]
> Upgrading from OpenCode 1.x to 2.x? Rename `"plugin"` to `"plugins"` — the same default export carries both the v1 `server` hook and the v2 `setup` hook, so each host mounts the lifecycle hooks it understands, no code changes needed. If you previously copied `commands/agy.md` into `~/.config/opencode/commands/`, delete it (`rm ~/.config/opencode/commands/agy.md`) to pick up the plugin's bundled slash-command.

### From source (development only)

```bash
git clone https://github.com/chigarow/antigravity-for-opencode.git
cd antigravity-for-opencode
bun install
bun run build:all
```

Then point OpenCode at the build output and restart:

```json
{
  "plugins": ["file:///absolute/path/to/antigravity-for-opencode/dist/index.js"]
}
```

Use `"plugin"` instead of `"plugins"` on OpenCode 1.x.

## Usage

### Tool

The main agent calls the `agy` tool to delegate scoped work:

```json
{
  "prompt": "merge feature/auth into main, resolve conflicts, run the full test suite",
  "tier": "claude-opus-5-5-hi",
  "timeout": "30m",
  "dir": "/path/to/your/repo"
}
```

#### Arguments

| Argument | Type | Description |
| --- | --- | --- |
| `prompt` | `string` | **Required.** The task to send to agy. |
| `tier` | `string` | Model tier, see [Model tiers](#model-tiers). Default: `flash-3.8-med`. |
| `dir` | `string` | Workspace directory exposed to agy (`--add-dir`). |
| `project` | `string` | Project name passed to agy (`--project <value>`), e.g. to scope work to a specific Google Cloud project. |
| `timeout` | `string \| number` | Duration like `30m` or `300s`, or raw milliseconds (`300000` = `5m`). Default `15m` for all tiers, hard cap `4h` (anything above is clamped). `0` / `0s` is valid. |
| `yolo` | `boolean` | Auto-approve permissions inside agy (`--dangerously-skip-permissions`). Since Agy 1.3.2 this no longer auto-approves `/plan` artifacts. Use deliberately, on a reviewed diff or throwaway branch/worktree. |
| `sandbox` | `boolean` | Run agy with terminal restrictions (`--sandbox`). Can block merge or filesystem-heavy work. |
| `continue` | `boolean` | Resume the most recent agy conversation. Mutually exclusive with `conversation`. |
| `conversation` | `string` | Resume a specific agy conversation by ID. Mutually exclusive with `continue`. |
| `model` | `string` | Exact model name override, including non-Gemini backends when the CLI supports them. |

#### Long-running work

For git merges with conflicts, heavy refactors, or large test generation: prefer a reviewed diff, a fresh branch or worktree, and a clear rollback plan. If the task hits the limit, the plugin returns `AGY_ERROR [TIMEOUT]` with the observed duration and a `suggestedNextTimeout`, so the caller can retry with `continue: true` or `conversation: <id>` instead of re-prompting:

```ts
// Pseudocode for an agent catching a TIMEOUT
try {
  await agy({ prompt: "merge feature/auth into main", tier: "claude-opus-5-5-hi", timeout: "20m" });
} catch (e) {
  if (e.code !== "TIMEOUT") throw e;
  const { conversationId, suggestedNextTimeout } = e.details;
  await agy({
    prompt: "keep going, finish the merge",
    conversation: conversationId, // or continue: true for the most recent one
    timeout: suggestedNextTimeout ?? "30m",
  });
}
```

The conversation ID is extracted from agy's log and surfaced on every success result and error `details`. Pass it back exactly as received.

#### Local file analysis

> [!IMPORTANT]
> Analyzing a local file (PDF, PNG, any binary agy's tools can read) in headless mode requires **both** `dir` (pointed at the file's parent directory) **and** `yolo: true`. In `--print` mode agy has no TTY, and its file-reading tools default to an "Ask" permission that can never be answered — so without `yolo: true` the call deadlocks silently or returns empty output. `sandbox: true` stays compatible: it restricts terminal commands only, not file reads.

```json
{
  "prompt": "Read this PDF and extract every line item into a markdown table.",
  "tier": "flash-3.8-lo",
  "dir": "/path/to/the/files/parent/directory",
  "yolo": true,
  "sandbox": true
}
```

### Slash command

Invoke agy directly from the OpenCode TUI:

```
/agy write a full test suite for src/utils/math.ts
/agy --tier claude-sonnet-5-5-hi --sandbox "scaffold the reports module"
/agy --tier claude-opus-5-5-hi --timeout 30m "merge feature/auth into main and resolve conflicts"
/agy --continue "finish the previous task and add docs"
/agy --tier flash-3.8-lo --yolo --dir /path/to/dir "summarize report.pdf"
```

## Model tiers

Twelve tiers across four models. The `hi` / `med` / `lo` suffix selects the model's reasoning effort. All tiers default to a 15-minute timeout (see [`timeout`](#arguments)).

| Tiers | Model | Account |
| --- | --- | --- |
| `flash-3.8-hi` / `flash-3.8-med` / `flash-3.8-lo` | Gemini 3.8 Flash | Pro & Ultra |
| `claude-sonnet-5-5-hi` / `claude-sonnet-5-5-med` / `claude-sonnet-5-5-lo` | Claude Sonnet 5.5 | Pro & Ultra |
| `claude-opus-5-5-hi` / `claude-opus-5-5-med` / `claude-opus-5-5-lo` | Claude Opus 5.5 | Pro & Ultra |
| `argon-4-hi` / `argon-4-med` / `argon-4-lo` | Gemini 4 Argon | **Ultra only** |

> [!NOTE]
> On Pro accounts, `argon-4-*` tiers fail with `MODEL_NOT_FOUND` until Ultra unlocks them. For reference, official Gemini 3.8 Flash limits (documentation facts, not enforced by this plugin): 1,000,000 input/context tokens and 65,536 max output tokens ([model card](https://deepmind.google/models/model-cards/gemini-3-8-flash)).

> [!WARNING]
> `flash-3.5-*`, `flash-3.6-*`, `flash-3.7-*`, and `pro-3.1-*` were removed (Enterprise-only upstream) and have **no aliases** — they return `INVALID_TIER`. Map old names: `flash-3.5-hi/med` → `flash-3.8-hi/med`, and the old default `flash-3.7-med` → `flash-3.8-med`.

## Safety & isolation

- Stdin is always detached, so agy can never wait on interactive input.
- Every failure — timeout, quota, auth, crash, empty output, missing CLI — is returned as `AGY_ERROR [<CODE>]` text plus metadata; the host process stays up.
- Secrets are scrubbed from surfaced errors, and agy's log is teed to a private, owner-only (`0700`) temp directory that is removed on every exit path.
- Output is truncated at 100,000 characters as a hard safety cap.
- Timeouts are handled by agy's own `--print-timeout`, user-controllable via the `timeout` argument.
- The calling agent owns verification: review the diff before trusting delegated changes.

Compatibility is observed empirically against Agy 1.3.5 (check `agy --version`). One caveat: in headless mode agy can expand slash commands when prompt content begins with `/` (or follows a leading newline/tab), so restructure prompts that need literal slash-prefixed content. This plugin intentionally does not expose `--disable-slash-commands`.

## Debugging

A standalone bash wrapper mirrors the plugin (same tiers, same flags) for use outside OpenCode:

```bash
./scripts/agy-delegate.sh --tier flash-3.8-hi "your task here"
echo "task" | ./scripts/agy-delegate.sh -
```

## Development

```bash
bun test           # unit + integration tests
bun run test:smoke # opt-in: drives the installed OpenCode 2.x binary
bun run typecheck
bun run build:all
```

Tests cover argument building and tier mapping, every error path (quota, auth, timeout, not found, empty, truncation), plugin shape (the `agy` tool and `/agy` command register correctly), and real agy integration. `test:smoke` additionally loads the built plugin through the real OpenCode 2.x loader and executes `/agy` through the real command endpoint, using a local stub provider and a throwaway HOME.

## Philosophy

Pragmatic over clever. Minimal surface area. Failures are data, not crashes. The main agent owns verification.

---

Design inspired by [antigravity-for-claude-code](https://github.com/yuting0624/antigravity-for-claude-code).
