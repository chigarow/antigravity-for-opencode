import { describe, expect, test, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, symlinkSync, chmodSync, realpathSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { mentionedPaths, slimPrompt, MAX_FILE_CHARS, resolveWorkspaceFile } from "../src/agy-prompt";

describe("slimPrompt", () => {
  const cleanup: string[] = [];
  afterEach(() => {
    for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("leaves a task-only prompt unchanged", () => {
    expect(slimPrompt({ prompt: "Reply with ok", workspaceRoot: tmpdir() })).toBe("Reply with ok");
  });

  test("attaches only requested files that exist inside the workspace", () => {
    const root = mkdtempSync(path.join(tmpdir(), "agy-prompt-"));
    cleanup.push(root);
    writeFileSync(path.join(root, "keep.py"), "print(1)\n");
    writeFileSync(path.join(root, "ignore.py"), "SECRET\n");
    const out = slimPrompt({
      prompt: "Average the column",
      files: ["keep.py"],
      workspaceRoot: root,
    });
    expect(out).toContain("Average the column");
    expect(out).toContain("print(1)");
    expect(out).not.toContain("SECRET");
    expect(out).toContain(path.join(realpathSync(root), "keep.py"));
  });

  test("also attaches mentioned workspace paths, and skips anything outside", () => {
    const root = mkdtempSync(path.join(tmpdir(), "agy-prompt-"));
    cleanup.push(root);
    writeFileSync(path.join(root, "in.txt"), "inside\n");
    const outside = path.join(tmpdir(), "agy-prompt-outside.txt");
    writeFileSync(outside, "outside-secret\n");
    cleanup.push(outside);
    const out = slimPrompt({
      prompt: "Read in.txt and also /etc/passwd please",
      workspaceRoot: root,
    });
    expect(mentionedPaths("See src/foo.ts and ./bar.py")).toEqual(["src/foo.ts", "./bar.py"]);
    expect(out).toContain("inside");
    expect(out).not.toContain("outside-secret");
    expect(out).not.toContain("root:");
  });

  test("rejects a symlink file and a symlinked parent that escape the root", () => {
    const root = mkdtempSync(path.join(tmpdir(), "agy-prompt-"));
    cleanup.push(root);
    const outsideDir = mkdtempSync(path.join(tmpdir(), "agy-prompt-out-"));
    cleanup.push(outsideDir);
    writeFileSync(path.join(outsideDir, "secret.txt"), "outside-secret\n");
    symlinkSync(path.join(outsideDir, "secret.txt"), path.join(root, "link.txt"));
    mkdirSync(path.join(root, "sub"));
    symlinkSync(outsideDir, path.join(root, "sub", "escaped"));
    expect(resolveWorkspaceFile(path.join(root, "link.txt"), root)).toBeUndefined();
    expect(resolveWorkspaceFile(path.join(root, "sub", "escaped", "secret.txt"), root)).toBeUndefined();
    const out = slimPrompt({
      prompt: "Read link.txt please",
      files: [path.join(root, "link.txt"), path.join(root, "sub", "escaped", "secret.txt")],
      workspaceRoot: root,
    });
    expect(out).not.toContain("outside-secret");
  });

  test("does not treat a similarly prefixed path as inside the root", () => {
    const parent = mkdtempSync(path.join(tmpdir(), "agy-ws-"));
    cleanup.push(parent);
    const root = path.join(parent, "ws");
    const evil = path.join(parent, "ws-evil");
    mkdirSync(root);
    mkdirSync(evil);
    writeFileSync(path.join(evil, "secret.py"), "evil-secret\n");
    expect(resolveWorkspaceFile(path.join(evil, "secret.py"), root)).toBeUndefined();
    const out = slimPrompt({
      prompt: "Read this",
      files: [path.join(evil, "secret.py")],
      workspaceRoot: root,
    });
    expect(out).not.toContain("evil-secret");
  });

  test("explicit files outside the selected dir still attach when they stay inside the workspace root", () => {
    const root = mkdtempSync(path.join(tmpdir(), "agy-prompt-"));
    cleanup.push(root);
    mkdirSync(path.join(root, "sub"));
    writeFileSync(path.join(root, "keep.py"), "root-file\n");
    writeFileSync(path.join(root, "sub", "in.py"), "sub-file\n");
    const out = slimPrompt({
      prompt: "Use both",
      files: [path.join(root, "keep.py")],
      workspaceRoot: root,
      mentionRoot: path.join(root, "sub"),
    });
    expect(out).toContain("root-file");
    expect(out).toContain(path.join(realpathSync(root), "keep.py"));
  });

  test("truncates a large file and skips an unreadable one", () => {
    const root = mkdtempSync(path.join(tmpdir(), "agy-prompt-"));
    cleanup.push(root);
    const big = path.join(root, "big.txt");
    writeFileSync(big, "A".repeat(MAX_FILE_CHARS + 2_000));
    const locked = path.join(root, "locked.txt");
    writeFileSync(locked, "should-not-appear\n");
    const asRoot = typeof process.getuid === "function" && process.getuid() === 0;
    if (!asRoot) chmodSync(locked, 0);
    const out = slimPrompt({
      prompt: "Read both",
      files: [big, locked],
      workspaceRoot: root,
    });
    expect(out).toContain("[truncated");
    if (!asRoot) {
      expect(out).not.toContain("should-not-appear");
      chmodSync(locked, 0o600);
    }
    expect(out.includes("A".repeat(100))).toBe(true);
  });
});
