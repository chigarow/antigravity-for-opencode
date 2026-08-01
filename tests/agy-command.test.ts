import { describe, test, expect } from "bun:test";
import {
  parseAgyCommand,
  createAgyCommand,
  isCommandDef,
  AgyCommandParseError,
} from "../src/agy-command";

describe("parseAgyCommand", () => {
  test("parses the real commands/agy.md embedded source with exact description", () => {
    // Given: the embedded command source (bundled raw text of commands/agy.md)
    const cmd = createAgyCommand();
    // When/Then: description is the exact machine-consumed frontmatter value
    expect(cmd.description).toBe(
      "Delegate a task to agy (Antigravity / Gemini sub-agent)",
    );
  });

  test("parsed template preserves $ARGUMENTS and is non-empty", () => {
    // Given: the embedded command source
    const cmd = createAgyCommand();
    // When/Then: $ARGUMENTS placeholder is intact in the template
    expect(cmd.template.includes("$ARGUMENTS")).toBe(true);
    expect(cmd.template.length).toBeGreaterThan(0);
  });

  test("parses a well-formed frontmatter + body correctly", () => {
    // Given: a minimal well-formed command document
    const input = "---\ndescription: My test command\n---\nDo the thing:\n$ARGUMENTS\n";
    // When
    const result = parseAgyCommand(input);
    // Then
    expect(result.description).toBe("My test command");
    expect(result.template).toBe("Do the thing:\n$ARGUMENTS");
  });

  test("throws AgyCommandParseError when frontmatter delimiter is missing", () => {
    expect(() => parseAgyCommand("no frontmatter here")).toThrow(
      AgyCommandParseError,
    );
  });

  test("throws AgyCommandParseError when frontmatter is never closed", () => {
    const input = "---\ndescription: broken\nbody without close";
    expect(() => parseAgyCommand(input)).toThrow(AgyCommandParseError);
  });

  test("throws AgyCommandParseError when description field is absent", () => {
    const input = "---\nsome_other_field: value\n---\nbody\n";
    expect(() => parseAgyCommand(input)).toThrow(AgyCommandParseError);
  });

  test("throws AgyCommandParseError when description value is empty", () => {
    const input = "---\ndescription:   \n---\nbody\n";
    expect(() => parseAgyCommand(input)).toThrow(AgyCommandParseError);
  });

  test("throws AgyCommandParseError when frontmatter has an unsupported field", () => {
    const input = "---\ntitle: unsupported\n---\nbody\n";
    expect(() => parseAgyCommand(input)).toThrow(AgyCommandParseError);
  });
 
  test("throws AgyCommandParseError when description is duplicated", () => {
    const input = "---\ndescription: first\ndescription: second\n---\nbody\n";
    expect(() => parseAgyCommand(input)).toThrow(AgyCommandParseError);
  });

  test("throws AgyCommandParseError when body (template) is empty", () => {
    const input = "---\ndescription: valid\n---\n   \n  \n";
    expect(() => parseAgyCommand(input)).toThrow(AgyCommandParseError);
  });

  test("throws AgyCommandParseError on empty string input", () => {
    expect(() => parseAgyCommand("")).toThrow(AgyCommandParseError);
  });
});

describe("createAgyCommand freshness", () => {
  test("returns independent objects on repeated calls", () => {
    // Given: two calls to createAgyCommand
    const a = createAgyCommand();
    const b = createAgyCommand();
    // Then: equal values but not the same reference
    expect(a).not.toBe(b);
    expect(a.description).toBe(b.description);
    expect(a.template).toBe(b.template);
    // Mutating one must not affect the other
    Object.assign(a, { template: "mutated" });
    expect(b.template).not.toBe("mutated");
  });
});

describe("isCommandDef validation", () => {
  test("accepts a minimal valid definition with non-empty template", () => {
    expect(isCommandDef({ template: "do something" })).toBe(true);
  });

  test("accepts a definition with all optional fields correctly typed", () => {
    expect(
      isCommandDef({
        template: "do something",
        description: "desc",
        agent: "build",
        model: "anthropic/claude",
        subtask: true,
      }),
    ).toBe(true);
  });

  test("rejects null", () => {
    expect(isCommandDef(null)).toBe(false);
  });

  test("rejects undefined", () => {
    expect(isCommandDef(undefined)).toBe(false);
  });

  test("rejects empty template string", () => {
    expect(isCommandDef({ template: "" })).toBe(false);
  });

  test("rejects missing template key", () => {
    expect(isCommandDef({ description: "no template" })).toBe(false);
  });

  test("rejects wrong-typed optional fields", () => {
    expect(isCommandDef({ template: "ok", agent: 123 })).toBe(false);
    expect(isCommandDef({ template: "ok", subtask: "yes" })).toBe(false);
  });

  test("rejects arrays", () => {
    expect(isCommandDef(["template"])).toBe(false);
  });
});
