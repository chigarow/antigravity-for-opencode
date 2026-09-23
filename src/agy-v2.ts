import { runAgy, AgyError, type AgyResult } from "./agy-runner";
import { createAgyCommand } from "./agy-command";

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
        "flash-3.8-lo",
        "flash-3.8-med",
        "pro-3.1-hi",
        "pro-3.1-lo",
        "flash-3.6-hi",
        "flash-3.6-med",
        "flash-3.6-lo",
        "flash-3.7-hi",
        "flash-3.7-med",
        "flash-3.7-lo",
      ],
      description:
        "Model tier. flash-3.8-med (default) = Gemini 3.8 Flash Medium, flash-3.8-hi = newest fast flash model, flash-3.8-lo = cheapest, flash-3.6-med = Gemini 3.6 Flash Medium, flash-3.6-hi = Gemini 3.6 Flash High, flash-3.6-lo = cheapest 3.6 option, flash-3.7-hi = Gemini 3.7 Flash High, flash-3.7-med = Gemini 3.7 Flash Medium, flash-3.7-lo = cheapest 3.7 option, pro-3.1-hi = stronger Gemini 3.1 Pro, pro-3.1-lo = Gemini 3.1 Pro (Low). Gemini 3.5 Flash tiers were removed upstream.",
    },
    dir: {
      type: "string",
      description: "Workspace directory to give agy (--add-dir).",
    },
    project: {
      type: "string",
      description: "Project name to pass to agy (--project <value>).",
    },
    timeout: {
      oneOf: [{ type: "string" }, { type: "number" }],
      description:
        "Timeout for agy. Accepts duration strings like '5m', '10m', '300s', or raw milliseconds (e.g. 300000 or 600000). " +
        "Numbers/strings of digits are normalized to proper duration (300000 → '5m'). " +
        "Default depends on tier: 'pro-3.1-hi' and 'pro-3.1-lo' default to '15m' (heavier work); flash-3.8-hi/flash-3.8-lo/flash-3.8-med/flash-3.6-hi/flash-3.6-med/flash-3.6-lo/flash-3.7-hi/flash-3.7-med/flash-3.7-lo default to '10m'. " +
        "Hard upper bound: any value above 4h is silently clamped to '4h'. " +
        "For long tasks (big merges, heavy refactors) use '15m' or '30m' and/or tier=pro-3.1-hi.",
    },
    yolo: {
      type: "boolean",
      description:
        "Auto-approve every tool inside agy (--dangerously-skip-permissions). Use only with --sandbox or throwaway dirs. " +
        "Required for local file analysis (PDF/image) — agy's MCP tools need auto-approval in headless mode.",
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
        "Exact model name override (advanced / future-proof). Example: 'Gemini 3.1 Pro (High)'.",
    },
  },
  required: ["prompt"],
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
    const convId = err.details?.conversationId;
    const resumeHint = convId
      ? `\nTo resume this exact conversation: pass conversation: "${convId}" (or --continue) together with a higher timeout (see details.suggestedNextTimeout) if available.`
      : "";

    const body = [
      `AGY_ERROR [${err.code}]`,
      err.message,
      err.details ? JSON.stringify(err.details, null, 2) : "",
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

  const message = err instanceof Error ? err.message : String(err);
  const body = [
    `AGY_UNEXPECTED_ERROR`,
    message,
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

export async function setupV2Plugin(ctx: any): Promise<void> {
  if (!ctx || typeof ctx !== "object") return;

  if (typeof ctx.tool?.transform === "function") {
    await ctx.tool.transform((editor: any) => {
      const toolDef = {
        name: "agy",
        description:
          "Delegate a well-scoped task to Antigravity (agy / Gemini) in headless mode. " +
          "Best for bulk work, scaffolding, tests, research, or cross-model verification. " +
          "The main agent MUST verify the result. " +
          "Supports resume (`continue` / `conversation`) and `--sandbox` for safer tool use. " +
          "For local file analysis (PDF, PNG, images), set `dir` to the file's parent directory AND set `yolo: true`. " +
          "In headless mode, agy's file-reading tools (pdf-reader, read_file) default to 'Ask' permission which deadlocks without a TTY. " +
          "`yolo: true` auto-approves all tool permissions; `dir` scopes the workspace so agy can access the file. " +
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
      };

      if (typeof editor?.add === "function") {
        editor.add(toolDef);
      } else if (Array.isArray(editor)) {
        editor.push(toolDef);
      } else if (editor && typeof editor === "object") {
        editor.agy = toolDef;
      }
    });
  }

  if (typeof ctx.command?.transform === "function") {
    await ctx.command.transform((editor: any) => {
      const cmd = createAgyCommand();
      const cmdDef = {
        name: "agy",
        description: cmd.description,
        template: cmd.template,
      };

      if (typeof editor?.add === "function") {
        editor.add(cmdDef);
      } else if (Array.isArray(editor)) {
        editor.push(cmdDef);
      } else if (editor && typeof editor === "object") {
        editor.agy = cmdDef;
      }
    });
  }
}
