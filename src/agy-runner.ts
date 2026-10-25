import { spawn } from "bun";
import { mkdtemp, chmod, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "os";
import path from "node:path";

export type Tier =
  | "flash-3.8-hi"
  | "flash-3.8-med"
  | "flash-3.8-lo"
  | "claude-sonnet-5-5-hi"
  | "claude-sonnet-5-5-med"
  | "claude-sonnet-5-5-lo"
  | "claude-opus-5-5-hi"
  | "claude-opus-5-5-med"
  | "claude-opus-5-5-lo"
  | "argon-4-hi"
  | "argon-4-med"
  | "argon-4-lo";

/**
 * Host-owned authority policy. Everything here comes from the plugin
 * configuration or the process environment, never from the model's
 * tool arguments — that separation is what makes `dir` and `yolo`
 * containment meaningful.
 */
export interface AgyPolicy {
  /** Absolute, canonical directory that `dir` must stay inside. */
  workspaceRoot: string;
  /** Whether `yolo: true` may be honoured at all (still requires sandbox). */
  allowYolo: boolean;
}

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
  signal?: AbortSignal;
  /** Overrides for the host policy; omitted fields fall back to env/cwd. */
  policy?: Partial<AgyPolicy>;
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
  "flash-3.8-hi": "Gemini 3.8 Flash (High)",
  "flash-3.8-med": "Gemini 3.8 Flash (Medium)",
  "flash-3.8-lo": "Gemini 3.8 Flash (Low)",
  "claude-sonnet-5-5-hi": "Claude Sonnet 5.5 (High)",
  "claude-sonnet-5-5-med": "Claude Sonnet 5.5 (Medium)",
  "claude-sonnet-5-5-lo": "Claude Sonnet 5.5 (Low)",
  "claude-opus-5-5-hi": "Claude Opus 5.5 (High)",
  "claude-opus-5-5-med": "Claude Opus 5.5 (Medium)",
  "claude-opus-5-5-lo": "Claude Opus 5.5 (Low)",
  "argon-4-hi": "Gemini 4 Argon (High)",
  "argon-4-med": "Gemini 4 Argon (Medium)",
  "argon-4-lo": "Gemini 4 Argon (Low)",
};

/** Environment variables the delegated child is allowed to inherit. */
const CHILD_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "TERM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "NO_COLOR",
  "FORCE_COLOR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
] as const;

/**
 * Build the child environment from an explicit allowlist.
 *
 * The host process environment routinely carries provider keys, cloud
 * credentials, and CI secrets that a delegated, model-driven child has no
 * business reading. Only names on {@link CHILD_ENV_ALLOWLIST} survive.
 */
export function buildChildEnv(
  baseEnv: Record<string, string | undefined> = process.env
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of CHILD_ENV_ALLOWLIST) {
    const value = baseEnv[name];
    if (typeof value === "string") env[name] = value;
  }
  return env;
}

/**
 * Resolve the host policy: explicit overrides win, then `AGY_WORKSPACE_ROOT`
 * / `AGY_ALLOW_YOLO=1`, then the current working directory and "no yolo".
 */
export function resolvePolicy(overrides: Partial<AgyPolicy> = {}): AgyPolicy {
  const root = overrides.workspaceRoot ?? process.env.AGY_WORKSPACE_ROOT ?? process.cwd();
  return {
    workspaceRoot: canonicalDir(root, "workspace root"),
    allowYolo: overrides.allowYolo ?? process.env.AGY_ALLOW_YOLO === "1",
  };
}

function canonicalDir(dir: string, what: string): string {
  try {
    return realpathSync(path.resolve(dir));
  } catch {
    throw new AgyError(
      `${what} is not an existing directory: ${dir}`,
      "DIR_NOT_ALLOWED",
      { dir }
    );
  }
}

/**
 * Canonicalize `dir` and require it to be the workspace root or a
 * descendant. Symlinks are resolved before the check, so a link inside the
 * root that points outside is rejected. Anything that is not a real
 * directory (missing path, dangling link, flag-like value) is rejected
 * rather than forwarded to the child's argv.
 */
export function confinedDir(dir: string, policy: AgyPolicy): string {
  if (typeof dir !== "string" || dir.length === 0) {
    throw new AgyError("dir must be a non-empty string", "DIR_NOT_ALLOWED", { dir });
  }
  if (dir.startsWith("-") || dir.includes("\0")) {
    throw new AgyError("dir must not be flag-like or contain NUL", "DIR_NOT_ALLOWED", { dir });
  }
  const real = canonicalDir(dir, "dir");
  const root = policy.workspaceRoot;
  if (real !== root && !real.startsWith(root + path.sep)) {
    throw new AgyError(
      `dir is outside the approved workspace: ${dir}`,
      "DIR_NOT_ALLOWED",
      { dir, workspaceRoot: root }
    );
  }
  return real;
}

/**
 * A conversation ID is echoed back to the parent model and later becomes a
 * `--conversation` argv value, so it must not be able to carry shell-,
 * flag-, path-, or markup-shaped payloads. Accepts the three documented
 * shapes: `ses_…`, a UUID, or a plain slug of 6-64 characters.
 */
const CONVERSATION_ID_RE =
  /^(?:ses_[A-Za-z0-9_-]{4,64}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[A-Za-z0-9][A-Za-z0-9_-]{5,63})$/;

export function isValidConversationId(id: unknown): id is string {
  if (typeof id !== "string") return false;
  if (id.startsWith("-") || id.includes("..")) return false;
  if (/[\s"'/\\<>]/.test(id)) return false;
  return CONVERSATION_ID_RE.test(id);
}

/**
 * Hard upper bound for any timeout that flows through `normalizeTimeout`.
 * Any value that normalizes above 4h is silently clamped to "4h".
 * This is a safety cap — pair it with retry logic for tasks that genuinely
 * need more wall-clock time than this.
 */
const MAX_TIMEOUT_MS = 4 * 60 * 60 * 1000;

/**
 * Normalize and validate a timeout.
 *
 * Default when omitted: "15m" for every tier.
 *
 * Accepts exactly two shapes:
 *  - a positive integer (ms): 300000 → "5m"
 *  - a positive duration string: "5m", "300s", "2h", "500ms"
 *
 * Everything else — `0`, `"0s"`, negatives, `NaN`, `"5.5h"`, `"1d"`,
 * `"abc"` — throws `AgyError { code: "INVALID_TIMEOUT" }`. The old
 * "pass unparseable strings through" behaviour let a caller put an
 * arbitrary token into `--print-timeout`, so it is gone.
 *
 * Any valid duration above 4h is clamped to "4h".
 */
function normalizeTimeout(t: string | number | undefined): string {
  if (t == null) return "15m";

  if (typeof t === "number") {
    if (!Number.isFinite(t) || !Number.isInteger(t) || t <= 0) {
      throw invalidTimeout(t);
    }
    return clampOversizedTimeout(t >= 60_000 ? Math.ceil(t / 60_000) + "m" : Math.ceil(t / 1_000) + "s");
  }

  if (typeof t !== "string") throw invalidTimeout(t);
  const s = t.trim();

  if (/^[1-9]\d*$/.test(s)) {
    const n = Number(s);
    return clampOversizedTimeout(n >= 60_000 ? Math.ceil(n / 60_000) + "m" : Math.ceil(n / 1_000) + "s");
  }
  if (/^[1-9]\d*\s*(h|m|s|ms)$/i.test(s)) {
    return clampOversizedTimeout(s.replace(/\s+/g, "").toLowerCase());
  }
  throw invalidTimeout(t);
}

function invalidTimeout(value: unknown): AgyError {
  return new AgyError(
    `invalid timeout: ${JSON.stringify(value)} (use a positive integer of ms, or a duration like "5m", "300s", "2h")`,
    "INVALID_TIMEOUT",
    { value }
  );
}

/**
 * Clamp a normalized duration above 4h down to "4h". The strict parser
 * guarantees the input matches `<positive><unit>`, so no unparseable
 * string can reach this function.
 */
function clampOversizedTimeout(result: string): string {
  const m = result.match(/^(\d+)(h|m|s|ms)$/);
  if (!m) return result;
  const n = Number(m[1]);
  const unit = m[2];
  const ms =
    unit === "h" ? n * 3_600_000
    : unit === "m" ? n * 60_000
    : unit === "s" ? n * 1_000
    : n; // "ms"
  return ms > MAX_TIMEOUT_MS ? "4h" : result;
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
 * Strip trailing (and leading) punctuation that Go log formatting appends
 * to captured IDs — e.g. `2e456db3-...-54159bf7eb49,` or `ses_abc")`.
 * Hyphens and underscores inside the ID are preserved.
 */
function normalizeConversationId(id: string): string {
  return id.replace(/^[.,;:)\]}"'!?<>]+|[.,;:)\]}"'!?<>]+$/g, "");
}

/**
 * Normalize a raw capture, then require the documented ID shape.
 * Returns the cleaned ID, or undefined if it is not a valid selector.
 */
function extractValidId(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = normalizeConversationId(raw);
  return isValidConversationId(cleaned) ? cleaned : undefined;
}

/**
 * Match sets that agy uses to report a conversation, in priority order:
 * the most specific / explicit form wins. Within one pattern the LAST
 * valid match wins, so content echoed into the log early (a prompt, an
 * ingested document) cannot shadow the session ID agy records later.
 */
const CONVERSATION_PATTERNS: readonly RegExp[] = [
  /conversationID\s*=\s*"([^"\s]+)"/gi,
  /conversationID\s*=\s*(\S+)/gi,
  /\bconversation\s*=\s*"([^"\s]+)"/gi,
  /\bconversation\s*=\s*(\S+)/gi,
  /Conversation using project ID:\s*(\S+)/gi,
  /conversation\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi,
];

/**
 * Extract a conversation ID from a chunk of agy log content.
 * Pure: no I/O, no side effects. See {@link CONVERSATION_PATTERNS} for the
 * priority order and the last-match rule.
 */
export function parseConversationIdFromLog(log: string): string | undefined {
  if (!log) return undefined;
  for (const pattern of CONVERSATION_PATTERNS) {
    let found: string | undefined;
    for (const match of log.matchAll(pattern)) {
      const id = extractValidId(match[1]);
      if (id) found = id;
    }
    if (found) return found;
  }
  return undefined;
}

function assertBoolean(opts: AgyOptions, key: "yolo" | "sandbox" | "continue"): void {
  const value = opts[key];
  if (value !== undefined && typeof value !== "boolean") {
    throw new AgyError(
      `${key} must be a boolean, received ${JSON.stringify(value)}`,
      "INVALID_ARGUMENT",
      { argument: key }
    );
  }
}

/** Reject argv-shaped values before they can become another flag. */
function assertNotFlagLike(name: string, value: string | undefined): void {
  if (value === undefined) return;
  if (typeof value !== "string" || value.length === 0) {
    throw new AgyError(`${name} must be a non-empty string`, "INVALID_ARGUMENT", { argument: name });
  }
  if (value.startsWith("-") || value.includes("\0")) {
    throw new AgyError(`${name} must not be flag-like or contain NUL`, "INVALID_ARGUMENT", {
      argument: name,
    });
  }
}

/** The model name the caller's tier (or explicit override) resolves to. */
function modelUsed(opts: AgyOptions): string {
  return opts.model ?? TIER_MODEL[opts.tier ?? "flash-3.8-med"];
}

interface PreparedAgy {
  args: string[];
  policy: AgyPolicy;
  /** Directory the child runs in: the granted dir, else the workspace root. */
  cwd: string;
  timeout: string;
}

/**
 * Validate everything the caller supplied and build the child invocation.
 * All authority inputs (`dir`, `yolo`) are checked against the host policy
 * here, so both the argv builder and the runner share one gate.
 */
function prepareAgy(opts: AgyOptions): PreparedAgy {
  if (typeof opts.prompt !== "string" || opts.prompt.length === 0) {
    throw new AgyError("prompt must be a non-empty string", "INVALID_ARGUMENT");
  }
  assertBoolean(opts, "yolo");
  assertBoolean(opts, "sandbox");
  assertBoolean(opts, "continue");

  // Validate explicit tier before model selection so an exact model override
  // cannot make an invalid tier valid, and so prototype-chain keys
  // ("constructor", "__proto__") cannot pass as tiers.
  if (opts.tier !== undefined) {
    if (typeof opts.tier !== "string" || !Object.hasOwn(TIER_MODEL, opts.tier)) {
      throw new AgyError(`Unknown tier: ${opts.tier}`, "INVALID_TIER");
    }
  }
  const model = modelUsed(opts);
  if (typeof model !== "string" || model.length === 0) {
    throw new AgyError(`Unknown tier: ${opts.tier}`, "INVALID_TIER");
  }
  assertNotFlagLike("model", opts.model);
  assertNotFlagLike("project", opts.project);

  if (opts.continue === true && opts.conversation !== undefined) {
    throw new AgyError("pass either continue or conversation, not both", "INVALID_ARGS");
  }
  if (opts.conversation !== undefined) {
    assertNotFlagLike("conversation", opts.conversation);
    if (!isValidConversationId(opts.conversation)) {
      throw new AgyError("Invalid conversation ID", "INVALID_CONVERSATION_ID");
    }
  }

  const policy = resolvePolicy(opts.policy);
  const dir = opts.dir !== undefined ? confinedDir(opts.dir, policy) : undefined;

  // yolo is auto-approval of every tool inside the child. It requires both
  // host consent and the terminal sandbox, so a single model-chosen flag can
  // never grant it on its own.
  if (opts.yolo === true && !(policy.allowYolo && opts.sandbox === true)) {
    throw new AgyError(
      "yolo requires configured consent (AGY_ALLOW_YOLO=1 or policy.allowYolo) plus sandbox: true",
      "YOLO_NOT_APPROVED"
    );
  }

  const timeout = normalizeTimeout(opts.timeout);
  const args: string[] = ["--model", model, "--print-timeout", timeout];

  if (dir) args.push("--add-dir", dir);
  if (opts.project) args.push("--project", opts.project);
  if (opts.yolo === true) args.push("--dangerously-skip-permissions");
  if (opts.sandbox === true) args.push("--sandbox");
  if (opts.continue === true) args.push("--continue");
  if (opts.conversation) args.push("--conversation", opts.conversation);

  args.push("-p", opts.prompt);
  return { args, policy, cwd: dir ?? policy.workspaceRoot, timeout };
}

export function buildAgyArgs(opts: AgyOptions): string[] {
  return prepareAgy(opts).args;
}

export type SpawnFn = typeof spawn;

/** Hard caps on what a chatty (or hostile) child can make the host buffer. */
export const MAX_STDOUT_BYTES = 100_000;
/** Cap on the stderr copy surfaced to callers; classification captures more. */
export const MAX_STDERR_BYTES = 2_000;
/** Bounded stderr capture kept in memory for error classification only. */
const MAX_STDERR_CAPTURE_BYTES = 64_000;

/** How long a terminated child gets to exit before SIGKILL. */
const KILL_GRACE_MS = 2_000;

/**
 * Terminate the child: SIGTERM to the child process directly, then SIGKILL
 * after a short grace. The spawn is not detached, so the child has no own
 * process group — a negative-pid signal would hit the caller's group — which
 * is why no group semantics are claimed or attempted here. The escalation is
 * cancelled as soon as the child is observed to exit, so a child that
 * honoured SIGTERM is never SIGKILLed (PID/group reuse hazard).
 */
function terminateChild(proc: any): void {
  const signal = (sig: NodeJS.Signals) => {
    try {
      proc.kill(sig);
    } catch {
      // already gone
    }
  };
  signal("SIGTERM");
  const escalation = setTimeout(() => signal("SIGKILL"), KILL_GRACE_MS);
  escalation.unref?.();
  const exited = proc?.exited;
  if (typeof exited?.then === "function") {
    exited.then(
      () => clearTimeout(escalation),
      () => clearTimeout(escalation)
    );
  }
}

/**
 * Read a child stream into a bounded buffer, draining (and counting) the
 * rest so the child never blocks on a full pipe.
 */
async function readCapped(
  stream: ReadableStream<Uint8Array>,
  max: number
): Promise<{ text: string; dropped: number }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let kept = 0;
  let dropped = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.byteLength === 0) continue;
    const room = max - kept;
    if (room <= 0) {
      dropped += value.byteLength;
      continue;
    }
    const slice = value.byteLength > room ? value.subarray(0, room) : value;
    chunks.push(slice);
    kept += slice.byteLength;
    dropped += value.byteLength - slice.byteLength;
  }
  const merged = new Uint8Array(kept);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(merged), dropped };
}

/**
 * Cap a captured string for display, appending an explicit truncation
 * marker when anything was cut, so downstream classification-vs-surfacing
 * gaps are visible instead of silent.
 * ponytail: the marker counts chars of the captured decode, not raw stream
 * bytes; switch to a byte count if precision ever matters.
 */
function truncateForDisplay(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n... [truncated ${text.length - maxChars} chars]`;
}

export async function runAgy(
  opts: AgyOptions,
  spawnFn: SpawnFn = spawn
): Promise<AgyResult> {
  const prepared = prepareAgy(opts);
  const args = prepared.args;
  const start = Date.now();
  const requestedConvId = opts.conversation;

  // Always tee agy's log to a unique temp file inside a fresh per-run 0700
  // directory under the OS temp dir. mkdtemp atomically creates a unique
  // directory; chmod ensures owner-only access even if the platform default
  // is more permissive. The entire directory is removed in finally.
  const logDir = await mkdtemp(path.join(tmpdir(), "opencode-agy-"));
  let abortHandler: (() => void) | undefined;
  let hostTimer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    await chmod(logDir, 0o700);
    const logFile = path.join(logDir, "agy.log");
    args.push("--log-file", logFile);
    let proc;
    try {
      proc = spawnFn(["agy", ...args], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: buildChildEnv(),
        cwd: prepared.cwd,
      });
    } catch (err: any) {
      if (err?.code === "ENOENT" || String(err).toLowerCase().includes("not found")) {
        throw new AgyError(
          "agy CLI not found on PATH",
          "AGY_NOT_FOUND",
          {
            original: scrubSecrets(String(err)),
            durationMs: Date.now() - start,
            ...convIdField(requestedConvId),
          }
        );
      }
      throw err;
    }

    if (opts.signal) {
      if (opts.signal.aborted) {
        terminateChild(proc);
      } else {
        abortHandler = () => {
          terminateChild(proc);
        };
        opts.signal.addEventListener("abort", abortHandler, { once: true });
      }
    }

    // Host-side backstop: agy's --print-timeout is advisory from this
    // process's point of view, so enforce the same budget locally.
    hostTimer = setTimeout(() => {
      timedOut = true;
      terminateChild(proc);
    }, parseTimeoutMs(prepared.timeout) + 1_000);
    hostTimer.unref?.();

    proc.stdin.end();

    const [out, err, exit] = await Promise.all([
      readCapped(proc.stdout, MAX_STDOUT_BYTES),
      readCapped(proc.stderr, MAX_STDERR_CAPTURE_BYTES),
      proc.exited,
    ]);

    const durationMs = Date.now() - start;
    const stdoutText = out.dropped > 0 ? `${out.text}\n... [truncated ${out.dropped} bytes]` : out.text;
    // Classification runs on the full capture; the surfaced copy is capped
    // and carries an explicit truncation marker when it was cut.
    const stderrRaw = err.text;
    const stderrText = truncateForDisplay(stderrRaw, MAX_STDERR_BYTES);

    // Best-effort: read the temp log and pull the conversation ID. The log
    // may be missing (e.g. spawn-ENOENT path, or agy never wrote anything)
    // — treat that as "no ID extracted" and keep moving.
    const extractedConvId = await readConvIdFromLog(logFile);
    const convId = requestedConvId || extractedConvId;

    // The budget agy actually saw, echoed on every error from a real spawn
    // (TIMEOUT, AGY_FAILED, EMPTY_OUTPUT, and the general classified path).
    const used = prepared.timeout;
    const timeoutField: Record<string, unknown> = { timeout: used };

    if (timedOut) {
      throw new AgyError("agy exceeded its timeout (host timer)", "TIMEOUT", {
        ...timeoutField,
        durationMs,
        suggestedNextTimeout: computeSuggestedNextTimeout(durationMs, used),
        ...convIdField(convId),
      });
    }

    if (exit !== 0) {
      const classified = classifyError(stderrRaw, exit);
      if (classified) {
        if (classified.code === "TIMEOUT") {
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
          stderr: scrubSecrets(stderrText),
          ...timeoutField,
          durationMs,
          ...convIdField(convId),
        }
      );
    }

    if (!stdoutText.trim()) {
      throw new AgyError("agy returned empty output", "EMPTY_OUTPUT", {
        model: modelUsed(opts),
        ...timeoutField,
        durationMs,
        ...convIdField(convId),
      });
    }

    const result: AgyResult = {
      stdout: scrubSecrets(stdoutText),
      stderr: scrubSecrets(stderrText),
      exitCode: exit,
      durationMs,
    };
    if (convId) result.conversationId = convId;
    return result;
  } finally {
    if (hostTimer) clearTimeout(hostTimer);
    if (opts.signal && abortHandler) {
      opts.signal.removeEventListener("abort", abortHandler);
    }
    // Best-effort whole-directory cleanup of the per-run temp directory.
    // Never let a leftover dir break the call or leak on disk.
    await rm(logDir, { recursive: true, force: true }).catch(() => {});
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
 * Read the last 64 KiB of the agy log and extract the conversation ID,
 * swallowing any I/O or parse errors. The tail bound matters: the child
 * chooses how much it writes, and the ID is a single line near the end.
 */
const LOG_TAIL_BYTES = 65_536;

async function readConvIdFromLog(logFile: string): Promise<string | undefined> {
  try {
    const file = Bun.file(logFile);
    const size = file.size;
    const start = Math.max(0, size - LOG_TAIL_BYTES);
    const content = await file.slice(start, size).text();
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
  if (
    blob.includes("is not recognized as a known model") ||
    blob.includes("available models") ||
    blob.includes("agy_error")
  ) {
    const ultraOnly = blob.includes("argon");
    return new AgyError(
      "agy model not found — requested model is unavailable for this account",
      "MODEL_NOT_FOUND",
      {
        exitCode,
        hint: ultraOnly
          ? "Argon 4 tiers require the Ultra plan (plan is resolved server-side from the signed-in account; upgrade or pick another tier)"
          : "model requires a higher account plan (Pro/Ultra) or was removed upstream; run `agy models` to list the models this account may use",
      }
    );
  }
  if (blob.includes("command not found") || blob.includes("agy: not found") || blob.includes("enoent")) {
    return new AgyError("agy CLI not found on PATH", "AGY_NOT_FOUND", { exitCode });
  }
  return null;
}

/**
 * Best-effort secret scrubbing for anything shown to the parent model.
 * Replaces common token shapes with [REDACTED].
 * Classification logic receives raw stderr.
 */
export function scrubSecrets(text: string): string {
  if (!text) return text;
  return (
    text
      // PEM blocks, optionally assigned to a (quoted) key, span lines: redact
      // from BEGIN through the END line and any closing quote. Must run
      // before the single-line assignment rule below, which would otherwise
      // eat only the first line and leak the key body.
      .replace(
        /(?:\b[A-Za-z0-9_]*key["']?\s*[:=]\s*)?["']?\s*-----BEGIN[A-Z ]*-----[\s\S]*?-----END [A-Z ]+-----["']?/gi,
        "[REDACTED]"
      )
      // Authorization headers / bearer tokens
      .replace(/\bBearer\s+[A-Za-z0-9\-._~+\/]+=*/gi, "Bearer [REDACTED]")
      // OpenAI / Anthropic style keys: whole token, no surviving tail
      .replace(/\bsk-[A-Za-z0-9_-]{10,}/g, "[REDACTED]")
      // Google API keys (low minimum: prefer over-redaction to leakage)
      .replace(/\bAIza[0-9A-Za-z_-]{6,}/g, "[REDACTED]")
      // GitHub tokens (low minimum: truncated real tokens must still be redacted)
      .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{6,}/g, "[REDACTED]")
      .replace(/\bgithub_pat_[A-Za-z0-9_]{22,}/g, "[REDACTED]")
      // AWS access key IDs
      .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[REDACTED]")
      // Slack tokens (low minimum: short truncated tokens are still secrets)
      .replace(/\bxox[baprs]-[A-Za-z0-9-]{4,}/g, "[REDACTED]")
      // Generic assignments: FOO_SECRET=..., token: ..., password=..., api_key=...
      // (optional quotes around the name so JSON-style keys are covered, e.g.
      // "aws_secret_access_key": "...")
      .replace(
        /\b(password|passwd|pwd|token|secret|api_key|apikey|access_key|private_key|client_secret|[A-Z0-9_]+_(?:KEY|TOKEN|SECRET|PASSWORD))["']?\s*[:=]\s*["']?[^\s"']+["']?/gi,
        (_match, name: string) => `${name}=[REDACTED]`
      )
  );
}

/**
 * Render an exception message with secrets removed. Shared by the v1 and v2
 * error formatters so both surfaces behave the same.
 */
export function redactError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return scrubSecrets(message);
}

