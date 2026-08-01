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
  for (const key of Object.keys(value)) {
    switch (key) {
      case "template":
      case "description":
      case "agent":
      case "model":
      case "subtask":
        break;
      default:
        return false;
    }
  }
  if (!("template" in value)) return false;
  if (typeof value.template !== "string" || value.template.trim().length === 0) return false;
  if ("description" in value && typeof value.description !== "string") return false;
  if ("agent" in value && typeof value.agent !== "string") return false;
  if ("model" in value && typeof value.model !== "string") return false;
  if ("subtask" in value && typeof value.subtask !== "boolean") return false;
  return true;
}

/**
 * Produce a fresh `{ description, template }` from the embedded
 * `commands/agy.md` source. Each call returns an independent object
 * so independent configs never share mutable state.
 */
export function createAgyCommand(): ParsedCommand {
  return parseAgyCommand(agyCommandMarkdown);
}
