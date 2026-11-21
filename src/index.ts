import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { runAgy, AgyError, isValidConversationId, redactError, scrubSecrets } from "./agy-runner";
import { buildAgyToolResult, createAgyCommand, isCommandDef, upsertRegistryEntry } from "./agy-command";
import { setupV2Plugin } from "./agy-v2";
import { disposeAgyAcp, prewarmAgyAcp } from "./agy-acp";

export interface UniversalAgyPlugin {
  id: string;
  server: Plugin;
  setup: (ctx: any) => Promise<void> | void;
}

/**
 * opencode-agy
 *
 * OpenCode plugin that exposes a single `agy` tool for delegating scoped work
 * to the Antigravity CLI in headless mode.
 *
 * Design goals:
 * - One tool (`agy`) plus one slash command (`/agy`).
 * - Small surface area: one config hook, no event or execution hooks.
 * - Failures are returned as text instead of crashing the host process.
 * - The caller is still responsible for reviewing the result.
 * - Supports `--sandbox`, `--continue`, `--conversation`, and exact model override.
 * - Slash command is provided via commands/agy.md.
 */
const v1Server: Plugin = async (ctx) => {
  const workspaceRoot =
    typeof (ctx as any)?.directory === "string" && (ctx as any).directory
      ? (ctx as any).directory
      : undefined;
  prewarmAgyAcp({ cwd: workspaceRoot });
  return {
    tool: {
      agy: tool({
        description:
          "Delegate a well-scoped task to Antigravity (agy / Gemini) in headless mode. " +
          "Best for bulk work, scaffolding, tests, research, or cross-model verification. " +
          "The main agent MUST verify the result. " +
          "Supports resume (`continue` / `conversation`) and `--sandbox` for safer tool use. " +
          "`dir` must be the workspace root or a directory inside it (AGY_WORKSPACE_ROOT, default: the current project). " +
          "For local file analysis (PDF, PNG, images), set `dir` to the file's directory inside that root; " +
          "`yolo: true` additionally requires `sandbox: true` and host consent (AGY_ALLOW_YOLO=1), because it auto-approves every tool. " +
          "`sandbox: true` is compatible with file reads (restricts only terminal commands).",

        args: {
          prompt: tool.schema
            .string()
            .describe("The task to send to agy/Gemini. Be specific and scoped."),

          tier: tool.schema
            .enum(["flash-3.8-hi", "flash-3.8-med", "flash-3.8-lo", "claude-sonnet-5-5-hi", "claude-sonnet-5-5-med", "claude-sonnet-5-5-lo", "claude-opus-5-5-hi", "claude-opus-5-5-med", "claude-opus-5-5-lo", "argon-4-hi", "argon-4-med", "argon-4-lo", "neon-4-hi", "neon-4-med", "neon-4-lo", "neon-4-xhigh", "hydrogen-4-hi", "hydrogen-4-med", "hydrogen-4-lo", "hydrogen-4-xhigh", "gpt-oss-120b-med", "orchestrator-argon", "orchestrator-neon"])
            .optional()
            .describe("Model tier. When omitted, the plugin auto-routes: simple tasks use flash-3.8-med, normal coding uses hydrogen-4-med, hard tasks use hydrogen-4-hi (pass claude-opus-5-5-hi to use Opus 5.5). An explicit tier or model always wins. flash-3.8-med = Gemini 3.8 Flash Medium (works on every account). flash-3.8-hi = Gemini 3.8 Flash High, flash-3.8-lo = cheapest Flash. claude-sonnet-5-5-hi/med/lo = Claude Sonnet 5.5 (requires a Pro or Ultra plan). claude-opus-5-5-hi/med/lo = Claude Opus 5.5 (requires a Pro or Ultra plan). argon-4-hi/med/lo = Gemini 4 Argon (requires a paid Pro or Ultra plan; trial plans excluded). neon-4-hi/med/lo/xhigh = Gemini 4 Neon (paid Pro/Ultra plans, Pro trials with eligible premium devices, or Gemini Enterprise; four effort levels including XHigh; launched Nov 18, 2026). hydrogen-4-hi/med/lo/xhigh = Gemini 4 Hydrogen (four effort levels including XHigh; run `agy models` to check availability). gpt-oss-120b-med = GPT-OSS 120B (runs on Free/Plus/Pro/Ultra plans; upstream lists a Nov 18, 2026 removal date, availability may end without notice). orchestrator-argon / orchestrator-neon = Orchestrator (Argon/Neon). Gemini 3.6/3.7 Flash and 3.1 Pro tiers were removed upstream (Enterprise-only) and now return INVALID_TIER."),

          dir: tool.schema
            .string()
            .optional()
            .describe("Workspace directory to give agy (--add-dir). Must resolve inside the workspace root (AGY_WORKSPACE_ROOT, default: the current project)."),

          project: tool.schema
            .string()
            .optional()
            .describe("Project name to pass to agy (--project <value>)."),

          timeout: tool.schema
            .union([tool.schema
            .string(), tool.schema.number()])
            .optional()
            .describe(
              "Timeout for agy. Accepts duration strings like '5m', '10m', '300s', or a positive integer of milliseconds (e.g. 300000). " +
              "Numbers are normalized to a proper duration (300000 → '5m'). " +
              "Default: '15m' for every tier. " +
              "Values that are not a positive duration are rejected with INVALID_TIMEOUT. " +
              "Hard upper bound: any value above 4h is clamped to '4h'. " +
              "For long tasks (big merges, heavy refactors) use '15m' or '30m'."
            ),

          yolo: tool.schema
            .boolean()
            .optional()
            .describe("Auto-approve every tool inside agy (--dangerously-skip-permissions). Requires sandbox: true and host consent (AGY_ALLOW_YOLO=1); otherwise the call is rejected with YOLO_NOT_APPROVED."),

          sandbox: tool.schema
            .boolean()
            .optional()
            .describe("Run agy with terminal restrictions enabled (--sandbox). Recommended when giving broad permissions. " + "Does not restrict file reads — only restricts terminal commands."),

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

          files: tool.schema
            .array(tool.schema.string())
            .optional()
            .describe("Optional paths inside the workspace to attach. Only these files (plus paths mentioned in the prompt that exist in the workspace) are sent to agy."),
        },

        async execute(args, context) {
          try {
            const workspaceRoot =
              typeof (ctx as any)?.directory === "string" && (ctx as any).directory
                ? (ctx as any).directory
                : undefined;
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
              files: args.files,
              signal: (context as any)?.signal,
              ...(workspaceRoot ? { policy: { workspaceRoot } } : {}),
            });

            return buildAgyToolResult(args, result);
          } catch (err: unknown) {
            // Never let agy failures crash the main opencode process.
            if (err instanceof AgyError) {
              // Only echo a conversation id we would accept back as a selector.
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
              redactError(err),
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
    config: async (cfg) => {
      // Shape-aware registry write (same helper as v2): object, Map and Array
      // registries keep their sibling entries; a schema-valid `agy` command is
      // preserved by identity, anything else is replaced in place.
      if (cfg.command == null || typeof cfg.command !== "object") {
        (cfg as any).command = {};
      }
      upsertRegistryEntry(cfg.command as any, "agy", createAgyCommand(), isCommandDef);
    },
    dispose: async () => {
      await disposeAgyAcp();
    },
  };
};

// OpenCode 2.x Schema.Struct requires the default export to be a plain
// object with `id` and `setup` (or `effect`). A function with those
// properties attached fails to load: "Expected object at [\"default\"]".
// Official dual-export shape (docs: migrate-v1): V2 calls setup();
// OpenCode 1.18.29+ calls server(). Named function exports stay forbidden
// because OpenCode 1.19.4's legacy loader invokes every function export.
// Guarded by tests/entry-export-surface.test.ts.
const AgyPlugin: UniversalAgyPlugin = {
  id: "opencode-agy",
  server: v1Server,
  setup: setupV2Plugin,
};

export default AgyPlugin;
