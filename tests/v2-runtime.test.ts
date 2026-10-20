import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Opt-in smoke test against a real OpenCode v2 runtime.
 *
 * Run with `OPENCODE_SMOKE=1 bun test tests/v2-runtime.test.ts` (or
 * `bun run test:smoke`). It drives the installed `opencode` binary in a
 * throwaway HOME/XDG tree and covers the two regressions end to end:
 *
 * 1. the real PluginModule loader accepts the default export;
 * 2. `/agy` executes through POST /api/session/:id/command and renders
 *    `$ARGUMENTS`.
 *
 * The model is a local OpenAI-compatible stub that answers immediately and
 * advertises no tool support, so no credentials, network, or agy process is
 * involved.
 */

const REPO = path.join(import.meta.dir, "..");
const BIN = process.env.OPENCODE_BIN ?? Bun.which("opencode");

async function versionOf(bin: string): Promise<string | null> {
  try {
    const proc = Bun.spawn([bin, "--version"], { stdout: "pipe", stderr: "ignore" });
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    return out;
  } catch {
    return null;
  }
}

const optedIn = process.env.OPENCODE_SMOKE === "1" && BIN !== null;
const enabled = optedIn && /(?:^|\D)2\.\d+\.\d+/.test((await versionOf(BIN!)) ?? "");

describe("real OpenCode v2 runtime (smoke)", () => {
  const root = enabled ? mkdtempSync(path.join(tmpdir(), "opencode-agy-smoke-")) : "";
  let env: Record<string, string> = {};
  let stub: Server | null = null;
  let captures: string[] = [];
  let sessionID = "";

  async function run(args: string[], timeoutMs = 60_000): Promise<string> {
    const proc = Bun.spawn([BIN!, ...args], {
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

    // The loader imports dist/index.js, so test the current source, not a stale build.
    const build = Bun.spawn(["bun", "run", "build"], { cwd: REPO, stdout: "ignore", stderr: "pipe" });
    if ((await build.exited) !== 0) throw new Error("bun run build failed");

    const configDir = path.join(root, "config", "opencode");
    mkdirSync(path.join(configDir, "plugins"), { recursive: true });
    mkdirSync(path.join(root, "proj"), { recursive: true });
    mkdirSync(path.join(root, "tmp"), { recursive: true });

    // Every path OpenCode may read or write stays inside the sandbox.
    env = {
      HOME: path.join(root, "home"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_STATE_HOME: path.join(root, "state"),
      XDG_RUNTIME_DIR: path.join(root, "run"),
      TMPDIR: path.join(root, "tmp"),
      PATH: process.env.PATH ?? "/usr/bin:/bin",
    };
    mkdirSync(env.HOME, { recursive: true });
    mkdirSync(env.XDG_RUNTIME_DIR, { recursive: true });

    // v2 config only accepts plugin directories, so wrap the built entrypoint.
    writeFileSync(
      path.join(configDir, "plugins", "agy-smoke.ts"),
      `export { default } from ${JSON.stringify(path.join(REPO, "dist", "index.js"))};\n`,
    );

    stub = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString("utf8");
      captures.push(raw);
      if (!raw.includes('"stream":true')) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-stub",
            object: "chat.completion",
            created: 0,
            model: "harness",
            choices: [{ index: 0, message: { role: "assistant", content: "STUB_OK" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", connection: "keep-alive" });
      res.write(`data: ${JSON.stringify({ id: "chatcmpl-stub", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "STUB_OK" }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: "chatcmpl-stub", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
    await new Promise<void>((resolve) => stub!.listen(0, "127.0.0.1", resolve));
    const port = (stub.address() as { port: number }).port;

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

    // A private port keeps the sandbox away from the user's running server.
    await run(["service", "set", "port", String(40000 + Math.floor(Math.random() * 20000))]);
    // Plugins reconcile per instance; one throwaway prompt creates one with the stub model.
    await run(["run", "--model", "stub/harness", "warmup"]);

    const logFile = path.join(env.XDG_DATA_HOME, "opencode", "log", "opencode.log");
    await waitFor("plugin load in server log", () =>
      existsSync(logFile) && readFileSync(logFile, "utf8").includes("agy-smoke.ts") ? true : undefined,
    );

    const created = JSON.parse(await run(["api", "POST", "/api/session", "-d", "{}"])) as { data?: { id?: string } };
    sessionID = created.data?.id ?? "";
    if (!/^ses/.test(sessionID)) throw new Error("could not create a sandbox session");
  }, 120_000);

  afterAll(async () => {
    if (!root) return;
    try {
      await run(["service", "stop"], 15_000);
    } catch {
      // best effort: the sandbox is deleted below either way
    }
    stub?.closeAllConnections?.();
    await new Promise<void>((resolve) => (stub ? stub.close(() => resolve()) : resolve()));
    rmSync(root, { recursive: true, force: true });
  });

  test.skipIf(!enabled)("real v2 loader accepts the default export", () => {
    const log = readFileSync(path.join(env.XDG_DATA_HOME, "opencode", "log", "opencode.log"), "utf8");
    expect(log).not.toContain("failed to load plugin");
    expect(log).toContain("agy-smoke.ts");
  });

  test.skipIf(!enabled)("real v2 /agy executes and renders $ARGUMENTS", async () => {
    const before = captures.length;
    await run(["api", "POST", `/api/session/${sessionID}/command`, "-d", JSON.stringify({ name: "agy", text: "test" })]);

    // The command is only accepted if it registered an execute(); the prompt
    // reaching the model proves the handler ran and rendered the template.
    const body = await waitFor("the /agy prompt to reach the model", () =>
      captures.slice(before).find((c) => c.includes("Delegate this task to the `agy` tool")),
    );

    expect(body).toContain("test");
    expect(body).not.toContain("$ARGUMENTS");
  }, 90_000);
});
