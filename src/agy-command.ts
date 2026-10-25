/**
 * Embedded `/agy` command source and parser.
 *
 * `commands/agy.md` is the sole source of truth for the slash command.
 * It is imported as raw text at build time (Bun text loader) so the
 * bundled `dist/index.js` carries the command with zero runtime file
 * dependency. This module parses the frontmatter `description` field
 * and the body `template`, validates existing config definitions, and
 * produces a fresh definition object on every call.
 */

import agyCommandMarkdown from "../commands/agy.md";
import type { AgyResult, Tier } from "./agy-runner";

/** Parsed result of {@link parseAgyCommand}. */
export interface ParsedCommand {
  readonly description: string;
  readonly template: string;
}

/**
 * Shape of a single entry in `config.command[key]`.
 * Mirrors the OpenCode SDK `Config.command` value type.
 */
export interface CommandDef {
  readonly template: string;
  readonly description?: string;
  readonly agent?: string;
  readonly model?: string;
  readonly subtask?: boolean;
}

/** Stable machine-readable parser failure codes. */
export type AgyCommandParseErrorCode =
  | "MISSING_FRONTMATTER"
  | "UNCLOSED_FRONTMATTER"
  | "UNSUPPORTED_FRONTMATTER_FIELD"
  | "DUPLICATE_DESCRIPTION"
  | "MISSING_DESCRIPTION"
  | "EMPTY_DESCRIPTION"
  | "EMPTY_TEMPLATE";

/** Deterministic error thrown when command markdown cannot be parsed. */
export class AgyCommandParseError extends Error {
  readonly code: AgyCommandParseErrorCode;

  constructor(message: string, code: AgyCommandParseErrorCode) {
    super(message);
    this.name = "AgyCommandParseError";
    this.code = code;
  }
}

const FRONTMATTER_DELIMITER = "---";
const DESCRIPTION_PREFIX = "description:";

/**
 * Parse raw command markdown into `{ description, template }`.
 *
 * Accepts exactly one frontmatter block delimited by `---` lines,
 * extracts the `description` field, and treats the remaining body as
 * the template. Throws {@link AgyCommandParseError} on any structural
 * problem so callers get a deterministic, typed failure.
 */
export function parseAgyCommand(markdown: string): ParsedCommand {
  const lines = markdown.split("\n");

  if (lines[0]?.trim() !== FRONTMATTER_DELIMITER) {
    throw new AgyCommandParseError(
      "Command markdown must start with a '---' frontmatter delimiter",
      "MISSING_FRONTMATTER",
    );
  }

  let closingIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === FRONTMATTER_DELIMITER) {
      closingIndex = i;
      break;
    }
  }

  if (closingIndex === -1) {
    throw new AgyCommandParseError(
      "Command markdown frontmatter is not closed",
      "UNCLOSED_FRONTMATTER",
    );
  }

  let description: string | undefined;
  for (let i = 1; i < closingIndex; i++) {
    const line = (lines[i] ?? "").trim();
    if (line.length === 0) continue;
    if (!line.startsWith(DESCRIPTION_PREFIX)) {
      throw new AgyCommandParseError(
        "Command markdown frontmatter only supports the 'description' field",
        "UNSUPPORTED_FRONTMATTER_FIELD",
      );
    }
    if (description !== undefined) {
      throw new AgyCommandParseError(
        "Command markdown frontmatter contains duplicate 'description' fields",
        "DUPLICATE_DESCRIPTION",
      );
    }
    description = line.slice(DESCRIPTION_PREFIX.length).trim();
  }

  if (description === undefined) {
    throw new AgyCommandParseError(
      "Command markdown frontmatter must contain a 'description' field",
      "MISSING_DESCRIPTION",
    );
  }
  if (description.length === 0) {
    throw new AgyCommandParseError(
      "Command markdown frontmatter description must not be empty",
      "EMPTY_DESCRIPTION",
    );
  }

  const template = lines.slice(closingIndex + 1).join("\n").trim();
  if (template.length === 0) {
    throw new AgyCommandParseError(
      "Command markdown body (template) must not be empty",
      "EMPTY_TEMPLATE",
    );
  }

  return { description, template };
}

/**
 * Type guard: is `value` a schema-valid command definition?
 *
 * A valid definition has a non-empty `template` string and every
 * present optional field (`description`, `agent`, `model`, `subtask`)
 * has the correct primitive type. `null`, `undefined`, and malformed
 * objects all return `false` so the caller can safely replace them.
 */
export function isCommandDef(value: unknown): value is CommandDef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const def = value as Record<string, unknown>;
  // The template must be the definition's own string. `in` would accept an
  // inherited property from a prototype, which no real config entry has.
  if (!Object.hasOwn(def, "template")) return false;
  if (typeof def.template !== "string" || def.template.trim().length === 0) return false;
  // Optional fields are type-checked when present. Unknown keys are allowed:
  // OpenCode may add command fields over time, and rejecting them would
  // silently replace a user's working definition.
  if (Object.hasOwn(def, "description") && typeof def.description !== "string") return false;
  if (Object.hasOwn(def, "agent") && typeof def.agent !== "string") return false;
  if (Object.hasOwn(def, "model") && typeof def.model !== "string") return false;
  if (Object.hasOwn(def, "subtask") && typeof def.subtask !== "boolean") return false;
  return true;
}

const registeredAddEditors = new WeakMap<object, Set<string>>();

/**
 * Insert `def` under `name` into whatever registry shape the host provides.
 *
 * Single implementation shared by v1 (`src/index.ts` config hook) and v2
 * (`src/agy-v2.ts` transform editors), idempotent for every shape:
 * - add-capable editors (OpenCode 2.x): append unless `has(name)` reports the
 *   name taken; an add-only editor (no `has`) cannot be inspected, so what
 *   this module already added is remembered per editor in a WeakMap (the
 *   editor itself is never mutated);
 * - Map registries: `set` unless `isValid` accepts the existing entry;
 * - Array registries: push when absent, replace in place when invalid
 *   (inserted entries are tagged with `name` so repeat calls can find them);
 * - plain object registries: assign unless an own `name` key holds a value
 *   `isValid` accepts.
 * An entry `isValid` accepts is always preserved by identity (never copied),
 * and sibling entries are never touched.
 */
export function upsertRegistryEntry(
  editor: any,
  name: string,
  def: unknown,
  isValid: (value: unknown) => boolean,
): void {
  if (typeof editor?.add === "function") {
    if (typeof editor.has === "function") {
      if (editor.has(name)) return;
    } else {
      // Add-only editor: remember per editor which names we already added.
      let seen = registeredAddEditors.get(editor);
      if (!seen) {
        seen = new Set();
        registeredAddEditors.set(editor, seen);
      }
      if (seen.has(name)) return;
      seen.add(name);
    }
    editor.add(def);
    return;
  }
  if (editor instanceof Map) {
    if (!isValid(editor.get(name))) editor.set(name, def);
    return;
  }
  if (Array.isArray(editor)) {
    const index = editor.findIndex((entry) => entry?.name === name);
    if (index === -1) {
      editor.push({ name, ...(def as Record<string, unknown>) });
      return;
    }
    if (isValid(editor[index])) return;
    editor.splice(index, 1, { name, ...(def as Record<string, unknown>) });
    return;
  }
  if (
    editor &&
    typeof editor === "object" &&
    !(Object.hasOwn(editor, name) && isValid(editor[name]))
  ) {
    editor[name] = def;
  }
}

/**
 * Produce a fresh `{ description, template }` from the embedded
 * `commands/agy.md` source. Each call returns an independent object
 * so independent configs never share mutable state.
 */
export function createAgyCommand(): ParsedCommand {
  return parseAgyCommand(agyCommandMarkdown);
}

/**
 * Arguments accepted by the agy tool and by {@link buildAgyToolResult}.
 * Mirrors the tool schema one-to-one.
 */
export interface AgyToolArgs {
  prompt: string;
  tier?: Tier;
  dir?: string;
  project?: string;
  timeout?: string | number;
  yolo?: boolean;
  sandbox?: boolean;
  continue?: boolean;
  conversation?: string;
  model?: string;
}

/**
 * Pure success-path builder for the agy tool result.
 * Extracted so tests can verify header/metadata/warning logic without
 * spawning real agy or leaking a global module mock.
 *
 * Lives here (not in src/index.ts) so the entry module can keep a
 * default-only runtime export surface (opencode 1.19.4 loader safety).
 */
export function buildAgyToolResult(args: AgyToolArgs, result: AgyResult | undefined) {
  if (!result) {
    return {
      title: `agy error (UNDEFINED_RESULT)`,
      output: [
        "AGY_UNDEFINED_RESULT",
        "agy runner returned an undefined result. This usually means the tool was invoked by an incompatible OpenCode version.",
        "Please report this issue.",
      ].join("\n"),
      metadata: { error: true, unexpected: true, code: "UNDEFINED_RESULT" },
    };
  }
  const header = [
    `## agy result`,
    `tier: ${args.tier ?? "flash-3.8-med"}`,
    `duration: ${result.durationMs}ms`,
    `exit: ${result.exitCode}`,
    args.sandbox ? `sandbox: true` : "",
    (args.continue || args.conversation) ? `resumed: true` : "",
    (args.yolo && args.sandbox)
      ? "WARNING: yolo (--dangerously-skip-permissions) + sandbox both enabled. agy will auto-approve every tool inside a restricted terminal."
      : "",
    ``,
  ].filter(Boolean).join("\n");

  return {
    title: `agy (${args.tier ?? "flash-3.8-med"})`,
    output: header + "\n" + result.stdout,
    metadata: {
      tier: args.tier ?? "flash-3.8-med",
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      tool: "agy",
      sandbox: !!args.sandbox,
      yolo: !!args.yolo,
      resumed: !!(args.continue || args.conversation),
      ...(result.conversationId ? { conversationId: result.conversationId } : {}),
    },
  };
}
