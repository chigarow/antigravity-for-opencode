import { describe, test, expect } from "bun:test";
import { readFileSync, writeFileSync, mkdtempSync, chmodSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
    slug: "flash-3.5-med",
    display: "Gemini 3.5 Flash (Medium)",
  },
  {
    slug: "pro-3.1",
    display: "Gemini 3.1 Pro (High)",
  },
  {
    slug: "pro-3.1-lo",
    display: "Gemini 3.1 Pro (Low)",
  },
  {
    slug: "flash-3.6",
    display: "Gemini 3.6 Flash (High)",
  },
  {
    slug: "flash-3.6-med",
    display: "Gemini 3.6 Flash (Medium)",
  },
  {
    slug: "flash-3.6-lo",
    display: "Gemini 3.6 Flash (Low)",
  },
];

/** Case arm whose sole pattern is exactly `slug)` (no compound patterns). */
function soleCaseArm(slug: string): RegExp {
  // bash case arm: optional indent, exact slug, closing paren
  return new RegExp(`^\\s*${slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`, "m");
}

function readScript(): string {
  return readFileSync(SCRIPT_PATH, "utf8");
}

describe("bash tier parity (scripts/agy-delegate.sh)", () => {
  test("default TIER is flash-3.6-med", () => {
    // Given: the standalone delegate script source
    const source = readScript();

    // When: we inspect the default TIER assignment
    // Then: default is the versioned flash-3.6-med slug
    expect(source).toContain('TIER="flash-3.6-med"');
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

  test("usage help lists the eight versioned tiers", () => {
    // Given: usage() heredoc
    const source = readScript();

    // When / Then: help documents all eight tier slugs
    for (const { slug } of EXPECTED_TIERS) {
      expect(source).toContain(slug);
    }
    // Tier option line should list them (not the legacy bare trio alone)
    expect(source).toMatch(
      /--tier\s+<[^>]*flash-3\.5[^>]*flash-3\.5-lo[^>]*flash-3\.5-med[^>]*pro-3\.1[^>]*pro-3\.1-lo[^>]*flash-3\.6[^>]*flash-3\.6-med[^>]*flash-3\.6-lo[^>]*>/,
    );
    // --timeout help line should list all flash-family tiers that default to 10m
    expect(source).toMatch(/--timeout.*flash-3\.5.*flash-3\.5-lo.*flash-3\.5-med.*flash-3\.6.*flash-3\.6-med.*flash-3\.6-lo/);
    // --timeout help should list pro family (15m default)
    expect(source).toMatch(/pro-3\.1.*pro-3\.1-lo/);
  });

  test("tier-aware default timeout: pro family → 15m, flash family → 10m, explicit --timeout wins", async () => {
    // Given: a fake `agy` on a private PATH that captures every arg it receives
    const tmp = mkdtempSync(join(tmpdir(), "agy-bash-"));
    const captureFile = join(tmp, "args.txt");
    const fakeAgy = join(tmp, "agy");
    writeFileSync(
      fakeAgy,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${captureFile}"\necho "fake agy output"\n`,
    );
    chmodSync(fakeAgy, 0o755);

    const script = join(import.meta.dir, "..", "scripts", "agy-delegate.sh");

    async function timeoutForTier(tier: string, extra: string[] = []): Promise<string | undefined> {
      // reset capture
      try { unlinkSync(captureFile); } catch {}
      const args = ["bash", script, "--tier", tier, ...extra, "task"];
      const proc = Bun.spawn(args, {
        env: { ...process.env, PATH: `${tmp}:${process.env.PATH}` },
        stdout: "pipe",
        stderr: "pipe",
      });
      await proc.exited;
      const lines = readFileSync(captureFile, "utf8").split("\n");
      const idx = lines.indexOf("--print-timeout");
      return idx >= 0 ? lines[idx + 1] : undefined;
    }

    // pro-3.1-lo defaults to 15m (Pro family)
    expect(await timeoutForTier("pro-3.1-lo")).toBe("15m");
    // pro-3.1 also defaults to 15m (verifying the bash timeout fix for existing tier)
    expect(await timeoutForTier("pro-3.1")).toBe("15m");
    // flash-3.5-med defaults to 10m (Flash family)
    expect(await timeoutForTier("flash-3.5-med")).toBe("10m");
    // flash-3.6-med (default tier) also 10m
    expect(await timeoutForTier("flash-3.6-med")).toBe("10m");
    // explicit --timeout always wins, even for Pro family
    expect(await timeoutForTier("pro-3.1-lo", ["--timeout", "5m"])).toBe("5m");
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

  test("bash -n accepts scripts/agy-delegate.sh (model_for_tier case is closed)", async () => {
    // Given: the standalone delegate script on disk
    // When: the real bash parser validates it with bash -n
    const proc = Bun.spawn(["bash", "-n", SCRIPT_PATH], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stderr, exitCode] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    // Then: zero exit status — missing esac / other syntax errors must fail this test
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
  });
});
