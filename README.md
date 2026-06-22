# opencode-agy

Production-ready OpenCode plugin that safely runs the Antigravity CLI (`agy` / Gemini) in headless mode as a sub-agent.

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
- **Safe by design** — every failure (timeout, quota, auth, crash, empty output, not found) is caught and returned as structured text. The main opencode process is never impacted.
- **Thin wrapper** — follows the reference architecture exactly.

## Compatibility

This plugin has been verified to not clash with `oh-my-openagent` (the most common heavy plugin at the time of writing).

- Tool name `agy` does not exist in oh-my-openagent.
- No hooks or commands are registered.
- No shared config keys or namespaces.

You can safely load both plugins together.

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
- `tier` ("flash" | "flash-lo" | "pro", optional) — Default: "flash".
- `dir` (string, optional) — Workspace directory (`--add-dir`).
- `timeout` (string | number, optional) — Pass a duration string like "5m", "10m", "30m", "300s", or raw milliseconds (e.g. `300000`, `900000`, or the string `"900000"`); digit-only inputs are auto-normalized (300000 → "5m"). **Default depends on tier**: `tier: "pro"` defaults to `"15m"` (heavier work); `flash` / `flash-lo` default to `"10m"`. **Hard upper bound: any value above 4h is silently clamped to `"4h"`** — pair with `continue: true` and a higher value on retry if your task really needs more wall-clock time. For git merges, heavy refactors, and large test generation, set this explicitly ("15m"–"30m") and/or pair it with `tier: "pro"`. If the task still exceeds the limit, the plugin returns a `TIMEOUT` error code so the caller can retry with `continue: true` and a higher value.
- `yolo` (boolean, optional) — Auto-approve all permissions inside agy (use with extreme care).
- `sandbox` (boolean, optional) — Run agy with terminal restrictions (`--sandbox`).
- `continue` (boolean, optional) — Resume the most recent agy conversation.
- `conversation` (string, optional) — Resume a specific agy conversation by ID.
- `model` (string, optional) — Exact model name override (future-proof).

### Handling long-running work

A 5-minute default used to be enough, but real engineering tasks aren't. The motivating failure was a git merge that needed more time; default is now `10m` for `flash` / `flash-lo` and `15m` for `pro`, and you should go higher for anything known to be slow.

- For **git merges with conflicts**, **heavy refactors**, and **large test generation**: pass `timeout: "15m"` or `timeout: "30m"`, set `tier: "pro"`. For merges specifically, **do not use `sandbox`** (it blocks the filesystem/shell ops git needs); use a fresh branch (`git checkout -b merge-attempt`) + `yolo: true` instead. The real safety is branch hygiene so you can `git merge --abort` if needed.
- If the task still hits the limit, the plugin returns a structured `AGY_ERROR [TIMEOUT]` with the configured timeout, the observed duration, and a `suggestedNextTimeout` so you can retry without guessing. The calling agent can then retry with `continue: true` (or a specific `conversation: <id>`) and a higher `timeout` — no need to re-prompt from scratch.
- **Hard upper bound: 4h.** Any input that normalizes above `4h` (e.g. `"100h"`, `999999999`) is silently clamped to `"4h"` before being passed to agy. If your task truly needs more than 4h, plan to resume via `continue: true` / `conversation: <id>` after each 4h window — that is the supported long-running pattern, not a single oversized `--print-timeout`.
- Plain numbers work too: `timeout: 1800000` is the same as `timeout: "30m"`. Useful when the timeout is computed.
Example for a slow merge:

```json
{
  "prompt": "merge feature/auth into main, resolve conflicts, run the full test suite",
  "tier": "pro",
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

The plugin now tees agy's log to a temp file and extracts the conversation ID
from it, then surfaces it on the success result and on **every** `AgyError`'s
`details` (TIMEOUT, QUOTA, AUTH, AGY_FAILED, EMPTY, AGY_NOT_FOUND). The
TIMEOUT error also carries `details.suggestedNextTimeout` from the previous
session, so the retry is fully data-driven:

```ts
// Pseudocode for an agent / orchestrator catching a TIMEOUT
try {
  await agy({
    prompt: "merge feature/auth into main, resolve conflicts, run the full test suite",
    tier: "pro",
    timeout: "20m",
    yolo: true,
    dir: "/path/to/your/repo",
  });
} catch (e) {
  if (e.code !== "TIMEOUT") throw e;

  // details is a plain object — read the surfaced conversationId + suggestion
  // and re-call without re-prompting.
  const { conversationId, suggestedNextTimeout } = e.details;

  await agy({
    prompt: "keep going, resolve the remaining conflicts and finish the merge",
    // Either of these works; conversation is the precise resume handle:
    conversation: conversationId,
    continue: true,
    timeout: suggestedNextTimeout ?? "30m",
  });
}
```

If you passed `conversation: "<id>"` on the first call, that same ID comes
back on the error — pass it again on retry, exactly as you received it.

See [Tool arguments](#tool-arguments) above for the full list.
## Slash command

After installing the command file (step 3 in Installation), you can invoke agy directly from the OpenCode TUI prompt:

```
/agy write a full test suite for src/utils/math.ts
/agy --tier pro --sandbox "scaffold the reports module"
/agy --tier pro --timeout 30m "merge feature/auth into main and resolve conflicts"
/agy --continue "finish the previous task and add docs"
```

This is the same experience as `/antigravity:delegate` in the Claude Code reference plugin. The main agent (you) is still responsible for reviewing the result.

## Safety & isolation

- Stdin is always detached (`< /dev/null`).
- All errors are turned into `ToolResult` text + metadata.
- Output is truncated at 100k characters as a hard safety cap.
- Timeouts are handled by agy's own `--print-timeout`, which is user-controllable via the `timeout` argument (see [Tool arguments](#tool-arguments) and [Handling long-running work](#handling-long-running-work) above). For long tasks, set an explicit higher value up front or plan to resume with `continue: true` / `conversation: <id>`.
- The calling agent is expected to verify results.

## Standalone script (for debugging)

```bash
./scripts/agy-delegate.sh --tier flash "your task here"
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
