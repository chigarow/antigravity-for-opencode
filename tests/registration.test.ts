/**
 * Registration-surface defect tests (TDD).
 *
 * Covers three defects:
 * 1. AGY_V2_TOOL_SCHEMA descriptions must mirror the updated v1 policy
 *    (workspace-root containment, yolo consent, INVALID_TIMEOUT rejection).
 * 2. The v1 config hook must be Map/Array-safe via the shared shape-aware
 *    registry helper (preserve valid entries by identity, replace invalid).
 * 3. setupV2Plugin must be idempotent per context/editor: repeated setup
 *    registers exactly one `agy` entry per name for every editor shape.
 */
import { describe, expect, test } from "bun:test";
import AgyPlugin from "../src/index";
import { AGY_V2_TOOL_SCHEMA, setupV2Plugin } from "../src/agy-v2";
import { isCommandDef } from "../src/agy-command";

async function v1ConfigHook(): Promise<(cfg: any) => Promise<void>> {
  const hooks: any = await (AgyPlugin as any)({});
  const hook = hooks.config;
  if (typeof hook !== "function") throw new Error("AgyPlugin must expose a config hook");
  return hook;
}

// ---------------------------------------------------------------------------
// Defect 1: v2 schema descriptions mirror the v1 policy
// ---------------------------------------------------------------------------

describe("AGY_V2_TOOL_SCHEMA descriptions mirror the v1 policy", () => {
  const schemaText = JSON.stringify(AGY_V2_TOOL_SCHEMA);

  test("yolo requires sandbox: true AND host consent (AGY_ALLOW_YOLO=1)", () => {
    expect(schemaText).toContain("AGY_ALLOW_YOLO=1");
    expect(schemaText).toContain("Requires sandbox: true and host consent");
    expect(schemaText).toContain("YOLO_NOT_APPROVED");
  });

  test("no v2 description still implies yolo only needs sandbox for file analysis", () => {
    expect(schemaText).not.toContain("Required for local file analysis");
  });

  test("dir must resolve inside the workspace root (AGY_WORKSPACE_ROOT)", () => {
    expect(schemaText).toContain("Must resolve inside the workspace root (AGY_WORKSPACE_ROOT");
  });

  test("timeout rejects invalid values with INVALID_TIMEOUT instead of silently clamping", () => {
    expect(schemaText).toContain("rejected with INVALID_TIMEOUT");
    expect(schemaText).not.toContain("silently clamped");
    expect(schemaText).toContain("clamped to '4h'");
  });

  test("schema shape is mechanically unchanged", () => {
    expect(AGY_V2_TOOL_SCHEMA.type).toBe("object");
    expect(AGY_V2_TOOL_SCHEMA.required).toEqual(["prompt"]);
    expect((AGY_V2_TOOL_SCHEMA as any).additionalProperties).toBe(false);
    expect(Object.keys(AGY_V2_TOOL_SCHEMA.properties).sort()).toEqual([
      "continue",
      "conversation",
      "dir",
      "model",
      "project",
      "prompt",
      "sandbox",
      "tier",
      "timeout",
      "yolo",
    ]);
    expect((AGY_V2_TOOL_SCHEMA.properties as any).yolo.type).toBe("boolean");
    expect((AGY_V2_TOOL_SCHEMA.properties as any).timeout.oneOf).toEqual([
      { type: "string" },
      { type: "number" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Defect 2: v1 config hook is registry-shape safe
// ---------------------------------------------------------------------------

describe("v1 config hook is registry-shape safe", () => {
  test("object registry: schema-valid agy preserved by identity, siblings untouched", async () => {
    const config = await v1ConfigHook();
    const sentinel = { template: "USER_SENTINEL $ARGUMENTS" };
    const cfg: any = { command: { agy: sentinel, other: { template: "other $ARGUMENTS" } } };
    await config(cfg);
    expect(cfg.command.agy).toBe(sentinel);
    expect(cfg.command.other).toEqual({ template: "other $ARGUMENTS" });
  });

  test("object registry: invalid agy replaced, siblings untouched", async () => {
    const config = await v1ConfigHook();
    const cfg: any = { command: { agy: null, other: { template: "other $ARGUMENTS" } } };
    await config(cfg);
    expect(isCommandDef(cfg.command.agy)).toBe(true);
    expect(cfg.command.agy.template).toContain("$ARGUMENTS");
    expect(cfg.command.other).toEqual({ template: "other $ARGUMENTS" });
  });

  test("Map registry: unrelated entries kept, exactly one agy gained, no stray properties", async () => {
    const config = await v1ConfigHook();
    const command = new Map<string, unknown>([["other", { template: "other $ARGUMENTS" }]]);
    const cfg: any = { command };
    await config(cfg);
    expect(cfg.command).toBe(command); // registry identity kept, never spread into a plain object
    expect(command.size).toBe(2);
    expect(isCommandDef(command.get("agy"))).toBe(true);
    expect(command.get("other")).toEqual({ template: "other $ARGUMENTS" });
    expect(Object.keys(command)).toHaveLength(0); // no own property leaked onto the Map instance
  });

  test("Map registry: schema-valid agy preserved by identity", async () => {
    const config = await v1ConfigHook();
    const sentinel = { template: "USER_SENTINEL $ARGUMENTS" };
    const command = new Map([["agy", sentinel as unknown]]);
    await config({ command } as any);
    expect(command.get("agy")).toBe(sentinel);
    expect(command.size).toBe(1);
  });

  test("Array registry: unrelated entries kept, exactly one agy gained", async () => {
    const config = await v1ConfigHook();
    const command: any[] = [{ name: "other", template: "other $ARGUMENTS" }];
    const cfg: any = { command };
    await config(cfg);
    expect(cfg.command).toBe(command);
    const agy = command.filter((entry) => entry?.name === "agy");
    expect(agy).toHaveLength(1);
    expect(isCommandDef(agy[0])).toBe(true);
    expect(command).toHaveLength(2);
    expect(command[0]).toEqual({ name: "other", template: "other $ARGUMENTS" });
  });

  test("Array registry: invalid agy replaced in place, exactly one agy remains", async () => {
    const config = await v1ConfigHook();
    const command: any[] = [
      { name: "agy", template: "" },
      { name: "other", template: "other $ARGUMENTS" },
    ];
    await config({ command } as any);
    expect(command).toHaveLength(2);
    expect(isCommandDef(command[0])).toBe(true);
    expect(command[1]).toEqual({ name: "other", template: "other $ARGUMENTS" });
  });

  test("Map and Array registries are idempotent under repeated hook runs", async () => {
    const config = await v1ConfigHook();
    const map = new Map<string, unknown>();
    await config({ command: map } as any);
    const agy = map.get("agy");
    await config({ command: map } as any);
    expect(map.size).toBe(1);
    expect(map.get("agy")).toBe(agy);

    const arr: any[] = [];
    await config({ command: arr } as any);
    const first = arr[0];
    await config({ command: arr } as any);
    expect(arr).toHaveLength(1);
    expect(arr[0]).toBe(first);
  });
});

// ---------------------------------------------------------------------------
// Defect 3: setupV2Plugin registers exactly once per context/editor shape
// ---------------------------------------------------------------------------

type EditorShape = "object" | "map" | "addon" | "array";

function fakeCtx(shape: EditorShape) {
  const state: { tool?: any; command?: any } = {};
  const newEditor = (): any => {
    if (shape === "map") return new Map<string, any>([["sibling", { name: "sibling" }]]);
    if (shape === "array") return [{ name: "sibling" }];
    if (shape === "addon") {
      const entries: any[] = [{ name: "sibling" }];
      return { add: (def: any) => entries.push(def), entries };
    }
    return { sibling: { template: "keep $ARGUMENTS" } };
  };
  return {
    state,
    ctx: {
      tool: {
        transform: async (fn: (editor: any) => void) => {
          state.tool ??= newEditor();
          await fn(state.tool);
        },
      },
      command: {
        transform: async (fn: (editor: any) => void) => {
          state.command ??= newEditor();
          await fn(state.command);
        },
      },
    },
  };
}

function agyEntries(shape: EditorShape, editor: any): any[] {
  if (shape === "map") return [editor.get("agy")];
  if (shape === "array") return editor.filter((entry: any) => entry?.name === "agy");
  if (shape === "addon") return editor.entries.filter((entry: any) => entry?.name === "agy");
  return [editor.agy];
}

describe("setupV2Plugin registers exactly one agy entry per name", () => {
  const shapes: EditorShape[] = ["object", "map", "addon", "array"];

  for (const shape of shapes) {
    test(`tool editor (${shape}): two setups yield exactly one agy entry, sibling untouched`, async () => {
      const { ctx, state } = fakeCtx(shape);
      await setupV2Plugin(ctx as any);
      await setupV2Plugin(ctx as any);

      const editor = state.tool;
      const agy = agyEntries(shape, editor);
      expect(agy).toHaveLength(1);
      expect(agy[0]?.name).toBe("agy");
      expect(typeof agy[0]?.execute).toBe("function");

      if (shape === "map") {
        expect(editor.size).toBe(2);
        expect(Object.keys(editor)).toHaveLength(0); // no stray own properties on the Map
        expect(editor.get("sibling")).toEqual({ name: "sibling" });
      } else if (shape === "array") {
        expect(editor).toHaveLength(2);
        expect(editor[0]).toEqual({ name: "sibling" });
      } else if (shape === "addon") {
        expect(editor.entries).toHaveLength(2);
        expect(editor.entries[0]).toEqual({ name: "sibling" });
      } else {
        expect(Object.keys(editor).filter((key) => key === "agy")).toHaveLength(1);
        expect(editor.sibling).toEqual({ template: "keep $ARGUMENTS" });
      }
    });

    test(`command editor (${shape}): two setups yield exactly one agy entry, sibling untouched`, async () => {
      const { ctx, state } = fakeCtx(shape);
      await setupV2Plugin(ctx as any);
      await setupV2Plugin(ctx as any);

      const editor = state.command;
      const agy = agyEntries(shape, editor);
      expect(agy).toHaveLength(1);
      expect(agy[0]?.name).toBe("agy");
      expect(isCommandDef(agy[0])).toBe(true);

      if (shape === "map") {
        expect(editor.size).toBe(2);
        expect(Object.keys(editor)).toHaveLength(0);
        expect(editor.get("sibling")).toEqual({ name: "sibling" });
      } else if (shape === "array") {
        expect(editor).toHaveLength(2);
        expect(editor[0]).toEqual({ name: "sibling" });
      } else if (shape === "addon") {
        expect(editor.entries).toHaveLength(2);
        expect(editor.entries[0]).toEqual({ name: "sibling" });
      } else {
        expect(Object.keys(editor).filter((key) => key === "agy")).toHaveLength(1);
        expect(editor.sibling).toEqual({ template: "keep $ARGUMENTS" });
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Entry-module loader safety: opencode 1.19.4's legacy plugin loader walks
// every runtime export of the entry module AND INVOKES each distinct function
// export as a plugin server, pushing each return value into its hooks array.
// setupV2Plugin returns undefined, so a named `setupV2Plugin`/`setup` export
// put `undefined` into the hooks array and crashed the host ("plugin config
// hook failed: undefined is not an object (evaluating 'R.config')"). The
// entry module must therefore expose EXACTLY one runtime export: default.
// ---------------------------------------------------------------------------

describe("entry module is plugin-loader safe", () => {
  test("runtime export surface is exactly [\"default\"] (opencode 1.19.4 loader invokes every function export)", async () => {
    const mod: Record<string, unknown> = await import("../src/index");

    expect(Object.keys(mod).sort()).toEqual(["default"]);

    // The plain-object schema that broke 1.19.4 must not come back on the entry.
    expect("AGY_V2_TOOL_SCHEMA" in mod).toBe(false);
  });

  test("default export keeps attached id/server/setup for programmatic consumers", async () => {
    const plugin = (await import("../src/index")).default;
    expect(plugin.id).toBe("opencode-agy");
    expect(typeof plugin.server).toBe("function");
    expect(typeof plugin.setup).toBe("function");
  });
});
