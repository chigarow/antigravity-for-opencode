import { describe, expect, test } from "bun:test";
import { autoTier, classifyTask } from "../src/agy-route";
import { buildAgyArgs, resolvedTier } from "../src/agy-runner";

describe("classifyTask", () => {
  test("short or simple questions stay simple", () => {
    expect(classifyTask("x")).toBe("simple");
    expect(classifyTask("do something")).toBe("simple");
    expect(classifyTask("Reply with exactly the word ok and nothing else.")).toBe("simple");
    expect(classifyTask("What is a monorepo?")).toBe("simple");
    expect(classifyTask("Explain this sentence.")).toBe("simple");
  });

  test("normal coding requests are coding", () => {
    expect(classifyTask("Implement a function promedio_columna(ruta, columna) in Python.")).toBe("coding");
    expect(classifyTask("Add tests for confinedDir in agy-runner.ts")).toBe("coding");
    expect(classifyTask("Fix the bug in src/index.ts")).toBe("coding");
    expect(classifyTask("Please look at this", ["src/agy-runner.ts"])).toBe("coding");
  });

  test("architecture and large migrations are hard", () => {
    expect(classifyTask("Design the architecture for a distributed queue with failover.")).toBe("hard");
    expect(classifyTask("Security audit the auth flow and produce a threat model.")).toBe("hard");
    expect(classifyTask("Rewrite the system from scratch as a multi-repo platform.")).toBe("hard");
  });

  test("six named code files plus refactor is hard, and CODE_EXT_RE.test still finds later files", () => {
    const files = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"];
    expect(classifyTask("please refactor these modules", files)).toBe("hard");
    expect(classifyTask("please refactor a.ts b.ts c.ts d.ts e.ts f.ts")).toBe("hard");
    // Shared /g lastIndex would make the second .test skip; this must stay coding.
    expect(classifyTask("look at notes.md then fix src/index.ts")).toBe("coding");
    expect(classifyTask("fix the typo in this sentence")).toBe("simple");
  });
});

describe("auto-route vs explicit tier", () => {
  test("omitted tier on a simple prompt still maps to Flash Medium (existing default tests)", () => {
    expect(autoTier("do something")).toBe("flash-3.8-med");
    const args = buildAgyArgs({ prompt: "do something" });
    expect(args).toContain("Gemini 3.8 Flash (Medium)");
  });

  test("coding without a tier goes to hydrogen medium", () => {
    const prompt = "Implement a function promedio_columna(ruta, columna) in Python.";
    expect(resolvedTier({ prompt })).toBe("hydrogen-4-med");
    expect(buildAgyArgs({ prompt })).toContain("Gemini 4 Hydrogen (Medium)");
  });

  test("hard without a tier goes to hydrogen high", () => {
    const prompt = "Design the architecture for a distributed queue with failover.";
    expect(resolvedTier({ prompt })).toBe("hydrogen-4-hi");
    expect(buildAgyArgs({ prompt })).toContain("Gemini 4 Hydrogen (High)");
  });

  test("an explicit tier always wins, even on a hard prompt", () => {
    const prompt = "Design the architecture for a distributed queue with failover.";
    const args = buildAgyArgs({ prompt, tier: "flash-3.8-lo" });
    expect(args).toContain("Gemini 3.8 Flash (Low)");
    expect(args).not.toContain("Gemini 4 Hydrogen (High)");
  });

  test("an explicit model always wins", () => {
    const prompt = "Implement a function foo()";
    const args = buildAgyArgs({ prompt, model: "Claude Opus 5.5 (High)" });
    expect(args).toContain("Claude Opus 5.5 (High)");
    expect(args).not.toContain("Gemini 4 Hydrogen (Medium)");
  });
});

