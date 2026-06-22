import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { runAgy, AgyError, type Tier } from "./agy-runner";

/**
 * opencode-agy
 *
 * Minimal, production-ready, future-proof OpenCode plugin.
 * Exposes a single tool `agy` that delegates work to the Antigravity CLI
 * (Gemini) in true headless `--print` mode.
 *
 * Design goals (matching antigravity-for-claude-code reference):
 * - One tool (`agy`) + one slash command (`/agy`).
 * - Extremely non-intrusive (safe with oh-my-openagent and future plugins).
 * - All failures are caught and returned as text — host process is never crashed.
 * - Caller is always responsible for verification.
 * - Future-proof: supports --sandbox, --continue, --conversation, and exact model override.
 * - Slash command is provided via commands/agy.md (OpenCode custom command mechanism).
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

          timeout: tool.schema
            .string()
            .optional()
            .describe("Timeout string (e.g. '5m', '10m', '300s'). Passed to agy --print-timeout. Default: 5m."),

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
              timeout: args.timeout,
              yolo: args.yolo,
              sandbox: args.sandbox,
              continue: args.continue,
              conversation: args.conversation,
              model: args.model,
            });

            const header = [
              `## agy result`,
              `tier: ${args.tier ?? "flash"}`,
              `duration: ${result.durationMs}ms`,
              `exit: ${result.exitCode}`,
              args.sandbox ? `sandbox: true` : "",
              (args.continue || args.conversation) ? `resumed: true` : "",
              ``,
            ].filter(Boolean).join("\n");

            return {
              title: `agy (${args.tier ?? "flash"})`,
              output: header + result.stdout,
              metadata: {
                tier: args.tier ?? "flash",
                durationMs: result.durationMs,
                exitCode: result.exitCode,
                tool: "agy",
                sandbox: !!args.sandbox,
                resumed: !!(args.continue || args.conversation),
              },
            };
          } catch (err: any) {
            // Never let agy failures crash the main opencode process.
            if (err instanceof AgyError) {
              const body = [
                `AGY_ERROR [${err.code}]`,
                err.message,
                err.details ? JSON.stringify(err.details, null, 2) : "",
                "",
                "agy sub-agent failed. Decide whether to retry, change tier, use --continue/--conversation, enable --sandbox, or handle manually.",
              ].join("\n");

              return {
                title: `agy error (${err.code})`,
                output: body,
                metadata: {
                  error: true,
                  code: err.code,
                  details: err.details,
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
