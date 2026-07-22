import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * File-content parity checks for scripts/agy-delegate.sh tier slugs.
 * Pure text assertions only — never spawns agy.
 * RED until Wave 3 rewrites the bash case arms to versioned tier names.
 */

const SCRIPT_PATH = join(import.meta.dir, "..", "scripts", "agy-delegate.sh");

const EXPECTED_TIERS = [
  {
    slug: "flash-3.5",
    display: "Gemini 3.5 Flash (High)",
  },
  {
    slug: "flash-3.5-lo",
    display: "Gemini 3.5 Flash (Low)",
  },
  {
    slug: "pro-3.1",
    display: "Gemini 3.1 Pro (High)",
  },
  {
    slug: "flash-3.6",
    display: "Gemini 3.6 Flash (High)",
  },
] as const;

/** Case arm whose sole pattern is exactly `slug)` (no compound patterns). */
function soleCaseArm(slug: string): RegExp {
  // bash case arm: optional indent, exact slug, closing paren
  return new RegExp(`^\\s*${slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`, "m");
}

function readScript(): string {
  return readFileSync(SCRIPT_PATH, "utf8");
}

describe("bash tier parity (scripts/agy-delegate.sh)", () => {
  test("default TIER is flash-3.5", () => {
    // Given: the standalone delegate script source
    const source = readScript();

    // When: we inspect the default TIER assignment
    // Then: default is the versioned flash-3.5 slug (not bare flash)
    expect(source).toContain('TIER="flash-3.5"');
  });

  test("model_for_tier case arms map each versioned slug to its display name", () => {
    // Given: the model_for_tier case table
    const source = readScript();

    // When / Then: each expected sole arm exists and echoes the frozen display name
    for (const { slug, display } of EXPECTED_TIERS) {
      expect(source).toMatch(soleCaseArm(slug));
      expect(source).toContain(`echo "${display}"`);
    }
  });

  test("usage help lists the four versioned tiers", () => {
    // Given: usage() heredoc
    const source = readScript();

    // When / Then: help documents all four tier slugs
    for (const { slug } of EXPECTED_TIERS) {
      expect(source).toContain(slug);
    }
    // Tier option line should list them (not the legacy bare trio alone)
    expect(source).toMatch(
      /--tier\s+<[^>]*flash-3\.5[^>]*flash-3\.5-lo[^>]*pro-3\.1[^>]*flash-3\.6[^>]*>/,
    );
  });

  test("unknown-tier die path is still present", () => {
    // Given: model_for_tier default arm
    const source = readScript();

    // When / Then: unknown tier still dies with the machine-readable message shape
    expect(source).toMatch(/\*\).*die\s+"unknown tier/);
  });

  test("no sole case arms for legacy bare flash / flash-lo / pro", () => {
    // Given: model_for_tier case arms after Wave 3 rename
    const source = readScript();

    // When / Then: bare legacy slugs must not appear as sole arm names
    expect(source).not.toMatch(soleCaseArm("flash"));
    expect(source).not.toMatch(soleCaseArm("flash-lo"));
    expect(source).not.toMatch(soleCaseArm("pro"));
  });
});
