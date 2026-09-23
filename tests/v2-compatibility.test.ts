import { describe, test, expect, mock } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { $ } from "bun";
import { createOpencodeClient } from "@opencode-ai/sdk";

describe("Task 1: package.json contracts & dependencies", () => {
  const pkgPath = path.join(__dirname, "../package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

  test("version is bumped to 0.11.0", () => {
    expect(pkg.version).toBe("0.11.0");
  });

  test("peerDependencies includes both @opencode-ai/plugin and @opencode/plugin", () => {
    expect(pkg.peerDependencies).toBeDefined();
    expect(pkg.peerDependencies["@opencode-ai/plugin"]).toBe("^1.17.9 || ^1.18.0");
    expect(pkg.peerDependencies["@opencode/plugin"]).toBe(">=2.0.0");
  });

  test("peerDependenciesMeta marks both peer dependencies as optional", () => {
    expect(pkg.peerDependenciesMeta).toBeDefined();
    expect(pkg.peerDependenciesMeta["@opencode-ai/plugin"]?.optional).toBe(true);
    expect(pkg.peerDependenciesMeta["@opencode/plugin"]?.optional).toBe(true);
  });
});

describe("Task 2: Subprocess Cancellation & V2 Adapter", () => {
  test("AgyOptions.signal: aborting AbortController triggers process kill in runAgy", async () => {
    const { runAgy } = await import("../src/agy-runner");

    let killed = false;
    const ac = new AbortController();

    const fakeProc = {
      stdin: { end: () => {} },
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          // delay closing stdout to simulate long-running process
          setTimeout(() => {
            controller.enqueue(new TextEncoder().encode("delayed"));
            controller.close();
          }, 100);
        },
      }),
      stderr: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
      exited: new Promise<number>((resolve) => {
        // resolves when killed or done
        setTimeout(() => resolve(0), 150);
      }),
      kill: () => {
        killed = true;
      },
    };

    const spawnFn: any = () => fakeProc;

    const promise = runAgy(
      {
        prompt: "test abort",
        signal: ac.signal,
      },
      spawnFn
    );

    // Abort immediately
    ac.abort();
    await promise;

    expect(killed).toBe(true);
  });

  test("AgyOptions.signal: pre-aborted signal triggers process kill immediately", async () => {
    const { runAgy } = await import("../src/agy-runner");

    let killed = false;
    const ac = new AbortController();
    ac.abort();

    const fakeProc = {
      stdin: { end: () => {} },
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("pre-aborted"));
          controller.close();
        },
      }),
      stderr: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
      exited: Promise.resolve(0),
      kill: () => {
        killed = true;
      },
    };

    const spawnFn: any = () => fakeProc;

    await runAgy(
      {
        prompt: "test pre-aborted",
        signal: ac.signal,
      },
      spawnFn
    );

    expect(killed).toBe(true);
  });

  test("AGY_V2_TOOL_SCHEMA: valid JSON Schema with expected properties", async () => {
    const { AGY_V2_TOOL_SCHEMA } = await import("../src/agy-v2");

    expect(AGY_V2_TOOL_SCHEMA).toBeDefined();
    expect(AGY_V2_TOOL_SCHEMA.type).toBe("object");
    expect(AGY_V2_TOOL_SCHEMA.required).toEqual(["prompt"]);

    const props = Object.keys(AGY_V2_TOOL_SCHEMA.properties);
    const expectedProps = [
      "prompt",
      "tier",
      "dir",
      "project",
      "timeout",
      "yolo",
      "sandbox",
      "continue",
      "conversation",
      "model",
    ];

    for (const prop of expectedProps) {
      expect(props).toContain(prop);
    }
  });

  test("buildAgyV2ToolResult: returns { content: string, metadata?: Record<string, any> }", async () => {
    const { buildAgyV2ToolResult } = await import("../src/agy-v2");

    const sampleResult = {
      stdout: "hello from agy v2",
      stderr: "",
      exitCode: 0,
      durationMs: 1234,
      conversationId: "conv-123",
    };

    const toolResult = buildAgyV2ToolResult(sampleResult, {
      prompt: "hi",
      tier: "flash-3.8-med",
      sandbox: true,
      yolo: true,
    });

    expect(toolResult).toBeDefined();
    expect(typeof toolResult.content).toBe("string");
    expect(toolResult.content).toContain("## agy result");
    expect(toolResult.content).toContain("hello from agy v2");
    expect(toolResult.content).toContain("WARNING: yolo (--dangerously-skip-permissions) + sandbox both enabled");
    expect(toolResult.metadata).toBeDefined();
    expect(toolResult.metadata?.tier).toBe("flash-3.8-med");
    expect(toolResult.metadata?.durationMs).toBe(1234);
    expect(toolResult.metadata?.exitCode).toBe(0);
    expect(toolResult.metadata?.sandbox).toBe(true);
    expect(toolResult.metadata?.yolo).toBe(true);
    expect(toolResult.metadata?.conversationId).toBe("conv-123");
  });

  test("buildAgyV2ToolResult: handles undefined result gracefully", async () => {
    const { buildAgyV2ToolResult } = await import("../src/agy-v2");

    const toolResult = buildAgyV2ToolResult(undefined as any, { prompt: "hi" });
    expect(toolResult).toBeDefined();
    expect(typeof toolResult.content).toBe("string");
    expect(toolResult.content).toContain("AGY_UNDEFINED_RESULT");
    expect(toolResult.metadata?.error).toBe(true);
  });

  test("setupV2Plugin(ctx): registers tool and command, defends against missing editors", async () => {
    const { setupV2Plugin } = await import("../src/agy-v2");

    let toolRegistered: any = null;
    let commandRegistered: any = null;

    const mockToolEditor = {
      add: (t: any) => {
        toolRegistered = t;
      },
    };

    const mockCommandEditor = {
      add: (c: any) => {
        commandRegistered = c;
      },
    };

    const mockCtx = {
      tool: {
        transform: async (fn: any) => {
          await fn(mockToolEditor);
        },
      },
      command: {
        transform: async (fn: any) => {
          await fn(mockCommandEditor);
        },
      },
    };

    await setupV2Plugin(mockCtx);

    expect(toolRegistered).toBeDefined();
    expect(toolRegistered.name).toBe("agy");
    expect(toolRegistered.description).toBeDefined();
    expect(typeof toolRegistered.execute).toBe("function");

    expect(commandRegistered).toBeDefined();
    expect(commandRegistered.name).toBe("agy");
    expect(commandRegistered.description).toBeDefined();
    expect(commandRegistered.template).toBeDefined();
  });

  test("setupV2Plugin(ctx): defensive when ctx.command or transforms are undefined", async () => {
    const { setupV2Plugin } = await import("../src/agy-v2");

    // Should not throw when tool or command transforms are absent
    await expect(setupV2Plugin({})).resolves.toBeUndefined();
    await expect(setupV2Plugin({ tool: {} })).resolves.toBeUndefined();
    await expect(setupV2Plugin({ command: {} })).resolves.toBeUndefined();
    await expect(setupV2Plugin(null)).resolves.toBeUndefined();
    await expect(setupV2Plugin(undefined)).resolves.toBeUndefined();
  });

  test("setupV2Plugin tool execution: traps errors into { content } and forwards context.signal", async () => {
    const { setupV2Plugin } = await import("../src/agy-v2");

    let registeredTool: any = null;
    const mockCtx = {
      tool: {
        transform: async (fn: any) => {
          await fn({
            add: (t: any) => {
              registeredTool = t;
            },
          });
        },
      },
    };

    await setupV2Plugin(mockCtx);
    expect(registeredTool).toBeDefined();

    // Call execute with an invalid tier to cause AgyError
    const res = await registeredTool.execute(
      { prompt: "do work", tier: "non-existent-tier" },
      { signal: new AbortController().signal }
    );

    expect(res).toBeDefined();
    expect(typeof res.content).toBe("string");
    expect(res.content).toContain("AGY_ERROR [INVALID_TIER]");
    expect(res.metadata?.error).toBe(true);
    expect(res.metadata?.code).toBe("INVALID_TIER");
  });
});

describe("Task 3: Universal Dual-Export Entrypoint", () => {
  const fakeV1Ctx = () => {
    return {
      client: createOpencodeClient(),
      project: { id: "test", worktree: "/tmp", time: { created: 0 } },
      directory: "/tmp",
      worktree: "/tmp",
      experimental_workspace: { register: () => {} },
      serverUrl: new URL("http://localhost"),
      $,
    };
  };

  test("Loader Pattern 1: Default callable AgyPlugin(mockV1Ctx)", async () => {
    const mod = await import("../src/index");
    expect(typeof mod.default).toBe("function");

    const hooks = await mod.default(fakeV1Ctx());
    expect(hooks).toBeDefined();
    expect(hooks.tool?.agy).toBeDefined();
    expect(hooks.config).toBeDefined();
  });

  test("Loader Pattern 2: Default property .server AgyPlugin.server(mockV1Ctx)", async () => {
    const mod = await import("../src/index");
    expect(typeof mod.default.server).toBe("function");

    const hooks = await mod.default.server(fakeV1Ctx());
    expect(hooks).toBeDefined();
    expect(hooks.tool?.agy).toBeDefined();
  });

  test("Loader Pattern 3: Top-level named server(mockV1Ctx)", async () => {
    const { server } = await import("../src/index");
    expect(typeof server).toBe("function");

    const hooks = await server(fakeV1Ctx());
    expect(hooks).toBeDefined();
    expect(hooks.tool?.agy).toBeDefined();
  });

  test("Loader Pattern 4: Top-level named setup & default .id / .setup", async () => {
    const mod = await import("../src/index");
    const { setup, AgyPlugin } = mod;

    expect(AgyPlugin.id).toBe("opencode-agy");
    expect(typeof AgyPlugin.setup).toBe("function");
    expect(typeof setup).toBe("function");

    let v2ToolAdded = false;
    const mockV2Ctx = {
      tool: {
        transform: async (fn: any) => {
          await fn({
            add: (t: any) => {
              if (t.name === "agy") v2ToolAdded = true;
            },
          });
        },
      },
    };

    await AgyPlugin.setup(mockV2Ctx);
    expect(v2ToolAdded).toBe(true);

    v2ToolAdded = false;
    await setup(mockV2Ctx);
    expect(v2ToolAdded).toBe(true);
  });
});
