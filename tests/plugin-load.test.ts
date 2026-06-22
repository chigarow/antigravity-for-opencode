import { describe, test, expect } from "bun:test";

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
