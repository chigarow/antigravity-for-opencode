import { describe, test, expect } from "bun:test";
import { z } from "zod";

const LOCKED_TIERS = [
  "flash-3.5-lo",
  "flash-3.5-med",
  "flash-3.5-hi",
  "pro-3.1-lo",
  "pro-3.1-hi",
  "flash-3.6-lo",
  "flash-3.6-med",
  "flash-3.6-hi",
] as const;

const REMOVED_HIGH = ["flash-3.5", "pro-3.1", "flash-3.6"] as const;

describe("plugin module shape", () => {
  test("exports AgyPlugin as default and named", async () => {
    const mod = await import("../src/index.ts");
    expect(typeof mod.AgyPlugin).toBe("function");
    expect(typeof mod.default).toBe("function");
  });

  test("plugin function returns hooks with ONLY the agy tool and no other hooks", async () => {
    const { AgyPlugin } = await import("../src/index.ts");
    const fakeCtx = {
      client: {} as any,
      project: {} as any,
      directory: "/tmp",
      worktree: "/tmp",
      experimental_workspace: { register: () => {} } as any,
      serverUrl: new URL("http://localhost"),
      $: {} as any,
    };
    const hooks = await AgyPlugin(fakeCtx);
    expect(hooks).toBeDefined();
    expect(hooks.tool).toBeDefined();
    expect(hooks.tool!.agy).toBeDefined();
    // Must be strictly non-intrusive: only the "agy" tool, nothing else
    expect(Object.keys(hooks).filter(k => k !== "tool").length).toBe(0);
  });
});

describe("agy tool tier schema contracts (v0.8.0)", () => {
  async function tierSchema(): Promise<z.ZodTypeAny> {
    const { AgyPlugin } = await import("../src/index.ts");
    const fakeCtx = {
      client: {} as any,
      project: {} as any,
      directory: "/tmp",
      worktree: "/tmp",
      experimental_workspace: { register: () => {} } as any,
      serverUrl: new URL("http://localhost"),
      $: {} as any,
    };
    const hooks = await AgyPlugin(fakeCtx);
    const def = hooks.tool!.agy as {
      args: { tier: z.ZodTypeAny };
    };
    return def.args.tier;
  }

  function enumValues(schema: z.ZodTypeAny): string[] {
    // unwrap optional (Zod 4: optional → _def.innerType)
    let s: z.ZodTypeAny = schema;
    const outer = s as { _def?: { type?: string; innerType?: z.ZodTypeAny; entries?: Record<string, string>; values?: string[] } };
    if (outer._def?.type === "optional" && outer._def.innerType) {
      s = outer._def.innerType;
    }
    // Zod 4 enum stores accepted values in _def.entries (map value→value)
    const def = (s as { _def?: { entries?: Record<string, string>; values?: string[] } })._def;
    if (def?.entries) return Object.values(def.entries);
    if (def?.values) return [...def.values];
    throw new Error("could not extract enum values from tier schema");
  }

  test("schema accepts exactly the eight v0.8.0 tiers", async () => {
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
