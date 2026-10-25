import { runAgy, AgyError, isValidConversationId, redactError, scrubSecrets, type AgyResult } from "./agy-runner";
import { createAgyCommand, upsertRegistryEntry } from "./agy-command";

/**
 * Native JSON Schema for OpenCode 2.x tool registration.
 * Has zero dependency on @opencode-ai/plugin or Zod.
 */
export const AGY_V2_TOOL_SCHEMA = {
  type: "object",
  properties: {
    prompt: {
      type: "string",
      description: "The task to send to agy/Gemini. Be specific and scoped.",
    },
    tier: {
      type: "string",
      enum: [
        "flash-3.8-hi",
        "flash-3.8-med",
        "flash-3.8-lo",
        "claude-sonnet-5-5-hi",
        "claude-sonnet-5-5-med",
        "claude-sonnet-5-5-lo",
        "claude-opus-5-5-hi",
        "claude-opus-5-5-med",
        "claude-opus-5-5-lo",
        "argon-4-hi",
        "argon-4-med",
        "argon-4-lo",
      ],
      description:
        "Model tier. flash-3.8-med (default) = Gemini 3.8 Flash Medium (works on every account). flash-3.8-hi = Gemini 3.8 Flash High, flash-3.8-lo = cheapest Flash. claude-sonnet-5-5-hi/med/lo = Claude Sonnet 5.5 (requires a Pro or Ultra plan). claude-opus-5-5-hi/med/lo = Claude Opus 5.5 (requires a Pro or Ultra plan). argon-4-hi/med/lo = Gemini 4 Argon (Ultra plan only). Gemini 3.6/3.7 Flash and 3.1 Pro tiers were removed upstream (Enterprise-only) and are no longer accepted.",
    },
    dir: {
      type: "string",
      description:
        "Workspace directory to give agy (--add-dir). Must resolve inside the workspace root (AGY_WORKSPACE_ROOT, default: the current project).",
    },
    project: {
      type: "string",
      description: "Project name to pass to agy (--project <value>).",
    },
    timeout: {
      oneOf: [{ type: "string" }, { type: "number" }],
      description:
        "Timeout for agy. Accepts duration strings like '5m', '10m', '300s', or a positive integer of milliseconds (e.g. 300000). " +
        "Numbers are normalized to a proper duration (300000 → '5m'). " +
        "Default: '15m' for every tier. " +
        "Values that are not a positive duration are rejected with INVALID_TIMEOUT. " +
        "Hard upper bound: any value above 4h is clamped to '4h'. " +
        "For long tasks (big merges, heavy refactors) use '15m' or '30m'.",
    },
    yolo: {
      type: "boolean",
      description:
        "Auto-approve every tool inside agy (--dangerously-skip-permissions). Requires sandbox: true and host consent (AGY_ALLOW_YOLO=1); otherwise the call is rejected with YOLO_NOT_APPROVED.",
    },
    sandbox: {
      type: "boolean",
      description:
        "Run agy with terminal restrictions enabled (--sandbox). Recommended when giving broad permissions. " +
        "Does not restrict file reads — only restricts terminal commands.",
    },
    continue: {
      type: "boolean",
      description:
        "Resume the most recent agy conversation (--continue). Useful for long-running or multi-turn work.",
    },
    conversation: {
      type: "string",
      description: "Resume a specific agy conversation by ID (--conversation <id>).",
    },
    model: {
      type: "string",
      description:
        "Exact model name override (advanced / future-proof). Example: 'Claude Sonnet 5.5 (High)'.",
    },
  },
  required: ["prompt"],
  additionalProperties: false,
} as const;

export interface AgyV2ToolResult {
  content: string;
  metadata?: Record<string, any>;
}

export function buildAgyV2ToolResult(
  result: AgyResult | undefined,
  args: Record<string, any> = {}
): AgyV2ToolResult {
  if (!result) {
    return {
      content: [
        "AGY_UNDEFINED_RESULT",
        "agy runner returned an undefined result. This usually means the tool was invoked by an incompatible OpenCode version.",
        "Please report this issue.",
      ].join("\n"),
      metadata: { error: true, unexpected: true, code: "UNDEFINED_RESULT" },
    };
  }

  const header = [
    `## agy result`,
    `tier: ${args.tier ?? "flash-3.8-med"}`,
    `duration: ${result.durationMs}ms`,
    `exit: ${result.exitCode}`,
    args.sandbox ? `sandbox: true` : "",
    (args.continue || args.conversation) ? `resumed: true` : "",
    (args.yolo && args.sandbox)
      ? "WARNING: yolo (--dangerously-skip-permissions) + sandbox both enabled. agy will auto-approve every tool inside a restricted terminal."
      : "",
    ``,
  ].filter(Boolean).join("\n");

  const content = header ? header + "\n" + result.stdout : result.stdout;

  return {
    content,
    metadata: {
      tier: args.tier ?? "flash-3.8-med",
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      tool: "agy",
      sandbox: !!args.sandbox,
      yolo: !!args.yolo,
      resumed: !!(args.continue || args.conversation),
      ...(result.conversationId ? { conversationId: result.conversationId } : {}),
    },
  };
}

function formatV2Error(err: unknown): AgyV2ToolResult {
  if (err instanceof AgyError) {
    // Only echo a conversation id we would accept back as a selector; a value
    // the log parser invented must never become model guidance.
    const convId = isValidConversationId(err.details?.conversationId)
      ? err.details.conversationId
      : undefined;
    const resumeHint = convId
      ? `\nTo resume this exact conversation: pass conversation: "${convId}" (or --continue) together with a higher timeout (see details.suggestedNextTimeout) if available.`
      : "";

    const body = [
      `AGY_ERROR [${err.code}]`,
      redactError(err),
      err.details ? scrubSecrets(JSON.stringify(err.details, null, 2)) : "",
      "",
      "agy sub-agent failed. Decide whether to retry with higher timeout (see details.suggestedNextTimeout or durationMs), change tier, use --continue/--conversation, enable --sandbox (or not for merges), or handle manually.",
      resumeHint,
    ].join("\n");

    return {
      content: body,
      metadata: {
        error: true,
        code: err.code,
        details: err.details,
        ...(convId ? { conversationId: convId } : {}),
      },
    };
  }

  const body = [
    `AGY_UNEXPECTED_ERROR`,
    redactError(err),
    "",
    "Bug in opencode-agy plugin or environment. Please report.",
  ].join("\n");

  return {
    content: body,
    metadata: {
      error: true,
      unexpected: true,
    },
  };
}

/** v2 registration never overwrites: any defined existing value counts as taken. */
const defined = (value: unknown): boolean => value !== undefined;

export async function setupV2Plugin(ctx: any): Promise<void> {
  if (!ctx || typeof ctx !== "object") return;

  if (typeof ctx.tool?.transform === "function") {
    await ctx.tool.transform((editor: any) => {
      upsertRegistryEntry(editor, "agy", {
        name: "agy",
        description:
          "Delegate a well-scoped task to Antigravity (agy / Gemini) in headless mode. " +
          "Best for bulk work, scaffolding, tests, research, or cross-model verification. " +
          "The main agent MUST verify the result. " +
          "Supports resume (`continue` / `conversation`) and `--sandbox` for safer tool use. " +
          "`dir` is confined to the workspace root; for local file analysis (PDF, PNG, images) set `dir` to the file's directory inside that root. " +
          "`yolo: true` additionally requires `sandbox: true` and host consent; it auto-approves every tool inside agy. " +
          "`sandbox: true` is compatible with file reads (restricts only terminal commands).",
        schema: AGY_V2_TOOL_SCHEMA,
        input: AGY_V2_TOOL_SCHEMA,
        parameters: AGY_V2_TOOL_SCHEMA,
        execute: async (args: any, context?: any) => {
          try {
            const result = await runAgy({
              prompt: args.prompt,
              tier: args.tier,
              dir: args.dir,
              project: args.project,
              timeout: args.timeout,
              yolo: args.yolo,
              sandbox: args.sandbox,
              continue: args.continue,
              conversation: args.conversation,
              model: args.model,
              signal: context?.signal,
            });
            return buildAgyV2ToolResult(result, args);
          } catch (err: unknown) {
            return formatV2Error(err);
          }
        },
      }, defined);
    });
  }

  if (typeof ctx.command?.transform === "function") {
    await ctx.command.transform((editor: any) => {
      const cmd = createAgyCommand();
      upsertRegistryEntry(editor, "agy", {
        name: "agy",
        description: cmd.description,
        template: cmd.template,
      }, defined);
    });
  }
}
