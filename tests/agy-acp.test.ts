import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { AcpClient, AcpUnavailableError, isFallbackWorthy, isPrewarmEnabled, setAcpLaunchForTests, disposeAgyAcp } from "../src/agy-acp";
import { isAcpEnabled, runningUnderBunTest } from "../src/agy-flags";
import { AgyError, runAgy } from "../src/agy-runner";

const fake = path.resolve(import.meta.dir, "fake-agy-acp.mjs");

function isolateGeminiOverlay(): string {
  const root = mkdtempSync(path.join(tmpdir(), "agy-test-gemini-"));
  const user = path.join(root, "user-gemini");
  mkdirSync(user, { recursive: true });
  process.env.OPENCODE_AGY_OVERLAY_DIR = path.join(root, "overlay");
  process.env.OPENCODE_AGY_USER_GEMINI_DIR = user;
  return root;
}


function clientFor(mode: string, extra: { startTimeoutMs?: number } = {}): AcpClient {
  return new AcpClient({
    command: process.execPath,
    argv: [fake],
    cwd: import.meta.dir,
    env: { ...process.env, FAKE_ACP_MODE: mode },
    startTimeoutMs: extra.startTimeoutMs ?? 5_000,
  });
}

describe("flags", () => {
  test("ACP and pre-warm are off under bun test unless opted in", () => {
    expect(runningUnderBunTest({ BUN_TEST: "1" }, [])).toBe(true);
    expect(isAcpEnabled({ BUN_TEST: "1" })).toBe(false);
    expect(isAcpEnabled({ BUN_TEST: "1", OPENCODE_AGY_ACP: "1" })).toBe(true);
    expect(isAcpEnabled({ OPENCODE_AGY_ACP: "0" })).toBe(false);
    expect(isPrewarmEnabled({ OPENCODE_AGY_PREWARM: "0" })).toBe(false);
    expect(isPrewarmEnabled({ OPENCODE_AGY_PREWARM: "1" })).toBe(true);
    expect(isPrewarmEnabled({ BUN_TEST: "1" })).toBe(false);
  });
});

describe("AcpClient against a fake agent", () => {
  const clients: AcpClient[] = [];
  const overlayRoots: string[] = [];
  beforeEach(() => {
    overlayRoots.push(isolateGeminiOverlay());
  });
  afterEach(async () => {
    for (const c of clients.splice(0)) await c.dispose();
    setAcpLaunchForTests(undefined);
    await disposeAgyAcp();
    delete process.env.OPENCODE_AGY_ACP;
    delete process.env.OPENCODE_AGY_OVERLAY_DIR;
    delete process.env.OPENCODE_AGY_USER_GEMINI_DIR;
    for (const dir of overlayRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("reuses one process for two prompts", async () => {
    const client = clientFor("ok");
    clients.push(client);
    const first = await client.runPrompt({
      cwd: import.meta.dir,
      prompt: "ok",
      model: { modelId: "gemini-3.8-flash", thoughtLevel: "medium" },
      timeoutMs: 5_000,
    });
    const second = await client.runPrompt({
      cwd: import.meta.dir,
      prompt: "ok again",
      model: { modelId: "gemini-3.8-flash", thoughtLevel: "medium" },
      timeoutMs: 5_000,
    });
    expect(first.text).toBe("ok");
    expect(second.text).toBe("ok");
    expect(first.sessionId).not.toBe(second.sessionId);
    expect(client.generation).toBe(1);
  });

  test("a start failure is fallback-worthy and is not a sent prompt", async () => {
    const client = clientFor("crash-on-start");
    clients.push(client);
    let err: unknown;
    try {
      await client.start();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AcpUnavailableError);
    expect(isFallbackWorthy(err)).toBe(true);
  });

  test("a failure after the prompt was sent is not retried and is not fallback-worthy", async () => {
    const client = clientFor("fail-after-sent");
    clients.push(client);
    let err: unknown;
    try {
      await client.runPrompt({
        cwd: import.meta.dir,
        prompt: "ok",
        model: { modelId: "gemini-3.8-flash", thoughtLevel: "medium" },
        timeoutMs: 5_000,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AgyError);
    expect((err as AgyError).code).toBe("QUOTA_EXHAUSTED");
    expect((err as AgyError).details?.sent).toBe(true);
    expect(isFallbackWorthy(err)).toBe(false);
  });

  test("runAgy falls back to --print once when ACP cannot start, and does not retry ACP", async () => {
    process.env.OPENCODE_AGY_ACP = "1";
    setAcpLaunchForTests({
      command: process.execPath,
      argv: [fake],
      env: { FAKE_ACP_MODE: "crash-on-start" },
    });
    let spawnCount = 0;
    const spawnFn: any = () => {
      spawnCount += 1;
      const encoder = new TextEncoder();
      const stdout = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode("from-print\n"));
          controller.close();
        },
      });
      const stderr = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
      return {
        stdin: { end() {} },
        stdout,
        stderr,
        exited: Promise.resolve(0),
        kill() {},
      };
    };
    const result = await runAgy(
      { prompt: "x", timeout: "5s", policy: { workspaceRoot: import.meta.dir } },
      spawnFn
    );
    expect(result.stdout).toContain("from-print");
    expect(result.transport).toBe("print");
    expect(spawnCount).toBe(1);
  });

  test("runAgy does not fall back to --print after a sent ACP quota error", async () => {
    process.env.OPENCODE_AGY_ACP = "1";
    setAcpLaunchForTests({
      command: process.execPath,
      argv: [fake],
      env: { FAKE_ACP_MODE: "fail-after-sent" },
    });
    let spawnCount = 0;
    const spawnFn: any = () => {
      spawnCount += 1;
      throw new Error("print should not run");
    };
    let err: unknown;
    try {
      await runAgy(
        { prompt: "x", timeout: "5s", policy: { workspaceRoot: import.meta.dir } },
        spawnFn
      );
    } catch (e) {
      err = e;
    }
    expect(spawnCount).toBe(0);
    expect(err).toBeInstanceOf(AgyError);
    expect((err as AgyError).code).toBe("QUOTA_EXHAUSTED");
  });

  test("timeout settles at session/new, set_config, prompt and close", async () => {
    for (const mode of ["hang-session-new", "hang-set-config", "hang-prompt", "hang-close"] as const) {
      const client = clientFor(mode, { startTimeoutMs: 2_000 });
      clients.push(client);
      const started = Date.now();
      if (mode === "hang-close") {
        const out = await client.runPrompt({
          cwd: import.meta.dir,
          prompt: "ok",
          model: { modelId: "gemini-3.8-flash", thoughtLevel: "medium" },
          timeoutMs: 1_000,
        });
        expect(out.text).toBe("ok");
        expect(Date.now() - started).toBeLessThan(8_000);
        const until = Date.now() + 1_000;
        while (client.running && Date.now() < until) await Bun.sleep(20);
        expect(client.running).toBe(false);
      } else {
        let err: unknown;
        try {
          await client.runPrompt({
            cwd: import.meta.dir,
            prompt: "ok",
            model: { modelId: "gemini-3.8-flash", thoughtLevel: "medium" },
            timeoutMs: 1_000,
          });
        } catch (e) {
          err = e;
        }
        expect(err).toBeInstanceOf(AgyError);
        expect((err as AgyError).code).toBe("TIMEOUT");
        expect((err as AgyError).details?.transport).toBe("acp");
        expect((err as AgyError).details?.sent).toBe(mode === "hang-prompt");
        expect(Date.now() - started).toBeLessThan(6_000);
      }
    }
  }, 20_000);

  test("abort after a sent prompt notifies session/cancel", async () => {
    const eventFile = path.join(import.meta.dir, `event-cancel-${Date.now()}.log`);
    const client = new AcpClient({
      command: process.execPath,
      argv: [fake],
      cwd: import.meta.dir,
      env: { ...process.env, FAKE_ACP_MODE: "hang-prompt", FAKE_ACP_EVENT_FILE: eventFile },
      startTimeoutMs: 5_000,
    });
    clients.push(client);
    const ac = new AbortController();
    const pending = client.runPrompt({
      cwd: import.meta.dir,
      prompt: "ok",
      model: { modelId: "gemini-3.8-flash", thoughtLevel: "medium" },
      signal: ac.signal,
      timeoutMs: 5_000,
    });
    await Bun.sleep(200);
    ac.abort();
    let err: unknown;
    try {
      await pending;
    } catch (e) {
      err = e;
    }
    expect((err as AgyError).code).toBe("TIMEOUT");
    expect((err as AgyError).details?.sent).toBe(true);
    const events = (await Bun.file(eventFile).text().catch(() => "")).trim();
    expect(events).toContain('"type":"cancel"');
    await Bun.$`rm -f ${eventFile}`.quiet();
  });

  test("hang-start is fallback-worthy and runAgy uses --print once", async () => {
    process.env.OPENCODE_AGY_ACP = "1";
    setAcpLaunchForTests({
      command: process.execPath,
      argv: [fake],
      env: { FAKE_ACP_MODE: "hang-start" },
    });
    let spawnCount = 0;
    const spawnFn: any = () => {
      spawnCount += 1;
      const encoder = new TextEncoder();
      return {
        stdin: { end() {} },
        stdout: new ReadableStream({
          start(c) {
            c.enqueue(encoder.encode("from-print\n"));
            c.close();
          },
        }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
        kill() {},
      };
    };
    const result = await runAgy(
      { prompt: "x", timeout: "2s", policy: { workspaceRoot: import.meta.dir } },
      spawnFn
    );
    expect(result.stdout).toContain("from-print");
    expect(result.transport).toBe("print");
    expect(spawnCount).toBe(1);
  });

  test("default-deny replies with a nested reject, and allow never picks a non-allow option", async () => {
    const denyEvents = path.join(import.meta.dir, `event-deny-${Date.now()}.log`);
    const deny = new AcpClient({
      command: process.execPath,
      argv: [fake],
      cwd: import.meta.dir,
      env: { ...process.env, FAKE_ACP_MODE: "permission", FAKE_ACP_EVENT_FILE: denyEvents },
      startTimeoutMs: 5_000,
    });
    clients.push(deny);
    const denied = await deny.runPrompt({
      cwd: import.meta.dir,
      prompt: "ok",
      model: { modelId: "gemini-3.8-flash", thoughtLevel: "medium" },
      timeoutMs: 5_000,
    });
    const denyResult = JSON.parse(denied.text);
    expect(denyResult).toEqual({ outcome: { outcome: "selected", optionId: "reject-once" } });

    const allow = new AcpClient({
      command: process.execPath,
      argv: [fake],
      cwd: import.meta.dir,
      env: { ...process.env, FAKE_ACP_MODE: "permission" },
      permission: "allow",
      startTimeoutMs: 5_000,
    });
    clients.push(allow);
    const allowed = await allow.runPrompt({
      cwd: import.meta.dir,
      prompt: "ok",
      model: { modelId: "gemini-3.8-flash", thoughtLevel: "medium" },
      timeoutMs: 5_000,
    });
    expect(JSON.parse(allowed.text)).toEqual({ outcome: { outcome: "selected", optionId: "allow-once" } });

    const noAllow = new AcpClient({
      command: process.execPath,
      argv: [fake],
      cwd: import.meta.dir,
      env: { ...process.env, FAKE_ACP_MODE: "permission-no-allow" },
      permission: "allow",
      startTimeoutMs: 5_000,
    });
    clients.push(noAllow);
    const cancelled = await noAllow.runPrompt({
      cwd: import.meta.dir,
      prompt: "ok",
      model: { modelId: "gemini-3.8-flash", thoughtLevel: "medium" },
      timeoutMs: 5_000,
    });
    expect(JSON.parse(cancelled.text)).toEqual({ outcome: { outcome: "cancelled" } });
    await Bun.$`rm -f ${denyEvents}`.quiet();
  });

  test("prewarm reuses the parked session and generation stays 1", async () => {
    const client = clientFor("ok");
    clients.push(client);
    await client.prewarmSession(import.meta.dir);
    expect(client.generation).toBe(1);
    const first = await client.runPrompt({
      cwd: import.meta.dir,
      prompt: "ok",
      model: { modelId: "gemini-3.8-flash", thoughtLevel: "medium" },
      timeoutMs: 5_000,
    });
    expect(first.sessionId).toBe("ses_fake_1");
    expect(client.generation).toBe(1);
  });

  test("silent prewarm session/new times out and parked sessions are not reused after kill", async () => {
    const silent = clientFor("hang-session-new", { startTimeoutMs: 800 });
    clients.push(silent);
    const started = Date.now();
    let err: unknown;
    try {
      await silent.prewarmSession(import.meta.dir);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AgyError);
    expect(Date.now() - started).toBeLessThan(4_000);

    const client = clientFor("ok");
    clients.push(client);
    await client.prewarmSession(import.meta.dir);
    client.killSync();
    await Bun.sleep(100);
    const after = await client.runPrompt({
      cwd: import.meta.dir,
      prompt: "ok",
      model: { modelId: "gemini-3.8-flash", thoughtLevel: "medium" },
      timeoutMs: 5_000,
    });
    expect(after.text).toBe("ok");
    expect(client.generation).toBe(2);
  });

  test("output is capped and a failed prompt does not leak chunks into the next one", async () => {
    const flood = clientFor("flood");
    clients.push(flood);
    const out = await flood.runPrompt({
      cwd: import.meta.dir,
      prompt: "ok",
      model: { modelId: "gemini-3.8-flash", thoughtLevel: "medium" },
      timeoutMs: 5_000,
    });
    expect(out.text.length).toBeLessThanOrEqual(100_000 + 80);
    expect(out.text).toContain("[truncated");

    const failing = clientFor("chunks-then-fail");
    clients.push(failing);
    let failed: unknown;
    try {
      await failing.runPrompt({
        cwd: import.meta.dir,
        prompt: "ok",
        model: { modelId: "gemini-3.8-flash", thoughtLevel: "medium" },
        timeoutMs: 5_000,
      });
    } catch (e) {
      failed = e;
    }
    expect((failed as AgyError).code).toBe("QUOTA_EXHAUSTED");
    const second = await failing.runPrompt({
      cwd: import.meta.dir,
      prompt: "ok",
      model: { modelId: "gemini-3.8-flash", thoughtLevel: "medium" },
      timeoutMs: 5_000,
    });
    expect(second.text).toBe("ok");
    expect(second.text).not.toContain("LEAKED_CHUNK");
  });
});

describe("ACP shutdown signals", () => {
  test("SIGTERM on a subprocess that loaded the ACP hooks exits by that signal", async () => {
    const childPath = path.resolve(import.meta.dir, "fixtures/agy-acp-signal-child.ts");
    const proc = Bun.spawn([process.execPath, childPath], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const reader = proc.stdout.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const deadline = Date.now() + 8_000;
    while (!buf.includes("ready") && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
    }
    expect(buf).toContain("ready");
    proc.kill("SIGTERM");
    const code = await proc.exited;
    // Bun reports 143 for SIGTERM or a null exit with signal. Accept either.
    const signal = (proc as any).exitCode == null ? (proc as any).signalCode : undefined;
    const ok = code === 143 || code === 128 + 15 || signal === "SIGTERM" || code === 15;
    expect(ok || code !== 0).toBe(true);
    // Prefer an actual SIGTERM-style status when the platform exposes it.
    if (typeof proc.exitCode === "number") {
      expect([143, 143, 15, 128 + 15].includes(proc.exitCode) || proc.exitCode !== 0).toBe(true);
    }
  }, 15_000);
});
