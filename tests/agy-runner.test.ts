import { describe, test, expect, afterEach } from "bun:test";
import {
  buildAgyArgs,
  runAgy,
  AgyError,
  parseConversationIdFromLog,
  scrubSecrets,
  type SpawnFn,
} from "../src/agy-runner";
import path from "node:path";
import { statSync, existsSync } from "node:fs";
import { tmpdir } from "os";

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
  test("defaults to flash-3.8-med tier and 10m timeout", () => {
    const args = buildAgyArgs({ prompt: "do something" });
    expect(args).toContain("--model");
    expect(args).toContain("Gemini 3.8 Flash (Medium)");
    expect(args).toContain("--print-timeout");
    expect(args).toContain("10m");
    expect(args).toContain("-p");
    expect(args[args.length - 1]).toBe("do something");
  });

  test("maps all eleven versioned tiers correctly", () => {
    expect(buildAgyArgs({ prompt: "x", tier: "flash-3.8-hi" })).toContain(
      "Gemini 3.8 Flash (High)"
    );
    expect(buildAgyArgs({ prompt: "x", tier: "flash-3.8-lo" })).toContain(
      "Gemini 3.8 Flash (Low)"
    );
    expect(buildAgyArgs({ prompt: "x", tier: "flash-3.8-med" })).toContain(
      "Gemini 3.8 Flash (Medium)"
    );
    expect(buildAgyArgs({ prompt: "x", tier: "pro-3.1-hi" })).toContain(
      "Gemini 3.1 Pro (High)"
    );
    expect(buildAgyArgs({ prompt: "x", tier: "pro-3.1-lo" })).toContain(
      "Gemini 3.1 Pro (Low)"
    );
    expect(buildAgyArgs({ prompt: "x", tier: "flash-3.6-hi" })).toContain(
      "Gemini 3.6 Flash (High)"
    );
    expect(buildAgyArgs({ prompt: "x", tier: "flash-3.6-med" })).toContain(
      "Gemini 3.6 Flash (Medium)"
    );
    expect(buildAgyArgs({ prompt: "x", tier: "flash-3.6-lo" })).toContain(
      "Gemini 3.6 Flash (Low)"
    );
    expect(buildAgyArgs({ prompt: "x", tier: "flash-3.7-hi" })).toContain(
      "Gemini 3.7 Flash (High)"
    );
    expect(buildAgyArgs({ prompt: "x", tier: "flash-3.7-med" })).toContain(
      "Gemini 3.7 Flash (Medium)"
    );
    expect(buildAgyArgs({ prompt: "x", tier: "flash-3.7-lo" })).toContain(
      "Gemini 3.7 Flash (Low)"
    );
  });

  test("adds --add-dir when dir provided", () => {
    const args = buildAgyArgs({ prompt: "x", dir: "/tmp/repo" });
    expect(args).toContain("--add-dir");
    expect(args).toContain("/tmp/repo");
  });

  test("adds --project when project provided", () => {
    const args = buildAgyArgs({ prompt: "x", project: "my-proj" });
    expect(args).toContain("--project");
    expect(args).toContain("my-proj");
    // -p and prompt must still be last
    const pIndex = args.lastIndexOf("-p");
    expect(pIndex).toBeGreaterThan(0);
    expect(args[pIndex + 1]).toBe("x");
  });

  test("adds --dangerously-skip-permissions when yolo=true", () => {
    const args = buildAgyArgs({ prompt: "x", yolo: true });
    expect(args).toContain("--dangerously-skip-permissions");
  });

  test("respects custom timeout", () => {
    const args = buildAgyArgs({ prompt: "x", timeout: "10m" });
    expect(args).toContain("10m");
  });

  test("coerces numeric ms (300000) to 5m", () => {
    const args = buildAgyArgs({ prompt: "x", timeout: 300000 });
    expect(args).toContain("5m");
  });

  test("coerces digit-string 300000 ms to 5m", () => {
    const args = buildAgyArgs({ prompt: "x", timeout: "300000" });
    expect(args).toContain("5m");
  });

  test("coerces numeric ms (600000) to 10m", () => {
    const args = buildAgyArgs({ prompt: "x", timeout: 600000 });
    expect(args).toContain("10m");
  });

  test("passes through formatted 300s string", () => {
    const args = buildAgyArgs({ prompt: "x", timeout: "300s" });
    expect(args).toContain("300s");
  });

  test("passes through formatted 15m string", () => {
    const args = buildAgyArgs({ prompt: "x", timeout: "15m" });
    expect(args).toContain("15m");
  });

  test("coerces small numeric ms (45000) to 45s", () => {
    const args = buildAgyArgs({ prompt: "x", timeout: 45000 });
    expect(args).toContain("45s");
  });

  test("normalizes 0 or small to seconds", () => {
    expect(buildAgyArgs({ prompt: "x", timeout: 0 })).toContain("0s");
    expect(buildAgyArgs({ prompt: "x", timeout: 5000 })).toContain("5s");
  });

  test("always puts -p and prompt as last arguments", () => {
    const args = buildAgyArgs({ prompt: "final task here" });
    const pIndex = args.lastIndexOf("-p");
    expect(pIndex).toBeGreaterThan(0);
    expect(args[pIndex + 1]).toBe("final task here");
  });

  // ---- tier-aware defaults + 4h cap ----

  test("pro-3.1-hi tier with no explicit timeout defaults to 15m", () => {
    const args = buildAgyArgs({ prompt: "x", tier: "pro-3.1-hi" });
    expect(args).toContain("15m");
  });

  test("pro-3.1-hi tier with explicit timeout uses the explicit value, not the tier default", () => {
    const args = buildAgyArgs({ prompt: "x", tier: "pro-3.1-hi", timeout: "5m" });
    expect(args).toContain("5m");
    expect(args).not.toContain("15m");
  });

  // ---- flash-3.6-hi + timeout matrix + model override (TDD RED) ----

  test("flash-3.6-hi maps to Gemini 3.6 Flash (High) and defaults timeout to 10m", () => {
    const args = buildAgyArgs({ prompt: "x", tier: "flash-3.6-hi" });
    expect(args).toContain("Gemini 3.6 Flash (High)");
    expect(args).toContain("10m");
  });

  test("flash-3.6-lo maps to Gemini 3.6 Flash (Low) and defaults timeout to 10m", () => {
    const args = buildAgyArgs({ prompt: "x", tier: "flash-3.6-lo" });
    expect(args).toContain("Gemini 3.6 Flash (Low)");
    expect(args).toContain("10m");
  });

  test("flash-3.6-lo is distinct from flash-3.6-hi (different model strings)", () => {
    const loArgs = buildAgyArgs({ prompt: "x", tier: "flash-3.6-lo" });
    const hiArgs = buildAgyArgs({ prompt: "x", tier: "flash-3.6-hi" });
    expect(loArgs).toContain("Gemini 3.6 Flash (Low)");
    expect(hiArgs).toContain("Gemini 3.6 Flash (High)");
    expect(loArgs).not.toContain("Gemini 3.6 Flash (High)");
    expect(hiArgs).not.toContain("Gemini 3.6 Flash (Low)");
  });

  test("flash-3.6-med maps to Gemini 3.6 Flash (Medium) and defaults timeout to 10m", () => {
    const args = buildAgyArgs({ prompt: "x", tier: "flash-3.6-med" });
    expect(args).toContain("Gemini 3.6 Flash (Medium)");
    expect(args).toContain("10m");
    // Pairing: explicit flash-3.6-med stays 3.6 while the omitted tier defaults to 3.8
    const omittedArgs = buildAgyArgs({ prompt: "x" });
    expect(omittedArgs).toContain("Gemini 3.8 Flash (Medium)");
    expect(omittedArgs).not.toContain("Gemini 3.6 Flash (Medium)");
  });

  test("flash-3.6-med is distinct from flash-3.6-hi and flash-3.6-lo", () => {
    const medArgs = buildAgyArgs({ prompt: "x", tier: "flash-3.6-med" });
    const hiArgs = buildAgyArgs({ prompt: "x", tier: "flash-3.6-hi" });
    const loArgs = buildAgyArgs({ prompt: "x", tier: "flash-3.6-lo" });
    expect(medArgs).toContain("Gemini 3.6 Flash (Medium)");
    expect(hiArgs).toContain("Gemini 3.6 Flash (High)");
    expect(loArgs).toContain("Gemini 3.6 Flash (Low)");
    expect(medArgs).not.toContain("Gemini 3.6 Flash (High)");
    expect(medArgs).not.toContain("Gemini 3.6 Flash (Low)");
    expect(hiArgs).not.toContain("Gemini 3.6 Flash (Medium)");
    expect(loArgs).not.toContain("Gemini 3.6 Flash (Medium)");
  });

  // ---- flash-3.7 family: mapping, 10m default, distinctness, overrides (TDD RED) ----

  test("flash-3.7-hi maps to Gemini 3.7 Flash (High) and defaults timeout to 10m", () => {
    // Given: the new Gemini 3.7 Flash (High) tier
    // When: buildAgyArgs runs without an explicit timeout
    const args = buildAgyArgs({ prompt: "x", tier: "flash-3.7-hi" });
    // Then: the frozen display name and the Flash-family 10m default are emitted
    expect(args).toContain("Gemini 3.7 Flash (High)");
    expect(args).toContain("10m");
  });

  test("flash-3.7-med maps to Gemini 3.7 Flash (Medium) and defaults timeout to 10m", () => {
    // Given: the new Gemini 3.7 Flash (Medium) tier
    const args = buildAgyArgs({ prompt: "x", tier: "flash-3.7-med" });
    // When / Then: display name and 10m default
    expect(args).toContain("Gemini 3.7 Flash (Medium)");
    expect(args).toContain("10m");
  });

  test("flash-3.7-lo maps to Gemini 3.7 Flash (Low) and defaults timeout to 10m", () => {
    // Given: the new Gemini 3.7 Flash (Low) tier
    const args = buildAgyArgs({ prompt: "x", tier: "flash-3.7-lo" });
    // When / Then: display name and 10m default
    expect(args).toContain("Gemini 3.7 Flash (Low)");
    expect(args).toContain("10m");
  });

  test("flash-3.7 tiers are pairwise distinct (hi, med, lo map to different display names)", () => {
    // Given: all three 3.7 tiers
    const hiArgs = buildAgyArgs({ prompt: "x", tier: "flash-3.7-hi" });
    const medArgs = buildAgyArgs({ prompt: "x", tier: "flash-3.7-med" });
    const loArgs = buildAgyArgs({ prompt: "x", tier: "flash-3.7-lo" });
    // When / Then: each emits its own display name and never another 3.7 name
    expect(hiArgs).toContain("Gemini 3.7 Flash (High)");
    expect(medArgs).toContain("Gemini 3.7 Flash (Medium)");
    expect(loArgs).toContain("Gemini 3.7 Flash (Low)");
    expect(hiArgs).not.toContain("Gemini 3.7 Flash (Medium)");
    expect(hiArgs).not.toContain("Gemini 3.7 Flash (Low)");
    expect(medArgs).not.toContain("Gemini 3.7 Flash (High)");
    expect(medArgs).not.toContain("Gemini 3.7 Flash (Low)");
    expect(loArgs).not.toContain("Gemini 3.7 Flash (High)");
    expect(loArgs).not.toContain("Gemini 3.7 Flash (Medium)");
  });

  test("model override wins for flash-3.7-hi when both model and tier are set", () => {
    // Given: a 3.7 tier combined with an explicit exact model override
    const args = buildAgyArgs({
      prompt: "x",
      tier: "flash-3.7-hi",
      model: "Custom 3.7 High Override",
    });
    // Then: the explicit model is emitted, the tier display name is not
    expect(args).toContain("Custom 3.7 High Override");
    expect(args).not.toContain("Gemini 3.7 Flash (High)");
  });

  test("flash-3.7-med with explicit timeout uses the explicit value, not the 10m default", () => {
    // Given: a 3.7 tier with an explicit timeout
    const args = buildAgyArgs({ prompt: "x", tier: "flash-3.7-med", timeout: "5m" });
    // Then: the explicit timeout wins over the tier default
    expect(args).toContain("5m");
    expect(args).not.toContain("10m");
  });

  test("flash-3.8-lo defaults timeout to 10m", () => {
    const args = buildAgyArgs({ prompt: "x", tier: "flash-3.8-lo" });
    expect(args).toContain("Gemini 3.8 Flash (Low)");
    expect(args).toContain("10m");
  });

  test("flash-3.8-hi defaults timeout to 10m when tier is explicit", () => {
    const args = buildAgyArgs({ prompt: "x", tier: "flash-3.8-hi" });
    expect(args).toContain("Gemini 3.8 Flash (High)");
    expect(args).toContain("10m");
  });

  // ---- flash-3.8-med + pro-3.1-lo tiers ----

  test("flash-3.8-med maps to Gemini 3.8 Flash (Medium) and defaults timeout to 10m", () => {
    const args = buildAgyArgs({ prompt: "x", tier: "flash-3.8-med" });
    expect(args).toContain("Gemini 3.8 Flash (Medium)");
    expect(args).toContain("10m");
  });

  test("pro-3.1-lo maps to Gemini 3.1 Pro (Low) and defaults timeout to 15m", () => {
    const args = buildAgyArgs({ prompt: "x", tier: "pro-3.1-lo" });
    expect(args).toContain("Gemini 3.1 Pro (Low)");
    expect(args).toContain("15m");
  });

  test("flash-3.8-med is distinct from flash-3.8-hi and flash-3.8-lo", () => {
    const medArgs = buildAgyArgs({ prompt: "x", tier: "flash-3.8-med" });
    const hiArgs = buildAgyArgs({ prompt: "x", tier: "flash-3.8-hi" });
    const loArgs = buildAgyArgs({ prompt: "x", tier: "flash-3.8-lo" });
    expect(medArgs).toContain("Gemini 3.8 Flash (Medium)");
    expect(hiArgs).toContain("Gemini 3.8 Flash (High)");
    expect(loArgs).toContain("Gemini 3.8 Flash (Low)");
    expect(medArgs).not.toContain("Gemini 3.8 Flash (High)");
    expect(medArgs).not.toContain("Gemini 3.8 Flash (Low)");
    expect(hiArgs).not.toContain("Gemini 3.8 Flash (Medium)");
    expect(loArgs).not.toContain("Gemini 3.8 Flash (Medium)");
  });

  test("pro-3.1-lo is distinct from pro-3.1-hi", () => {
    const loArgs = buildAgyArgs({ prompt: "x", tier: "pro-3.1-lo" });
    const hiArgs = buildAgyArgs({ prompt: "x", tier: "pro-3.1-hi" });
    expect(loArgs).toContain("Gemini 3.1 Pro (Low)");
    expect(hiArgs).toContain("Gemini 3.1 Pro (High)");
    expect(loArgs).not.toContain("Gemini 3.1 Pro (High)");
    expect(hiArgs).not.toContain("Gemini 3.1 Pro (Low)");
  });

  test("pro-3.1-lo with explicit timeout uses the explicit value, not the 15m default", () => {
    const args = buildAgyArgs({ prompt: "x", tier: "pro-3.1-lo", timeout: "5m" });
    expect(args).toContain("5m");
    expect(args).not.toContain("15m");
  });

  test("model override wins for pro-3.1-lo when both model and tier are set", () => {
    const args = buildAgyArgs({
      prompt: "x",
      tier: "pro-3.1-lo",
      model: "Custom Pro Low Override",
    });
    expect(args).toContain("Custom Pro Low Override");
    expect(args).not.toContain("Gemini 3.1 Pro (Low)");
  });

  test("model override wins when both model and tier are set", () => {
    const args = buildAgyArgs({
      prompt: "x",
      tier: "flash-3.8-hi",
      model: "Custom Override Model",
    });
    expect(args).toContain("Custom Override Model");
    expect(args).not.toContain("Gemini 3.8 Flash (High)");
  });

  // ---- INVALID_TIER: removed / unknown tier names ----

  test("throws INVALID_TIER for removed tier name flash", () => {
    try {
      buildAgyArgs({ prompt: "x", tier: "flash" as any });
      throw new Error("expected AgyError");
    } catch (e: any) {
      expect(e).toBeInstanceOf(AgyError);
      expect(e.code).toBe("INVALID_TIER");
    }
  });

  test("throws INVALID_TIER for removed tier name flash-lo", () => {
    try {
      buildAgyArgs({ prompt: "x", tier: "flash-lo" as any });
      throw new Error("expected AgyError");
    } catch (e: any) {
      expect(e).toBeInstanceOf(AgyError);
      expect(e.code).toBe("INVALID_TIER");
    }
  });

  test("throws INVALID_TIER for removed tier name pro", () => {
    try {
      buildAgyArgs({ prompt: "x", tier: "pro" as any });
      throw new Error("expected AgyError");
    } catch (e: any) {
      expect(e).toBeInstanceOf(AgyError);
      expect(e.code).toBe("INVALID_TIER");
    }
  });

  test.each(["flash-3.5-hi", "flash-3.5-med", "flash-3.5-lo"])(
    "throws INVALID_TIER for removed Gemini 3.5 tier name %s",
    (removedTier) => {
      try {
        buildAgyArgs({ prompt: "x", tier: removedTier as any });
        throw new Error("expected AgyError");
      } catch (e: any) {
        expect(e).toBeInstanceOf(AgyError);
        expect(e.code).toBe("INVALID_TIER");
      }
    }
  );

  test("caps oversized string duration (100h) at 4h", () => {
    const args = buildAgyArgs({ prompt: "x", timeout: "100h" });
    expect(args).toContain("4h");
    expect(args).not.toContain("100h");
  });

  test("caps oversized numeric ms (999999999) at 4h", () => {
    const args = buildAgyArgs({ prompt: "x", timeout: 999_999_999 });
    expect(args).toContain("4h");
  });

  // ---- INVALID_TIMEOUT: invalid numeric inputs surface as a structured error ----

  test("throws INVALID_TIMEOUT for negative numeric ms", () => {
    try {
      buildAgyArgs({ prompt: "x", timeout: -1 });
      throw new Error("expected AgyError");
    } catch (e: any) {
      expect(e).toBeInstanceOf(AgyError);
      expect(e.code).toBe("INVALID_TIMEOUT");
      expect(e.details?.value).toBe(-1);
    }
  });

  test("throws INVALID_TIMEOUT for NaN", () => {
    try {
      buildAgyArgs({ prompt: "x", timeout: Number.NaN });
      throw new Error("expected AgyError");
    } catch (e: any) {
      expect(e).toBeInstanceOf(AgyError);
      expect(e.code).toBe("INVALID_TIMEOUT");
    }
  });

  test("throws INVALID_TIMEOUT for Infinity", () => {
    try {
      buildAgyArgs({ prompt: "x", timeout: Number.POSITIVE_INFINITY });
      throw new Error("expected AgyError");
    } catch (e: any) {
      expect(e).toBeInstanceOf(AgyError);
      expect(e.code).toBe("INVALID_TIMEOUT");
    }
  });

  test("INVALID_TIMEOUT fires before spawn (buildAgyArgs is the throw site)", () => {
    const neverSpawn: SpawnFn = (() => {
      throw new Error("spawn must not run for INVALID_TIMEOUT");
    }) as any;
    // runAgy delegates to buildAgyArgs first, so this surfaces as INVALID_TIMEOUT
    // without ever touching the spawn layer.
    return expect(
      runAgy({ prompt: "x", timeout: -1 }, neverSpawn)
    ).rejects.toMatchObject({ code: "INVALID_TIMEOUT" });
  });

  test("literal 0 still coerces to 0s (preserved policy)", () => {
    const args = buildAgyArgs({ prompt: "x", timeout: 0 });
    expect(args).toContain("0s");
  });
});


describe("runAgy (injected spawn)", () => {
  // Date.now mock plumbing for tests that need a non-zero observed duration.
  let realNow: () => number;
  let savedNow: (() => number) | null = null;

  afterEach(() => {
    if (savedNow) {
      Date.now = savedNow;
      savedNow = null;
    }
  });

  function fakeElapsed(elapsedMs: number) {
    realNow = Date.now;
    let calls = 0;
    // First Date.now() (start) returns the real time;
    // every subsequent call returns start + elapsedMs.
    Date.now = () => realNow() + (++calls >= 2 ? elapsedMs : 0);
    savedNow = realNow;
  }

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
      // durationMs is now attached on every AgyError.
      expect(typeof e.details?.durationMs).toBe("number");
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

  test("classifies timeout error and surfaces explicit timeout in details", async () => {
    const fakeSpawn: SpawnFn = (() =>
      createFakeProc({
        stdout: "",
        stderr: "Error: print-timeout exceeded for request",
        exitCode: 1,
      })) as any;

    try {
      await runAgy({ prompt: "slow", timeout: "15m" }, fakeSpawn);
    } catch (e: any) {
      expect(e.code).toBe("TIMEOUT");
      expect(e.details?.timeout).toBe("15m");
    }
  });

  test("classifies timeout error and surfaces default timeout (10m) in details", async () => {
    const fakeSpawn: SpawnFn = (() =>
      createFakeProc({
        stdout: "",
        stderr: "Request timed out after --print-timeout",
        exitCode: 1,
      })) as any;

    try {
      await runAgy({ prompt: "slow" }, fakeSpawn);
    } catch (e: any) {
      expect(e.code).toBe("TIMEOUT");
      expect(e.details?.timeout).toBe("10m");
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
      // AGY_NOT_FOUND happens before proc start, so durationMs may be 0 —
      // what matters is that the field is present and the type is right.
      expect(e.details).toHaveProperty("durationMs");
      expect(typeof e.details.durationMs).toBe("number");
    }
  });

  // ---- P0 enhancements: durationMs + suggestedNextTimeout ----

  test("TIMEOUT attaches durationMs and suggestedNextTimeout (10m config, ~9m observed → '20m')", async () => {
    const fakeSpawn: SpawnFn = (() =>
      createFakeProc({
        stdout: "",
        stderr: "Error: print-timeout exceeded for request",
        exitCode: 1,
      })) as any;

    // Simulate a 9-minute run by advancing Date.now between the start
    // and post-exit reads inside runAgy.
    fakeElapsed(9 * 60 * 1000);

    try {
      await runAgy({ prompt: "slow", timeout: "10m" }, fakeSpawn);
      throw new Error("expected AgyError");
    } catch (e: any) {
      expect(e.code).toBe("TIMEOUT");
      expect(e.details?.timeout).toBe("10m");
      expect(typeof e.details?.durationMs).toBe("number");
      // 9 minutes ± small jitter from the real-now baseline.
      expect(e.details.durationMs).toBeGreaterThanOrEqual(9 * 60 * 1000 - 1000);
      // Heuristic: max(9m*1.5=13.5m→14m, 10m*2=20m, 15m) = 20m.
      expect(e.details.suggestedNextTimeout).toBe("20m");
    }
  });

  test("TIMEOUT with small configured timeout and short observed duration floors suggestion to 15m", async () => {
    const fakeSpawn: SpawnFn = (() =>
      createFakeProc({
        stdout: "",
        stderr: "Error: print-timeout exceeded for request",
        exitCode: 1,
      })) as any;

    // Configured 5m, observed 4m. Heuristic:
    //   max(4m*1.5=6m, 5m*2=10m, 15m) = 15m
    fakeElapsed(4 * 60 * 1000);

    try {
      await runAgy({ prompt: "slow", timeout: "5m" }, fakeSpawn);
      throw new Error("expected AgyError");
    } catch (e: any) {
      expect(e.code).toBe("TIMEOUT");
      expect(e.details.timeout).toBe("5m");
      expect(e.details.suggestedNextTimeout).toBe("15m");
    }
  });

  test("TIMEOUT with 4h config and ~14m observed → '480m' (hours parsing)", async () => {
    const fakeSpawn: SpawnFn = (() =>
      createFakeProc({
        stdout: "",
        stderr: "Error: print-timeout exceeded for request",
        exitCode: 1,
      })) as any;

    fakeElapsed(14 * 60 * 1000);

    try {
      await runAgy({ prompt: "slow", timeout: "4h" }, fakeSpawn);
      throw new Error("expected AgyError");
    } catch (e: any) {
      expect(e.code).toBe("TIMEOUT");
      expect(e.details?.timeout).toBe("4h");
      // Heuristic: max(14m*1.5=21m, 4h*2=480m, 15m) = 480m.
      expect(e.details.suggestedNextTimeout).toBe("480m");
    }
  });

  test("QUOTA_EXHAUSTED error includes durationMs and no suggestedNextTimeout", async () => {
    const fakeSpawn: SpawnFn = (() =>
      createFakeProc({
        stdout: "",
        stderr: "You have exceeded your quota for this model",
        exitCode: 1,
      })) as any;

    fakeElapsed(3_500);

    try {
      await runAgy({ prompt: "quota" }, fakeSpawn);
      throw new Error("expected AgyError");
    } catch (e: any) {
      expect(e.code).toBe("QUOTA_EXHAUSTED");
      expect(typeof e.details?.durationMs).toBe("number");
      expect(e.details.durationMs).toBeGreaterThanOrEqual(3_000);
      // Non-timeout errors must not carry a suggestedNextTimeout.
      expect(e.details.suggestedNextTimeout).toBeUndefined();
    }
  });

  test("EMPTY_OUTPUT error includes durationMs in details", async () => {
    const fakeSpawn: SpawnFn = (() =>
      createFakeProc({
        stdout: "   \n\n  ",
        stderr: "",
        exitCode: 0,
      })) as any;

    fakeElapsed(2_200);

    try {
      await runAgy({ prompt: "empty" }, fakeSpawn);
      throw new Error("expected AgyError");
    } catch (e: any) {
      expect(e.code).toBe("EMPTY_OUTPUT");
      expect(typeof e.details?.durationMs).toBe("number");
      expect(e.details.durationMs).toBeGreaterThanOrEqual(2_000);
      // Omitted tier: EMPTY_OUTPUT details.model must report the 3.8 default
      expect(e.details?.model).toBe("Gemini 3.8 Flash (Medium)");
    }
  });

  test("result includes conversationId when opts.conversation is provided", async () => {
    const fakeSpawn: SpawnFn = (() =>
      createFakeProc({
        stdout: "ok",
        stderr: "",
        exitCode: 0,
      })) as any;

    const result = await runAgy(
      { prompt: "x", conversation: "caller-supplied-id" },
      fakeSpawn
    );
    expect(result.conversationId).toBe("caller-supplied-id");
  });

  test("TIMEOUT error.details includes conversationId from opts.conversation", async () => {
    const fakeSpawn: SpawnFn = (() =>
      createFakeProc({
        stdout: "",
        stderr: "Error: print-timeout exceeded for request",
        exitCode: 1,
      })) as any;

    try {
      await runAgy(
        { prompt: "slow", conversation: "caller-conv-id", timeout: "5m" },
        fakeSpawn
      );
      throw new Error("expected AgyError");
    } catch (e: any) {
      expect(e.code).toBe("TIMEOUT");
      expect(e.details?.conversationId).toBe("caller-conv-id");
      // The richer TIMEOUT fields stay intact.
      expect(e.details?.timeout).toBe("5m");
      expect(e.details?.suggestedNextTimeout).toBe("15m");
    }
  });

  test("AGY_FAILED error.details includes conversationId from opts.conversation", async () => {
    const fakeSpawn: SpawnFn = (() =>
      createFakeProc({
        stdout: "",
        stderr: "some weird failure",
        exitCode: 2,
      })) as any;

    try {
      await runAgy(
        { prompt: "fail", conversation: "caller-conv-id" },
        fakeSpawn
      );
      throw new Error("expected AgyError");
    } catch (e: any) {
      expect(e.code).toBe("AGY_FAILED");
      expect(e.details?.conversationId).toBe("caller-conv-id");
    }
  });

  test("runner extracts conversationId from agy log file when no opts.conversation was passed", async () => {
    const { writeFileSync, existsSync } = await import("node:fs");
    let capturedLogPath = "";
    const fakeSpawn: SpawnFn = ((args: string[]) => {
      const logIdx = (args as string[]).indexOf("--log-file");
      expect(logIdx).toBeGreaterThanOrEqual(0);
      capturedLogPath = (args as string[])[logIdx + 1];
      writeFileSync(
        capturedLogPath,
        'conversationID="c376e6a4-1234-5678-9abc-def012345678" /usr/local/go/src/printmode.go:42\n'
      );
      return createFakeProc({
        stdout: "ok",
        stderr: "",
        exitCode: 0,
      });
    }) as any;

    const result = await runAgy({ prompt: "x" }, fakeSpawn);
    expect(result.conversationId).toBe("c376e6a4-1234-5678-9abc-def012345678");
    // Temp log file must be cleaned up after the run.
    expect(capturedLogPath).not.toBe("");
    expect(existsSync(capturedLogPath)).toBe(false);
  });

  test("opts.conversation takes priority over a value extracted from the log", async () => {
    const { writeFileSync } = await import("node:fs");
    const fakeSpawn: SpawnFn = ((args: string[]) => {
      const logIdx = (args as string[]).indexOf("--log-file");
      const logPath = (args as string[])[logIdx + 1];
      writeFileSync(logPath, 'conversationID="from-log-id"\n');
      return createFakeProc({
        stdout: "ok",
        stderr: "",
        exitCode: 0,
      });
    }) as any;

    const result = await runAgy(
      { prompt: "x", conversation: "from-caller" },
      fakeSpawn
    );
    // Caller wins.
    expect(result.conversationId).toBe("from-caller");
  });

  // ---- Pure exit-code TIMEOUT classification (no stderr) ----

  test("classifies exit code 124 (empty stderr) as TIMEOUT with default timeout echoed", async () => {
    const fakeSpawn: SpawnFn = (() =>
      createFakeProc({
        stdout: "",
        stderr: "",
        exitCode: 124,
      })) as any;

    fakeElapsed(7 * 60 * 1000); // 7m observed

    try {
      await runAgy({ prompt: "killed" }, fakeSpawn);
      throw new Error("expected AgyError");
    } catch (e: any) {
      // Pure exit-code branch — nothing on stderr.
      expect(e.code).toBe("TIMEOUT");
      expect(e.details?.exitCode).toBe(124);
      // 10m default (flash-3.8-med tier, no explicit timeout).
      expect(e.details?.timeout).toBe("10m");
      expect(typeof e.details?.durationMs).toBe("number");
      expect(e.details.durationMs).toBeGreaterThanOrEqual(7 * 60 * 1000 - 1000);
      // Heuristic: max(7m*1.5=11m→11m, 10m*2=20m, 15m) = 20m.
      expect(e.details.suggestedNextTimeout).toBe("20m");
    }
  });

  test("classifies exit code 143 (empty stderr) as TIMEOUT with explicit timeout echoed", async () => {
    const fakeSpawn: SpawnFn = (() =>
      createFakeProc({
        stdout: "",
        stderr: "",
        exitCode: 143,
      })) as any;

    fakeElapsed(11 * 60 * 1000); // 11m observed

    try {
      await runAgy({ prompt: "sigterm", timeout: "12m" }, fakeSpawn);
      throw new Error("expected AgyError");
    } catch (e: any) {
      // Pure exit-code branch — nothing on stderr.
      expect(e.code).toBe("TIMEOUT");
      expect(e.details?.exitCode).toBe(143);
      // Explicit value surfaces in details, NOT the default.
      expect(e.details?.timeout).toBe("12m");
      expect(typeof e.details?.durationMs).toBe("number");
      // Heuristic: max(11m*1.5=17m→17m, 12m*2=24m, 15m) = 24m.
      expect(e.details.suggestedNextTimeout).toBe("24m");
    }
  });

  // ---- INVALID_ARGS guard: continue + conversation is mutually exclusive ----

  test("throws INVALID_ARGS when both continue and conversation are passed (spawn never runs)", async () => {
    const neverSpawn: SpawnFn = (() => {
      throw new Error("spawn must not be called for INVALID_ARGS");
    }) as any;

    try {
      await runAgy(
        { prompt: "x", continue: true, conversation: "abc" },
        neverSpawn
      );
      throw new Error("expected AgyError");
    } catch (e: any) {
      expect(e).toBeInstanceOf(AgyError);
      expect(e.code).toBe("INVALID_ARGS");
    }
  });

  // ---- timeout echo on every classified / structured error path ----

  test("QUOTA_EXHAUSTED error echoes timeout in details", async () => {
    const fakeSpawn: SpawnFn = (() =>
      createFakeProc({
        stdout: "",
        stderr: "You have exceeded your quota for this model",
        exitCode: 1,
      })) as any;

    try {
      await runAgy({ prompt: "q", timeout: "7m" }, fakeSpawn);
      throw new Error("expected AgyError");
    } catch (e: any) {
      expect(e.code).toBe("QUOTA_EXHAUSTED");
      expect(e.details?.timeout).toBe("7m");
    }
  });

  test("AUTH_REQUIRED error echoes timeout in details", async () => {
    const fakeSpawn: SpawnFn = (() =>
      createFakeProc({
        stdout: "",
        stderr: "Please authenticate with agy first",
        exitCode: 1,
      })) as any;

    try {
      await runAgy({ prompt: "a", timeout: "3m" }, fakeSpawn);
      throw new Error("expected AgyError");
    } catch (e: any) {
      expect(e.code).toBe("AUTH_REQUIRED");
      expect(e.details?.timeout).toBe("3m");
    }
  });

  test("AGY_FAILED error echoes explicit timeout in details", async () => {
    const fakeSpawn: SpawnFn = (() =>
      createFakeProc({
        stdout: "",
        stderr: "some weird failure",
        exitCode: 2,
      })) as any;

    try {
      await runAgy({ prompt: "fail", timeout: "8m" }, fakeSpawn);
      throw new Error("expected AgyError");
    } catch (e: any) {
      expect(e.code).toBe("AGY_FAILED");
      expect(e.details?.timeout).toBe("8m");
    }
  });

  test("AGY_FAILED error echoes the default timeout (10m) when no explicit timeout is passed", async () => {
    const fakeSpawn: SpawnFn = (() =>
      createFakeProc({
        stdout: "",
        stderr: "some weird failure",
        exitCode: 2,
      })) as any;

    try {
      await runAgy({ prompt: "fail" }, fakeSpawn);
      throw new Error("expected AgyError");
    } catch (e: any) {
      expect(e.code).toBe("AGY_FAILED");
      expect(e.details?.timeout).toBe("10m");
    }
  });

  test("EMPTY_OUTPUT error echoes timeout in details", async () => {
    const fakeSpawn: SpawnFn = (() =>
      createFakeProc({
        stdout: "   \n\n  ",
        stderr: "",
        exitCode: 0,
      })) as any;

    try {
      await runAgy({ prompt: "empty", timeout: "4m" }, fakeSpawn);
      throw new Error("expected AgyError");
    } catch (e: any) {
      expect(e.code).toBe("EMPTY_OUTPUT");
      expect(e.details?.timeout).toBe("4m");
    }
  });
});


describe("parseConversationIdFromLog", () => {
  test("extracts conversationID=\"<id>\" (most explicit form)", () => {
    expect(
      parseConversationIdFromLog(
        'conversationID="c376e6a4-1234-5678-9abc-def012345678"'
      )
    ).toBe("c376e6a4-1234-5678-9abc-def012345678");
  });

  test("extracts unquoted conversationID=<id>", () => {
    expect(
      parseConversationIdFromLog("conversationID=c376e6a4-no-quotes-here")
    ).toBe("c376e6a4-no-quotes-here");
  });

  test("extracts quoted \\bconversation=\"<id>\"", () => {
    expect(parseConversationIdFromLog('conversation="abc-123"')).toBe("abc-123");
  });

  test("extracts unquoted \\bconversation=<id>", () => {
    expect(parseConversationIdFromLog("using conversation=abc-123 now")).toBe(
      "abc-123"
    );
  });

  test("extracts 'Conversation using project ID: <id>'", () => {
    expect(
      parseConversationIdFromLog("Conversation using project ID: proj-xyz-789")
    ).toBe("proj-xyz-789");
  });

  test("extracts UUID after the word 'conversation'", () => {
    expect(
      parseConversationIdFromLog(
        "resuming conversation 11111111-2222-3333-4444-555555555555 now"
      )
    ).toBe("11111111-2222-3333-4444-555555555555");
  });

  test("returns undefined when no match", () => {
    expect(parseConversationIdFromLog("some random log line, no id here")).toBeUndefined();
  });

  test("returns undefined for empty input", () => {
    expect(parseConversationIdFromLog("")).toBeUndefined();
  });

  test("prefers explicit conversationID=\"...\" over a bare UUID after 'conversation'", () => {
    const log =
      'conversationID="primary-id" then conversation 11111111-2222-3333-4444-555555555555';
    expect(parseConversationIdFromLog(log)).toBe("primary-id");
  });

  test("does not match 'myconversation=' (word boundary enforced)", () => {
    expect(parseConversationIdFromLog("myconversation=should-not-match")).toBeUndefined();
  });

  test("extracts the ID even when surrounded by printmode.go path noise", () => {
    const log =
      'INFO agy conversationID="c376e6a4-9abc-def0-1234-56789abcdef0" /usr/local/go/src/printmode.go:128 msg="starting"';
    expect(parseConversationIdFromLog(log)).toBe(
      "c376e6a4-9abc-def0-1234-56789abcdef0"
    );
  });

  // ---- Wave 5.5 regression: malformed conversationId from Go log noise ----

  test("rejects pure-punctuation captures from Go log noise (E2E: conversationId=\"\"\")\"\)", () => {
    // Real agy log noise that produced conversationId: "\"\")\"" in Wave 5 E2E.
    // Pattern 4 (\bconversation=\S+) naively captures the punctuation blob.
    expect(parseConversationIdFromLog('conversation="")')).toBeUndefined();
    expect(
      parseConversationIdFromLog('conversation="") /usr/local/go/src/printmode.go:42')
    ).toBeUndefined();
  });

  test("rejects pure-punctuation unquoted conversationID capture", () => {
    expect(parseConversationIdFromLog('conversationID="")')).toBeUndefined();
  });

  test("still extracts valid ID when malformed punctuation precedes it in the same log", () => {
    const log =
      'conversation="") /usr/local/go/src/printmode.go:42\n' +
      'conversationID="ses_real123abc" /usr/local/go/src/printmode.go:128';
    expect(parseConversationIdFromLog(log)).toBe("ses_real123abc");
  });

  // ---- Wave 5.5 follow-up: trailing punctuation normalization ----

  test("strips trailing comma from UUID capture (live E2E: conversationId=<uuid>,)", () => {
    const log = 'conversationID=2e456db3-ddc5-4310-98eb-54159bf7eb49,';
    expect(parseConversationIdFromLog(log)).toBe(
      "2e456db3-ddc5-4310-98eb-54159bf7eb49"
    );
  });

  test("strips trailing period from unquoted conversation=<id>.", () => {
    const log = 'conversation=ses_abc123XYZ.';
    expect(parseConversationIdFromLog(log)).toBe("ses_abc123XYZ");
  });

  test("strips trailing semicolon and closing paren from Go log noise", () => {
    const log =
      'conversationID="2e456db3-ddc5-4310-98eb-54159bf7eb49"); msg="done"';
    expect(parseConversationIdFromLog(log)).toBe(
      "2e456db3-ddc5-4310-98eb-54159bf7eb49"
    );
  });

  test("strips trailing closing quote from unquoted UUID capture", () => {
    const log = 'conversation=2e456db3-ddc5-4310-98eb-54159bf7eb49"';
    expect(parseConversationIdFromLog(log)).toBe(
      "2e456db3-ddc5-4310-98eb-54159bf7eb49"
    );
  });

  test("hyphenated ses_ IDs with internal hyphens are preserved", () => {
    const log = 'conversationID="ses-abc-def-123",';
    expect(parseConversationIdFromLog(log)).toBe("ses-abc-def-123");
  });
});

describe("secure per-run temp-log lifecycle (S1)", () => {
  /**
   * Type-safe extraction of the --log-file path from spawn args.
   * Uses bounds checks instead of non-null assertions or casts.
   */
  function extractLogFile(args: readonly string[]): string | undefined {
    const idx = args.indexOf("--log-file");
    if (idx < 0 || idx + 1 >= args.length) return undefined;
    return args[idx + 1];
  }

  test("success: live 0700 dir, stable agy.log, removed after settlement", async () => {
    // Given: a fake spawn that captures --log-file and stats the parent dir while alive
    let capturedFile: string | undefined;
    let liveMode: number | undefined;
    const fakeSpawn: SpawnFn = (args) => {
      const lf = extractLogFile(args);
      if (lf !== undefined) {
        capturedFile = lf;
        liveMode = statSync(path.dirname(lf)).mode & 0o777;
      }
      return createFakeProc({ stdout: "ok", stderr: "", exitCode: 0 });
    };

    // When: runAgy resolves successfully
    await runAgy({ prompt: "x" }, fakeSpawn);

    // Then: parent is under tmpdir with the stable prefix and agy.log filename
    expect(capturedFile).toBeTruthy();
    if (capturedFile === undefined) throw new Error("test setup: --log-file not captured");
    const dir = path.dirname(capturedFile);
    expect(path.dirname(dir)).toBe(tmpdir());
    expect(path.basename(dir).startsWith("opencode-agy-")).toBe(true);
    expect(path.basename(capturedFile)).toBe("agy.log");
    // And: live mode was exactly 0700
    expect(liveMode).toBe(0o700);
    // And: both file and parent directory are absent after settlement
    expect(existsSync(capturedFile)).toBe(false);
    expect(existsSync(dir)).toBe(false);
  });

  test("AGY_FAILED: per-run dir removed after unclassified nonzero failure", async () => {
    // Given: a spawn with nonzero exit and generic stderr
    let capturedDir: string | undefined;
    const fakeSpawn: SpawnFn = (args) => {
      const lf = extractLogFile(args);
      if (lf !== undefined) capturedDir = path.dirname(lf);
      return createFakeProc({ stdout: "", stderr: "unknown error", exitCode: 2 });
    };

    // When: runAgy rejects with AGY_FAILED
    try {
      await runAgy({ prompt: "fail" }, fakeSpawn);
      throw new Error("expected AgyError");
    } catch (e) {
      if (!(e instanceof AgyError)) throw e;
      expect(e.code).toBe("AGY_FAILED");
    }

    // Then: the per-run directory is absent
    if (capturedDir === undefined) throw new Error("test setup: --log-file not captured");
    expect(existsSync(capturedDir)).toBe(false);
  });

  test("EMPTY_OUTPUT: per-run dir removed after empty stdout", async () => {
    // Given: a spawn with exit 0 but empty stdout
    let capturedDir: string | undefined;
    const fakeSpawn: SpawnFn = (args) => {
      const lf = extractLogFile(args);
      if (lf !== undefined) capturedDir = path.dirname(lf);
      return createFakeProc({ stdout: "   \n\n  ", stderr: "", exitCode: 0 });
    };

    // When: runAgy rejects with EMPTY_OUTPUT
    try {
      await runAgy({ prompt: "empty" }, fakeSpawn);
      throw new Error("expected AgyError");
    } catch (e) {
      if (!(e instanceof AgyError)) throw e;
      expect(e.code).toBe("EMPTY_OUTPUT");
    }

    // Then: the per-run directory is absent
    if (capturedDir === undefined) throw new Error("test setup: --log-file not captured");
    expect(existsSync(capturedDir)).toBe(false);
  });

  test("TIMEOUT: per-run dir removed after classified timeout", async () => {
    // Given: a spawn with timeout-classified stderr (existing fixture)
    let capturedDir: string | undefined;
    const fakeSpawn: SpawnFn = (args) => {
      const lf = extractLogFile(args);
      if (lf !== undefined) capturedDir = path.dirname(lf);
      return createFakeProc({ stdout: "", stderr: "Error: print-timeout exceeded for request", exitCode: 1 });
    };

    // When: runAgy rejects with TIMEOUT
    try {
      await runAgy({ prompt: "slow", timeout: "15m" }, fakeSpawn);
      throw new Error("expected AgyError");
    } catch (e) {
      if (!(e instanceof AgyError)) throw e;
      expect(e.code).toBe("TIMEOUT");
    }

    // Then: the per-run directory is absent
    if (capturedDir === undefined) throw new Error("test setup: --log-file not captured");
    expect(existsSync(capturedDir)).toBe(false);
  });

  test("AUTH_REQUIRED: per-run dir removed after classified auth error", async () => {
    // Given: a spawn with auth-classified stderr (existing fixture)
    let capturedDir: string | undefined;
    const fakeSpawn: SpawnFn = (args) => {
      const lf = extractLogFile(args);
      if (lf !== undefined) capturedDir = path.dirname(lf);
      return createFakeProc({ stdout: "", stderr: "Please authenticate with agy first", exitCode: 1 });
    };

    // When: runAgy rejects with AUTH_REQUIRED
    try {
      await runAgy({ prompt: "auth" }, fakeSpawn);
      throw new Error("expected AgyError");
    } catch (e) {
      if (!(e instanceof AgyError)) throw e;
      expect(e.code).toBe("AUTH_REQUIRED");
    }

    // Then: the per-run directory is absent
    if (capturedDir === undefined) throw new Error("test setup: --log-file not captured");
    expect(existsSync(capturedDir)).toBe(false);
  });

  test("QUOTA_EXHAUSTED: per-run dir removed after classified quota error", async () => {
    // Given: a spawn with quota-classified stderr (existing fixture)
    let capturedDir: string | undefined;
    const fakeSpawn: SpawnFn = (args) => {
      const lf = extractLogFile(args);
      if (lf !== undefined) capturedDir = path.dirname(lf);
      return createFakeProc({ stdout: "", stderr: "You have exceeded your quota for this model", exitCode: 1 });
    };

    // When: runAgy rejects with QUOTA_EXHAUSTED
    try {
      await runAgy({ prompt: "quota" }, fakeSpawn);
      throw new Error("expected AgyError");
    } catch (e) {
      if (!(e instanceof AgyError)) throw e;
      expect(e.code).toBe("QUOTA_EXHAUSTED");
    }

    // Then: the per-run directory is absent
    if (capturedDir === undefined) throw new Error("test setup: --log-file not captured");
    expect(existsSync(capturedDir)).toBe(false);
  });

  test("AGY_NOT_FOUND: created dir removed after synchronous spawn ENOENT", async () => {
    // Given: a spawn that throws synchronously with ENOENT after --log-file was captured
    let capturedDir: string | undefined;
    const badSpawn: SpawnFn = (args) => {
      const lf = extractLogFile(args);
      if (lf !== undefined) capturedDir = path.dirname(lf);
      const err = Object.assign(new Error("spawn agy ENOENT"), { code: "ENOENT" });
      throw err;
    };

    // When: runAgy rejects with AGY_NOT_FOUND
    try {
      await runAgy({ prompt: "missing" }, badSpawn);
      throw new Error("expected AgyError");
    } catch (e) {
      if (!(e instanceof AgyError)) throw e;
      expect(e.code).toBe("AGY_NOT_FOUND");
    }

    // Then: the already-created per-run directory is absent
    if (capturedDir === undefined) throw new Error("test setup: --log-file not captured");
    expect(existsSync(capturedDir)).toBe(false);
  });

  test("concurrency: eight concurrent calls produce eight distinct dirs, all cleaned", async () => {
    // Given: eight concurrent calls with a spawn that captures each log dir
    const capturedDirs: string[] = [];
    const fakeSpawn: SpawnFn = (args) => {
      const lf = extractLogFile(args);
      if (lf !== undefined) capturedDirs.push(path.dirname(lf));
      return createFakeProc({ stdout: "ok", stderr: "", exitCode: 0 });
    };

    // When: all eight settle successfully
    await Promise.all(
      Array.from({ length: 8 }, () => runAgy({ prompt: "concurrent" }, fakeSpawn))
    );

    // Then: eight distinct parent directories were observed
    expect(capturedDirs.length).toBe(8);
    const unique = new Set(capturedDirs);
    expect(unique.size).toBe(8);
    // And: none remain on disk
    for (const dir of unique) {
      expect(existsSync(dir)).toBe(false);
    }
  });
});

describe("stderr secret scrubbing (S2)", () => {
  test("scrubs secrets from AGY_FAILED details.stderr while classification still works", async () => {
    const secretStderr =
      "Error: auth failed\nAuthorization: Bearer sk-abc123xyz\npassword=supersecret123";
    const fakeSpawn: SpawnFn = (() =>
      createFakeProc({ stdout: "", stderr: secretStderr, exitCode: 1 })) as any;

    try {
      await runAgy({ prompt: "fail" }, fakeSpawn);
      throw new Error("expected AgyError");
    } catch (e: any) {
      expect(e.code).toBe("AGY_FAILED");
      const scrubbed = e.details?.stderr as string;
      expect(scrubbed).toBeDefined();
      expect(scrubbed).not.toContain("sk-abc123xyz");
      expect(scrubbed).not.toContain("supersecret123");
      expect(scrubbed).toContain("[REDACTED]");
      // classifyError still saw raw (it matched nothing specific here, but the path is exercised)
    }
  });

  test("scrubs secrets from success result.stderr", async () => {
    const secretStderr = "token=ghp_1234567890abcdef password=foo";
    const fakeSpawn: SpawnFn = (() =>
      createFakeProc({ stdout: "ok", stderr: secretStderr, exitCode: 0 })) as any;

    const result = await runAgy({ prompt: "x" }, fakeSpawn);
    expect(result.stderr).toBeDefined();
    expect(result.stderr).not.toContain("ghp_1234567890abcdef");
    expect(result.stderr).not.toContain("password=foo");
    expect(result.stderr).toContain("[REDACTED]");
  });

  test("scrubSecrets scrubs Authorization: Bearer token", () => {
    const scrubbed = scrubSecrets(
      "Authorization: Bearer ya29.test123"
    );
    expect(scrubbed).toContain("[REDACTED]");
    expect(scrubbed).not.toContain("ya29.test123");
  });
});

