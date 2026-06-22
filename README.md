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

3. Install the `/agy` slash command (so it appears in the TUI command menu, just like the Claude Code reference):

   ```bash
   # Global (recommended — available in every project)
   mkdir -p ~/.config/opencode/commands
   cp commands/agy.md ~/.config/opencode/commands/agy.md

   # Or per-project only
   mkdir -p .opencode/commands
   cp commands/agy.md .opencode/commands/agy.md
   ```

4. Restart opencode.

   Both the `agy` tool (callable by the agent) and the `/agy` slash command (type it in the prompt) will be available.

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

## Slash command

After installing the command file (step 3 in Installation), you can invoke agy directly from the OpenCode TUI prompt:

```
/agy write a full test suite for src/utils/math.ts
/agy --tier pro --sandbox "scaffold the reports module"
/agy --continue "finish the previous task and add docs"
```

This is the same experience as `/antigravity:delegate` in the Claude Code reference plugin. The main agent (you) is still responsible for reviewing the result.

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
