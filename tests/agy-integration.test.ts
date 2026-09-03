import { describe, test, expect } from "bun:test";
import { runAgy, AgyError } from "../src/agy-runner";

// Gate: skip unless agy is on PATH AND AGY_INTEGRATION=1
const hasAgy = await (async () => {
  try {
    const proc = Bun.spawn(["which", "agy"], { stdout: "pipe" });
    await proc.exited;
    return proc.exitCode === 0;
  } catch {
    return false;
  }
})();

const integrationEnabled = hasAgy && process.env.AGY_INTEGRATION === "1";

describe("real agy integration (headless)", () => {
  test.skipIf(!integrationEnabled)("simple prompt returns output or times out gracefully", async () => {
    try {
      const result = await runAgy({
        prompt: "Reply with exactly the word: INTEGRATION_OK and nothing else.",
        tier: "flash-3.8-lo",
        timeout: "25s",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.toUpperCase()).toContain("INTEGRATION_OK");
    } catch (e: any) {
      // Acceptable in slow/CI environments
      if (e.code === "TIMEOUT" || e.code === "QUOTA_EXHAUSTED") {
        console.log("[integration] agy slow or limited, got expected error:", e.code);
        return;
      }
      throw e;
    }
  }, 30000);

  test.skipIf(!integrationEnabled)("flash-3.7-hi tier returns output or times out gracefully", async () => {
    try {
      const result = await runAgy({
        prompt: "Reply with exactly the word: GEM37_OK and nothing else.",
        tier: "flash-3.7-hi",
        timeout: "25s",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.toUpperCase()).toContain("GEM37_OK");
    } catch (e: unknown) {
      // Acceptable in slow/CI environments — same tolerance as the existing live test
      if (e instanceof AgyError && (e.code === "TIMEOUT" || e.code === "QUOTA_EXHAUSTED")) {
        console.log("[integration] agy slow or limited, got expected error:", e.code);
        return;
      }
      throw e;
    }
  }, 30000);

  test.skipIf(!integrationEnabled)("flash-3.8-med tier (new default model) returns output or times out gracefully", async () => {
    try {
      const result = await runAgy({
        prompt: "Reply with exactly the word: GEM38_OK and nothing else.",
        tier: "flash-3.8-med",
        timeout: "25s",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.toUpperCase()).toContain("GEM38_OK");
    } catch (e: unknown) {
      // Acceptable in slow/CI environments — same tolerance as the existing live tests
      if (e instanceof AgyError && (e.code === "TIMEOUT" || e.code === "QUOTA_EXHAUSTED")) {
        console.log("[integration] agy slow or limited, got expected error:", e.code);
        return;
      }
      throw e;
    }
  }, 30000);

  test.skipIf(!integrationEnabled)("omitted tier resolves to the default model or times out gracefully", async () => {
    try {
      const result = await runAgy({
        prompt: "Reply with exactly the word: DEFAULT_OK and nothing else.",
        timeout: "25s",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.toUpperCase()).toContain("DEFAULT_OK");
    } catch (e: unknown) {
      // Acceptable in slow/CI environments — same tolerance as the existing live tests
      if (e instanceof AgyError && (e.code === "TIMEOUT" || e.code === "QUOTA_EXHAUSTED")) {
        console.log("[integration] agy slow or limited, got expected error:", e.code);
        return;
      }
      throw e;
    }
  }, 30000);
});
