import { describe, test, expect } from "bun:test";
import { readFileSync, writeFileSync, mkdtempSync, chmodSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * File-content and process parity checks for scripts/agy-delegate.sh tier slugs.
 * Process tests use a fake agy on PATH — never the real CLI.
 */

const SCRIPT_PATH = join(import.meta.dir, "..", "scripts", "agy-delegate.sh");

const EXPECTED_TIERS = [
  { slug: "flash-3.8-hi", display: "Gemini 3.8 Flash (High)" },
  { slug: "flash-3.8-med", display: "Gemini 3.8 Flash (Medium)" },
  { slug: "flash-3.8-lo", display: "Gemini 3.8 Flash (Low)" },
  { slug: "claude-sonnet-5-5-hi", display: "Claude Sonnet 5.5 (High)" },
  { slug: "claude-sonnet-5-5-med", display: "Claude Sonnet 5.5 (Medium)" },
  { slug: "claude-sonnet-5-5-lo", display: "Claude Sonnet 5.5 (Low)" },
  { slug: "claude-opus-5-5-hi", display: "Claude Opus 5.5 (High)" },
  { slug: "claude-opus-5-5-med", display: "Claude Opus 5.5 (Medium)" },
  { slug: "claude-opus-5-5-lo", display: "Claude Opus 5.5 (Low)" },
  { slug: "argon-4-hi", display: "Gemini 4 Argon (High)" },
  { slug: "argon-4-med", display: "Gemini 4 Argon (Medium)" },
  { slug: "argon-4-lo", display: "Gemini 4 Argon (Low)" },
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
  test("default TIER is flash-3.8-med", () => {
    // Given: the standalone delegate script source
    const source = readScript();

    // When: we inspect the default TIER assignment
    // Then: default is the versioned flash-3.8-med slug
    expect(source).toContain('TIER="flash-3.8-med"');
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

  test("usage help lists the twelve versioned tiers", () => {
    // Given: usage() heredoc
    const source = readScript();

    // When / Then: help documents all twelve tier slugs
    for (const { slug } of EXPECTED_TIERS) {
      expect(source).toContain(slug);
    }
    // Tier option line lists the new surface in canonical groups
    expect(source).toMatch(
      /--tier\s+<[^>]*flash-3\.8-hi[^>]*flash-3\.8-med[^>]*flash-3\.8-lo[^>]*claude-sonnet-5-5[^>]*claude-opus-5-5[^>]*argon-4[^>]*>/,
    );
    // --timeout help documents the uniform 15m default
    expect(source).toMatch(/--timeout.*default 15m for all tiers/);
  });

  test("uniform 15m default for every tier; explicit --timeout wins", async () => {
    // Given: a fake `agy` on a private PATH that captures every arg it receives
    const tmp = mkdtempSync(join(tmpdir(), "agy-bash-"));
    const captureFile = join(tmp, "args.txt");
    const fakeAgy = join(tmp, "agy");
    writeFileSync(
      fakeAgy,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${captureFile}"\necho "fake agy output"\n`,
    );
    chmodSync(fakeAgy, 0o755);

    async function timeoutForTier(tier: string, extra: string[] = []): Promise<string | undefined> {
      // reset capture
      try { unlinkSync(captureFile); } catch {}
      const args = ["bash", SCRIPT_PATH, "--tier", tier, ...extra, "task"];
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

    // Every tier family defaults to the uniform 15m
    expect(await timeoutForTier("flash-3.8-med")).toBe("15m");
    expect(await timeoutForTier("claude-sonnet-5-5-lo")).toBe("15m");
    expect(await timeoutForTier("claude-opus-5-5-hi")).toBe("15m");
    expect(await timeoutForTier("argon-4-hi")).toBe("15m");
    // explicit --timeout always wins, even for the heaviest tiers
    expect(await timeoutForTier("argon-4-lo", ["--timeout", "5m"])).toBe("5m");
  });

  test("omitted --tier defaults to Gemini 3.8 Flash (Medium) with 15m print-timeout", async () => {
    // Given: a fake `agy` on a private PATH that captures every arg it receives
    const tmp = mkdtempSync(join(tmpdir(), "agy-bash-default-"));
    const captureFile = join(tmp, "args.txt");
    const fakeAgy = join(tmp, "agy");
    writeFileSync(
      fakeAgy,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${captureFile}"\necho "fake agy output"\n`,
    );
    chmodSync(fakeAgy, 0o755);

    const script = join(import.meta.dir, "..", "scripts", "agy-delegate.sh");

    // When: the real script runs with NO --tier (omitted-tier default path)
    const proc = Bun.spawn(["bash", script, "task"], {
      env: { ...process.env, PATH: `${tmp}:${process.env.PATH}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;

    // Then: fake agy ran and captured the 3.8 default model + Flash-family 10m timeout
    expect(exitCode).toBe(0);
    const lines = readFileSync(captureFile, "utf8").split("\n");
    const modelIdx = lines.indexOf("--model");
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(lines[modelIdx + 1]).toBe("Gemini 3.8 Flash (Medium)");
    const timeoutIdx = lines.indexOf("--print-timeout");
    expect(timeoutIdx).toBeGreaterThanOrEqual(0);
    expect(lines[timeoutIdx + 1]).toBe("15m");
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

  test("usage help tier list is exactly the twelve v0.11.0 tiers", () => {
    // Given: usage() --tier option line
    const source = readScript();
    const m = source.match(/--tier\s+<([^>]+)>/);
    expect(m).not.toBeNull();
    const listed = new Set(
      m![1]
        .split("|")
        .map((s) => s.trim())
        .filter(Boolean),
    );
    const expected = new Set(EXPECTED_TIERS.map((t) => t.slug));
    expect(listed).toEqual(expected);
  });

  test("process rejects all removed tiers with unknown tier", async () => {
    // Given: fake agy on PATH so model_for_tier runs
    const tmp = mkdtempSync(join(tmpdir(), "agy-bash-reject-"));
    const fakeAgy = join(tmp, "agy");
    writeFileSync(fakeAgy, `#!/usr/bin/env bash\necho fake\n`);
    chmodSync(fakeAgy, 0o755);
    const script = SCRIPT_PATH;
    const removed = ["flash-3.5", "flash-3.5-hi", "flash-3.5-med", "flash-3.5-lo", "pro-3.1", "pro-3.1-hi", "pro-3.1-lo", "flash-3.6", "flash-3.6-hi", "flash-3.6-med", "flash-3.6-lo", "flash-3.7-hi", "flash-3.7-med", "flash-3.7-lo", "flash", "flash-lo", "pro", "gpt-oss-120b-medium"];
    for (const tier of removed) {
      const proc = Bun.spawn(["bash", script, "--tier", tier, "task"], {
        env: { ...process.env, PATH: `${tmp}:${process.env.PATH}` },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stderr, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode).not.toBe(0);
      expect(stderr).toMatch(/unknown tier/i);
    }
  });

  test("removed High tiers die even when --model is set (no agy invoke)", async () => {
    // Given: fake agy that writes an invocation marker if ever reached
    const tmp = mkdtempSync(join(tmpdir(), "agy-bash-model-bypass-"));
    const marker = join(tmp, "invoked");
    const fakeAgy = join(tmp, "agy");
    writeFileSync(
      fakeAgy,
      `#!/usr/bin/env bash\ntouch "${marker}"\necho fake\n`,
    );
    chmodSync(fakeAgy, 0o755);
    const removed = ["flash-3.5-hi", "pro-3.1", "pro-3.1-lo", "flash-3.6", "flash-3.7-med", "gpt-oss-120b-medium"] as const;

    for (const tier of removed) {
      try { unlinkSync(marker); } catch {}
      // When: invalid tier is combined with an explicit exact model override
      const proc = Bun.spawn(
        ["bash", SCRIPT_PATH, "--tier", tier, "--model", "Custom Model", "task"],
        {
          env: { ...process.env, PATH: `${tmp}:${process.env.PATH}` },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stderr, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      // Then: non-zero exit, exact unknown-tier message, agy never ran
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain(`unknown tier '${tier}'`);
      let markerPresent = true;
      try {
        readFileSync(marker);
      } catch {
        markerPresent = false;
      }
      expect(markerPresent).toBe(false);
    }
  });

  test("valid tier + custom --model reaches fake agy with exact model", async () => {
    // Given: fake agy that records args and an invocation marker
    const tmp = mkdtempSync(join(tmpdir(), "agy-bash-custom-model-"));
    const marker = join(tmp, "invoked");
    const captureFile = join(tmp, "args.txt");
    const fakeAgy = join(tmp, "agy");
    writeFileSync(
      fakeAgy,
      `#!/usr/bin/env bash\ntouch "${marker}"\nprintf '%s\\n' "$@" > "${captureFile}"\necho "fake agy output"\n`,
    );
    chmodSync(fakeAgy, 0o755);

    // When: a valid tier is paired with an explicit exact model override
    const proc = Bun.spawn(
      ["bash", SCRIPT_PATH, "--tier", "argon-4-med", "--model", "Custom Model", "task"],
      {
        env: { ...process.env, PATH: `${tmp}:${process.env.PATH}` },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const exitCode = await proc.exited;

    // Then: fake agy ran and the exact model was forwarded unchanged
    expect(exitCode).toBe(0);
    expect(readFileSync(marker, "utf8")).toBeDefined();
    const lines = readFileSync(captureFile, "utf8").split("\n");
    const modelIdx = lines.indexOf("--model");
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(lines[modelIdx + 1]).toBe("Custom Model");
  });
});
