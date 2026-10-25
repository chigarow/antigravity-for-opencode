import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { mkdtempSync, realpathSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AgyError,
  buildAgyArgs,
  buildChildEnv,
  confinedDir,
  isValidConversationId,
  parseConversationIdFromLog,
  redactError,
  runAgy,
  scrubSecrets,
  type AgyPolicy,
  type SpawnFn,
} from "../src/agy-runner";
import { isCommandDef } from "../src/agy-command";
import { AGY_V2_TOOL_SCHEMA, setupV2Plugin } from "../src/agy-v2";

function policyFor(root: string, allowYolo = false): AgyPolicy {
  return { workspaceRoot: realpathSync(root), allowYolo };
}

function expectAgyError(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AgyError);
    expect((err as AgyError).code).toBe(code);
    return err as AgyError;
  }
  throw new Error(`expected AgyError ${code}`);
}

/** Fake child that records the spawn options and writes to the --log-file path. */
function capturingSpawn(opts: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  logBody?: string;
  hang?: boolean;
}) {
  const calls: Array<{ argv: string[]; opts: any }> = [];
  let release: (code: number) => void = () => {};
  let kills = 0;
  const spawnFn = ((argv: string[], spawnOpts: any) => {
    calls.push({ argv, opts: spawnOpts });
    const logIdx = argv.indexOf("--log-file");
    if (logIdx >= 0 && opts.logBody !== undefined) {
      writeFileSync(argv[logIdx + 1]!, opts.logBody);
    }
    const enc = new TextEncoder();
    let settle: (code: number) => void = () => {};
    const exited = new Promise<number>((resolve) => {
      settle = resolve;
      release = resolve;
    });
    if (!opts.hang) queueMicrotask(() => settle(opts.exitCode ?? 0));
    const stream = (text: string) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(enc.encode(text));
          controller.close();
        },
      });
    return {
      pid: 4242,
      stdin: { end: () => {} },
      stdout: stream(opts.stdout ?? "ok"),
      stderr: stream(opts.stderr ?? ""),
      exited,
      kill: () => {
        kills += 1;
        settle(143);
      },
    } as any;
  }) as unknown as SpawnFn;
  return { spawnFn, calls, killCount: () => kills, release: (code: number) => release(code) };
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "agy-sec-"));
  await mkdir(path.join(root, "sub", "deep"), { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("F-1 dir containment", () => {
  test("confinedDir accepts the root itself and subdirectories", () => {
    const policy = policyFor(root);
    expect(confinedDir(root, policy)).toBe(realpathSync(root));
    expect(confinedDir(path.join(root, "sub"), policy)).toBe(realpathSync(path.join(root, "sub")));
  });

  test("confinedDir rejects filesystem root, traversal, siblings and flag-like values", () => {
    const policy = policyFor(root);
    for (const bad of ["/", "../../../../etc", path.dirname(root), "-rf"]) {
      expectAgyError(() => confinedDir(bad, policy), "DIR_NOT_ALLOWED");
    }
  });

  test("confinedDir rejects a symlink inside the root that resolves outside", async () => {
    const policy = policyFor(root);
    const outside = await mkdtemp(path.join(tmpdir(), "agy-outside-"));
    try {
      const link = path.join(root, "escape");
      await symlink(outside, link);
      expectAgyError(() => confinedDir(link, policy), "DIR_NOT_ALLOWED");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("confinedDir rejects a non-existent path instead of leaking an errno", () => {
    expectAgyError(() => confinedDir(path.join(root, "nope"), policyFor(root)), "DIR_NOT_ALLOWED");
  });

  test("buildAgyArgs emits the canonical path for an allowed dir", () => {
    const args = buildAgyArgs({
      prompt: "x",
      dir: path.join(root, "sub"),
      policy: policyFor(root),
    });
    expect(args).toContain("--add-dir");
    expect(args[args.indexOf("--add-dir") + 1]).toBe(realpathSync(path.join(root, "sub")));
  });

  test("buildAgyArgs rejects dir '/' with DIR_NOT_ALLOWED", () => {
    expectAgyError(() => buildAgyArgs({ prompt: "x", dir: "/", policy: policyFor(root) }), "DIR_NOT_ALLOWED");
  });
});

describe("yolo policy gate", () => {
  test("yolo without sandbox is rejected", () => {
    expectAgyError(
      () => buildAgyArgs({ prompt: "x", yolo: true, policy: policyFor(root, true) }),
      "YOLO_NOT_APPROVED"
    );
  });

  test("yolo with sandbox but without configured consent is rejected", () => {
    expectAgyError(
      () => buildAgyArgs({ prompt: "x", yolo: true, sandbox: true, policy: policyFor(root, false) }),
      "YOLO_NOT_APPROVED"
    );
  });

  test("yolo with sandbox and configured consent is allowed", () => {
    const args = buildAgyArgs({ prompt: "x", yolo: true, sandbox: true, policy: policyFor(root, true) });
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).toContain("--sandbox");
  });

  test("sandbox alone still works without yolo", () => {
    expect(buildAgyArgs({ prompt: "x", sandbox: true, policy: policyFor(root) })).toContain("--sandbox");
  });

  test("non-boolean yolo is rejected rather than coerced by truthiness", () => {
    expectAgyError(
      () => buildAgyArgs({ prompt: "x", yolo: "false" as any, policy: policyFor(root, true) }),
      "INVALID_ARGUMENT"
    );
    expectAgyError(
      () => buildAgyArgs({ prompt: "x", sandbox: "false" as any, policy: policyFor(root) }),
      "INVALID_ARGUMENT"
    );
    expectAgyError(
      () => buildAgyArgs({ prompt: "x", continue: "false" as any, policy: policyFor(root) }),
      "INVALID_ARGUMENT"
    );
  });
});

describe("tier and flag-injection hardening", () => {
  test("prototype-chain keys are not valid tiers", () => {
    for (const tier of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expectAgyError(() => buildAgyArgs({ prompt: "x", tier: tier as any }), "INVALID_TIER");
    }
  });

  test("model, project, conversation and dir reject leading dashes and NUL", () => {
    for (const field of ["model", "project", "conversation"] as const) {
      expectAgyError(
        () => buildAgyArgs({ prompt: "x", [field]: "--help", policy: policyFor(root) } as any),
        "INVALID_ARGUMENT"
      );
      expectAgyError(
        () => buildAgyArgs({ prompt: "x", [field]: "a\0b", policy: policyFor(root) } as any),
        "INVALID_ARGUMENT"
      );
    }
    // dir has its own, more specific code.
    expectAgyError(
      () => buildAgyArgs({ prompt: "x", dir: "--help", policy: policyFor(root) }),
      "DIR_NOT_ALLOWED"
    );
  });
});

describe("timeout parsing", () => {
  test("invalid timeouts are rejected instead of passed through", () => {
    for (const t of [0, "0s", "0", "5.5h", "1d", "abc", -5, "  ", "10 minutes"]) {
      expectAgyError(() => buildAgyArgs({ prompt: "x", timeout: t as any }), "INVALID_TIMEOUT");
    }
  });

  test("valid timeouts normalize and clamp at 4h", () => {
    expect(buildAgyArgs({ prompt: "x", timeout: "5m" })).toContain("5m");
    expect(buildAgyArgs({ prompt: "x", timeout: "300s" })).toContain("300s");
    expect(buildAgyArgs({ prompt: "x", timeout: 300_000 })).toContain("5m");
    expect(buildAgyArgs({ prompt: "x", timeout: "600000" })).toContain("10m");
    expect(buildAgyArgs({ prompt: "x", timeout: "100h" })).toContain("4h");
    expect(buildAgyArgs({ prompt: "x" })).toContain("15m");
  });
});

describe("child environment and cwd", () => {
  test("spawn receives an allowlisted env and the workspace cwd", async () => {
    const { spawnFn, calls } = capturingSpawn({});
    const prev = { canary: process.env.SECRET_CANARY, aws: process.env.AWS_SECRET_ACCESS_KEY };
    process.env.SECRET_CANARY = "leak-me";
    process.env.AWS_SECRET_ACCESS_KEY = "leak-me-too";
    try {
      await runAgy({ prompt: "x", policy: policyFor(root) }, spawnFn);
    } finally {
      if (prev.canary === undefined) delete process.env.SECRET_CANARY;
      else process.env.SECRET_CANARY = prev.canary;
      if (prev.aws === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
      else process.env.AWS_SECRET_ACCESS_KEY = prev.aws;
    }
    const opts = calls[0]!.opts;
    expect(opts.env.SECRET_CANARY).toBeUndefined();
    expect(opts.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(typeof opts.env.PATH).toBe("string");
    expect(opts.cwd).toBe(realpathSync(root));
  });

  test("cwd follows dir when one is granted", async () => {
    const { spawnFn, calls } = capturingSpawn({});
    await runAgy({ prompt: "x", dir: path.join(root, "sub"), policy: policyFor(root) }, spawnFn);
    expect(calls[0]!.opts.cwd).toBe(realpathSync(path.join(root, "sub")));
  });

  test("buildChildEnv drops everything outside the allowlist", () => {
    const env = buildChildEnv({ PATH: "/bin", HOME: "/h", AWS_SECRET_ACCESS_KEY: "x", RANDOM: "y" } as any);
    expect(env.PATH).toBe("/bin");
    expect(env.HOME).toBe("/h");
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.RANDOM).toBeUndefined();
  });
});

describe("secret scrubbing", () => {
  test("redacts every required token family without keeping tails", () => {
    const text = [
      "sk-live-ABCDEFGHIJKLMNOP1234",
      "AIzaSyDUMMYfixtureKEY0123456789abcdefghij",
      "ghp_DUMMYfixtureTOKEN0123456789abcdefghij",
      "github_pat_DUMMY0123456789abcdefghij",
      "AKIAIOSFODNN7EXAMPLE",
      "xoxb-1234567890-abcdefghij",
      "FOO_SECRET=bar",
      "password: hunter2",
      "Authorization: Bearer abc.def.ghi",
    ].join("\n");
    const out = scrubSecrets(text);
    for (const leak of ["ABCDEFGHIJKLMNOP", "AIzaSy", "ghp_", "github_pat_", "AKIA", "xoxb-", "bar", "hunter2", "abc.def"]) {
      expect(out).not.toContain(leak);
    }
  });

  test("stdout is scrubbed before it reaches the caller", async () => {
    const { spawnFn } = capturingSpawn({ stdout: "key AIzaSyDUMMYfixtureKEY0123456789abcdefghij done" });
    const result = await runAgy({ prompt: "x", policy: policyFor(root) }, spawnFn);
    expect(result.stdout).not.toContain("AIzaSy");
    expect(result.stdout).toContain("[REDACTED]");
  });

  test("redactError scrubs exception messages", () => {
    expect(redactError(new Error("failed with ghp_DUMMYfixtureTOKEN0123456789abcdefghij"))).toContain("[REDACTED]");
    expect(redactError("plain")).toBe("plain");
  });
});

describe("conversation id validation and log extraction", () => {
  test("accepts documented shapes and rejects injected ones", () => {
    for (const ok of ["ses_abcd1234", "2e456db3-1111-2222-3333-54159bf7eb49", "caller-supplied-id"]) {
      expect(isValidConversationId(ok)).toBe(true);
    }
    for (const bad of ["a", "/../secrets", "--dangerously-skip-permissions", 'ses_foo"bar', "<script>", "x".repeat(300), "has space"]) {
      expect(isValidConversationId(bad)).toBe(false);
    }
  });

  test("buildAgyArgs rejects an invalid conversation id", () => {
    expectAgyError(
      () => buildAgyArgs({ prompt: "x", conversation: "--dangerously-skip-permissions" }),
      "INVALID_ARGUMENT"
    );
    expectAgyError(() => buildAgyArgs({ prompt: "x", conversation: "<script>" }), "INVALID_CONVERSATION_ID");
  });

  test("the genuine session id later in the log beats an earlier decoy", () => {
    const log = [
      'INFO ingested: reuse conversationID="ses_decoy00"',
      'INFO agy conversationID="ses_real_9f2c1a"',
    ].join("\n");
    expect(parseConversationIdFromLog(log)).toBe("ses_real_9f2c1a");
  });

  test("a decoy outside the 64 KiB tail is never read", async () => {
    const decoy = 'conversationID="ses_decoy00"\n';
    const padding = "x".repeat(200_000);
    const genuine = '\nconversationID="ses_real_9f2c1a"\n';
    const { spawnFn } = capturingSpawn({ logBody: decoy + padding + genuine });
    const result = await runAgy({ prompt: "x", policy: policyFor(root) }, spawnFn);
    expect(result.conversationId).toBe("ses_real_9f2c1a");
  });
});

describe("bounded streaming and lifecycle", () => {
  test("oversized stdout is capped without failing the run", async () => {
    const { spawnFn } = capturingSpawn({ stdout: "a".repeat(250_000) });
    const result = await runAgy({ prompt: "x", policy: policyFor(root) }, spawnFn);
    expect(result.stdout.length).toBeLessThan(120_000);
    expect(result.stdout).toContain("[truncated");
  });

  test("a hung child is killed by the host-side timer", async () => {
    const { spawnFn } = capturingSpawn({ hang: true });
    const started = Date.now();
    try {
      await runAgy({ prompt: "x", timeout: "1s", policy: policyFor(root) }, spawnFn);
      throw new Error("expected TIMEOUT");
    } catch (err) {
      expect(err).toBeInstanceOf(AgyError);
      expect((err as AgyError).code).toBe("TIMEOUT");
    }
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  test("abort signal terminates the child", async () => {
    const { spawnFn, killCount } = capturingSpawn({ hang: true });
    const ac = new AbortController();
    const pending = runAgy({ prompt: "x", policy: policyFor(root), signal: ac.signal }, spawnFn);
    setTimeout(() => ac.abort(), 20);
    // The child dies; how the exit is classified (TIMEOUT for 143) is the
    // pre-existing contract, so only the termination is asserted here.
    await pending.catch(() => {});
    expect(killCount()).toBeGreaterThan(0);
  });
});

describe("v2 schema and registration safety", () => {
  test("the schema forbids additional properties", () => {
    expect((AGY_V2_TOOL_SCHEMA as any).additionalProperties).toBe(false);
  });

  test("setup registers into a Map without adding stray properties and preserves an existing entry", async () => {
    const tools = new Map<string, any>();
    const commands = new Map<string, any>();
    tools.set("agy", { name: "agy", sentinel: "user-owned" });
    await setupV2Plugin({
      tool: { transform: (fn: any) => fn({ add: (d: any) => tools.set(d.name, d), has: tools.has.bind(tools) }) },
      command: { transform: (fn: any) => fn({ add: (d: any) => commands.set(d.name, d), has: commands.has.bind(commands) }) },
    });
    expect(tools.get("agy").sentinel).toBe("user-owned");
    expect((tools as any).agy).toBeUndefined();
  });

  test("repeated setup never duplicates a registered entry", async () => {
    const tools = new Map<string, any>();
    const commands = new Map<string, any>();
    const ctx = {
      tool: { transform: (fn: any) => fn({ add: (d: any) => tools.set(d.name, d), has: tools.has.bind(tools) }) },
      command: { transform: (fn: any) => fn({ add: (d: any) => commands.set(d.name, d), has: commands.has.bind(commands) }) },
    };
    await setupV2Plugin(ctx);
    await setupV2Plugin(ctx);
    expect(tools.size).toBe(1);
    expect(commands.size).toBe(1);
  });

  test("v2 execute rejects non-boolean yolo and non-string prompt", async () => {
    let captured: any;
    await setupV2Plugin({ tool: { transform: (fn: any) => fn({ add: (d: any) => (captured = d) }) } });
    const bad = await captured.execute({ prompt: "x", yolo: "false" });
    expect(bad.content).toContain("AGY_ERROR");
    expect(bad.content).toContain("INVALID_ARGUMENT");
    const badPrompt = await captured.execute({ prompt: 42 });
    expect(badPrompt.content).toContain("AGY_ERROR");
  });
});

describe("command definition guard", () => {
  test("accepts extra OpenCode keys and rejects inherited template", () => {
    expect(isCommandDef({ template: "do it", description: "d", agent: "build", extra: 1 })).toBe(true);
    const inherited = Object.create({ template: "inherited" });
    expect(isCommandDef(inherited)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// F-1 process termination honesty
// ---------------------------------------------------------------------------

/** Fake child that records every kill signal; optionally ignores SIGTERM. */
function killRecordingSpawn(opts: { ignoreSigterm?: boolean } = {}) {
  const signals: string[] = [];
  const enc = new TextEncoder();
  let settle: (code: number) => void = () => {};
  const exited = new Promise<number>((resolve) => {
    settle = resolve;
  });
  const spawnFn = ((() => ({
    pid: 4242,
    stdin: { end: () => {} },
    stdout: new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode("ok"));
        c.close();
      },
    }),
    stderr: new ReadableStream<Uint8Array>({
      start(c) {
        c.close();
      },
    }),
    exited,
    kill: (sig: string) => {
      signals.push(sig);
      if (sig === "SIGKILL" || !opts.ignoreSigterm) settle(143);
    },
  })) as unknown) as SpawnFn;
  return { spawnFn, signals };
}

describe("child termination (F-1)", () => {
  test("a child that exits after SIGTERM is never SIGKILLed and no process-group kill is attempted", async () => {
    const { spawnFn, signals } = killRecordingSpawn();
    const groupCalls: number[] = [];
    const origKill = process.kill.bind(process);
    (process as any).kill = (pid: number, sig?: NodeJS.Signals) => {
      if (typeof pid === "number" && pid < 0) {
        // The child has no own process group (no detached spawn), so a
        // negative-pid kill would hit the caller's group: record and fail
        // like ESRCH, which is what really happens.
        groupCalls.push(pid);
        const err = new Error("kill ESRCH") as any;
        err.code = "ESRCH";
        throw err;
      }
      return origKill(pid as any, sig as any);
    };
    try {
      const ac = new AbortController();
      const pending = runAgy({ prompt: "x", policy: policyFor(root), signal: ac.signal }, spawnFn);
      setTimeout(() => ac.abort(), 20);
      await pending.catch(() => {});
      // Wait past the 2s escalation window: an uncleared timer would have
      // fired by now.
      await Bun.sleep(2300);
      expect(signals).toEqual(["SIGTERM"]);
      expect(groupCalls).not.toContain(-4242);
    } finally {
      process.kill = origKill;
    }
  }, 10_000);

  test("a child that ignores SIGTERM still receives SIGKILL", async () => {
    const { spawnFn, signals } = killRecordingSpawn({ ignoreSigterm: true });
    const ac = new AbortController();
    const pending = runAgy({ prompt: "x", policy: policyFor(root), signal: ac.signal }, spawnFn);
    setTimeout(() => ac.abort(), 20);
    await pending.catch(() => {});
    expect(signals).toContain("SIGTERM");
    expect(signals).toContain("SIGKILL");
  }, 10_000);
});

// ---------------------------------------------------------------------------
// F-2 stderr capture vs surfaced copy
// ---------------------------------------------------------------------------

describe("stderr capture and truncation (F-2)", () => {
  test("classification keywords beyond the first 2 KiB of stderr are still honored", async () => {
    for (const [keyword, code] of [
      ["quota exceeded", "QUOTA_EXHAUSTED"],
      ["print-timeout", "TIMEOUT"],
      ["unauthenticated", "AUTH_REQUIRED"],
    ] as const) {
      const stderr = "x".repeat(5000) + keyword;
      const { spawnFn } = capturingSpawn({ stdout: "", stderr, exitCode: 1 });
      try {
        await runAgy({ prompt: "x", policy: policyFor(root) }, spawnFn);
        throw new Error(`expected AgyError ${code}`);
      } catch (err) {
        expect((err as AgyError).code).toBe(code);
      }
    }
  });

  test("surfaced stderr on failure is capped at ~2 KiB with an explicit truncation marker", async () => {
    const tail = "TAIL-MARKER-9f8e7d";
    const { spawnFn } = capturingSpawn({
      stdout: "",
      stderr: "e".repeat(5000) + tail,
      exitCode: 1,
    });
    try {
      await runAgy({ prompt: "x", policy: policyFor(root) }, spawnFn);
      throw new Error("expected AgyError");
    } catch (err: any) {
      expect(err.code).toBe("AGY_FAILED");
      const surfaced = err.details.stderr as string;
      expect(surfaced).toContain("[truncated");
      expect(surfaced.length).toBeLessThan(2200);
      expect(surfaced).not.toContain(tail);
    }
  });

  test("a successful run still surfaces stderr with the truncation marker", async () => {
    const { spawnFn } = capturingSpawn({ stdout: "ok", stderr: "e".repeat(5000), exitCode: 0 });
    const result = await runAgy({ prompt: "x", policy: policyFor(root) }, spawnFn);
    expect(result.stderr).toContain("[truncated");
    expect(result.stderr.length).toBeLessThan(2200);
  });
});

// ---------------------------------------------------------------------------
// F-3 secret scrubbing holes
// ---------------------------------------------------------------------------

describe("secret scrubbing holes (F-3)", () => {
  const PEM = [
    'private_key = "-----BEGIN RSA PRIVATE KEY-----',
    "MIIEpAIBAAKCAQEA7dDummy7dDummy7dDummy7dUm",
    "q83rDummyBody q83rDummyBody q83rDummyBody",
    '-----END RSA PRIVATE KEY-----"',
  ].join("\n");

  async function scrubbedSurfaces(payload: string) {
    const { spawnFn } = capturingSpawn({
      stdout: `start ${payload} end`,
      stderr: `start ${payload} end`,
      exitCode: 0,
    });
    const result = await runAgy({ prompt: "x", policy: policyFor(root) }, spawnFn);
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      error: redactError(new Error(`start ${payload} end`)),
    };
  }

  test("multiline PEM values are redacted through the closing quote on stdout, stderr and error payloads", async () => {
    const { stdout, stderr, error } = await scrubbedSurfaces(PEM);
    for (const surface of [stdout, stderr, error]) {
      expect(surface).toContain("[REDACTED]");
      expect(surface).not.toContain("MIIEpAIBAAKCAQEA");
      expect(surface).not.toContain("DummyBody");
      expect(surface).not.toContain("-----END RSA");
    }
  });

  test("aws_secret_access_key values are redacted on all surfaces, including the JSON form", async () => {
    const secret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    const { stdout, stderr, error } = await scrubbedSurfaces(
      `{"aws_secret_access_key": "${secret}"} and aws_secret_access_key=${secret}`
    );
    for (const surface of [stdout, stderr, error]) {
      expect(surface).not.toContain("wJalrXUtnFEMI");
      expect(surface).toContain("[REDACTED]");
    }
  });

  test("short tokens are redacted on all surfaces (ghp_short123, xoxp-short, short AIza)", async () => {
    const { stdout, stderr, error } = await scrubbedSurfaces("ghp_short123 xoxp-short AIzaSyABC123xyz");
    for (const surface of [stdout, stderr, error]) {
      expect(surface).not.toContain("ghp_short123");
      expect(surface).not.toContain("xoxp-short");
      expect(surface).not.toContain("AIzaSyABC123");
      expect(surface).toContain("[REDACTED]");
    }
  });
});

// ---------------------------------------------------------------------------
// F-4 dir TOCTOU / canonical path reuse
// ---------------------------------------------------------------------------

describe("dir canonicalization (F-4)", () => {
  test("a dir behind a symlinked parent is emitted as its realpath in --add-dir", async () => {
    await symlink(path.join(root, "sub"), path.join(root, "link"));
    const granted = path.join(root, "link", "deep");
    const expected = realpathSync(path.join(root, "sub", "deep"));
    const args = buildAgyArgs({ prompt: "x", dir: granted, policy: policyFor(root) });
    const emitted = args[args.indexOf("--add-dir") + 1];
    expect(emitted).toBe(expected);
    expect(emitted).not.toContain("link");
  });

  test("a relative dir with a symlinked parent resolves against cwd and emits the realpath", async () => {
    await symlink(path.join(root, "sub"), path.join(root, "link"));
    const expected = realpathSync(path.join(root, "sub", "deep"));
    const prevCwd = process.cwd();
    process.chdir(root);
    try {
      const args = buildAgyArgs({ prompt: "x", dir: path.join("link", "deep"), policy: policyFor(root) });
      const emitted = args[args.indexOf("--add-dir") + 1];
      expect(emitted).toBe(expected);
      expect(emitted).not.toContain("link");
    } finally {
      process.chdir(prevCwd);
    }
  });

  test("runAgy spawns with cwd equal to the granted dir's realpath", async () => {
    await symlink(path.join(root, "sub"), path.join(root, "link"));
    const granted = path.join(root, "link", "deep");
    const expected = realpathSync(path.join(root, "sub", "deep"));
    const { spawnFn, calls } = capturingSpawn({});
    await runAgy({ prompt: "x", dir: granted, policy: policyFor(root) }, spawnFn);
    expect(calls[0]!.opts.cwd).toBe(expected);
    const argv = calls[0]!.argv;
    expect(argv[argv.indexOf("--add-dir") + 1]).toBe(expected);
  });
});
