import { describe, test, expect, afterEach } from "bun:test";
import {
  buildAgyArgs,
  runAgy,
  AgyError,
  type SpawnFn,
} from "../src/agy-runner";

function createFakeProc({
  stdout = "",
  stderr = "",
  exitCode = 0,
}: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}) {
  const enc = new TextEncoder();

  const stdoutStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode(stdout));
      controller.close();
    },
  });

  const stderrStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode(stderr));
      controller.close();
    },
  });

  return {
    stdin: { end: () => {} },
    stdout: stdoutStream,
    stderr: stderrStream,
    exited: Promise.resolve(exitCode),
    kill: () => {},
  } as any;
}

describe("buildAgyArgs", () => {
  test("defaults to flash tier and 5m timeout", () => {
    const args = buildAgyArgs({ prompt: "do something" });
    expect(args).toContain("--model");
    expect(args).toContain("Gemini 3.5 Flash (High)");
    expect(args).toContain("--print-timeout");
    expect(args).toContain("5m");
    expect(args).toContain("-p");
    expect(args[args.length - 1]).toBe("do something");
  });

  test("maps tiers correctly", () => {
    expect(buildAgyArgs({ prompt: "x", tier: "flash" })).toContain("Gemini 3.5 Flash (High)");
    expect(buildAgyArgs({ prompt: "x", tier: "flash-lo" })).toContain("Gemini 3.5 Flash (Low)");
    expect(buildAgyArgs({ prompt: "x", tier: "pro" })).toContain("Gemini 3.1 Pro (High)");
  });

  test("adds --add-dir when dir provided", () => {
    const args = buildAgyArgs({ prompt: "x", dir: "/tmp/repo" });
    expect(args).toContain("--add-dir");
    expect(args).toContain("/tmp/repo");
  });

  test("adds --dangerously-skip-permissions when yolo=true", () => {
    const args = buildAgyArgs({ prompt: "x", yolo: true });
    expect(args).toContain("--dangerously-skip-permissions");
  });

  test("respects custom timeout", () => {
    const args = buildAgyArgs({ prompt: "x", timeout: "10m" });
    expect(args).toContain("10m");
  });

  test("always puts -p and prompt as last arguments", () => {
    const args = buildAgyArgs({ prompt: "final task here" });
    const pIndex = args.lastIndexOf("-p");
    expect(pIndex).toBeGreaterThan(0);
    expect(args[pIndex + 1]).toBe("final task here");
  });
});

describe("runAgy (injected spawn)", () => {
  test("returns stdout on success", async () => {
    const fakeSpawn: SpawnFn = (() =>
      createFakeProc({
        stdout: "Hello from Gemini\nTask complete.",
        stderr: "",
        exitCode: 0,
      })) as any;

    const result = await runAgy({ prompt: "say hello" }, fakeSpawn);
    expect(result.stdout).toContain("Hello from Gemini");
    expect(result.exitCode).toBe(0);
  });

  test("throws structured AgyError on non-zero exit", async () => {
    const fakeSpawn: SpawnFn = (() =>
      createFakeProc({
        stdout: "",
        stderr: "some error happened",
        exitCode: 2,
      })) as any;

    await expect(runAgy({ prompt: "fail" }, fakeSpawn)).rejects.toThrow(AgyError);

    try {
      await runAgy({ prompt: "fail" }, fakeSpawn);
    } catch (e: any) {
      expect(e.code).toBe("AGY_FAILED");
      expect(e.details?.exitCode).toBe(2);
    }
  });

  test("classifies quota error from stderr", async () => {
    const fakeSpawn: SpawnFn = (() =>
      createFakeProc({
        stdout: "",
        stderr: "You have exceeded your quota for this model",
        exitCode: 1,
      })) as any;

    try {
      await runAgy({ prompt: "quota test" }, fakeSpawn);
    } catch (e: any) {
      expect(e.code).toBe("QUOTA_EXHAUSTED");
    }
  });

  test("classifies auth error", async () => {
    const fakeSpawn: SpawnFn = (() =>
      createFakeProc({
        stdout: "",
        stderr: "Please authenticate with agy first",
        exitCode: 1,
      })) as any;

    try {
      await runAgy({ prompt: "auth test" }, fakeSpawn);
    } catch (e: any) {
      expect(e.code).toBe("AUTH_REQUIRED");
    }
  });

  test("throws on empty output", async () => {
    const fakeSpawn: SpawnFn = (() =>
      createFakeProc({
        stdout: "   \n\n  ",
        stderr: "",
        exitCode: 0,
      })) as any;

    try {
      await runAgy({ prompt: "empty" }, fakeSpawn);
    } catch (e: any) {
      expect(e.code).toBe("EMPTY_OUTPUT");
    }
  });

  test("truncates very long output", async () => {
    const long = "x".repeat(200_000);
    const fakeSpawn: SpawnFn = (() =>
      createFakeProc({
        stdout: long,
        stderr: "",
        exitCode: 0,
      })) as any;

    const result = await runAgy({ prompt: "long output" }, fakeSpawn);
    expect(result.stdout.length).toBeLessThanOrEqual(100_100);
    expect(result.stdout).toContain("truncated");
  });

  test("throws AGY_NOT_FOUND when spawn fails to find binary", async () => {
    const badSpawn: SpawnFn = (() => {
      const err: any = new Error("spawn agy ENOENT");
      err.code = "ENOENT";
      throw err;
    }) as any;

    try {
      await runAgy({ prompt: "notfound" }, badSpawn);
    } catch (e: any) {
      expect(e.code).toBe("AGY_NOT_FOUND");
    }
  });
});
