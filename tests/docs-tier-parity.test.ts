import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const files = ["README.md", "commands/agy.md", "skills/opencode-agy/SKILL.md"];
const expected = [
  ...["flash-3.8", "claude-sonnet-5-5", "claude-opus-5-5", "argon-4"]
    .flatMap((prefix) => ["hi", "med", "lo"].map((effort) => `${prefix}-${effort}`)),
  "neon-4-hi", "neon-4-med", "neon-4-lo", "neon-4-xhigh",
  ...["hydrogen-4"].flatMap((prefix) => ["hi", "med", "lo"].map((effort) => `${prefix}-${effort}`)),
  "hydrogen-4-xhigh",
  "gpt-oss-120b-med",
];
const read = (file: string) => readFileSync(join(import.meta.dir, "..", file), "utf8");
const sentences = (text: string) => text.split(/(?<=[.!?])\s+(?=[A-Z`])/);

function slugs(text: string): Set<string> {
  const expanded = text.replace(/([a-z0-9.-]+)-\{([a-z,]+)\}/g,
    (_, prefix: string, suffixes: string) => suffixes.split(",").map((suffix) => `${prefix}-${suffix}`).join(" "));
  return new Set(expanded.match(/(?:flash-3\.8|claude-(?:sonnet|opus)-5-5|argon-4|neon-4|hydrogen-4|gpt-oss-120b)-(?:xhigh|hi|med|lo)\b/g));
}

function neutral(span: string) {
  expect(span).not.toMatch(/1\.4\.2|\b(?:minimum|requires?|needs?|at least)\s+(?:agy|v?\d)|\b(?:agy|CLI)\s+v?\d+\.\d+|\d[\d,]*(?:\s*[km])?\s*(?:input|output|context|max|tokens?)|Pro\s*(?:\/|or|&)\s*Ultra|\b(?:Pro|Ultra|trial|student|Carbon)\b/i);
}

describe("documentation tier parity", () => {
  for (const file of files) {
    test(`${file} documents all twenty-one tiers and consistent counts`, () => {
      const text = read(file);
      const found = slugs(text);
      for (const tier of expected) expect(found.has(tier)).toBe(true);
      expect(text).not.toMatch(/\btwelve\b/i);
      expect(text).not.toContain("12 model tiers");
      const countSpans = text.split("\n").flatMap(sentences)
        .filter((span) => /\b(?:\d+|twenty-one|sixteen|twelve)\s+(?:(?:model|versioned)\s+)?tiers?\b/i.test(span));
      expect(countSpans.length).toBeGreaterThan(0);
      for (const span of countSpans) {
        expect(span).toMatch(/\b(?:twenty-one|21)\s+(?:(?:model|versioned)\s+)?tiers?\b/i);
        for (const count of span.matchAll(/\b(\d+|twenty-one|sixteen|twelve)\s+(?:(?:model|versioned)\s+)?tiers?\b/gi)) {
          expect(["21", "twenty-one"]).toContain(count[1]!.toLowerCase());
        }
      }
    });

    test(`${file} scopes Hydrogen claims to neutral sentences and rows`, () => {
      const spans = read(file).split("\n").flatMap((line) =>
        line.startsWith("|") ? [line] : sentences(line))
        .filter((span) => /hydrogen/i.test(span));
      expect(spans.length).toBeGreaterThan(0);
      for (const span of spans) neutral(span);
      if (file === "commands/agy.md") {
        const availability = read(file).split("\n").find((line) => line.startsWith("- Account availability:"))!;
        const hydrogen = sentences(availability).filter((span) => /hydrogen/i.test(span));
        expect(hydrogen.length).toBeGreaterThan(0);
        for (const span of hydrogen) neutral(span);
      }
    });
  }

  test("README features seven families, xhigh, and separate model notes", () => {
    const text = read("README.md");
    const feature = text.split("\n").find((line) => line.includes("model tiers"))!;
    for (const family of ["Gemini 3.8 Flash", "Claude Sonnet 5.5", "Claude Opus 5.5", "Gemini 4 Argon", "Gemini 4 Neon", "Gemini 4 Hydrogen", "GPT-OSS 120B"]) expect(feature).toContain(family);
    expect(feature).toMatch(/xhigh/i);
    const notes = text.match(/^> \[!NOTE\]\n(?:>[^\n]*(?:\n|$))+/gm) ?? [];
    const hydrogenNote = notes.find((note) => /hydrogen/i.test(note));
    expect(hydrogenNote).toBeDefined();
    expect(hydrogenNote!).toContain("agy models");
    neutral(hydrogenNote!);
    expect(notes.some((note) => note.includes("Gemini 4 Neon launched Nov 18, 2026"))).toBe(true);
    const warnings = text.match(/^> \[!WARNING\]\n(?:>[^\n]*(?:\n|$))+/gm) ?? [];
    expect(warnings.some((note) => note.includes("Nov 18, 2026 removal date for GPT-OSS-120b"))).toBe(true);
    expect(text).toContain("Paid Pro & Ultra");
    expect(text).toContain("Free, Plus, Pro & Ultra");
    const compatibility = text.split("\n").find((line) => line.startsWith("Model-selection smoke probes"))!;
    const hydrogen = sentences(compatibility).filter((span) => /hydrogen/i.test(span));
    expect(hydrogen.length).toBeGreaterThan(0);
    for (const span of hydrogen) neutral(span);
  });

  test("skill frontmatter includes all families and MODEL_NOT_FOUND guidance is neutral", () => {
    const text = read("skills/opencode-agy/SKILL.md");
    expect(text.split("---")[1]).toContain("(Gemini / Claude / Argon / Neon / Hydrogen / GPT-OSS)");
    const row = text.split("\n").find((line) => line.startsWith("| `MODEL_NOT_FOUND`"))!;
    expect(row).toContain("agy models");
    expect(row).not.toContain("The plan lacks the model");
  });
});
