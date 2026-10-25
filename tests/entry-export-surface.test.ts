/**
 * Entry-module export-surface regression (TDD).
 *
 * opencode 1.19.4's legacy plugin loader walks EVERY runtime export of the
 * entry module and INVOKES each distinct function export as a plugin server,
 * pushing every return value into its hooks array. Any named function export
 * whose return value is not a hooks object (setupV2Plugin -> undefined,
 * buildAgyToolResult -> a tool result, ...) becomes a bogus hook and crashes
 * the host: "plugin config hook failed: undefined is not an object
 * (evaluating 'R.config')", "Event listener failed: ... (evaluating
 * 'E.event')". A live end-to-end run confirmed: entry exports ONLY default ->
 * exactly one provider request and no host errors.
 *
 * Therefore the entry module must expose EXACTLY one runtime export: default.
 * Type-only exports (`export type ...`) are erased by the bundler and are
 * allowed. Programmatic consumers reach server/setup through the attached
 * properties on the default export.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import * as entry from "../src/index";

const bundlePath = new URL("../dist/index.js", import.meta.url);

describe("entry module export surface", () => {
  test('runtime export surface is exactly ["default"] (opencode 1.19.4 plugin-loader regression)', () => {
    expect(Object.keys(entry).sort()).toEqual(["default"]);
  });

  test("default export keeps attached id/server/setup for programmatic consumers", () => {
    const plugin = entry.default;
    expect(plugin.id).toBe("opencode-agy");
    expect(typeof plugin.server).toBe("function");
    expect(typeof plugin.setup).toBe("function");
  });

  const mayTestBundle = test.skipIf(!existsSync(bundlePath));
  mayTestBundle("built bundle dist/index.js exports only default", () => {
    const bundle = readFileSync(bundlePath, "utf8");
    const names = new Set<string>();
    for (const m of bundle.matchAll(/export\s*\{([^}]*)\}/g)) {
      for (const raw of m[1].split(",")) {
        const name = raw.split(" as ").pop()!.trim();
        if (name) names.add(name);
      }
    }
    if (/export\s+default/.test(bundle)) names.add("default");
    expect([...names].sort()).toEqual(["default"]);
  });
});
