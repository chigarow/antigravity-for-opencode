import { describe, test, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { runAgy, AgyError } from "../src/agy-runner";

// ─── Gate: skip unless agy is on PATH AND AGY_INTEGRATION=1 ──────────────
// Mirrors the `which agy` PATH check from tests/agy-integration.test.ts:1-12,
// extended with an explicit opt-in env var so a normal `bun test` skips
// these heavyweight live-LLM tests entirely.
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

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * High-entropy canary token, generated per-run.
 * NEVER appears in the prompt or filename — only inside file content.
 * If agy's stdout contains this exact string, it MUST have read the file.
 */
function generateToken(): string {
  return `GROUND_TOKEN_${randomUUID().slice(0, 8)}`;
}

/** Create a throwaway temp directory. Caller MUST clean up via cleanupDir. */
async function createTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agy-ground-"));
}

/** Recursively remove a temp directory, ignoring errors. */
async function cleanupDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe("file-grounding integration (adversarial)", () => {
  test.skipIf(!integrationEnabled)(
    "grounded-TXT: reads real file content with yolo + dir",
    async () => {
      const token = generateToken();
      const tempDir = await createTempDir();
      try {
        const filePath = join(tempDir, "secret.txt");
        await writeFile(filePath, `The secret token is: ${token}\n`, "utf-8");

        const result = await runAgy({
          prompt: `Read the file at ${filePath} and output ONLY the exact token you find, nothing else.`,
          dir: tempDir,
          yolo: true,
          tier: "flash-3.6-lo",
          timeout: "2m",
        });

        expect(result.exitCode).toBe(0);
        // The token exists ONLY in the file. Finding it proves real grounding.
        expect(result.stdout).toContain(token);
      } finally {
        await cleanupDir(tempDir);
      }
    },
    180_000,
  );

  test.skipIf(!integrationEnabled)(
    "grounded-TXT-sandbox: sandbox does not block file reads",
    async () => {
      const token = generateToken();
      const tempDir = await createTempDir();
      try {
        const filePath = join(tempDir, "secret.txt");
        await writeFile(filePath, `The secret token is: ${token}\n`, "utf-8");

        const result = await runAgy({
          prompt: `Read the file at ${filePath} and output ONLY the exact token you find, nothing else.`,
          dir: tempDir,
          yolo: true,
          sandbox: true,
          tier: "flash-3.6-lo",
          timeout: "2m",
        });

        expect(result.exitCode).toBe(0);
        // Sandbox restricts terminal commands, NOT file reads. Token must still appear.
        expect(result.stdout).toContain(token);
      } finally {
        await cleanupDir(tempDir);
      }
    },
    180_000,
  );

  test.skipIf(!integrationEnabled)(
    "negative-nonexistent: does not hallucinate a token for a missing file",
    async () => {
      const tempDir = await createTempDir();
      try {
        const ghostPath = join(tempDir, "does-not-exist.txt");

        try {
          const result = await runAgy({
            prompt: `Read the file at ${ghostPath} and output ONLY the exact token you find.`,
            dir: tempDir,
            yolo: true,
            tier: "flash-3.6-lo",
            timeout: "1m",
          });

          // The file does not exist, so the model must NOT fabricate a token.
          // Any GROUND_TOKEN_ prefix in stdout is hallucination.
          expect(result.stdout).not.toMatch(/GROUND_TOKEN_/);
        } catch (e) {
          // TIMEOUT / EMPTY_OUTPUT means agy produced no output — no hallucination.
          if (e instanceof AgyError && (e.code === "TIMEOUT" || e.code === "EMPTY_OUTPUT")) {
            return;
          }
          throw e;
        }
      } finally {
        await cleanupDir(tempDir);
      }
    },
    90_000,
  );

  test.skipIf(!integrationEnabled)(
    "negative-no-yolo: permission deadlock prevents file read without yolo",
    async () => {
      const token = generateToken();
      const tempDir = await createTempDir();
      try {
        const filePath = join(tempDir, "secret.txt");
        await writeFile(filePath, `The secret token is: ${token}\n`, "utf-8");

        try {
          const result = await runAgy({
            prompt: `Read the file at ${filePath} and output ONLY the exact token you find.`,
            dir: tempDir,
            // NO yolo — MCP file-reading tools default to "Ask" permission,
            // which deadlocks in headless --print mode (no TTY to approve).
            tier: "flash-3.6-lo",
            timeout: "30s",
          });

          // If agy returned (model gave up without reading), the token must
          // NOT be present — proving the file was never actually read.
          expect(result.stdout).not.toContain(token);
        } catch (e) {
          // A TIMEOUT is the expected outcome of the permission deadlock.
          if (e instanceof AgyError && e.code === "TIMEOUT") {
            return; // deadlock confirmed — pass
          }
          throw e;
        }
      } finally {
        await cleanupDir(tempDir);
      }
    },
    60_000,
  );
});
