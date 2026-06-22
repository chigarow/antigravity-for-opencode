import { spawn } from "bun";

export type Tier = "flash" | "flash-lo" | "pro";

export interface AgyOptions {
  prompt: string;
  tier?: Tier;
  dir?: string;
  timeout?: string;
  yolo?: boolean;
  sandbox?: boolean;
  continue?: boolean;
  conversation?: string;
  model?: string; // exact model name override (future-proof)
}

export interface AgyResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export class AgyError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "AgyError";
  }
}

const TIER_MODEL: Record<Tier, string> = {
  flash: "Gemini 3.5 Flash (High)",
  "flash-lo": "Gemini 3.5 Flash (Low)",
  pro: "Gemini 3.1 Pro (High)",
};

export function buildAgyArgs(opts: AgyOptions): string[] {
  const model = opts.model || TIER_MODEL[opts.tier ?? "flash"];
  if (!model) {
    throw new AgyError(`Unknown tier: ${opts.tier}`, "INVALID_TIER");
  }

  const timeout = opts.timeout ?? "5m";

  const args: string[] = [
    "--model",
    model,
    "--print-timeout",
    timeout,
  ];

  if (opts.dir) args.push("--add-dir", opts.dir);
  if (opts.yolo) args.push("--dangerously-skip-permissions");
  if (opts.sandbox) args.push("--sandbox");
  if (opts.continue) args.push("--continue");
  if (opts.conversation) args.push("--conversation", opts.conversation);

  args.push("-p", opts.prompt);
  return args;
}

export type SpawnFn = typeof spawn;

export async function runAgy(
  opts: AgyOptions,
  spawnFn: SpawnFn = spawn
): Promise<AgyResult> {
  const args = buildAgyArgs(opts);
  const start = Date.now();

  let proc;
  try {
    proc = spawnFn(["agy", ...args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err: any) {
    if (err?.code === "ENOENT" || String(err).toLowerCase().includes("not found")) {
      throw new AgyError("agy CLI not found on PATH", "AGY_NOT_FOUND", { original: String(err) });
    }
    throw err;
  }

  proc.stdin.end();

  const [out, err, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  const durationMs = Date.now() - start;

  if (exit !== 0) {
    const classified = classifyError(err, exit);
    if (classified) throw classified;

    throw new AgyError(
      `agy exited with code ${exit}`,
      "AGY_FAILED",
      { exitCode: exit, stderr: truncate(err, 2000) }
    );
  }

  const trimmed = out.trim();
  if (!trimmed) {
    throw new AgyError("agy returned empty output", "EMPTY_OUTPUT", {
      model: opts.model || TIER_MODEL[opts.tier ?? "flash"],
    });
  }

  return {
    stdout: truncate(out, 100_000),
    stderr: err,
    exitCode: exit,
    durationMs,
  };
}

function classifyError(stderr: string, exitCode: number): AgyError | null {
  const blob = (stderr || "").toLowerCase();
  if (blob.includes("quota") || blob.includes("rate limit") || blob.includes("resource exhausted")) {
    return new AgyError("agy quota or rate limit exceeded", "QUOTA_EXHAUSTED", { exitCode });
  }
  if (blob.includes("unauthenticated") || blob.includes("unauthorized") || blob.includes("sign in") || blob.includes("authenticate")) {
    return new AgyError("agy not authenticated — run `agy` once interactively", "AUTH_REQUIRED", { exitCode });
  }
  if (blob.includes("timed out") || blob.includes("deadline exceeded") || blob.includes("print-timeout")) {
    return new AgyError("agy print timeout", "TIMEOUT", { exitCode });
  }
  if (blob.includes("command not found") || blob.includes("agy: not found") || blob.includes("enoent")) {
    return new AgyError("agy CLI not found on PATH", "AGY_NOT_FOUND", { exitCode });
  }
  return null;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n... [truncated ${text.length - max} chars]`;
}
