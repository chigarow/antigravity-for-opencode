/**
 * Phase 2 latency + model validation.
 *
 * Uses the plugin Gemini-dir overlay so plugin calls do not start the user's
 * MCP servers. Never writes ~/.gemini/config/mcp_config.json.
 * Prints no secret values.
 *
 * Usage: bun scripts/phase2-bench.ts
 */
import { spawn } from "node:child_process";
import { statSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AcpClient, TIER_ACP, defaultAcpArgv, disposeAgyAcp, type AcpModelRef } from "../src/agy-acp";
import { ensureAgyOverlay, overlayChildEnv } from "../src/agy-overlay";
import { buildChildEnv, type Tier } from "../src/agy-runner";

const TASK = "Reply with exactly the word ok and nothing else.";
const AGY = process.env.AGY || "agy";
const USER_MCP = resolve(process.env.HOME || "", ".gemini/config/mcp_config.json");
const WORKSPACE = mkdtempSync(join(tmpdir(), "agy-phase2-bench-"));

function log(msg: string): void {
  console.log(msg);
}
const FLASH: AcpModelRef = { modelId: "gemini-3.8-flash", thoughtLevel: "medium" };
const FLASH_PRINT = "Gemini 3.8 Flash (Medium)";

function mcpStamp(): { mtime: string; size: number } | undefined {
  try {
    const st = statSync(USER_MCP);
    return { mtime: st.mtime.toISOString(), size: st.size };
  } catch {
    return undefined;
  }
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function runPrint(overlayDir: string, model: string, prompt: string, timeoutSec = 60): Promise<{ ms: number; text: string; exit: number; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const start = Date.now();
    const env = overlayChildEnv(
      { geminiDir: overlayDir, userGeminiDir: "", env: { GEMINI_DIR: overlayDir, ANTIGRAVITY_GEMINI_DIR: overlayDir } },
      buildChildEnv()
    );
    const proc = spawn(
      AGY,
      ["--model", model, "--print", prompt, "--print-timeout", `${timeoutSec}s`, "--output-format", "text"],
      { env, stdio: ["ignore", "pipe", "pipe"] }
    );
    let stdout = "";
    let stderr = "";
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (c) => {
      stdout += c;
    });
    proc.stderr.on("data", (c) => {
      stderr += c;
    });
    const killer = setTimeout(() => proc.kill("SIGKILL"), (timeoutSec + 15) * 1000);
    proc.on("error", (err) => {
      clearTimeout(killer);
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(killer);
      resolvePromise({ ms: Date.now() - start, text: stdout.trim(), exit: code ?? 1, stderr: stderr.slice(0, 400) });
    });
  });
}

async function withClient<T>(overlayDir: string, fn: (client: AcpClient) => Promise<T>): Promise<T> {
  const env = overlayChildEnv(
    { geminiDir: overlayDir, userGeminiDir: "", env: { GEMINI_DIR: overlayDir, ANTIGRAVITY_GEMINI_DIR: overlayDir } },
    buildChildEnv()
  );
  const client = new AcpClient({
    command: AGY,
    argv: defaultAcpArgv({ geminiDir: overlayDir }),
    env,
    cwd: WORKSPACE,
    startTimeoutMs: 60_000,
  });
  try {
    return await fn(client);
  } finally {
    await client.dispose();
  }
}

async function main() {
  const beforeMcp = mcpStamp();
  const overlay = ensureAgyOverlay();
  const results: Record<string, unknown> = {
    task: TASK,
    model: FLASH_PRINT,
    overlay: overlay.geminiDir,
    mcpBefore: beforeMcp,
  };

  const printRuns: number[] = [];
  const printOut: string[] = [];
  if (process.env.SKIP_PRINT === "1") {
    // Filled from the earlier measured run when re-running only ACP cases.
    printRuns.push(9354, 8082, 9176);
    log("PRINT skipped; using prior 9354/8082/9176");
  } else for (let i = 0; i < 3; i++) {
    const r = await runPrint(overlay.geminiDir, FLASH_PRINT, TASK);
    printRuns.push(r.ms);
    printOut.push(`${r.exit}:${r.text.slice(0, 40)}`);
    log(`PRINT#${i + 1} ${r.ms}ms exit=${r.exit} text=${JSON.stringify(r.text.slice(0, 40))}`);
  }
  results.printNoMcp = { runsMs: printRuns, medianMs: median(printRuns), samples: printOut };

  log("ACP_COLD_BEGIN");
  const coldRuns: number[] = [];
  const coldOut: string[] = [];
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    const r = await withClient(overlay.geminiDir, async (client) => {
      await client.start();
      return client.runPrompt({ cwd: WORKSPACE, prompt: TASK, model: FLASH, timeoutMs: 60_000 });
    });
    const ms = Date.now() - t0;
    coldRuns.push(ms);
    coldOut.push(r.text.slice(0, 40));
    log(`COLD#${i + 1} ${ms}ms text=${JSON.stringify(r.text.slice(0, 40))}`);
  }
  results.firstCallNoPrewarm = { runsMs: coldRuns, medianMs: median(coldRuns), samples: coldOut };

  const warmFirst: number[] = [];
  const prewarmMs: number[] = [];
  const warmFirstOut: string[] = [];
  for (let i = 0; i < 3; i++) {
    const pw = Date.now();
    await withClient(overlay.geminiDir, async (client) => {
      await client.start();
      await client.prewarmSession(WORKSPACE);
      prewarmMs.push(Date.now() - pw);
      const t0 = Date.now();
      const r = await client.runPrompt({ cwd: WORKSPACE, prompt: TASK, model: FLASH, timeoutMs: 60_000 });
      const ms = Date.now() - t0;
      warmFirst.push(ms);
      warmFirstOut.push(r.text.slice(0, 40));
      log(`PREWARM_READY#${i + 1} ${prewarmMs[i]}ms  FIRST#${i + 1} ${ms}ms text=${JSON.stringify(r.text.slice(0, 40))}`);
    });
  }
  results.prewarmSetup = { runsMs: prewarmMs, medianMs: median(prewarmMs) };
  results.firstCallWithPrewarm = { runsMs: warmFirst, medianMs: median(warmFirst), samples: warmFirstOut };

  const reuse: number[] = [];
  const reuseOut: string[] = [];
  await withClient(overlay.geminiDir, async (client) => {
    await client.start();
    await client.prewarmSession(WORKSPACE);
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now();
      const r = await client.runPrompt({ cwd: WORKSPACE, prompt: TASK, model: FLASH, timeoutMs: 60_000 });
      const ms = Date.now() - t0;
      reuse.push(ms);
      reuseOut.push(r.text.slice(0, 40));
      log(`REUSE#${i + 1} ${ms}ms text=${JSON.stringify(r.text.slice(0, 40))}`);
    }
  });
  results.acpReuse = { runsMs: reuse, medianMs: median(reuse), samples: reuseOut };

  // Validate every plugin tier with one warm process.
  const models: { tier: Tier; ok: boolean; ms: number; text?: string; error?: string }[] = [];
  await withClient(overlay.geminiDir, async (client) => {
    await client.start();
    for (const tier of Object.keys(TIER_ACP) as Tier[]) {
      const t0 = Date.now();
      try {
        const r = await client.runPrompt({
          cwd: WORKSPACE,
          prompt: TASK,
          model: TIER_ACP[tier],
          timeoutMs: 90_000,
        });
        const ms = Date.now() - t0;
        const ok = /\bok\b/i.test(r.text);
        models.push({ tier, ok, ms, text: r.text.slice(0, 80) });
        log(`MODEL ${tier} ${ok ? "OK" : "UNEXPECTED"} ${ms}ms ${JSON.stringify(r.text.slice(0, 60))}`);
      } catch (err) {
        const ms = Date.now() - t0;
        const message = err instanceof Error ? err.message : String(err);
        models.push({ tier, ok: false, ms, error: message.slice(0, 300) });
        log(`MODEL ${tier} FAIL ${ms}ms ${message.slice(0, 200)}`);
        // no retry
      }
    }
  });
  results.models = models;
  const afterMcp = mcpStamp();
  results.mcpAfter = afterMcp;
  results.mcpUnchanged = Boolean(
    beforeMcp &&
      afterMcp &&
      beforeMcp.mtime === afterMcp.mtime &&
      beforeMcp.size === afterMcp.size
  );

  console.log("JSON_RESULT_START");
  log(JSON.stringify(results, null, 2));
  log("JSON_RESULT_END");
  await disposeAgyAcp();
}

main().catch(async (err) => {
  console.error("BENCH_FAILED", err instanceof Error ? err.message : String(err));
  await disposeAgyAcp().catch(() => {});
  process.exit(1);
});
