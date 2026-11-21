import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { setAcpLaunchForTests, disposeAgyAcp } from "../src/agy-acp";
import { runAgy } from "../src/agy-runner";
import { autoTier } from "../src/agy-route";

const fake = path.resolve(import.meta.dir, "fake-agy-acp.mjs");

function isolateGeminiOverlay(): string {
  const root = mkdtempSync(path.join(tmpdir(), "agy-test-gemini-"));
  const user = path.join(root, "user-gemini");
  mkdirSync(user, { recursive: true });
  process.env.OPENCODE_AGY_OVERLAY_DIR = path.join(root, "overlay");
  process.env.OPENCODE_AGY_USER_GEMINI_DIR = user;
  return root;
}


function printSpawn(label = "from-print") {
  let spawnCount = 0;
  const spawnFn: any = () => {
    spawnCount += 1;
    const encoder = new TextEncoder();
    return {
      stdin: { end() {} },
      stdout: new ReadableStream({
        start(c) {
          c.enqueue(encoder.encode(label + "\n"));
          c.close();
        },
      }),
      stderr: new ReadableStream({ start(c) { c.close(); } }),
      exited: Promise.resolve(0),
      kill() {},
    };
  };
  return { spawnFn, get count() { return spawnCount; } };
}

describe("ACP transport gate", () => {
  const overlayRoots: string[] = [];
  beforeEach(() => {
    overlayRoots.push(isolateGeminiOverlay());
  });
  afterEach(async () => {
    setAcpLaunchForTests(undefined);
    await disposeAgyAcp();
    delete process.env.OPENCODE_AGY_ACP;
    delete process.env.OPENCODE_AGY_OVERLAY_DIR;
    delete process.env.OPENCODE_AGY_USER_GEMINI_DIR;
    for (const dir of overlayRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("sandbox:true and project stay on --print with a single spawn", async () => {
    process.env.OPENCODE_AGY_ACP = "1";
    setAcpLaunchForTests({
      command: process.execPath,
      argv: [fake],
      env: { FAKE_ACP_MODE: "ok" },
    });
    for (const extra of [{ sandbox: true as const }, { project: "proj_abc123" }]) {
      const spy = printSpawn();
      const result = await runAgy(
        { prompt: "x", timeout: "5s", policy: { workspaceRoot: import.meta.dir }, ...extra },
        spy.spawnFn
      );
      expect(result.transport).toBe("print");
      expect(result.stdout).toContain("from-print");
      expect(spy.count).toBe(1);
    }
  });

  test("a plain call uses ACP and does not spawn --print", async () => {
    process.env.OPENCODE_AGY_ACP = "1";
    setAcpLaunchForTests({
      command: process.execPath,
      argv: [fake],
      env: { FAKE_ACP_MODE: "ok" },
    });
    const spy = printSpawn();
    const result = await runAgy(
      { prompt: "x", timeout: "5s", policy: { workspaceRoot: import.meta.dir } },
      spy.spawnFn
    );
    expect(result.transport).toBe("acp");
    expect(result.stdout).toBe("ok");
    expect(spy.count).toBe(0);
  });

  test("a short prompt with a long attachment still routes to Flash", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "agy-gate-"));
    try {
      const big = path.join(root, "notes.txt");
      writeFileSync(big, "word ".repeat(5_000));
      expect(autoTier("Reply with exactly the word ok and nothing else.", [big])).toBe("flash-3.8-med");
      process.env.OPENCODE_AGY_ACP = "1";
      const eventFile = path.join(root, "events.log");
      setAcpLaunchForTests({
        command: process.execPath,
        argv: [fake],
        env: { FAKE_ACP_MODE: "ok", FAKE_ACP_EVENT_FILE: eventFile },
      });
      const spy = printSpawn();
      const result = await runAgy(
        {
          prompt: "Reply with exactly the word ok and nothing else.",
          files: [big],
          timeout: "5s",
          policy: { workspaceRoot: root },
        },
        spy.spawnFn
      );
      expect(result.transport).toBe("acp");
      expect(result.tier).toBe("flash-3.8-med");
      const events = await Bun.file(eventFile).text();
      expect(events).toContain("gemini-3.8-flash");
      expect(events).not.toContain("gemini-4-hydrogen");
      expect(spy.count).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
