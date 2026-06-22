# opencode-agy

Production-ready OpenCode plugin that safely runs the Antigravity CLI (`agy` / Gemini) in headless mode as a sub-agent.

**https://github.com/chigarow/antigravity-for-opencode**

**Strictly follows the simplicity and non-intrusive design of https://github.com/yuting0624/antigravity-for-claude-code**

## What it does

Exposes a single tool named `agy` that the agent can call to delegate work to Gemini via the `agy` CLI in `--print` (headless) mode.

The main agent stays in control and is responsible for verification. This plugin only does safe delegation.

## Key properties

- **One tool only**: `agy`
- **Zero hooks, zero commands** — completely non-intrusive
- **Safe by design** — every failure (timeout, quota, auth, crash, empty output, not found) is caught and returned as structured text. The main opencode process is never impacted.
- **Thin wrapper** — follows the reference architecture exactly.

## Compatibility

This plugin has been verified to not clash with `oh-my-openagent` (the most common heavy plugin at the time of writing).

- Tool name `agy` does not exist in oh-my-openagent.
- No hooks or commands are registered.
- No shared config keys or namespaces.

You can safely load both plugins together.

## Installation

1. Build:
   ```bash
   bun install
   bun run build
   ```

2. Add to your `~/.config/opencode/opencode.json` (or project `opencode.json`):

   ```json
   {
     "plugin": [
       "file:///absolute/path/to/antigravity-for-opencode/dist/index.js"
     ]
   }
   ```

3. Restart opencode.

The `agy` tool will now be available to the agent.

## Tool arguments

- `prompt` (string, required) — The task to send to agy/Gemini.
- `tier` ("flash" | "flash-lo" | "pro", optional) — Default: "flash".
- `dir` (string, optional) — Workspace directory (`--add-dir`).
- `timeout` (string, optional) — e.g. "5m", "10m", "300s". Default: "5m".
- `yolo` (boolean, optional) — Auto-approve all permissions inside agy (use with extreme care).
- `sandbox` (boolean, optional) — Run agy with terminal restrictions (`--sandbox`).
- `continue` (boolean, optional) — Resume the most recent agy conversation.
- `conversation` (string, optional) — Resume a specific agy conversation by ID.
- `model` (string, optional) — Exact model name override (future-proof).

## Safety & isolation

- Stdin is always detached (`< /dev/null`).
- All errors are turned into `ToolResult` text + metadata.
- Output is truncated at 100k characters as a hard safety cap.
- Timeouts are handled by agy's own `--print-timeout`.
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
