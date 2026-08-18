

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

- Tool name `agy` does not exist in oh-my-openagent.
- One config hook registers the `/agy` command; no event or execution hooks are used.
- No shared config keys or namespaces.

You can usually load both plugins together, but treat that as a practical coexistence note, not a guarantee.

### Agy 1.1.13 compatibility

Observed compatibility is empirical against local Agy 1.1.13 (`agy --version`). All eleven exact display-name model values and wrapper-emitted flags were accepted. The following qualified caveats apply:

- In print/headless mode, Agy 1.1.13 can expand slash commands and skills when prompt content begins with `/`.
- Agy 1.1.13 also recognizes slash commands after a leading newline or tab.
- Callers needing literal slash-prefixed content at those recognition positions should restructure the prompt; this plugin intentionally does not expose `--disable-slash-commands` yet.
- Agy 1.1.13's default system-temp write grant is a qualified upstream reliability improvement for headless temp-log writes, not a universal guarantee.
- Observed compatibility is empirical; users should check their local `agy --version`.

## Installation

### The easy way (npm)

Just add this to your `~/.config/opencode/opencode.json` (or your project's `opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-agy"]
}
```

This will install the latest version available at the time opencode first loads the plugin.

**Recommended:** To always pull the newest version (including patch releases), use `@latest`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-agy@latest"]
}
```

Restart opencode. It will automatically download and load the plugin from npm (cached in `~/.cache/opencode/node_modules/`).

Both the `agy` tool and `/agy` slash command are now available. No manual copy steps needed.

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
   bun run build
   ```

2. Add the local path instead:

   ```json
   "plugin": ["file:///absolute/path/to/antigravity-for-opencode/dist/index.js"]
   ```

3. Restart opencode.


## Tool arguments

- `prompt` (string, required) — The task to send to agy/Gemini.
- `tier` ("flash-3.5-hi" | "flash-3.5-lo" | "flash-3.5-med" | "pro-3.1-hi" | "pro-3.1-lo" | "flash-3.6-hi" | "flash-3.6-med" | "flash-3.6-lo" | "flash-3.7-hi" | "flash-3.7-med" | "flash-3.7-lo", optional) — Default: "flash-3.7-med". See [Available model tiers](#available-model-tiers) for details.

- `dir` (string, optional) — Workspace directory (`--add-dir`).
- `project` (string, optional) — Project name passed to agy (`--project <value>`). Useful for scoping agy's work to a specific Google Cloud project.
- `timeout` (string | number, optional) — Pass a duration like "5m", "10m", "30m", or "300s", or pass raw milliseconds such as `300000`. Digit-only values are normalized, so `300000` becomes about `5m`. Default depends on tier. `pro-3.1-hi` and `pro-3.1-lo` default to `15m`; `flash-3.5-hi`, `flash-3.5-lo`, `flash-3.5-med`, `flash-3.6-hi`, `flash-3.6-med`, `flash-3.6-lo`, `flash-3.7-hi`, `flash-3.7-med`, and `flash-3.7-lo` default to `10m`. Anything above `4h` is silently clamped to `4h`, and `0` or `0s` is accepted as a valid zero timeout. For longer work, prefer explicit retries with `continue: true` or `conversation: <id>` rather than one huge timeout.
- `yolo` (boolean, optional) — Auto-approve all permissions inside agy. Only use with a reviewed diff, a throwaway branch or worktree, and `sandbox: true` when the task does not need direct filesystem or shell access.
- `sandbox` (boolean, optional) — Run agy with terminal restrictions (`--sandbox`). Helpful for safer execution, but it can block merge or filesystem heavy work.
- `continue` (boolean, optional) — Resume the most recent agy conversation. Mutually exclusive with `conversation`.
- `conversation` (string, optional) — Resume a specific agy conversation by ID. Mutually exclusive with `continue`.
- `model` (string, optional) — Exact model name override, including non-Gemini backends when the upstream CLI supports them.

### Handling long-running work

A 5-minute default used to be enough, but real engineering tasks aren't. The current defaults are `10m` for `flash-3.5-hi`, `flash-3.5-lo`, `flash-3.5-med`, `flash-3.6-hi`, `flash-3.6-med`, `flash-3.6-lo`, `flash-3.7-hi`, `flash-3.7-med`, and `flash-3.7-lo`, and `15m` for `pro-3.1-hi` and `pro-3.1-lo`. The timeout parser also accepts `0`, `0s`, raw milliseconds, and duration strings, and anything above `4h` is clamped to `4h`.

- For **git merges with conflicts**, **heavy refactors**, and **large test generation**: prefer a reviewed diff, a fresh branch or worktree, and a clear rollback plan. Use `sandbox: true` only when the task does not need full shell or filesystem access. If you need to auto-approve permissions, `yolo: true` is a deliberate escalation, not a default. 
- If the task still hits the limit, the plugin returns a structured `AGY_ERROR [TIMEOUT]` with the configured timeout, the observed duration, and a `suggestedNextTimeout` so you can retry without guessing. The calling agent can then retry with `continue: true` or `conversation: <id>` and a higher `timeout`.
- **Hard upper bound: 4h.** Any input that normalizes above `4h` is silently clamped to `4h` before being passed to agy.
- The plugin also emits `AGY_NOT_FOUND` when the CLI is missing and `INVALID_TIMEOUT` when timeout parsing fails. Secrets are scrubbed from surfaced errors, and the wrapper writes its private temp log to a fresh owner-only `0700` directory per invocation under `os.tmpdir()`, removing the entire directory on every exit path so conversation recovery works without leaving a shared log behind.
- Plain numbers work too: `timeout: 1800000` is the same as `timeout: "30m"`. Useful when the timeout is computed.
Example for a slow merge:

```json
{
  "prompt": "merge feature/auth into main, resolve conflicts, run the full test suite",
  "tier": "pro-3.1-hi",
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
    tier: "pro-3.1-hi",
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

### Gemini 3.5 Flash

| Tier | Display name | Default timeout |
| --- | --- | --- |
| `flash-3.5-lo` | Gemini 3.5 Flash (Low) | 10m |
| `flash-3.5-med` | Gemini 3.5 Flash (Medium) | 10m |
| `flash-3.5-hi` | Gemini 3.5 Flash (High) | 10m |

### Gemini 3.6 Flash

| Tier | Display name | Default timeout |
| --- | --- | --- |
| `flash-3.6-lo` | Gemini 3.6 Flash (Low) | 10m |
| `flash-3.6-med` | Gemini 3.6 Flash (Medium) | 10m |
| `flash-3.6-hi` | Gemini 3.6 Flash (High) | 10m |

### Gemini 3.7 Flash

| Tier | Display name | Default timeout |
| --- | --- | --- |
| `flash-3.7-lo` | Gemini 3.7 Flash (Low) | 10m |
| `flash-3.7-med` | Gemini 3.7 Flash (Medium) — default | 10m |
| `flash-3.7-hi` | Gemini 3.7 Flash (High) | 10m |

Official model limits (documentation facts only, not enforced by this plugin): 1,048,576 input/context tokens and 65,536 max output tokens per https://deepmind.google/models/model-cards/gemini-3-7-flash

### Gemini 3.1 Pro

| Tier | Display name | Default timeout |
| --- | --- | --- |
| `pro-3.1-lo` | Gemini 3.1 Pro (Low) | 15m |
| `pro-3.1-hi` | Gemini 3.1 Pro (High) | 15m |

## Local file analysis

To analyze a local file (PDF, PNG, image, or any binary agy's MCP tools can read), set **both** `dir` (to the file's parent directory) and `yolo: true`:

```json
{
  "prompt": "Read this PDF and extract every line item into a markdown table.",
  "tier": "flash-3.6-lo",
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
/agy --tier pro-3.1-hi --sandbox "scaffold the reports module"
/agy --tier pro-3.1-hi --timeout 30m "merge feature/auth into main and resolve conflicts"
/agy --continue "finish the previous task and add docs"
/agy --tier flash-3.6-lo --yolo --dir /path/to/dir "summarize report.pdf"
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
./scripts/agy-delegate.sh --tier flash-3.5-hi "your task here"
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
- Real agy integration (gracefully handles slow environments; skipped unless `agy` is on PATH and `AGY_INTEGRATION=1` is set)

## Philosophy

- Pragmatic over clever.
- Minimal surface area.
- Failures are data, not crashes.
- The main agent owns verification.

## License

MIT © 2026 chigarow
