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
- **Zero hooks** — completely non-intrusive and safe to load alongside oh-my-openagent or any other plugin
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

This plugin does not claim perfect compatibility. It is designed to stay small, avoid hooks, and work alongside other plugins, but you should still review changes in a branch or worktree and inspect the diff before trusting a merge or other risky task.

- Tool name `agy` does not exist in oh-my-openagent.
- No hooks or commands are registered.
- No shared config keys or namespaces.

You can usually load both plugins together, but treat that as a practical coexistence note, not a guarantee.

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

That's it. The `agy` tool is now available to the agent.

### Optional: Get the `/agy` slash command

The core `agy` tool works immediately after adding the plugin.

If you also want to type `/agy your task` directly in the TUI (like the Claude Code reference), copy the command definition once:

1. Add `"plugin": ["opencode-agy@latest"]` to your config and restart opencode (this downloads the package).
2. Then run:

   ```bash
   mkdir -p ~/.config/opencode/commands
   cp ~/.cache/opencode/node_modules/opencode-agy/commands/agy.md ~/.config/opencode/commands/agy.md
   ```

3. Restart opencode again.

`/agy` will now appear in the command menu.

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

3. (Optional) Copy `commands/agy.md` as shown above.

4. Restart opencode.

## Tool arguments

- `prompt` (string, required) — The task to send to agy/Gemini.
- `tier` ("flash-3.5" | "flash-3.5-lo" | "pro-3.1" | "flash-3.6", optional) — Default: "flash-3.5". `flash-3.5-lo` is the low-cost option, and `flash-3.6` is the new flash workhorse option.

Tier names changed in this breaking release. The old names are unsupported and have no aliases.

| Old name | New tier | Display name |
| --- | --- | --- |
| `flash` | `flash-3.5` | Gemini 3.5 Flash (High) |
| `flash-lo` | `flash-3.5-lo` | Gemini 3.5 Flash (Low) |
| `pro` | `pro-3.1` | Gemini 3.1 Pro (High) |
| NEW | `flash-3.6` | Gemini 3.6 Flash (High) |
- `dir` (string, optional) — Workspace directory (`--add-dir`).
- `project` (string, optional) — Project name passed to agy (`--project <value>`). Useful for scoping agy's work to a specific Google Cloud project.
- `timeout` (string | number, optional) — Pass a duration like "5m", "10m", "30m", or "300s", or pass raw milliseconds such as `300000`. Digit-only values are normalized, so `300000` becomes about `5m`. Default depends on tier. `pro-3.1` defaults to `15m`; `flash-3.5`, `flash-3.5-lo`, and `flash-3.6` default to `10m`. Anything above `4h` is silently clamped to `4h`, and `0` or `0s` is accepted as a valid zero timeout. For longer work, prefer explicit retries with `continue: true` or `conversation: <id>` rather than one huge timeout.
- `yolo` (boolean, optional) — Auto-approve all permissions inside agy. Only use with a reviewed diff, a throwaway branch or worktree, and `sandbox: true` when the task does not need direct filesystem or shell access.
- `sandbox` (boolean, optional) — Run agy with terminal restrictions (`--sandbox`). Helpful for safer execution, but it can block merge or filesystem heavy work.
- `continue` (boolean, optional) — Resume the most recent agy conversation. Mutually exclusive with `conversation`.
- `conversation` (string, optional) — Resume a specific agy conversation by ID. Mutually exclusive with `continue`.
- `model` (string, optional) — Exact model name override, including non-Gemini backends when the upstream CLI supports them.

### Handling long-running work

A 5-minute default used to be enough, but real engineering tasks aren't. The current defaults are `10m` for `flash-3.5`, `flash-3.5-lo`, and `flash-3.6`, and `15m` for `pro-3.1`. The timeout parser also accepts `0`, `0s`, raw milliseconds, and duration strings, and anything above `4h` is clamped to `4h`.

- For **git merges with conflicts**, **heavy refactors**, and **large test generation**: prefer a reviewed diff, a fresh branch or worktree, and a clear rollback plan. Use `sandbox: true` only when the task does not need full shell or filesystem access. If you need to auto-approve permissions, `yolo: true` is a deliberate escalation, not a default. 
- If the task still hits the limit, the plugin returns a structured `AGY_ERROR [TIMEOUT]` with the configured timeout, the observed duration, and a `suggestedNextTimeout` so you can retry without guessing. The calling agent can then retry with `continue: true` or `conversation: <id>` and a higher `timeout`.
- **Hard upper bound: 4h.** Any input that normalizes above `4h` is silently clamped to `4h` before being passed to agy.
- The plugin also emits `AGY_NOT_FOUND` when the CLI is missing and `INVALID_TIMEOUT` when timeout parsing fails. Secrets are scrubbed from surfaced errors, and the wrapper writes its private temp log under a locked temp directory so conversation recovery can work without leaving a shared log behind.
- Plain numbers work too: `timeout: 1800000` is the same as `timeout: "30m"`. Useful when the timeout is computed.
Example for a slow merge:

```json
{
  "prompt": "merge feature/auth into main, resolve conflicts, run the full test suite",
  "tier": "pro-3.1",
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
    tier: "pro-3.1",
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
## Slash command

After installing the command file, you can invoke agy directly from the OpenCode TUI prompt:

```
/agy write a full test suite for src/utils/math.ts
/agy --tier pro-3.1 --sandbox "scaffold the reports module"
/agy --tier pro-3.1 --timeout 30m "merge feature/auth into main and resolve conflicts"
/agy --continue "finish the previous task and add docs"
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
./scripts/agy-delegate.sh --tier flash-3.5 "your task here"
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
- Plugin shape verification (only the `agy` tool is registered)
- Real agy integration (gracefully handles slow environments)

## Philosophy

- Pragmatic over clever.
- Minimal surface area.
- Failures are data, not crashes.
- The main agent owns verification.

## License

MIT © 2026 chigarow
