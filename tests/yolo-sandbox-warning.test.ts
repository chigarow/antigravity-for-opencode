import { describe, test, expect } from "bun:test";
import { buildAgyToolResult } from "../src/index";
import type { AgyResult } from "../src/agy-runner";

const fakeResult: AgyResult = {
  stdout: "task complete",
  stderr: "",
  exitCode: 0,
  durationMs: 42,
};

describe("yolo + sandbox visible warning (S2)", () => {
  test("output contains visible warning when yolo=true AND sandbox=true", () => {
    const result = buildAgyToolResult(
      { prompt: "x", yolo: true, sandbox: true },
      fakeResult
    );

    // S2 requirement: output must contain a visible warning about the
    // dangerous yolo+sandbox combination.
    expect(String(result.output).toLowerCase()).toContain("warning");
  });

  test("metadata preserves both yolo and sandbox flags", () => {
    const result = buildAgyToolResult(
      { prompt: "x", yolo: true, sandbox: true },
      fakeResult
    );

    // S2 requirement: both flags must be preserved in metadata.
    expect(result.metadata?.sandbox).toBe(true);
    expect(result.metadata?.yolo).toBe(true);
  });
});

describe("header / stdout separator (Wave 5.5 regression)", () => {
  test("newline separates 'exit: 0' line from stdout (no 'exit: 0task' concatenation)", () => {
    const result = buildAgyToolResult(
      { prompt: "x" },
      { stdout: "task complete", stderr: "", exitCode: 0, durationMs: 42 }
    );
    // The E2E defect: header ended with 'exit: 0' directly joined to stdout.
    expect(result.output).toContain("exit: 0\n");
    expect(result.output).not.toContain("exit: 0task");
    // stdout content is still present after the separator.
    expect(result.output).toContain("task complete");
  });

  test("newline separates WARNING line from stdout (yolo+sandbox)", () => {
    const result = buildAgyToolResult(
      { prompt: "x", yolo: true, sandbox: true },
      { stdout: "I will run the task", stderr: "", exitCode: 0, durationMs: 99 }
    );
    // WARNING line must not run directly into stdout text.
    expect(result.output).not.toMatch(/WARNING.*I will run/);
    expect(result.output).toContain("\nI will run the task");
  });
});

describe("buildAgyToolResult tier reporting", () => {
  test("no tier defaults to flash-3.5 in header, title, and metadata", () => {
    // Given: buildAgyToolResult called without an explicit tier
    const result = buildAgyToolResult({ prompt: "x" }, fakeResult);

    // Then: all three surfaces report flash-3.5 (not the old bare "flash")
    expect(result.output).toContain("tier: flash-3.5");
    expect(result.title).toBe("agy (flash-3.5)");
    expect(result.metadata?.tier).toBe("flash-3.5");
  });

  test("explicit tier flash-3.6 propagates to header, title, and metadata", () => {
    // Given: buildAgyToolResult called with tier: "flash-3.6"
    // (as any cast in RED — Tier union does not include flash-3.6 yet)
    const result = buildAgyToolResult(
      { prompt: "x", tier: "flash-3.6" } as any,
      fakeResult
    );

    // Then: all three surfaces reflect the explicit tier
    expect(result.output).toContain("tier: flash-3.6");
    expect(result.title).toBe("agy (flash-3.6)");
    expect(result.metadata?.tier).toBe("flash-3.6");
  });
});
