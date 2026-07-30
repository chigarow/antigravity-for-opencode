import { describe, test, expect } from "bun:test";
import { runAgy } from "../src/agy-runner";

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
        tier: "flash-3.5-hi",
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
});
