# opencode-agy

OpenCode plugin for delegating scoped work to the Antigravity CLI (`agy` / Gemini) in headless mode.
The wording in this README is intentionally qualified, because the plugin is a thin wrapper around an external CLI and its behavior still depends on the local environment, upstream agy, and the host agent's review.

**https://github.com/chigarow/antigravity-for-opencode**

**Strictly follows the simplicity and non-intrusive design of https://github.com/yuting0624/antigravity-for-claude-code**

This plugin lets you run the Antigravity CLI (`agy` / Gemini) as a safe sub-agent from inside OpenCode.

It provides two surfaces, modeled after the Claude Code reference:

- **Tool `agy`** — the main agent can call this to delegate scoped work.
- **Slash command `/agy`** — type `/agy your task here` directly in the TUI (shows up in the command menu).

## Key properties

- **One tool**: `agy` (the agent calls this to delegate)
- **One slash command**: `/agy` (appears in the TUI command palette — type `/agy` to use it)
- **One config hook** — registers `/agy` automatically; no event or execution hooks
- **Safety boundary** — failures such as timeout, quota, auth, crash, empty output, and not found are captured and returned as text. The main OpenCode process stays up, but the result still needs human or agent review.
- **Thin wrapper** — follows the reference architecture exactly.

## Will this get my Antigravity account banned?

> **Short answer: No.**
>
> This plugin does not reverse-engineer, scrape, or bypass any Antigravity / Google API. It simply spawns the official `agy` CLI in headless mode — the exact same binary you would run from your terminal, with the exact same authentication and rate-limiting enforced by Google's servers.
>
> Every request goes through agy's standard authentication flow. Every quota check, rate limit, and abuse-detection mechanism on Google's side still applies identically. The plugin adds **zero additional calls** beyond what you would make manually.
>
> Think of it as a convenience wrapper: instead of typing `agy -p "your task"` in a separate terminal, OpenCode does it for you. Nothing more.


## Compatibility

This plugin does not claim perfect compatibility. It is designed to stay small, with minimal hook surface, and work alongside other plugins, but you should still review changes in a branch or worktree and inspect the diff before trusting a merge or other risky task.

### OpenCode host engine compatibility (1.x and 2.x)

`opencode-agy` supports both **OpenCode 2.x** and **OpenCode 1.x** using a universal dual-export plugin architecture:

- **OpenCode 2.x**: Fully supported via the 2.x plugin lifecycle. Exposes `setup(ctx)` / `AgyPlugin.setup` with `ctx.tool.transform` and `ctx.command.transform`. Seamlessly supports process cancellation via `AbortSignal` forwarded from `context.signal`.
- **OpenCode 1.x**: Fully backwards-compatible via the 1.x server hook (`AgyPlugin(ctx)` and `server(ctx)` returning `{ tool, config }`).
- **Coexistence**: Tool name `agy` does not conflict with oh-my-openagent. No shared config keys or namespaces.

### Agy 1.3.5 compatibility

Observed compatibility is empirical against local Agy 1.3.5 (`agy --version`). The twelve tier display-name values and wrapper-emitted flags are accepted where the signed-in account exposes the model; `argon-4-*` is Ultra-only today, so its display names follow the same `<Base> (<Effort>)` pattern but are unverified against a local Ultra account. The following qualified caveats apply:

- In print/headless mode, Agy 1.3.5 can expand slash commands and skills when prompt content begins with `/`.
- Agy 1.3.5 also recognizes slash commands after a leading newline or tab.
- Callers needing literal slash-prefixed content at those recognition positions should restructure the prompt; this plugin intentionally does not expose `--disable-slash-commands` yet.
- Since Agy 1.3.2, `--dangerously-skip-permissions` (the plugin's `yolo: true`) no longer auto-approves `/plan` artifacts; plan artifacts still require explicit review.
- Since Agy 1.3.0, the default verbosity is `medium` (previously `high`).
- Since Agy 1.2.10, headless model errors exit with code 3 and print an `AGY_ERROR` JSON line; the plugin classifies this as `MODEL_NOT_FOUND` with the upstream text. On a Pro account, `argon-4-*` tiers report `MODEL_NOT_FOUND` until Ultra unlocks them.
- Agy 1.3.5's default system-temp write grant is a qualified upstream reliability improvement for headless temp-log writes, not a universal guarantee.
- Observed compatibility is empirical; users should check their local `agy --version`.

## Installation

### The easy way (npm)

#### OpenCode 2.x

Add `opencode-agy` to `"plugins"` in your `opencode.json` (or `.opencode/config.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-agy@latest"]
}
```

#### OpenCode 1.x (Backwards Compatibility)

In OpenCode 1.x, plugins are configured using the singular `"plugin"` array in `~/.config/opencode/opencode.json` (or your project's `opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-agy@latest"]
}
```

Restart OpenCode. It will automatically download and load the plugin from npm (cached in your OpenCode cache directory).

Both the `agy` tool and `/agy` slash command are now available. No manual copy steps needed.

### Upgrading to OpenCode 2.x

When upgrading from OpenCode 1.x to OpenCode 2.x:

1. **Update config key**: In your configuration (`opencode.json` or `.opencode/config.json`), change `"plugin"` (singular) to `"plugins"` (plural):
   ```json
   {
     "plugins": ["opencode-agy@latest"]
   }
   ```
2. **Automatic runtime detection**: The plugin detects whether it is running under OpenCode 1.x or 2.x and mounts the appropriate lifecycle hooks (`setup` vs `server`). No code changes or special flags are required.
3. **Subprocess cancellation**: In OpenCode 2.x, cancelling a turn or aborting an agent run automatically signals and terminates running `agy` child processes.

### Migrating from a manually copied `/agy` command

If you previously copied `commands/agy.md` to `~/.config/opencode/commands/`, your already-loaded command file remains authoritative at this plugin's config-hook boundary. This means:

- The plugin's `config` hook sees your loaded command and preserves it (it is schema-valid).
- You may keep it as-is; it will continue to work.

If you want the plugin-default template to take effect (for example, to pick up updated guidelines shipped in future plugin releases), delete the copied file and restart opencode:

```bash
rm ~/.config/opencode/commands/agy.md
```

The plugin's config hook will then register its bundled default on the next load. This plugin does not automatically delete copied files or claim precedence over later-loaded plugins.

### From source (development only)

1. Clone and build:

   ```bash
   git clone https://github.com/chigarow/antigravity-for-opencode.git
   cd antigravity-for-opencode
   bun install
   bun run build:all
   ```

2. Add the local path instead:

   **OpenCode 2.x**:
   ```json
   "plugins": ["file:///absolute/path/to/antigravity-for-opencode/dist/index.js"]
   ```

   **OpenCode 1.x**:
   ```json
   "plugin": ["file:///absolute/path/to/antigravity-for-opencode/dist/index.js"]
   ```

3. Restart opencode.



## Tool arguments

- `prompt` (string, required) — The task to send to agy/Gemini.
- `tier` ("flash-3.8-hi" | "flash-3.8-lo" | "flash-3.8-med" | "claude-sonnet-5-5-hi" | "claude-sonnet-5-5-med" | "claude-sonnet-5-5-lo" | "claude-opus-5-5-hi" | "claude-opus-5-5-med" | "claude-opus-5-5-lo" | "argon-4-hi" | "argon-4-med" | "argon-4-lo", optional) — Default: "flash-3.8-med". See [Available model tiers](#available-model-tiers) for details.

- `dir` (string, optional) — Workspace directory (`--add-dir`).
- `project` (string, optional) — Project name passed to agy (`--project <value>`). Useful for scoping agy's work to a specific Google Cloud project.
- `timeout` (string | number, optional) — Pass a duration like "5m", "10m", "30m", or "300s", or pass raw milliseconds such as `300000`. Digit-only values are normalized, so `300000` becomes about `5m`. Defaults to `15m` for all tiers. Anything above `4h` is silently clamped to `4h`, and `0` or `0s` is accepted as a valid zero timeout. For longer work, prefer explicit retries with `continue: true` or `conversation: <id>` rather than one huge timeout.
- `yolo` (boolean, optional) — Auto-approve permissions inside agy. Since Agy 1.3.2 this no longer auto-approves `/plan` artifacts. Only use with a reviewed diff, a throwaway branch or worktree, and `sandbox: true` when the task does not need direct filesystem or shell access.
- `sandbox` (boolean, optional) — Run agy with terminal restrictions (`--sandbox`). Helpful for safer execution, but it can block merge or filesystem heavy work.
- `continue` (boolean, optional) — Resume the most recent agy conversation. Mutually exclusive with `conversation`.
- `conversation` (string, optional) — Resume a specific agy conversation by ID. Mutually exclusive with `continue`.
- `model` (string, optional) — Exact model name override, including non-Gemini backends when the upstream CLI supports them.

### Handling long-running work

A 5-minute default used to be enough, but real engineering tasks aren't. All twelve tiers currently default to `15m`. The timeout parser also accepts `0`, `0s`, raw milliseconds, and duration strings, and anything above `4h` is clamped to `4h`.

- For **git merges with conflicts**, **heavy refactors**, and **large test generation**: prefer a reviewed diff, a fresh branch or worktree, and a clear rollback plan. Use `sandbox: true` only when the task does not need full shell or filesystem access. If you need to auto-approve permissions, `yolo: true` is a deliberate escalation, not a default. 
- If the task still hits the limit, the plugin returns a structured `AGY_ERROR [TIMEOUT]` with the configured timeout, the observed duration, and a `suggestedNextTimeout` so you can retry without guessing. The calling agent can then retry with `continue: true` or `conversation: <id>` and a higher `timeout`.
- **Hard upper bound: 4h.** Any input that normalizes above `4h` is silently clamped to `4h` before being passed to agy.
- The plugin also emits `AGY_NOT_FOUND` when the CLI is missing and `INVALID_TIMEOUT` when timeout parsing fails. Secrets are scrubbed from surfaced errors, and the wrapper writes its private temp log to a fresh owner-only `0700` directory per invocation under `os.tmpdir()`, removing the entire directory on every exit path so conversation recovery works without leaving a shared log behind.
- Plain numbers work too: `timeout: 1800000` is the same as `timeout: "30m"`. Useful when the timeout is computed.
Example for a slow merge:

```json
{
  "prompt": "merge feature/auth into main, resolve conflicts, run the full test suite",
  "tier": "claude-opus-5-5-hi",
  "timeout": "30m",
  "yolo": true,
  "dir": "/path/to/your/repo"
}
```

Example for resuming after a timeout (slash-command form):

```
/agy --continue --timeout 30m "keep going, focus on the remaining conflicts"
```

Example for resuming after a timeout (programmatic form, using the returned `conversationId`):

The plugin tees agy's log to a private temp file, extracts the conversation ID from it, and surfaces it on the success result and on every `AgyError`'s `details`. The retry path should treat the returned payload as plain text plus metadata, not as a JSON envelope. On upstream builds, empty output and non-TTY behavior can still happen, so the caller should verify the result, inspect the diff, and decide whether to resume or stop.

```ts
// Pseudocode for an agent / orchestrator catching a TIMEOUT
try {
  await agy({
    prompt: "merge feature/auth into main, resolve conflicts, run the full test suite",
    tier: "claude-opus-5-5-hi",
    timeout: "20m",
    yolo: true,
    dir: "/path/to/your/repo",
  });
} catch (e) {
  if (e.code !== "TIMEOUT") throw e;

  // details is a plain object, read the surfaced conversationId + suggestion
  // and re-call without re-prompting.
  const { conversationId, suggestedNextTimeout } = e.details;

  await agy({
    prompt: "keep going, resolve the remaining conflicts and finish the merge",
    // Resume a specific conversation (preferred):
    conversation: conversationId,
    // ...or use --continue to resume the most recent one.
    timeout: suggestedNextTimeout ?? "30m",
  });
}
```

If you passed `conversation: "<id>"` on the first call, that same ID comes back on the error, so pass it again on retry exactly as received.

See [Tool arguments](#tool-arguments) above for the full list.

## Available model tiers

### Gemini 3.8 Flash

| Tier | Display name | Default timeout |
| --- | --- | --- |
| `flash-3.8-lo` | Gemini 3.8 Flash (Low) | 15m |
| `flash-3.8-med` | Gemini 3.8 Flash (Medium) — default | 15m |
| `flash-3.8-hi` | Gemini 3.8 Flash (High) | 15m |

Official model limits (documentation facts only, not enforced by this plugin): 1,000,000 input/context tokens and 65,536 max output tokens per https://deepmind.google/models/model-cards/gemini-3-8-flash

### Claude Sonnet 5.5

| Tier | Display name | Default timeout |
| --- | --- | --- |
| `claude-sonnet-5-5-lo` | Claude Sonnet 5.5 (Low) | 15m |
| `claude-sonnet-5-5-med` | Claude Sonnet 5.5 (Medium) | 15m |
| `claude-sonnet-5-5-hi` | Claude Sonnet 5.5 (High) | 15m |

### Claude Opus 5.5

| Tier | Display name | Default timeout |
| --- | --- | --- |
| `claude-opus-5-5-lo` | Claude Opus 5.5 (Low) | 15m |
| `claude-opus-5-5-med` | Claude Opus 5.5 (Medium) | 15m |
| `claude-opus-5-5-hi` | Claude Opus 5.5 (High) | 15m |

### Gemini 4 Argon

| Tier | Display name | Default timeout |
| --- | --- | --- |
| `argon-4-lo` | Gemini 4 Argon (Low) | 15m |
| `argon-4-med` | Gemini 4 Argon (Medium) | 15m |
| `argon-4-hi` | Gemini 4 Argon (High) | 15m |

Availability: `flash-3.8-*` and `claude-*-5-5-*` tiers work on both Pro and Ultra accounts. `argon-4-*` is Ultra-only today (Pro may unlock it later); on a Pro account these tiers fail with `MODEL_NOT_FOUND`.

### Dropped tiers

`flash-3.6-*`, `flash-3.7-*`, and `pro-3.1-*` were dropped in favor of the twelve tiers above (Enterprise-only upstream). They have no aliases and return `INVALID_TIER`.

### Migrating from v0.9.x

Gemini 3.5 Flash was removed upstream. Map old tier names as follows (no aliases — removed names return `INVALID_TIER`):

| Removed (v0.9.x) | Replacement (v0.10.0) |
| --- | --- |
| `flash-3.5-hi` | `flash-3.8-hi` |
| `flash-3.5-med` | `flash-3.8-med` |
| `flash-3.5-lo` | `flash-3.8-lo` (or any other tier) |
| (default) `flash-3.7-med` | (default) `flash-3.8-med` |

## Local file analysis

To analyze a local file (PDF, PNG, image, or any binary agy's MCP tools can read), set **both** `dir` (to the file's parent directory) and `yolo: true`:

```json
{
  "prompt": "Read this PDF and extract every line item into a markdown table.",
  "tier": "flash-3.8-lo",
  "dir": "/path/to/the/files/parent/directory",
  "yolo": true,
  "sandbox": true
}
```

Why this is required:

- In headless (`--print`) mode, agy has no TTY. Its file-reading tools (pdf-reader, read_file) default to **"Ask"** permission, which deadlocks silently — agy waits for an approval that never comes, and the call eventually returns empty output.
- `yolo: true` passes `--dangerously-skip-permissions`, auto-approving every tool call inside agy so file reads proceed without a prompt.
- `dir` scopes the workspace agy can see (`--add-dir`). Point it at the file's parent directory so agy's tools can reach the file.
- `sandbox: true` is **compatible** with file analysis — it restricts only terminal commands, not file reads. You can combine both for safer runs.

Without `yolo: true`, local file analysis in headless mode will hang or return empty. The main agent still owns verification of whatever agy extracts.
## Slash command

After setup, you can invoke agy directly from the OpenCode TUI prompt:

```
/agy write a full test suite for src/utils/math.ts
/agy --tier claude-sonnet-5-5-hi --sandbox "scaffold the reports module"
/agy --tier claude-opus-5-5-hi --timeout 30m "merge feature/auth into main and resolve conflicts"
/agy --continue "finish the previous task and add docs"
/agy --tier flash-3.8-lo --yolo --dir /path/to/dir "summarize report.pdf"
```

Use `sandbox: true` for safer isolation when the task does not need full shell access. Use `yolo: true` only for deliberate, reviewed branch or worktree work. The main agent still owns verification, diff review, and any follow-up fixes.

## Safety & isolation

- Stdin is always detached (`< /dev/null`).
- All errors are turned into `ToolResult` text + metadata.
- Output is truncated at 100k characters as a hard safety cap.
- Timeouts are handled by agy's own `--print-timeout`, which is user-controllable via the `timeout` argument. For long tasks, set an explicit higher value up front or plan to resume with `continue: true` or `conversation: <id>`.
- The calling agent is expected to verify results.

## Standalone script (for debugging)

```bash
./scripts/agy-delegate.sh --tier flash-3.8-hi "your task here"
echo "task" | ./scripts/agy-delegate.sh -
```

## Development & testing

```bash
bun test                 # all tests
bun run typecheck
bun run build
```

Tests include:
- Full argument building and tier mapping
- Success and all error paths (quota, auth, timeout, not found, empty, truncation)
- Plugin shape verification (the `agy` tool and `/agy` command are registered)
- Real agy integration (gracefully handles slow environments)

## Philosophy

- Pragmatic over clever.
- Minimal surface area.
- Failures are data, not crashes.
- The main agent owns verification.

## License

MIT © 2026 chigarow
