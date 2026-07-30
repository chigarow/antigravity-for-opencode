import { spawn } from "bun";
import { unlink } from "node:fs/promises";
import { tmpdir } from "os";
import path from "node:path";
import { mkdir } from "node:fs/promises";

export type Tier = "flash-3.5-hi" | "flash-3.5-lo" | "flash-3.5-med" | "pro-3.1-hi" | "pro-3.1-lo" | "flash-3.6-hi" | "flash-3.6-med" | "flash-3.6-lo";

export interface AgyOptions {
  prompt: string;
  tier?: Tier;
  dir?: string;
  timeout?: string | number;
  project?: string;
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
  /**
   * The conversation ID that was used (caller-supplied) or that agy created
   * for this run (extracted from agy's log via --log-file). Always optional:
   * a fresh run that crashed before agy could log the ID, or a session where
   * the parser found nothing, will leave this undefined. Echo this value back
   * via the `conversation` argument to resume the same session after a
   * TIMEOUT / EMPTY / AGY_FAILED.
   */
  conversationId?: string;
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
  "flash-3.5-hi": "Gemini 3.5 Flash (High)",
  "flash-3.5-lo": "Gemini 3.5 Flash (Low)",
  "flash-3.5-med": "Gemini 3.5 Flash (Medium)",
  "pro-3.1-hi": "Gemini 3.1 Pro (High)",
  "pro-3.1-lo": "Gemini 3.1 Pro (Low)",
  "flash-3.6-hi": "Gemini 3.6 Flash (High)",
  "flash-3.6-med": "Gemini 3.6 Flash (Medium)",
  "flash-3.6-lo": "Gemini 3.6 Flash (Low)",
};

/**
 * Hard upper bound for any timeout that flows through `normalizeTimeout`.
 * Any value that normalizes above 4h is silently clamped to "4h".
 * This is a safety cap — pair it with retry logic for tasks that genuinely
 * need more wall-clock time than this.
 */
const MAX_TIMEOUT_MS = 4 * 60 * 60 * 1000;

/**
 * Normalize timeout input to a string agy understands (e.g. "5m", "300s", "4h").
 *
 * Tier-aware default when no explicit timeout is provided:
 *  - tier === "pro-3.1-hi" || tier === "pro-3.1-lo"  → "15m"  (Pro family: heavier work, longer default)
 *  - any other tier                                → "10m"  (flash-3.5-hi, flash-3.5-lo, flash-3.5-med, flash-3.6-hi, flash-3.6-med, flash-3.6-lo, or unspecified)
 *
 * Accepts:
 *  - undefined / null            → tier-aware default
 *  - number (treated as ms)      → coerced (300000 → "5m", 60000 → "1m")
 *  - string of digits only       → coerced as ms
 *  - duration string ("5m", "10m", "300s", "1h", …) → passed through
 *
 * Hard upper bound: any normalized value that exceeds 4h
 * (MAX_TIMEOUT_MS) is silently clamped to "4h". Values that cannot be
 * parsed back to ms (e.g. "abc") are returned unchanged so the runner
 * surfaces them as before.
 *
 * Throws `AgyError { code: "INVALID_TIMEOUT" }` for numeric inputs that
 * are not finite (NaN, ±Infinity) or negative. A literal `0` is preserved
 * as "0s" — historically used to disable the timeout for short tasks and
 * the policy is locked in by tests. Strings are accepted as-is; "abc" or
 * negative-duration strings pass through and surface as a downstream
 * classification, not as INVALID_TIMEOUT, so user-facing surface stays
 * stable.
 */
function normalizeTimeout(t: string | number | undefined, tier: Tier = "flash-3.6-med"): string {
  if (t == null) return tier === "pro-3.1-hi" || tier === "pro-3.1-lo" ? "15m" : "10m";

  // Validate + coerce. The cap is applied uniformly to whatever this
  // returns so a 999_999_999 numeric input is clamped to "4h" the same
  // way a "100h" string is.
  const raw = normalizeRawTimeoutValue(t);
  return clampOversizedTimeout(raw);
}

/**
 * Coerce the raw timeout input to a string form, throwing on invalid
 * numeric values. The result may still exceed 4h — the caller applies
 * the cap (see `clampOversizedTimeout`).
 */
function normalizeRawTimeoutValue(t: string | number | undefined): string {
  if (typeof t === "number") return normalizeNumericTimeout(t);
  const s = String(t).trim();
  if (/^\d+$/.test(s)) return normalizeDigitStringTimeout(s);
  return s;
}

/**
 * Validate a numeric timeout and return the string form. Throws
 * `AgyError { code: "INVALID_TIMEOUT" }` for NaN, ±Infinity, or negatives.
 * Returns "0s" for the literal 0 (preserves the historical "no timeout"
 * policy locked in by tests).
 */
function normalizeNumericTimeout(t: number): string {
  if (!Number.isFinite(t)) {
    throw new AgyError(
      `invalid timeout: ${t} (must be a finite number of ms, or a duration string like "5m")`,
      "INVALID_TIMEOUT",
      { value: t }
    );
  }
  if (t < 0) {
    throw new AgyError(
      `invalid timeout: ${t} (must be ≥ 0)`,
      "INVALID_TIMEOUT",
      { value: t }
    );
  }
  // 0 → "0s" by policy; 4h cap is applied by the caller.
  if (t >= 60_000) return Math.ceil(t / 60_000) + "m";
  return Math.ceil(t / 1_000) + "s";
}

/**
 * Validate a digit-only string and return the string form. Same rules as
 * the numeric path: NaN / Infinity / negatives throw. "0" → "0s".
 */
function normalizeDigitStringTimeout(s: string): string {
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) {
    throw new AgyError(
      `invalid timeout: "${s}" (digit-only strings must be a non-negative ms count)`,
      "INVALID_TIMEOUT",
      { value: s }
    );
  }
  if (n >= 60_000) return Math.ceil(n / 60_000) + "m";
  return Math.ceil(n / 1_000) + "s";
}

/**
 * If `result` parses back to a duration > 4h, return "4h". Otherwise
 * return `result` unchanged. This is the safety cap — a parsed-back
 * guard means any path that produces a recognizable duration string
 * (numeric ms, digit-string ms, or a unit-suffixed literal) is clamped.
 * Unparseable inputs (e.g. "abc") pass through unchanged.
 */
function clampOversizedTimeout(result: string): string {
  if (!result) return result;
  const m = result.match(/^(\d+)\s*(h|m|s|ms)$/i);
  if (!m) return result;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const ms =
    unit === "h" ? n * 3_600_000
    : unit === "m" ? n * 60_000
    : unit === "s" ? n * 1_000
    : n; // "ms"
  if (ms > MAX_TIMEOUT_MS) return "4h";
  return result;
}

/**
 * Format a duration in milliseconds as a short string agy understands.
 * Rounds UP to the nearest second (< 60s) or minute (>= 60s).
 * Examples: 900000 → "15m", 45000 → "45s", 12500 → "13s".
 */
function formatMsToDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  if (ms >= 60_000) return Math.ceil(ms / 60_000) + "m";
  return Math.ceil(ms / 1_000) + "s";
}

/**
 * Parse a normalized timeout string (output of normalizeTimeout) into milliseconds.
 * Accepts: "10m", "300s", "900000" (digit-only ms), or a number.
 */
function parseTimeoutMs(timeout: string | number): number {
  if (typeof timeout === "number") return timeout;
  const s = String(timeout).trim();
  const m = s.match(/^(\d+)\s*(h|m|s|ms)$/);
  if (m) {
    const n = Number(m[1]);
    if (m[2] === "h") return n * 3_600_000;
    if (m[2] === "m") return n * 60_000;
    if (m[2] === "s") return n * 1_000;
    return n;
  }
  if (/^\d+$/.test(s)) return Number(s);
  return 10 * 60_000;
}

/**
 * Compute a suggested next timeout (string duration) given observed duration
 * and the configured timeout. Heuristic:
 *   suggestedMs = max(ceil(durationMs * 1.5), ceil(parsedTimeoutMs * 2), 15m)
 * This biases toward a generous bump and a 15-minute floor.
 */
function computeSuggestedNextTimeout(durationMs: number, used: string): string {
  const parsedTimeoutMs = parseTimeoutMs(used);
  const suggestedMs = Math.max(
    Math.ceil(durationMs * 1.5),
    Math.ceil(parsedTimeoutMs * 2),
    15 * 60_000
  );
  return formatMsToDuration(suggestedMs);
}

/**
 * Validate that a captured conversation/session ID looks plausible.
 * Real agy IDs always contain alphanumeric characters (UUIDs, ses_...,
 * project-xxx shapes). Pure-punctuation captures like `"""` are noise
 * from Go log formatting and must be rejected.
 */
function isPlausibleConversationId(id: string): boolean {
  return id.length > 0 && /[A-Za-z0-9]/.test(id);
}

/**
 * Strip trailing (and leading) punctuation that Go log formatting appends
 * to captured IDs — e.g. `2e456db3-...-54159bf7eb49,` or `ses_abc")`.
 * Hyphens and underscores inside the ID are preserved.
 */
function normalizeConversationId(id: string): string {
  return id.replace(/^[.,;:)\]}"'!?<>]+|[.,;:)\]}"'!?<>]+$/g, "");
}

/**
 * Normalize a raw capture, then validate the result is still plausible.
 * Returns the cleaned ID, or undefined if nothing usable remains after
 * normalization.
 */
function extractValidId(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = normalizeConversationId(raw);
  return isPlausibleConversationId(cleaned) ? cleaned : undefined;
}

/**
 * Extract a non-empty conversation ID from a chunk of agy log content.
 * Pure: no I/O, no side effects. Order of patterns is priority order — the most
 * specific / explicit form wins, so `conversationID="..."` is preferred over a
 * bare UUID that just happens to follow the word "conversation".
 * Patterns matched (case-insensitive):
 *   1. conversationID="<id>"
 *   2. conversationID=<id>      (unquoted)
 *   3. \bconversation="<id>"   (quoted, word boundary)
 *   4. \bconversation=<id>     (unquoted, word boundary)
 *   5. "Conversation using project ID: <id>"
 *   6. "conversation <uuid>"   (UUID-shaped token right after the word)
 * Returns undefined if nothing matches.
 * Captures are normalized: trailing/leading punctuation (commas, periods,
 * semicolons, quotes, brackets) is stripped before validation.
 */
export function parseConversationIdFromLog(log: string): string | undefined {
  if (!log) return undefined;

  // 1. conversationID="<id>" — most explicit, quoted.
  let id = extractValidId(log.match(/conversationID\s*=\s*"([^"\s]+)"/i)?.[1]);
  if (id) return id;

  // 2. conversationID=<id> — unquoted, bounded by whitespace.
  id = extractValidId(log.match(/conversationID\s*=\s*(\S+)/i)?.[1]);
  if (id) return id;

  // 3. \bconversation="<id>" — quoted. Word boundary prevents matching
  // inside "myconversation" or "aconversation=".
  id = extractValidId(
    log.match(/\bconversation\s*=\s*"([^"\s]+)"/i)?.[1]
  );
  if (id) return id;

  // 4. \bconversation=<id> — unquoted.
  id = extractValidId(log.match(/\bconversation\s*=\s*(\S+)/i)?.[1]);
  if (id) return id;

  // 5. "Conversation using project ID: <id>" — Go log style.
  id = extractValidId(
    log.match(/Conversation using project ID:\s*(\S+)/i)?.[1]
  );
  if (id) return id;

  // 6. "conversation <uuid>" — UUID-shaped token right after the word.
  id = extractValidId(
    log.match(
      /conversation\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
    )?.[1]
  );
  if (id) return id;

  return undefined;
}

export function buildAgyArgs(opts: AgyOptions): string[] {
  // Validate explicit tier before model selection so an exact model override
  // cannot make an invalid tier valid (v0.8.0 invariant 8).
  if (opts.tier !== undefined && !(opts.tier in TIER_MODEL)) {
    throw new AgyError(`Unknown tier: ${opts.tier}`, "INVALID_TIER");
  }
  const model = opts.model || TIER_MODEL[opts.tier ?? "flash-3.6-med"];
  if (!model) {
    throw new AgyError(`Unknown tier: ${opts.tier}`, "INVALID_TIER");
  }
  if (opts.continue && opts.conversation) {
    throw new AgyError("pass either continue or conversation, not both", "INVALID_ARGS");
  }

  const timeout = normalizeTimeout(opts.timeout, opts.tier);

  const args: string[] = [
    "--model",
    model,
    "--print-timeout",
    timeout,
  ];

  if (opts.dir) args.push("--add-dir", opts.dir);
  if (opts.project) args.push("--project", opts.project);
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
  const requestedConvId = opts.conversation?.trim() || undefined;

  // Always tee agy's log to a unique temp file inside a private 0700 subdirectory
  // under the OS temp dir (via os.tmpdir()). This mitigates symlink races on shared hosts.
  const logDir = path.join(tmpdir(), "opencode-agy-logs");
  await mkdir(logDir, { recursive: true, mode: 0o700 });
  const logFile = path.join(logDir, `agy-conv-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.log`);
  args.push("--log-file", logFile);

  try {
    let proc;
    try {
      proc = spawnFn(["agy", ...args], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (err: any) {
      if (err?.code === "ENOENT" || String(err).toLowerCase().includes("not found")) {
        throw new AgyError(
          "agy CLI not found on PATH",
          "AGY_NOT_FOUND",
          {
            original: String(err),
            durationMs: Date.now() - start,
            ...convIdField(requestedConvId),
          }
        );
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

    // Best-effort: read the temp log and pull the conversation ID. The log
    // may be missing (e.g. spawn-ENOENT path, or agy never wrote anything)
    // — treat that as "no ID extracted" and keep moving.
    const extractedConvId = await readConvIdFromLog(logFile);
    const convId = requestedConvId || extractedConvId;

    // Extract the timeout value agy actually saw on the command line. We
    // echo this on EVERY error from a real spawn (TIMEOUT, AGY_FAILED,
    // EMPTY_OUTPUT, and the general classified path) so callers can see
    // the configured budget without re-parsing args themselves. The
    // spawn-ENOENT path is excluded because it never reaches this point.
    const tIdx = args.indexOf("--print-timeout");
    const used = tIdx >= 0 ? args[tIdx + 1] : undefined;
    const timeoutField: Record<string, unknown> = used ? { timeout: used } : {};

    if (exit !== 0) {
      const classified = classifyError(err, exit);
      if (classified) {
        if (classified.code === "TIMEOUT" && used) {
          const suggestedNextTimeout = computeSuggestedNextTimeout(durationMs, used);
          throw new AgyError(
            classified.message,
            "TIMEOUT",
            {
              ...(classified.details || {}),
              ...timeoutField,
              durationMs,
              suggestedNextTimeout,
              ...convIdField(convId),
            }
          );
        }
        throw new AgyError(
          classified.message,
          classified.code,
          {
            ...(classified.details || {}),
            ...timeoutField,
            durationMs,
            ...convIdField(convId),
          }
        );
      }

      throw new AgyError(
        `agy exited with code ${exit}`,
        "AGY_FAILED",
        {
          exitCode: exit,
          stderr: scrubSecrets(truncate(err, 2000)),
          ...timeoutField,
          durationMs,
          ...convIdField(convId),
        }
      );
    }

    const trimmed = out.trim();
    if (!trimmed) {
      throw new AgyError("agy returned empty output", "EMPTY_OUTPUT", {
        model: opts.model || TIER_MODEL[opts.tier ?? "flash-3.6-med"],
        ...timeoutField,
        durationMs,
        ...convIdField(convId),
      });
    }

    const result: AgyResult = {
      stdout: truncate(out, 100_000),
      stderr: scrubSecrets(truncate(err, 2000)),
      exitCode: exit,
      durationMs,
    };
    if (convId) result.conversationId = convId;
    return result;
  } finally {
    // Best-effort cleanup of the private temp log file (under os.tmpdir()/opencode-agy-logs).
    // Never let a leftover log break the call or leak on disk.
    await unlink(logFile).catch(() => {});
  }
}

/**
 * Build a `{ conversationId: <id> }` object to spread into a details record.
 * Returns `{}` when no ID is known so callers can spread unconditionally.
 */
function convIdField(convId: string | undefined): Record<string, unknown> {
  return convId ? { conversationId: convId } : {};
}

/**
 * Read the agy log file and extract the conversation ID, swallowing any I/O
 * or parse errors. Pure best-effort: a missing/unreadable log means "no ID".
 */
async function readConvIdFromLog(logFile: string): Promise<string | undefined> {
  try {
    const content = await Bun.file(logFile).text();
    return parseConversationIdFromLog(content);
  } catch {
    return undefined;
  }
}

function classifyError(stderr: string, exitCode: number): AgyError | null {
  if (exitCode === 124 || exitCode === 143) {
    return new AgyError("agy print timeout", "TIMEOUT", { exitCode });
  }
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

/**
 * Best-effort secret scrubbing for stderr / logs before surfacing in results or errors.
 * Replaces common token patterns with [REDACTED].
 * Classification logic receives raw stderr.
 */
export function scrubSecrets(text: string): string {
  if (!text) return text;
  let s = text;
  // Bearer tokens and Authorization headers
  s = s.replace(/\bBearer\s+[A-Za-z0-9\-._~+\/]+=*/gi, "Bearer [REDACTED]");
  s = s.replace(/Authorization:\s*Bearer\s+[^\s]+/gi, "Authorization: Bearer [REDACTED]");
  // Common API key prefixes
  s = s.replace(/\b(sk-[A-Za-z0-9]+|xox[baprs]-[A-Za-z0-9-]+)/gi, "[REDACTED]");
  // password= token= secret= api_key= etc (case-insensitive)
  s = s.replace(/\b(password|token|secret|api[_-]?key|apikey)\s*=\s*[^\s&"']+/gi, "$1=[REDACTED]");
  return s;
}

