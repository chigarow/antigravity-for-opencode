import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { setupV2Plugin } from "../src/agy-v2";

const SKILL_ID = "opencode-agy";
const SKILL_PATH = "/builtin/opencode-agy/SKILL.md";
const skillFile = readFileSync(path.join(__dirname, "../skills/opencode-agy/SKILL.md"), "utf-8");
const frontmatterDescription = skillFile.match(/^description: (.+)$/m)?.[1];
// Body is everything after the closing frontmatter delimiter, trimmed.
const expectedBody = skillFile.slice(skillFile.indexOf("\n---\n") + "\n---\n".length).trim();

interface SkillCalls {
  add: number;
  update: number;
}

/** Map-backed skill editor with the 2.x semantics: add is Map.set, update is in-place. */
function skillRegistry(entries: Map<string, any> = new Map()) {
  const calls: SkillCalls = { add: 0, update: 0 };
  const makeEditor = () => ({
    add(info: any) {
      calls.add++;
      entries.set(info.id, info);
    },
    get(id: string) {
      return entries.get(id);
    },
    update(id: string, mutate: (current: any) => void) {
      calls.update++;
      const current = entries.get(id);
      if (current) mutate(current);
    },
    list() {
      return [...entries.values()];
    },
    remove(id: string) {
      entries.delete(id);
    },
  });
  return { entries, calls, editor: makeEditor(), makeEditor };
}

function makeCtx(skillEditor?: any) {
  const tools: any[] = [];
  const commands: any[] = [];
  const ctx: any = {
    tool: {
      transform: async (fn: any) => {
        await fn({ add: (t: any) => tools.push(t) });
      },
    },
    command: {
      transform: async (fn: any) => {
        await fn({ add: (c: any) => commands.push(c) });
      },
    },
  };
  if (skillEditor) {
    ctx.skill = {
      transform: async (fn: any) => {
        await fn(skillEditor);
      },
    };
  }
  return { ctx, tools, commands };
}

describe("opencode-agy skill registration (OpenCode 2.x)", () => {
  test("registers once with id, name, path, and the frontmatter description", async () => {
    const reg = skillRegistry();
    await setupV2Plugin(makeCtx(reg.editor).ctx);

    expect(reg.calls).toEqual({ add: 1, update: 0 });
    const skill = reg.entries.get(SKILL_ID);
    expect(skill).toMatchObject({
      id: "opencode-agy",
      name: "opencode-agy",
      path: "/builtin/opencode-agy/SKILL.md",
    });
    expect(frontmatterDescription).toBeDefined();
    expect(skill.description).toBe(frontmatterDescription);
  });

  test("content is the bare body: no frontmatter, real tier table and error codes", async () => {
    const reg = skillRegistry();
    await setupV2Plugin(makeCtx(reg.editor).ctx);
    const content: string = reg.entries.get(SKILL_ID).content;

    expect(content.startsWith("---")).toBe(false);
    expect(content).not.toMatch(/^name:/m);
    expect(content).not.toMatch(/^description:/m);
    expect(content).toBe(content.trim());
    expect(content).toBe(expectedBody);
    expect(content).toContain("| Tier | Use for |");
    for (const code of ["DIR_NOT_ALLOWED", "TIMEOUT", "QUOTA_EXHAUSTED"]) {
      expect(content).toContain(code);
    }
  });

  test("two consecutive setup calls leave one entry and make no second add or update", async () => {
    const reg = skillRegistry();
    const { ctx } = makeCtx(reg.editor);
    await setupV2Plugin(ctx);
    await setupV2Plugin(ctx);

    expect(reg.entries.size).toBe(1);
    expect(reg.calls).toEqual({ add: 1, update: 0 });
  });

  test("a skill already present with stale content is updated to the current content", async () => {
    const stale = {
      id: SKILL_ID,
      name: "opencode-agy",
      description: "old description",
      path: "/builtin/old/SKILL.md",
      content: "stale body",
    };
    const reg = skillRegistry(new Map([[SKILL_ID, stale]]));
    await setupV2Plugin(makeCtx(reg.editor).ctx);

    expect(reg.calls).toEqual({ add: 0, update: 1 });
    const skill = reg.entries.get(SKILL_ID);
    expect(skill.content).toBe(expectedBody);
    expect(skill.description).toBe(frontmatterDescription);
    expect(skill.path).toBe(SKILL_PATH);
  });

  test("a skill already present with identical content is a no-op", async () => {
    const seeded = skillRegistry();
    await setupV2Plugin(makeCtx(seeded.editor).ctx);
    const existing = { ...seeded.entries.get(SKILL_ID) };
    expect(existing.content).toBe(expectedBody);

    const reg = skillRegistry(new Map([[SKILL_ID, existing]]));
    await setupV2Plugin(makeCtx(reg.editor).ctx);

    expect(reg.calls).toEqual({ add: 0, update: 0 });
  });

  test("a fresh editor per transform over the same Map (host reload) adds once and never updates", async () => {
    const reg = skillRegistry();
    const { ctx } = makeCtx();
    ctx.skill = {
      transform: async (fn: any) => {
        await fn(reg.makeEditor());
      },
    };
    await setupV2Plugin(ctx);
    await setupV2Plugin(ctx);

    expect(reg.entries.size).toBe(1);
    expect(reg.calls).toEqual({ add: 1, update: 0 });
  });

  test("a skill whose only drift is a stale path is updated so the path converges", async () => {
    const seeded = skillRegistry();
    await setupV2Plugin(makeCtx(seeded.editor).ctx);
    const stalePath = { ...seeded.entries.get(SKILL_ID), path: "/builtin/old/SKILL.md" };

    const reg = skillRegistry(new Map([[SKILL_ID, stalePath]]));
    await setupV2Plugin(makeCtx(reg.editor).ctx);

    expect(reg.calls).toEqual({ add: 0, update: 1 });
    expect(reg.entries.get(SKILL_ID).path).toBe(SKILL_PATH);
  });

  test("ctx without skill (v1-like and bare {}) resolves and still registers the tool", async () => {
    const v1 = makeCtx();
    await expect(setupV2Plugin(v1.ctx)).resolves.toBeUndefined();
    expect(v1.tools.map((t) => t.name)).toEqual(["agy"]);

    await expect(setupV2Plugin({})).resolves.toBeUndefined();
  });

  test("a skill editor that throws does not reject setup or block tool and command registration", async () => {
    const throwingEditor = {
      get() {
        throw new Error("skill registry unavailable");
      },
      add() {
        throw new Error("skill registry unavailable");
      },
      update() {
        throw new Error("skill registry unavailable");
      },
      list: () => [],
      remove() {},
    };
    const { ctx, tools, commands } = makeCtx(throwingEditor);
    await expect(setupV2Plugin(ctx)).resolves.toBeUndefined();
    expect(tools.map((t) => t.name)).toEqual(["agy"]);
    expect(commands.map((c) => c.name)).toEqual(["agy"]);
  });

  test("a skill transform that rejects does not reject setup", async () => {
    const { ctx, tools } = makeCtx();
    ctx.skill = {
      transform: async () => {
        throw new Error("skill host down");
      },
    };
    await expect(setupV2Plugin(ctx)).resolves.toBeUndefined();
    expect(tools.map((t) => t.name)).toEqual(["agy"]);
  });
});
