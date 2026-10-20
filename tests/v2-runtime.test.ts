import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Real OpenCode v2 runtime regression tests.
 *
 * Unlike every other test file, these drive the installed `opencode` binary:
 * the plugin is loaded by the real PluginModule loader and `/agy` is executed
 * through the real command endpoint (POST /api/session/:id/command).
 *
 * The model is a local OpenAI-compatible stub that answers immediately and
 * never asks for tools, so no provider credentials and no agy process are
 * involved. Skipped when the binary is missing or is not v2.x.
 */

const REPO = path.join(import.meta.dir, "..");
const OPENCODE = process.env.OPENCODE_BIN ?? Bun.which("opencode");

async function opencodeVersion(bin: string): Promise<string | null> {
  try {
    const proc = Bun.spawn([bin, "--version"], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out.trim();
  } catch {
    return null;
  }
}

const version = OPENCODE ? await opencodeVersion(OPENCODE) : null;
const isV2 = version !== null && /(?:^|\D)2\.\d+\.\d+/.test(version);
const enabled = OPENCODE !== null && isV2;

type Capture = { messages?: Array<{ role: string; content: unknown }> };

describe("real OpenCode v2 runtime", () => {
  let root = "";
  let env: Record<string, string> = {};
  let server: Server | null = null;
  let captures: Capture[] = [];
  let sessionID = "";

  const text = (entry: Capture): string =>
    (entry.messages ?? []).map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");

  async function run(args: string[], timeoutMs = 60_000): Promise<string> {
    const proc = Bun.spawn([OPENCODE!, ...args], {
      cwd: path.join(root, "proj"),
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    clearTimeout(timer);
    if (proc.exitCode !== 0) throw new Error(`opencode ${args.join(" ")} failed (${proc.exitCode}): ${err || out}`);
    return out;
  }

  async function waitFor<T>(what: string, probe: () => T | undefined, timeoutMs = 30_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = probe();
      if (hit !== undefined) return hit;
      await Bun.sleep(200);
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  beforeAll(async () => {
    if (!enabled) return;

    // The loader always imports dist/index.js; build it from the current source.
    const build = Bun.spawn(["bun", "run", "build"], { cwd: REPO, stdout: "ignore", stderr: "pipe" });
    if ((await build.exited) !== 0) throw new Error("bun run build failed");

    root = mkdtempSync(path.join(tmpdir(), "opencode-agy-e2e-"));
    const configDir = path.join(root, "config", "opencode");
    mkdirSync(path.join(configDir, "plugins"), { recursive: true });
    mkdirSync(path.join(root, "proj"), { recursive: true });

    env = {
      HOME: path.join(root, "home"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_STATE_HOME: path.join(root, "state"),
      PATH: process.env.PATH ?? "/usr/bin:/bin",
    };
    mkdirSync(env.HOME, { recursive: true });

    // v2 config only accepts plugin directories, so wrap the built entrypoint.
    writeFileSync(
      path.join(configDir, "plugins", "agy-e2e.ts"),
      `export { default } from ${JSON.stringify(path.join(REPO, "dist", "index.js"))};\n`,
    );

    server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      let body: Record<string, any> = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        captures.push(body as Capture);
      } catch {
        captures.push({});
      }
      if (body.stream === true) {
        res.writeHead(200, { "content-type": "text/event-stream", connection: "keep-alive" });
        res.write(
          `data: ${JSON.stringify({ id: "chatcmpl-stub", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "STUB_OK" }, finish_reason: null }] })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({ id: "chatcmpl-stub", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
        );
        res.end("data: [DONE]\n\n");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-stub",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "harness",
          choices: [{ index: 0, message: { role: "assistant", content: "STUB_OK" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    writeFileSync(
      path.join(configDir, "opencode.json"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        model: "stub/harness",
        small_model: "stub/harness",
        provider: {
          stub: {
            npm: "@ai-sdk/openai-compatible",
            name: "Stub",
            options: {
              apiKey: "stub-key",
              baseURL: `http://127.0.0.1:${port}/v1`,
              timeout: 5000,
              headerTimeout: 5000,
              chunkTimeout: 5000,
            },
            models: {
              harness: {
                name: "Stub",
                limit: { context: 32768, output: 1024 },
                reasoning: false,
                tool_call: false,
                modalities: { input: ["text"], output: ["text"] },
              },
            },
          },
        },
      }),
      null,
      2,
    );

    // A private service port keeps the sandbox from touching the user's server.
    await run(["service", "set", "port", String(40000 + Math.floor(Math.random() * 20000))]);
    // Plugins reconcile per instance; one throwaway prompt creates one with the stub model.
    await run(["run", "--model", "stub/harness", "warmup"]);

    const logFile = path.join(env.XDG_DATA_HOME, "opencode", "log", "opencode.log");
    await waitFor("plugin load in server log", () => (existsSync(logFile) && readFileSync(logFile, "utf8").includes("agy-e2e.ts") ? true : undefined));

    const created = JSON.parse(await run(["api", "POST", "/api/session", "-d", "{}"])) as { data?: { id?: string } };
    sessionID = created.data?.id ?? "";
  }, 120_000);

  afterAll(async () => {
    if (OPENCODE && root && existsSync(root)) {
      try {
        await run(["service", "stop"], 15_000);
      } catch {
        // best effort
      }
    }
    server?.close();
  });

  test.skipIf(!enabled)("real v2 loader accepts the plugin default export", () => {
    const log = readFileSync(path.join(env.XDG_DATA_HOME, "opencode", "log", "opencode.log"), "utf8");
    expect(log).not.toContain("failed to load plugin");
    expect(log).toContain("agy-e2e.ts");
  });

  test.skipIf(!enabled)("real v2 /agy command executes and renders $ARGUMENTS", async () => {
    expect(sessionID).toMatch(/^ses/);
    const before = captures.length;

    // Exactly what the TUI's "/agy test" sends: a command invocation, not a prompt.
    await run(["api", "POST", `/api/session/${sessionID}/command`, "-d", JSON.stringify({ name: "agy", text: "test" })]);

    const captured = await waitFor(
      "the command prompt to reach the model",
      () => {
        const hit = captures.slice(before).find((c) => text(c).includes("Delegate this task to the `agy` tool"));
        return hit;
      },
      30_000,
    );

    const prompt = captured.messages?.filter((m) => m.role === "user").map((m) => String(m.content)).join("\n") ?? "";
    expect(prompt).toContain("Delegate this task to the `agy` tool");
    expect(prompt).toContain("test");
    expect(prompt).not.toContain("$ARGUMENTS");
  }, 60_000);
});
