import { $ } from "bun";
import { describe, expect, test } from "bun:test";
import { createOpencodeClient } from "@opencode-ai/sdk";
import type { Config, Hooks, PluginInput } from "@opencode-ai/plugin";
import { z } from "zod";

const LOCKED_TIERS = [
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
] as const;

const REMOVED_HIGH = ["flash-3.5", "pro-3.1", "flash-3.6"] as const;

/** Minimal PluginInput stub that satisfies the plugin entry without external deps. */
function fakeCtx(): PluginInput {
  const project = {
    id: "test-project",
    worktree: "/tmp",
    time: { created: 0 },
  } satisfies PluginInput["project"];

  return {
    client: createOpencodeClient(),
    project,
    directory: "/tmp",
    worktree: "/tmp",
    experimental_workspace: { register: () => {} },
    serverUrl: new URL("http://localhost"),
    $,
  };
}

describe("plugin module shape", () => {
  test("exports AgyPlugin as default and named", async () => {
    const mod = await import("../src/index.ts");
    expect(typeof mod.AgyPlugin).toBe("function");
    expect(typeof mod.default).toBe("function");
  });

  test("plugin function returns hooks with exactly tool + config", async () => {
    const { AgyPlugin } = await import("../src/index.ts");
    const hooks = await AgyPlugin(fakeCtx());
    expect(hooks).toBeDefined();
    expect(hooks.tool).toBeDefined();
    expect(hooks.tool?.agy).toBeDefined();
    expect(hooks.config).toBeDefined();
    // Exact hook surface: only config and tool, nothing else
    expect(Object.keys(hooks).sort()).toEqual(["config", "tool"]);
  });
});

describe("plugin config hook behavior", () => {
  async function getConfigHook(): Promise<NonNullable<Hooks["config"]>> {
    const { AgyPlugin } = await import("../src/index.ts");
    const hooks = await AgyPlugin(fakeCtx());
    const hook = hooks.config;
    if (hook === undefined) throw new Error("AgyPlugin must expose a config hook");
    return hook;
  }

  test("config hook on empty config injects command.agy with parsed description", async () => {
    // Given: an empty config object
    const configHook = await getConfigHook();
    const cfg: Config = {};
    // When: the config hook runs
    await configHook(cfg);
    // Then: command.agy exists with the exact embedded description
    expect(cfg.command?.agy).toBeDefined();
    expect(cfg.command?.agy?.description).toBe(
      "Delegate a task to agy (Antigravity / Gemini sub-agent)",
    );
  });

  test("config hook preserves $ARGUMENTS in injected template", async () => {
    const configHook = await getConfigHook();
    const cfg: Config = {};
    await configHook(cfg);
    expect(cfg.command?.agy?.template.includes("$ARGUMENTS")).toBe(true);
  });

  test("config hook preserves a valid existing command by identity", async () => {
    // Given: a config with a schema-valid sentinel command already present
    const configHook = await getConfigHook();
    const sentinel = { template: "OVERRIDE_SENTINEL $ARGUMENTS" } satisfies { template: string };
    const cfg: Config = { command: { agy: sentinel } };
    // When: the config hook runs
    await configHook(cfg);
    // Then: the sentinel object is preserved by reference (not overwritten)
    expect(cfg.command?.agy).toBe(sentinel);
  });

  test("config hook replaces null existing command with default", async () => {
    const configHook = await getConfigHook();
    const cfg: Config = {};
    Object.assign(cfg, { command: { agy: null } });
    await configHook(cfg);
    expect(cfg.command?.agy).toBeDefined();
    expect(cfg.command?.agy?.template.includes("$ARGUMENTS")).toBe(true);
  });

  test("config hook replaces empty-template command with default", async () => {
    const configHook = await getConfigHook();
    const cfg: Config = { command: { agy: { template: "" } } };
    await configHook(cfg);
    expect(cfg.command?.agy?.template).not.toBe("");
    expect(cfg.command?.agy?.template.includes("$ARGUMENTS")).toBe(true);
  });

  test("config hook replaces schema-invalid optional field with default", async () => {
    const configHook = await getConfigHook();
    const cfg: Config = {};
    Object.assign(cfg, { command: { agy: { template: "valid", agent: 123 } } });
    await configHook(cfg);
    expect(cfg.command?.agy?.template.includes("$ARGUMENTS")).toBe(true);
  });

  test("two independent empty configs receive non-shared definitions", async () => {
    const configHook = await getConfigHook();
    const cfgA: Config = {};
    const cfgB: Config = {};
    await configHook(cfgA);
    await configHook(cfgB);
    expect(cfgA.command?.agy).not.toBe(cfgB.command?.agy);
  });

  test("repeated hook invocation on same empty config is stable", async () => {
    const configHook = await getConfigHook();
    const cfg: Config = {};
    await configHook(cfg);
    const first = cfg.command?.agy;
    await configHook(cfg);
    // Idempotent: re-running on the now-populated config preserves the valid definition
    expect(cfg.command?.agy).toBe(first);
  });
});

describe("agy tool tier schema contracts (v0.8.0)", () => {
  async function tierSchema(): Promise<z.ZodTypeAny> {
    const { AgyPlugin } = await import("../src/index.ts");
    const hooks = await AgyPlugin(fakeCtx());
    const toolDefinition = hooks.tool?.agy;
    if (toolDefinition === undefined) throw new Error("AgyPlugin must expose the agy tool");
    return toolDefinition.args.tier;
  }

  function enumValues(schema: z.ZodTypeAny): readonly string[] {
    const unwrapped = schema instanceof z.ZodOptional ? schema.unwrap() : schema;
    if (!(unwrapped instanceof z.ZodEnum)) {
      throw new Error("could not extract enum values from tier schema");
    }
    return unwrapped.options;
  }

  test("schema accepts exactly the eleven v0.10.0 tiers", async () => {
    // Given: real tool schema from plugin registration
    const schema = await tierSchema();
    const values = new Set(enumValues(schema));
    // When / Then: exact set equality with locked public contract
    expect(values).toEqual(new Set(LOCKED_TIERS));
    for (const t of LOCKED_TIERS) {
      expect(schema.safeParse(t).success).toBe(true);
    }
  });

  test("schema rejects removed unsuffixed High names before execution", async () => {
    const schema = await tierSchema();
    for (const t of REMOVED_HIGH) {
      expect(schema.safeParse(t).success).toBe(false);
    }
  });

  test("flash-3.6-med remains valid and undefined (no tier) remains valid", async () => {
    const schema = await tierSchema();
    expect(schema.safeParse("flash-3.6-med").success).toBe(true);
    expect(schema.safeParse(undefined).success).toBe(true);
  });
});
