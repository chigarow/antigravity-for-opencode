import { $ } from "bun";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createOpencodeClient } from "@opencode-ai/sdk";
import type { PluginInput } from "@opencode-ai/plugin";
import { z } from "zod";
import { AgyError, buildAgyArgs, runAgy, type SpawnFn, type Tier } from "../src/agy-runner";
import { AGY_V2_TOOL_SCHEMA } from "../src/agy-v2";

// Label expectations follow the plan's RED contract; mappings finalized against agy 1.5.12 probes (Nov 19, 2026).
const NEW_TIERS = [
  ["neon-4-hi", "Gemini 4 Neon (High)"],
  ["neon-4-med", "Gemini 4 Neon (Medium)"],
  ["neon-4-lo", "Gemini 4 Neon (Low)"],
  ["neon-4-xhigh", "Gemini 4 Neon (XHigh)"],

  ["hydrogen-4-hi", "Gemini 4 Hydrogen (High)"],
  ["hydrogen-4-med", "Gemini 4 Hydrogen (Medium)"],
  ["hydrogen-4-lo", "Gemini 4 Hydrogen (Low)"],
  ["hydrogen-4-xhigh", "Gemini 4 Hydrogen (XHigh)"],
  ["gpt-oss-120b-med", "GPT-OSS 120B (Medium)"],
] as const;

const EXPECTED_TIERS = [
  "flash-3.8-hi", "flash-3.8-med", "flash-3.8-lo",
  "claude-sonnet-5-5-hi", "claude-sonnet-5-5-med", "claude-sonnet-5-5-lo",
  "claude-opus-5-5-hi", "claude-opus-5-5-med", "claude-opus-5-5-lo",
  "argon-4-hi", "argon-4-med", "argon-4-lo",
  ...NEW_TIERS.map(([tier]) => tier),
];

function fakeContext(): PluginInput {
  return {
    client: createOpencodeClient(),
    project: { id: "test-project", worktree: "/tmp", time: { created: 0 } },
    directory: "/tmp",
    worktree: "/tmp",
    experimental_workspace: { register: () => {} },
    serverUrl: new URL("http://localhost"),
    $,
  };
}

function rejectingSpawn(calls: string[][]): SpawnFn {
  return ((args) => {
    calls.push([...args]);
    const stream = (text: string) => new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    });
    return {
      stdin: { end: () => {} },
      stdout: stream(""),
      stderr: stream('model "requested" is not recognized as a known model'),
      exited: Promise.resolve(1),
      kill: () => {},
    } as any;
  }) as SpawnFn;
}

async function modelNotFound(options: Parameters<typeof runAgy>[0], calls: string[][]): Promise<AgyError> {
  try {
    await runAgy(options, rejectingSpawn(calls));
  } catch (error) {
    expect(error).toBeInstanceOf(AgyError);
    return error as AgyError;
  }
  throw new Error("expected MODEL_NOT_FOUND");
}

function expectNeutral(error: AgyError) {
  expect(error.code).toBe("MODEL_NOT_FOUND");
  expect(String(error.details?.hint)).toContain("agy models");
  expect(String(error.details?.hint)).not.toMatch(/trial|account|Pro|Ultra|higher account plan|plan lacks/i);
  expect(error.message).not.toContain("The plan lacks the model");
  expect(error.message).not.toMatch(/account|Pro\/Ultra|trial/i);
}

describe("Versioned tier contracts", () => {
  test.each(NEW_TIERS)("Tier union includes %s", (tier) => {
    const source = readFileSync(new URL("../src/agy-runner.ts", import.meta.url), "utf8");
    const union = source.match(/export type Tier\s*=([\s\S]*?);/)?.[1];
    expect(union).toBeDefined();
    expect(union).toContain(`"${tier}"`);
  });

  // TIER_MODEL is private: exercise its public argument-building consumer.
  test.each(NEW_TIERS)("TIER_MODEL maps %s to %s", (tier, model) => {
    const args = buildAgyArgs({ prompt: "x", tier: tier as Tier });
    expect(args[args.indexOf("--model") + 1]).toBe(model);
  });

  test("v1 schema accepts exactly the twenty-one versioned tiers", async () => {
    const { default: plugin } = await import("../src/index.ts");
    const hooks = await plugin(fakeContext());
    const schema = hooks.tool?.agy?.args.tier;
    expect(schema).toBeDefined();
    const unwrapped = schema instanceof z.ZodOptional ? schema.unwrap() : schema;
    expect(unwrapped).toBeInstanceOf(z.ZodEnum);
    expect(new Set((unwrapped as z.ZodEnum<any>).options)).toEqual(new Set(EXPECTED_TIERS));
  });

  test("v2 schema accepts exactly the twenty-one versioned tiers", () => {
    expect(new Set(AGY_V2_TOOL_SCHEMA.properties.tier.enum)).toEqual(new Set(EXPECTED_TIERS));
  });

  test("MODEL_NOT_FOUND hint is neutral and directs callers to agy models", async () => {
    const error = await modelNotFound({ prompt: "x", model: "missing-model" }, []);
    expect(error.code).toBe("MODEL_NOT_FOUND");
    expect(String(error.details?.hint)).toContain("agy models");
    expect(String(error.details?.hint)).not.toMatch(/trial|account|Pro|Ultra|higher account plan|plan lacks/i);
  });

  test("MODEL_NOT_FOUND message does not attribute failure to a plan or account", async () => {
    const error = await modelNotFound({ prompt: "x", model: "missing-model" }, []);
    expect(error.code).toBe("MODEL_NOT_FOUND");
    expect(error.message).not.toContain("The plan lacks the model");
    expect(error.message).not.toMatch(/account|Pro\/Ultra|trial/i);
  });

  test("unavailable Hydrogen spawns exactly once with its exact model and no fallback", async () => {
    const calls: string[][] = [];
    const error = await modelNotFound({ prompt: "x", tier: "hydrogen-4-hi" as Tier }, calls);
    expect(calls).toHaveLength(1);
    const argv = calls[0]!;
    expect(argv[0]).toBe("agy");
    expect(argv.filter((arg) => arg === "--model")).toHaveLength(1);
    expect(argv[argv.indexOf("--model") + 1]).toBe("Gemini 4 Hydrogen (High)");
    expectNeutral(error);
  });
});
