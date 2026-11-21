/**
 * Persistent ACP client for the plugin's agy calls.
 *
 * Protocol (newline-delimited JSON-RPC 2.0 on stdio) follows the Agent
 * Client Protocol as used by npm `opencode-with-agy` 0.1.1 (session/new,
 * session/prompt, session/set_config_option, permission replies). Written
 * here rather than vendored. Also informed by rasyidrafi/opencode-agy.
 *
 * One long-lived `agy acp` child is reused across calls. A failed start
 * falls back to `agy --print` in the runner; a prompt that was already
 * sent is never retried blindly.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { AgyError, scrubSecrets, classifyAgyError, MAX_STDOUT_BYTES, type AgyResult, type Tier } from "./agy-runner";
import { ensureAgyOverlay, overlayChildEnv, type AgyOverlay } from "./agy-overlay";
import { buildChildEnv } from "./agy-runner";
import { isAcpEnabled, runningUnderBunTest } from "./agy-flags";

export type ThoughtLevel = "low" | "medium" | "high" | "xhigh";

export interface AcpModelRef {
  modelId: string;
  thoughtLevel?: ThoughtLevel;
}

/** Map plugin tiers to ACP `model` + `thought_level` config options. */
export const TIER_ACP: Record<Tier, AcpModelRef> = {
  "flash-3.8-hi": { modelId: "gemini-3.8-flash", thoughtLevel: "high" },
  "flash-3.8-med": { modelId: "gemini-3.8-flash", thoughtLevel: "medium" },
  "flash-3.8-lo": { modelId: "gemini-3.8-flash", thoughtLevel: "low" },
  "claude-sonnet-5-5-hi": { modelId: "claude-sonnet-5-5", thoughtLevel: "high" },
  "claude-sonnet-5-5-med": { modelId: "claude-sonnet-5-5", thoughtLevel: "medium" },
  "claude-sonnet-5-5-lo": { modelId: "claude-sonnet-5-5", thoughtLevel: "low" },
  "claude-opus-5-5-hi": { modelId: "claude-opus-5-5", thoughtLevel: "high" },
  "claude-opus-5-5-med": { modelId: "claude-opus-5-5", thoughtLevel: "medium" },
  "claude-opus-5-5-lo": { modelId: "claude-opus-5-5", thoughtLevel: "low" },
  "argon-4-hi": { modelId: "gemini-4-argon", thoughtLevel: "high" },
  "argon-4-med": { modelId: "gemini-4-argon", thoughtLevel: "medium" },
  "argon-4-lo": { modelId: "gemini-4-argon", thoughtLevel: "low" },
  "neon-4-hi": { modelId: "gemini-4-neon", thoughtLevel: "high" },
  "neon-4-med": { modelId: "gemini-4-neon", thoughtLevel: "medium" },
  "neon-4-lo": { modelId: "gemini-4-neon", thoughtLevel: "low" },
  "neon-4-xhigh": { modelId: "gemini-4-neon", thoughtLevel: "xhigh" },
  "hydrogen-4-hi": { modelId: "gemini-4-hydrogen", thoughtLevel: "high" },
  "hydrogen-4-med": { modelId: "gemini-4-hydrogen", thoughtLevel: "medium" },
  "hydrogen-4-lo": { modelId: "gemini-4-hydrogen", thoughtLevel: "low" },
  "hydrogen-4-xhigh": { modelId: "gemini-4-hydrogen", thoughtLevel: "xhigh" },
  "gpt-oss-120b-med": { modelId: "gpt-oss-120b-medium" },
  "orchestrator-argon": { modelId: "gemini-pro-orchestrator-g1-pro" },
  "orchestrator-neon": { modelId: "gemini-pro-orchestrator-neon" },
};

const DISPLAY_TO_ACP: Record<string, AcpModelRef> = {
  "Gemini 3.8 Flash (High)": TIER_ACP["flash-3.8-hi"],
  "Gemini 3.8 Flash (Medium)": TIER_ACP["flash-3.8-med"],
  "Gemini 3.8 Flash (Low)": TIER_ACP["flash-3.8-lo"],
  "Claude Sonnet 5.5 (High)": TIER_ACP["claude-sonnet-5-5-hi"],
  "Claude Sonnet 5.5 (Medium)": TIER_ACP["claude-sonnet-5-5-med"],
  "Claude Sonnet 5.5 (Low)": TIER_ACP["claude-sonnet-5-5-lo"],
  "Claude Opus 5.5 (High)": TIER_ACP["claude-opus-5-5-hi"],
  "Claude Opus 5.5 (Medium)": TIER_ACP["claude-opus-5-5-med"],
  "Claude Opus 5.5 (Low)": TIER_ACP["claude-opus-5-5-lo"],
  "Gemini 4 Argon (High)": TIER_ACP["argon-4-hi"],
  "Gemini 4 Argon (Medium)": TIER_ACP["argon-4-med"],
  "Gemini 4 Argon (Low)": TIER_ACP["argon-4-lo"],
  "Gemini 4 Neon (High)": TIER_ACP["neon-4-hi"],
  "Gemini 4 Neon (Medium)": TIER_ACP["neon-4-med"],
  "Gemini 4 Neon (Low)": TIER_ACP["neon-4-lo"],
  "Gemini 4 Neon (XHigh)": TIER_ACP["neon-4-xhigh"],
  "Gemini 4 Hydrogen (High)": TIER_ACP["hydrogen-4-hi"],
  "Gemini 4 Hydrogen (Medium)": TIER_ACP["hydrogen-4-med"],
  "Gemini 4 Hydrogen (Low)": TIER_ACP["hydrogen-4-lo"],
  "Gemini 4 Hydrogen (XHigh)": TIER_ACP["hydrogen-4-xhigh"],
  "GPT-OSS 120B (Medium)": TIER_ACP["gpt-oss-120b-med"],
  "Orchestrator (Argon)": TIER_ACP["orchestrator-argon"],
  "Orchestrator (Neon)": TIER_ACP["orchestrator-neon"],
};

export function resolveAcpModel(opts: { tier?: Tier; model?: string }): AcpModelRef {
  if (opts.model) {
    const named = DISPLAY_TO_ACP[opts.model];
    if (named) return named;
    return { modelId: opts.model };
  }
  if (opts.tier && Object.hasOwn(TIER_ACP, opts.tier)) return TIER_ACP[opts.tier];
  return TIER_ACP["flash-3.8-med"];
}

export interface AcpClientOptions {
  command?: string;
  argv?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  startTimeoutMs?: number;
  permission?: "allow" | "deny";
  geminiDir?: string;
}

type Pending = {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
};

type ConfigOption = {
  id?: string;
  currentValue?: string;
  options?: { value: string; name?: string }[];
};

export class AcpUnavailableError extends AgyError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "ACP_UNAVAILABLE", { ...(details || {}), fallback: "print" });
    this.name = "AcpUnavailableError";
  }
}

/**
 * One `agy acp` child speaking NDJSON JSON-RPC 2.0 on stdio.
 */
export class AcpClient {
  generation = 0;
  private child: ChildProcessWithoutNullStreams | undefined;
  private starting: Promise<void> | undefined;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buffer = "";
  private disposed = false;
  private stderrTail = "";
  private parked: { sessionId: string; cwd: string } | undefined;

  constructor(private readonly options: AcpClientOptions = {}) {}

  get running(): boolean {
    return Boolean(this.child && this.child.exitCode == null);
  }

  async start(signal?: AbortSignal): Promise<void> {
    if (this.disposed) throw new AcpUnavailableError("agy ACP client is disposed");
    if (this.running) return;
    if (this.starting) return this.starting;
    this.beginOp();
    this.starting = this.spawnAndInitialize(signal)
      .finally(() => {
        this.starting = undefined;
        this.endOp();
      });
    return this.starting;
  }

  async request<T = unknown>(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    await this.start();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new AgyError("agy ACP request aborted", "TIMEOUT"));
        return;
      }
      const onAbort = () => {
        this.pending.delete(id);
        reject(new AgyError("agy ACP request aborted", "TIMEOUT"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener("abort", onAbort);
          if (this.pending.size === 0 && this.ops === 0) this.setBusy(false);
          resolve(value as T);
        },
        reject: (err) => {
          signal?.removeEventListener("abort", onAbort);
          if (this.pending.size === 0 && this.ops === 0) this.setBusy(false);
          reject(err);
        },
      });
      this.setBusy(true);
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    try {
      this.write({ jsonrpc: "2.0", method, params });
    } catch {
      // child already gone
    }
  }

  /**
   * Fresh session (empty context) → set model → prompt → close.
   * Reuses a pre-warmed unused session when the cwd matches.
   */

  async runPrompt(input: {
    cwd: string;
    prompt: string;
    model: AcpModelRef;
    signal?: AbortSignal;
    timeoutMs: number;
  }): Promise<{ text: string; sessionId: string }> {
    this.beginOp();
    let sessionId: string | undefined;
    let sent = false;
    const budget = Math.max(1_000, input.timeoutMs);
    const ac = new AbortController();
    const onCallerAbort = () => {
      try {
        ac.abort();
      } catch {
        // already aborted
      }
    };
    if (input.signal?.aborted) onCallerAbort();
    else input.signal?.addEventListener("abort", onCallerAbort, { once: true });
    const timeout = setTimeout(onCallerAbort, budget);
    timeout.unref?.();

    const timedOut = (wasSent: boolean) =>
      new AgyError("agy ACP request timed out", "TIMEOUT", { sent: wasSent, transport: "acp" });

    try {
      await this.start(ac.signal);
      if (ac.signal.aborted) throw timedOut(false);
      sessionId = await this.takeSession(input.cwd, ac.signal);
      this.texts.set(sessionId, []);
      await this.applyModel(sessionId, input.model, ac.signal);
      sent = true;
      if (ac.signal.aborted) {
        this.notify("session/cancel", { sessionId });
        throw timedOut(true);
      }
      const result = await this.request<{ stopReason?: string }>(
        "session/prompt",
        { sessionId, prompt: [{ type: "text", text: input.prompt }] },
        ac.signal
      );
      const text = this.consumeText(sessionId);
      if (!text.trim()) {
        throw new AgyError("agy returned empty output", "EMPTY_OUTPUT", {
          transport: "acp",
          stopReason: result?.stopReason,
          sent: true,
        });
      }
      return { text, sessionId };
    } catch (err) {
      if (ac.signal.aborted) {
        if (sessionId && sent) this.notify("session/cancel", { sessionId });
        if (err instanceof AgyError && err.code === "TIMEOUT") {
          throw new AgyError(err.message, "TIMEOUT", { ...(err.details || {}), sent, transport: "acp" });
        }
        throw timedOut(sent);
      }
      if (sent && err instanceof AgyError) {
        throw new AgyError(err.message, err.code, {
          ...(err.details || {}),
          sent: true,
          transport: "acp",
        });
      }
      throw err;
    } finally {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", onCallerAbort);
      if (sessionId) {
        this.texts.delete(sessionId);
        if (this.running) {
          const closed = await this.closeSession(sessionId);
          // Only kill on a hung close. An error reply still means the child is
          // alive and should be reused; a hanging request must not stay in
          // `pending` (closeSession aborts it after 2s).
          if (closed === "timeout" && this.ops <= 1) this.killSync();
        }
      }
      this.endOp();
    }
  }

  /**
   * Open one unused session so the first real call does not pay startup.
   */
  async prewarmSession(cwd: string): Promise<void> {
    this.beginOp();
    const ac = new AbortController();
    const budget = this.options.startTimeoutMs ?? 60_000;
    const timer = setTimeout(() => {
      try {
        ac.abort();
      } catch {
        // already aborted
      }
    }, budget);
    timer.unref?.();
    try {
      await this.start(ac.signal);
      if (this.parked?.cwd === cwd) return;
      if (this.parked) {
        await this.closeSession(this.parked.sessionId);
        this.parked = undefined;
      }
      const sessionId = await this.newSession(cwd, ac.signal);
      this.parked = { sessionId, cwd };
    } finally {
      clearTimeout(timer);
      this.endOp();
    }
  }

  /** Close a session, waiting at most 2s. "timeout" means the child did not answer. */
  private async closeSession(sessionId: string): Promise<"acked" | "error" | "timeout"> {
    if (!this.running) return "acked";
    const ac = new AbortController();
    const timer = setTimeout(() => {
      try {
        ac.abort();
      } catch {
        // already aborted
      }
    }, 2_000);
    timer.unref?.();
    try {
      await this.request("session/close", { sessionId }, ac.signal);
      return "acked";
    } catch {
      return ac.signal.aborted ? "timeout" : "error";
    } finally {
      clearTimeout(timer);
    }
  }

  killSync(): void {
    const child = this.child;
    if (!child || child.exitCode != null) return;
    try {
      child.kill("SIGTERM");
    } catch {
      // already gone
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.parked = undefined;
    if (this.idleUnref) {
      clearTimeout(this.idleUnref);
      this.idleUnref = undefined;
    }
    const child = this.child;
    this.child = undefined;
    this.rejectAll(new AcpUnavailableError("agy ACP client disposed"));
    if (!child || child.exitCode != null) return;
    child.ref?.();
    (child.stdin as any).ref?.();
    (child.stdout as any).ref?.();
    (child.stderr as any).ref?.();
    try {
      child.stdin.end();
    } catch {
      // ignore
    }
    const wait = new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
        resolve();
      }, 2_000);
      t.unref?.();
      child.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
    await wait;
  }

  private async takeSession(cwd: string, signal?: AbortSignal): Promise<string> {
    const parked = this.parked;
    if (parked && parked.cwd === cwd) {
      this.parked = undefined;
      return parked.sessionId;
    }
    if (parked) {
      this.parked = undefined;
      const closed = await this.closeSession(parked.sessionId);
      if (closed === "timeout" && this.ops <= 1) this.killSync();
    }
    return this.newSession(cwd, signal);
  }

  private async newSession(cwd: string, signal?: AbortSignal): Promise<string> {
    const created = await this.request<{ sessionId?: string; configOptions?: ConfigOption[] }>(
      "session/new",
      { cwd, mcpServers: [] },
      signal
    );
    const sessionId = created?.sessionId;
    if (!sessionId) throw new AcpUnavailableError("agy ACP session/new returned no sessionId");
    return sessionId;
  }

  private async applyModel(sessionId: string, model: AcpModelRef, signal?: AbortSignal): Promise<void> {
    const after = await this.request<{ configOptions?: ConfigOption[] }>("session/set_config_option", {
      sessionId,
      configId: "model",
      value: model.modelId,
    }, signal);
    if (!model.thoughtLevel) return;
    const thought = (after?.configOptions ?? []).find((c) => c.id === "thought_level");
    const allowed = (thought?.options ?? []).map((o) => o.value);
    if (allowed.length > 0 && !allowed.includes(model.thoughtLevel)) {
      throw new AgyError(
        `agy model ${model.modelId} does not offer thought level ${model.thoughtLevel}`,
        "MODEL_NOT_FOUND",
        { modelId: model.modelId, thoughtLevel: model.thoughtLevel, allowed, hint: "Run `agy models` or pick another tier." }
      );
    }
    if (thought?.currentValue === model.thoughtLevel) return;
    await this.request("session/set_config_option", {
      sessionId,
      configId: "thought_level",
      value: model.thoughtLevel,
    }, signal);
  }

  private texts = new Map<string, string[]>();

  private consumeText(sessionId: string): string {
    const chunks = this.texts.get(sessionId) ?? [];
    this.texts.delete(sessionId);
    return chunks.join("");
  }


  private ops = 0;

  private beginOp(): void {
    this.ops += 1;
    this.setBusy(true);
  }

  private endOp(): void {
    this.ops = Math.max(0, this.ops - 1);
    if (this.ops === 0 && this.pending.size === 0) this.setBusy(false);
  }

  private idleUnref: ReturnType<typeof setTimeout> | undefined;

  private setBusy(busy: boolean): void {
    const child = this.child;
    if (!child) return;
    if (this.idleUnref) {
      clearTimeout(this.idleUnref);
      this.idleUnref = undefined;
    }
    const apply = (wantBusy: boolean) => {
      const streams: any[] = [child.stdin, child.stdout, child.stderr];
      for (const stream of streams) {
        if (!stream) continue;
        if (wantBusy) stream.ref?.();
        else stream.unref?.();
      }
      if (wantBusy) child.ref?.();
      else child.unref?.();
    };
    if (busy) {
      apply(true);
      return;
    }
    // Delay unref so dispose()/the next await in the same turn can attach.
    this.idleUnref = setTimeout(() => {
      this.idleUnref = undefined;
      if (this.ops === 0 && this.pending.size === 0) apply(false);
    }, 100);
  }

  private async spawnAndInitialize(signal?: AbortSignal): Promise<void> {
    this.generation += 1;
    const command = this.options.command ?? "agy";
    const argv = this.options.argv ? [...this.options.argv] : undefined;
    const startTimeout = this.options.startTimeoutMs ?? 60_000;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, argv ?? defaultAcpArgv(this.options), {
        cwd: this.options.cwd,
        env: this.options.env as NodeJS.ProcessEnv | undefined,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err: any) {
      if (err?.code === "ENOENT" || String(err).toLowerCase().includes("not found")) {
        throw new AcpUnavailableError("agy CLI not found on PATH", { original: scrubSecrets(String(err)) });
      }
      throw new AcpUnavailableError(`failed to spawn agy acp: ${scrubSecrets(String(err))}`);
    }
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-8_000);
    });
    child.on("error", (err) => {
      this.child = undefined;
      this.rejectAll(new AcpUnavailableError(`agy ACP process error: ${scrubSecrets(String(err))}`));
    });
    child.on("exit", (code, signal) => {
      if (this.child === child) this.child = undefined;
      this.parked = undefined;
      this.texts.clear();
      this.buffer = "";
      const classified = classifyAgyError(this.stderrTail, code ?? 1);
      this.rejectAll(
        classified ??
          new AcpUnavailableError(
            `agy ACP process exited${code != null ? ` with code ${code}` : signal ? ` on ${signal}` : ""}`,
            { exitCode: code, signal, stderr: scrubSecrets(this.stderrTail) }
          )
      );
    });
    // Unref only when idle so a finished OpenCode run can exit; stay
    // referenced while start/prompt work is in flight (ops/pending).
    child.unref?.();
    this.setBusy(this.ops > 0 || this.pending.size > 0);

    const killer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, startTimeout);
    killer.unref?.();
    const onAbort = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await this.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "opencode-agy", version: "0.16.0-local" },
      }, signal);
    } catch (err) {
      if (this.child === child) this.child = undefined;
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      throw err instanceof AgyError
        ? err
        : new AcpUnavailableError(`agy ACP initialize failed: ${scrubSecrets(String(err))}`);
    } finally {
      clearTimeout(killer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const nl = this.buffer.indexOf("\n");
      if (nl < 0) break;
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      this.route(msg);
    }
  }

  private route(msg: any): void {
    if (msg && typeof msg.id !== "undefined" && (Object.hasOwn(msg, "result") || Object.hasOwn(msg, "error"))) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        const err = msg.error;
        const text = `${err.message ?? "ACP error"}${err.data ? ` ${safeJson(err.data)}` : ""}`;
        const classified = classifyAgyError(text, 1);
        pending.reject(classified ?? new AgyError(scrubSecrets(text), "AGY_FAILED", { acp: err }));
        return;
      }
      pending.resolve(msg.result);
      return;
    }
    if (msg && msg.method && typeof msg.id !== "undefined" && !Object.hasOwn(msg, "result")) {
      this.handleRequest(msg);
      return;
    }
    if (msg?.method === "session/update") {
      const params = msg.params ?? {};
      const update = params.update ?? params;
      const sessionId = params.sessionId ?? update.sessionId;
      if (update?.sessionUpdate === "agent_message_chunk") {
        const text = update?.content?.text;
        if (typeof text === "string" && sessionId && this.texts.has(sessionId)) {
          const list = this.texts.get(sessionId)!;
          const used = list.join("").length;
          if (used >= MAX_STDOUT_BYTES) return;
          const room = MAX_STDOUT_BYTES - used;
          if (text.length > room) {
            list.push(`${text.slice(0, room)}\n... [truncated ${text.length - room} chars]`);
          } else {
            list.push(text);
          }
        }
      }
    }
  }

  private handleRequest(msg: any): void {
    const method = msg.method;
    let result: unknown = {};
    if (method === "session/request_permission") {
      const mode = this.options.permission ?? "deny";
      const options: { optionId?: string; kind?: string }[] = msg.params?.options ?? [];
      if (mode === "deny") {
        const reject = options.find((o) => String(o.kind || "").startsWith("reject"));
        result = reject?.optionId
          ? { outcome: { outcome: "selected", optionId: reject.optionId } }
          : { outcome: { outcome: "cancelled" } };
      } else {
        const allow = options.find((o) => o.kind === "allow_once" || o.kind === "allow_always");
        result = allow?.optionId
          ? { outcome: { outcome: "selected", optionId: allow.optionId } }
          : { outcome: { outcome: "cancelled" } };
      }
    }
    try {
      this.write({ jsonrpc: "2.0", id: msg.id, result });
    } catch {
      // ignore
    }
  }

  private write(msg: unknown): void {
    const child = this.child;
    if (!child || child.exitCode != null) {
      throw new AcpUnavailableError("agy ACP process is not running");
    }
    child.stdin.write(JSON.stringify(msg) + "\n");
  }

  private rejectAll(err: Error): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    this.setBusy(false);
    for (const p of pending) p.reject(err);
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

export function defaultAcpArgv(options: { geminiDir?: string } = {}): string[] {
  const args = [
    "acp",
    "--stdio",
    "--disable-telemetry",
    "--include-default-customizations=false",
  ];
  if (options.geminiDir) args.push("--gemini-dir", options.geminiDir);
  return args;
}


/**
 * Pre-warm is on by default when OpenCode loads the plugin. Turn it off
 * with OPENCODE_AGY_PREWARM=0. It is also off under `bun test` so unit
 * tests do not spawn a real agy process.
 */
export function isPrewarmEnabled(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv): boolean {
  const raw = env.OPENCODE_AGY_PREWARM;
  if (raw === "0" || raw === "false" || raw === "no") return false;
  const underTest = runningUnderBunTest(env, argv);
  if (raw === "1" || raw === "true" || raw === "yes") return true;
  if (underTest) return false;
  return isAcpEnabled(env, argv);
}

let shared: AcpClient | undefined;
let sharedStart: Promise<AcpClient> | undefined;
let hooksInstalled = false;

let launchOverride: { command?: string; argv?: readonly string[]; env?: NodeJS.ProcessEnv } | undefined;

/** Test hook: point the shared client at a fake ACP process. */
export function setAcpLaunchForTests(opts: { command?: string; argv?: readonly string[]; env?: NodeJS.ProcessEnv } | undefined): void {
  launchOverride = opts;
  shared = undefined;
  sharedStart = undefined;
}


function installShutdownHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  const sync = () => {
    try {
      shared?.killSync();
    } catch {
      // ignore
    }
  };
  process.once("exit", sync);
  process.once("beforeExit", () => {
    void disposeAgyAcp();
  });
  const onSignal = (sig: NodeJS.Signals) => {
    try {
      shared?.killSync();
    } catch {
      // ignore
    }
    void disposeAgyAcp();
    // once() already removed this listener. Re-raise only when the host
    // has no remaining handler, so we do not swallow the first SIGINT/SIGTERM.
    if (process.listenerCount(sig) === 0) {
      try {
        process.kill(process.pid, sig);
      } catch {
        // ignore
      }
    }
  };
  process.once("SIGINT", () => onSignal("SIGINT"));
  process.once("SIGTERM", () => onSignal("SIGTERM"));
}

export async function getSharedAcpClient(options: { cwd?: string; overlay?: AgyOverlay } = {}): Promise<AcpClient> {
  if (shared?.running) return shared;
  if (sharedStart) return sharedStart;
  sharedStart = (async () => {
    const overlay = options.overlay ?? ensureAgyOverlay();
    const env = overlayChildEnv(overlay, buildChildEnv());
    const client = new AcpClient({
      cwd: options.cwd,
      env: { ...env, ...(launchOverride?.env ?? {}) },
      command: launchOverride?.command,
      argv: launchOverride?.argv ?? defaultAcpArgv({ geminiDir: overlay.geminiDir }),
    });
    installShutdownHooks();
    await client.start();
    shared = client;
    return client;
  })().finally(() => {
    sharedStart = undefined;
  });
  return sharedStart;
}

/** Fire-and-forget warmup from plugin setup. Never throws to the host. */
export function prewarmAgyAcp(options: { cwd?: string } = {}): void {
  if (!isPrewarmEnabled() || !isAcpEnabled()) return;
  void getSharedAcpClient({ cwd: options.cwd })
    .then((client) => client.prewarmSession(options.cwd || process.cwd()))
    .catch(() => {
      // First real call will wait or fall back to --print.
    });
}

export async function disposeAgyAcp(): Promise<void> {
  const client = shared;
  shared = undefined;
  sharedStart = undefined;
  if (client) await client.dispose();
}

export function isFallbackWorthy(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as AgyError).code;
  if (code !== "ACP_UNAVAILABLE") return false;
  const sent = (err as AgyError).details?.sent === true;
  return !sent;
}

export async function runAgyViaAcp(input: {
  cwd: string;
  prompt: string;
  tier?: Tier;
  model?: string;
  signal?: AbortSignal;
  timeoutMs: number;
}): Promise<AgyResult> {
  const start = Date.now();
  const ac = new AbortController();
  const onCallerAbort = () => {
    try {
      ac.abort();
    } catch {
      // already aborted
    }
  };
  if (input.signal?.aborted) onCallerAbort();
  else input.signal?.addEventListener("abort", onCallerAbort, { once: true });
  const startTimer = setTimeout(onCallerAbort, Math.max(1_000, input.timeoutMs));
  startTimer.unref?.();
  let client: AcpClient;
  try {
    client = await Promise.race([
      getSharedAcpClient({ cwd: input.cwd }),
      new Promise<AcpClient>((_, reject) => {
        const fail = () => reject(new AcpUnavailableError("agy ACP start timed out", { sent: false }));
        if (ac.signal.aborted) fail();
        else ac.signal.addEventListener("abort", fail, { once: true });
      }),
    ]);
  } catch (err) {
    // A caller abort is not a start failure: do not fall back to --print.
    if (input.signal?.aborted) {
      throw new AgyError("agy ACP request aborted", "TIMEOUT", { sent: false, transport: "acp" });
    }
    throw err;
  } finally {
    clearTimeout(startTimer);
    input.signal?.removeEventListener("abort", onCallerAbort);
  }
  const model = resolveAcpModel({ tier: input.tier, model: input.model });
  const leftover = Math.max(500, input.timeoutMs - (Date.now() - start));
  const out = await client.runPrompt({
    cwd: input.cwd,
    prompt: input.prompt,
    model,
    signal: input.signal,
    timeoutMs: leftover,
  });
  return {
    stdout: scrubSecrets(out.text),
    stderr: "",
    exitCode: 0,
    durationMs: Date.now() - start,
    conversationId: out.sessionId,
    transport: "acp",
    tier: input.tier,
  };
}
