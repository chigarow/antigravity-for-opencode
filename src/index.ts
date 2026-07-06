import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { runAgy, AgyError, type Tier, type AgyResult } from "./agy-runner";

/**
 * Arguments accepted by the agy tool and by {@link buildAgyToolResult}.
 * Mirrors the tool schema one-to-one.
 */
export interface AgyToolArgs {
  prompt: string;
  tier?: Tier;
  dir?: string;
  project?: string;
  timeout?: string | number;
  yolo?: boolean;
  sandbox?: boolean;
  continue?: boolean;
  conversation?: string;
  model?: string;
}

/**
 * Pure success-path builder for the agy tool result.
 * Extracted so tests can verify header/metadata/warning logic without
 * spawning real agy or leaking a global module mock.
 */
export function buildAgyToolResult(args: AgyToolArgs, result: AgyResult) {
  const header = [
    `## agy result`,
    `tier: ${args.tier ?? "flash"}`,
    `duration: ${result.durationMs}ms`,
    `exit: ${result.exitCode}`,
    args.sandbox ? `sandbox: true` : "",
    (args.continue || args.conversation) ? `resumed: true` : "",
    (args.yolo && args.sandbox)
      ? "WARNING: yolo (--dangerously-skip-permissions) + sandbox both enabled. agy will auto-approve every tool inside a restricted terminal."
      : "",
    ``,
  ].filter(Boolean).join("\n");

  return {
    title: `agy (${args.tier ?? "flash"})`,
    output: header + "\n" + result.stdout,
    metadata: {
      tier: args.tier ?? "flash",
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

/**
 * opencode-agy
 *
 * OpenCode plugin that exposes a single `agy` tool for delegating scoped work
 * to the Antigravity CLI in headless mode.
 *
 * Design goals:
 * - One tool (`agy`) plus one slash command (`/agy`).
 * - Small surface area and no hooks.
 * - Failures are returned as text instead of crashing the host process.
 * - The caller is still responsible for reviewing the result.
 * - Supports `--sandbox`, `--continue`, `--conversation`, and exact model override.
 * - Slash command is provided via commands/agy.md.
 */
export const AgyPlugin: Plugin = async (ctx) => {
  return {
    tool: {
      agy: tool({
        description:
          "Delegate a well-scoped task to Antigravity (agy / Gemini) in headless mode. " +
          "Best for bulk work, scaffolding, tests, research, or cross-model verification. " +
          "The main agent MUST verify the result. " +
          "Supports resume (`continue` / `conversation`) and `--sandbox` for safer tool use.",

        args: {
          prompt: tool.schema
            .string()
            .describe("The task to send to agy/Gemini. Be specific and scoped."),

          tier: tool.schema
            .enum(["flash", "flash-lo", "pro"])
            .optional()
            .describe("Model tier. flash (default) = fast/cheap Gemini 3.5 Flash High, flash-lo = cheapest, pro = stronger Gemini 3.1 Pro."),

          dir: tool.schema
            .string()
            .optional()
            .describe("Workspace directory to give agy (--add-dir)."),

          project: tool.schema
            .string()
            .optional()
            .describe("Project name to pass to agy (--project <value>)."),

          timeout: tool.schema
            .union([tool.schema
            .string(), tool.schema.number()])
            .optional()
            .describe(
              "Timeout for agy. Accepts duration strings like '5m', '10m', '300s', or raw milliseconds (e.g. 300000 or 600000). " +
              "Numbers/strings of digits are normalized to proper duration (300000 → '5m'). " +
              "Default depends on tier: 'pro' defaults to '15m' (heavier work); flash/flash-lo default to '10m'. " +
              "Hard upper bound: any value above 4h is silently clamped to '4h'. " +
              "For long tasks (big merges, heavy refactors) use '15m' or '30m' and/or tier=pro."
            ),

          yolo: tool.schema
            .boolean()
            .optional()
            .describe("Auto-approve every tool inside agy (--dangerously-skip-permissions). Use only with --sandbox or throwaway dirs."),

          sandbox: tool.schema
            .boolean()
            .optional()
            .describe("Run agy with terminal restrictions enabled (--sandbox). Recommended when giving broad permissions."),

          continue: tool.schema
            .boolean()
            .optional()
            .describe("Resume the most recent agy conversation (--continue). Useful for long-running or multi-turn work."),

          conversation: tool.schema
            .string()
            .optional()
            .describe("Resume a specific agy conversation by ID (--conversation <id>)."),

          model: tool.schema
            .string()
            .optional()
            .describe("Exact model name override (advanced / future-proof). Example: 'Gemini 3.1 Pro (High)'."),
        },

        async execute(args, context) {
          try {
            const result = await runAgy({
              prompt: args.prompt,
              tier: args.tier as Tier | undefined,
              dir: args.dir,
              project: args.project,
              timeout: args.timeout,
              yolo: args.yolo,
              sandbox: args.sandbox,
              continue: args.continue,
              conversation: args.conversation,
              model: args.model,
            });

            return buildAgyToolResult(args, result);
          } catch (err: any) {
            // Never let agy failures crash the main opencode process.
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
                title: `agy error (${err.code})`,
                output: body,
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
              String(err?.message ?? err),
              "",
              "Bug in opencode-agy plugin or environment. Please report.",
            ].join("\n");

            return {
              title: "agy unexpected error",
              output: body,
              metadata: {
                error: true,
                unexpected: true,
              },
            };
          }
        },
      }),
    },
  };
};

export default AgyPlugin;
