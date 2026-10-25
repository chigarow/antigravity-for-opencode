import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  readFileSync,
  existsSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Process tests for scripts/agy-delegate.sh hardening.
 * Every test drives the REAL script via Bun.spawn with a stub `agy` placed
 * first on PATH. AGY_WORKSPACE_ROOT and TMPDIR point into a per-test sandbox
 * so the real repo and host temp files are never touched.
 */

const SCRIPT = join(import.meta.dir, "..", "scripts", "agy-delegate.sh");

const cleanups: string[] = [];
afterAll(() => {
  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true });
});

let sandbox = "";
let bin = "";
let ws = "";
let canonicalWs = "";
let capture = "";
let permFile = "";
let logPathFile = "";
let outFile = "";
let errFile = "";

function realpathSync(p: string): string {
  const r = Bun.spawnSync(["realpath", p]);
  if (r.exitCode !== 0) throw new Error(`realpath failed for ${p}`);
  return r.stdout.toString().trim();
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "agy-delegate-test-"));
  cleanups.push(sandbox);
  bin = join(sandbox, "bin");
  ws = join(sandbox, "ws");
  mkdirSync(bin, { recursive: true });
  mkdirSync(ws, { recursive: true });
  canonicalWs = realpathSync(ws);
  capture = join(sandbox, "args.txt");
  permFile = join(sandbox, "logdir-perm.txt");
  logPathFile = join(sandbox, "logpath.txt");
  outFile = join(sandbox, "stub-out.txt");
  errFile = join(sandbox, "stub-err.txt");
});

/** Stub agy: records argv, probes --log-file dir perms, prints fixture, exits with code. */
function writeStub(opts: { code?: number; outBody?: string; errBody?: string } = {}) {
  writeFileSync(outFile, opts.outBody !== undefined ? opts.outBody : "fake agy output");
  if (opts.errBody !== undefined) writeFileSync(errFile, opts.errBody);
  const lines = [
    "#!/usr/bin/env bash",
    `printf '%s\\n' "$@" > "${capture}"`,
    `prev=""`,
    `for a in "$@"; do`,
    `  if [ "$prev" = "--log-file" ]; then`,
    `    d="$(dirname "$a")"`,
    `    { stat -c '%a' "$d" 2>/dev/null || stat -f '%Lp' "$d" 2>/dev/null; } > "${permFile}"`,
    `    printf '%s\\n' "$a" > "${logPathFile}"`,
    `  fi`,
    `  prev="$a"`,
    `done`,
    `[ -f "${outFile}" ] && cat "${outFile}"`,
    `[ -f "${errFile}" ] && cat "${errFile}" >&2`,
    `exit ${opts.code ?? 0}`,
    "",
  ];
  const agyPath = join(bin, "agy");
  writeFileSync(agyPath, lines.join("\n"));
  chmodSync(agyPath, 0o755);
}

function env(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    AGY_WORKSPACE_ROOT: canonicalWs,
    TMPDIR: sandbox,
    // Deterministic: no yolo host consent unless a test explicitly grants it.
    AGY_ALLOW_YOLO: "",
    ...extra,
  } as Record<string, string>;
}

async function runScript(
  args: string[],
  opts: { cwd?: string; stdin?: string; env?: Record<string, string> } = {},
) {
  const proc = Bun.spawn(["bash", SCRIPT, ...args], {
    cwd: opts.cwd ?? ws,
    env: env(opts.env),
    stdin: opts.stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (opts.stdin !== undefined) {
    proc.stdin.write(opts.stdin);
    proc.stdin.end();
  }
  const exitCode = await proc.exited;
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function capturedArgs(): string[] {
  return readFileSync(capture, "utf8").replace(/\n$/, "").split("\n");
}

function argAfter(flag: string): string | undefined {
  const args = capturedArgs();
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

async function runTimeout(timeout: string) {
  writeStub();
  const res = await runScript(["--timeout", timeout, "task"]);
  return {
    ...res,
    forwarded: existsSync(capture) ? argAfter("--print-timeout") : undefined,
  };
}

describe("agy-delegate.sh hardening", () => {
  // --- mutual exclusion ---------------------------------------------------

  test("--continue + --conversation rejected with exit 2, both flags named", async () => {
    writeStub();
    const { exitCode, stderr } = await runScript([
      "--continue",
      "--conversation",
      "abc-123",
      "task",
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("--continue");
    expect(stderr).toContain("--conversation");
    expect(existsSync(capture)).toBe(false);
  });

  test("--conversation before --continue is order-independent (exit 2)", async () => {
    writeStub();
    const { exitCode, stderr } = await runScript([
      "--conversation",
      "abc-123",
      "--continue",
      "task",
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("--continue");
    expect(stderr).toContain("--conversation");
    expect(existsSync(capture)).toBe(false);
  });

  // --- yolo/sandbox -------------------------------------------------------

  test("--yolo without --sandbox rejected, both flags and AGY_ALLOW_YOLO named", async () => {
    writeStub();
    const { exitCode, stderr } = await runScript(["--yolo", "task"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--yolo");
    expect(stderr).toContain("--sandbox");
    expect(stderr).toContain("AGY_ALLOW_YOLO");
    expect(existsSync(capture)).toBe(false);
  });

  test("--yolo + --sandbox without AGY_ALLOW_YOLO=1 host consent rejected", async () => {
    writeStub();
    const { exitCode, stderr } = await runScript(["--yolo", "--sandbox", "task"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("AGY_ALLOW_YOLO");
    expect(stderr).toContain("--yolo");
    expect(stderr).toContain("--sandbox");
    expect(existsSync(capture)).toBe(false);
  });

  test("AGY_ALLOW_YOLO other than exactly '1' is not host consent", async () => {
    writeStub();
    const { exitCode, stderr } = await runScript(["--yolo", "--sandbox", "task"], {
      env: { AGY_ALLOW_YOLO: "true" },
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("AGY_ALLOW_YOLO");
    expect(existsSync(capture)).toBe(false);
  });

  test("--yolo with --sandbox and AGY_ALLOW_YOLO=1 forwards both upstream flags", async () => {
    writeStub();
    const { exitCode } = await runScript(["--yolo", "--sandbox", "task"], {
      env: { AGY_ALLOW_YOLO: "1" },
    });
    expect(exitCode).toBe(0);
    expect(capturedArgs()).toContain("--dangerously-skip-permissions");
    expect(capturedArgs()).toContain("--sandbox");
  });

  // --- conversation id validation (parity with isValidConversationId) -------

  test.each([
    "has space",
    "/../secrets",
    "<script>",
    'ses_foo"bar',
    "ses_x", // ses_ ids need 4-64 chars after the prefix
    "a", // plain slugs need 6-64 chars
    "x".repeat(300), // too long
    "bad..id", // no '..'
    "back\\slash", // no '\'
  ])("rejects invalid --conversation %s", async (id) => {
    writeStub();
    const { exitCode, stderr } = await runScript(["--conversation", id, "task"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("invalid conversation ID");
    expect(existsSync(capture)).toBe(false);
  });

  test.each([
    "ses_abcd1234",
    "2e456db3-1111-2222-3333-54159bf7eb49",
    "caller-supplied-id",
  ])("forwards valid --conversation %s upstream", async (id) => {
    writeStub();
    const { exitCode } = await runScript(["--conversation", id, "task"]);
    expect(exitCode).toBe(0);
    expect(argAfter("--conversation")).toBe(id);
  });

  // --- option value validation --------------------------------------------

  test("--model --foo rejected (value must not start with '-')", async () => {
    writeStub();
    const { exitCode, stderr } = await runScript(["--model", "--foo", "task"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("--model");
    expect(existsSync(capture)).toBe(false);
  });

  test("--timeout --yolo rejected (value must not start with '-')", async () => {
    writeStub();
    const { exitCode, stderr } = await runScript(["--timeout", "--yolo", "task"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("--timeout");
    expect(existsSync(capture)).toBe(false);
  });

  test("empty option value rejected", async () => {
    writeStub();
    const { exitCode } = await runScript(["--tier", "", "task"]);
    expect(exitCode).not.toBe(0);
    expect(existsSync(capture)).toBe(false);
  });

  // --- timeout validation / normalization ---------------------------------

  test.each(["0", "0s", "5.5h", "1d", "abc"])(
    "rejects invalid timeout %s (nonzero, agy never runs)",
    async (t) => {
      const res = await runTimeout(t);
      expect(res.exitCode).not.toBe(0);
      expect(res.stderr).toContain("invalid timeout");
      expect(existsSync(capture)).toBe(false);
    },
  );

  test("negative timeout (-5m) rejected with the flag named", async () => {
    writeStub();
    const { exitCode, stderr } = await runScript(["--timeout", "-5m", "task"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("--timeout");
    expect(existsSync(capture)).toBe(false);
  });

  test.each([
    ["5m", "5m"],
    ["300000", "5m"],
    ["45s", "45s"],
    ["45S", "45s"],
    ["45000", "45s"],
    ["2H", "2h"],
    ["5h", "4h"],
    ["100h", "4h"],
    ["241m", "4h"],
  ])("normalises timeout %s to %s", async (raw, expected) => {
    const res = await runTimeout(raw);
    expect(res.exitCode).toBe(0);
    expect(res.forwarded).toBe(expected);
  });

  test("default timeout is 15m when --timeout omitted", async () => {
    writeStub();
    const res = await runScript(["task"]);
    expect(res.exitCode).toBe(0);
    expect(argAfter("--print-timeout")).toBe("15m");
  });

  // --- --dir containment ----------------------------------------------------

  test("--dir / rejected with DIR_NOT_ALLOWED", async () => {
    writeStub();
    const res = await runScript(["--dir", "/", "task"]);
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain("DIR_NOT_ALLOWED");
    expect(existsSync(capture)).toBe(false);
  });

  test("--dir ../../../../etc rejected with DIR_NOT_ALLOWED", async () => {
    writeStub();
    const res = await runScript(["--dir", "../../../../etc", "task"]);
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain("DIR_NOT_ALLOWED");
    expect(existsSync(capture)).toBe(false);
  });

  test("symlink escaping the workspace root rejected with DIR_NOT_ALLOWED", async () => {
    writeStub();
    symlinkSync("/etc", join(ws, "outlink"));
    const res = await runScript(["--dir", "outlink", "task"]);
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain("DIR_NOT_ALLOWED");
    expect(existsSync(capture)).toBe(false);
  });

  test("non-existent --dir rejected with DIR_NOT_ALLOWED", async () => {
    writeStub();
    const res = await runScript(["--dir", "nope", "task"]);
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain("DIR_NOT_ALLOWED");
    expect(existsSync(capture)).toBe(false);
  });

  test("--dir . forwards the resolved workspace root as --add-dir", async () => {
    writeStub();
    const res = await runScript(["--dir", ".", "task"]);
    expect(res.exitCode).toBe(0);
    expect(argAfter("--add-dir")).toBe(canonicalWs);
  });

  test("valid subdir forwards its resolved path as --add-dir", async () => {
    writeStub();
    const sub = join(ws, "sub");
    mkdirSync(sub, { recursive: true });
    const res = await runScript(["--dir", "sub", "task"]);
    expect(res.exitCode).toBe(0);
    expect(argAfter("--add-dir")).toBe(realpathSync(sub));
  });

  test("--dir . from a cwd under AGY_WORKSPACE_ROOT is allowed", async () => {
    writeStub();
    const sub = join(ws, "deeper");
    mkdirSync(sub, { recursive: true });
    const res = await runScript(["--dir", ".", "task"], { cwd: sub });
    expect(res.exitCode).toBe(0);
    expect(argAfter("--add-dir")).toBe(realpathSync(sub));
  });

  // --- stdout cap and redaction ---------------------------------------------

  test("stdout capped at 100KB with truncation marker", async () => {
    const body = "A".repeat(200 * 1024) + "ENDMARKER-9f8e7d6c\n";
    writeStub({ outBody: body });
    const { exitCode, stdout } = await runScript(["task"]);
    expect(exitCode).toBe(0);
    expect(stdout.length).toBeGreaterThan(100_000);
    expect(stdout.length).toBeLessThan(110_000);
    expect(stdout).toContain("output truncated");
    expect(stdout).not.toContain("ENDMARKER-9f8e7d6c");
  });

  test("secrets redacted in stdout", async () => {
    const aiza = "AIza" + "A".repeat(35);
    const body = [
      "ok",
      aiza,
      "Bearer abc.def.ghi",
      "sk-secrettoken123456",
      "api_key = supersecretvalue123",
      "password=hunter2",
      "done",
      "",
    ].join(" ");
    writeStub({ outBody: body });
    const { exitCode, stdout } = await runScript(["task"]);
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain(aiza);
    expect(stdout).not.toContain("abc.def.ghi");
    expect(stdout).not.toContain("sk-secrettoken123456");
    expect(stdout).not.toContain("supersecretvalue123");
    expect(stdout).not.toContain("hunter2");
    expect(stdout).toContain("[REDACTED]");
    expect(stdout).toContain("ok");
  });

  test("aws_secret_access_key-style names redacted (uppercase env var)", async () => {
    writeStub({ outBody: "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMItail9 done\n" });
    const { exitCode, stdout } = await runScript(["task"]);
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain("wJalrXUtnFEMItail9");
    expect(stdout).toContain("AWS_SECRET_ACCESS_KEY=");
    expect(stdout).toContain("[REDACTED]");
    expect(stdout).toContain("done");
  });

  test("lowercase aws_secret_access_key keeps its full name, redacts value", async () => {
    writeStub({ outBody: "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG done\n" });
    const { exitCode, stdout } = await runScript(["task"]);
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain("wJalrXUtnFEMI");
    expect(stdout).toContain("aws_secret_access_key");
    expect(stdout).toContain("[REDACTED]");
  });

  test("short ghp_/xox/AIza-shaped tokens are redacted", async () => {
    const ghp = "ghp_abc123";
    const xox = "xoxb-1234";
    const aiza = "AIzaSy0123456789";
    const body = `t ${ghp} ${xox} ${aiza} end\n`;
    writeStub({ outBody: body });
    const { exitCode, stdout } = await runScript(["task"]);
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain(ghp);
    expect(stdout).not.toContain(xox);
    expect(stdout).not.toContain(aiza);
    expect(stdout).toContain("t [REDACTED] [REDACTED] [REDACTED] end");
  });

  test("multiline PEM-style block folded to a single [REDACTED]", async () => {
    const body = [
      "before",
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEA1abcsecretbody456",
      "morebase64line",
      "-----END RSA PRIVATE KEY-----",
      "after",
      "",
    ].join("\n");
    writeStub({ outBody: body });
    const { exitCode, stdout } = await runScript(["task"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("before");
    expect(stdout).toContain("after");
    expect(stdout).toContain("[REDACTED]");
    expect(stdout).not.toContain("MIIEow");
    expect(stdout).not.toContain("morebase64line");
    expect(stdout).not.toContain("BEGIN RSA");
    expect(stdout).not.toContain("END RSA");
  });

  test("secrets redacted in echoed stderr on failure", async () => {
    const aiza = "AIza" + "B".repeat(35);
    writeStub({
      code: 4,
      errBody: `boom AIza-key=${aiza} and sk-errtoken987654 end\n`,
    });
    const { exitCode, stderr } = await runScript(["task"]);
    expect(exitCode).toBe(4);
    expect(stderr).toContain("agy exited 4");
    expect(stderr).not.toContain(aiza);
    expect(stderr).not.toContain("sk-errtoken987654");
    expect(stderr).toContain("[REDACTED]");
  });

  test("stderr surfaced on failure capped at 2KB with truncation marker, still redacted", async () => {
    const secret = "ghp_" + "Z".repeat(30);
    writeStub({
      code: 5,
      errBody: `boom ${secret} ${"E".repeat(3000)} TAIL-9f8e7d6c\n`,
    });
    const { exitCode, stderr } = await runScript(["task"]);
    expect(exitCode).toBe(5);
    expect(stderr).toContain("agy exited 5");
    expect(stderr).toContain("stderr truncated");
    // a secret inside the surfaced window is still redacted
    expect(stderr).not.toContain(secret);
    expect(stderr).toContain("[REDACTED]");
    // everything beyond the 2KB window never surfaces
    expect(stderr).not.toContain("TAIL-9f8e7d6c");
    expect(stderr.length).toBeLessThan(2200);
  });

  // --- per-run log dir --------------------------------------------------------

  test("log dir is 0700 during the run and removed afterwards", async () => {
    writeStub();
    const { exitCode } = await runScript(["task"]);
    expect(exitCode).toBe(0);
    expect(readFileSync(permFile, "utf8").trim()).toBe("700");
    expect(readFileSync(logPathFile, "utf8").trim().split("/").pop()).toBe("agy.log");
    const leftovers = readdirSync(sandbox).filter((e) => e.startsWith("agy-delegate."));
    expect(leftovers).toEqual([]);
  });

  // --- tiers, prompt plumbing, exit codes -------------------------------------

  test.each([
    ["flash-3.8-med", "Gemini 3.8 Flash (Medium)"],
    ["claude-opus-5-5-hi", "Claude Opus 5.5 (High)"],
    ["argon-4-lo", "Gemini 4 Argon (Low)"],
  ])("tier %s maps to model %s", async (slug, model) => {
    writeStub();
    const res = await runScript(["--tier", slug, "task"]);
    expect(res.exitCode).toBe(0);
    expect(argAfter("--model")).toBe(model);
  });

  test("prompt via '-' reads stdin and forwards via -p", async () => {
    writeStub();
    const res = await runScript(["-"], { stdin: "hello task" });
    expect(res.exitCode).toBe(0);
    expect(argAfter("-p")).toBe("hello task");
  });

  test("'--' terminator forwards a prompt starting with dashes", async () => {
    writeStub();
    const res = await runScript(["--", "--weird", "prompt"]);
    expect(res.exitCode).toBe(0);
    expect(argAfter("-p")).toBe("--weird prompt");
  });

  test("-h prints usage and exits 0", async () => {
    const { exitCode, stdout } = await runScript(["-h"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage");
  });

  test("empty agy output exits 3", async () => {
    writeStub({ outBody: "" });
    const res = await runScript(["task"]);
    expect(res.exitCode).toBe(3);
  });

  test("non-zero agy exit code is propagated", async () => {
    writeStub({ code: 7, errBody: "boom\n" });
    const { exitCode, stderr } = await runScript(["task"]);
    expect(exitCode).toBe(7);
    expect(stderr).toContain("agy exited 7");
    expect(stderr).toContain("boom");
  });
});
