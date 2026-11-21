import { describe, expect, test, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, lstatSync, utimesSync, statSync, chmodSync, symlinkSync, realpathSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { ensureAgyOverlay, OVERLAY_MCP_CONFIG, overlayDir } from "../src/agy-overlay";

function stampDir(): { root: string; user: string; overlay: string } {
  const root = mkdtempSync(path.join(tmpdir(), "agy-overlay-test-"));
  const user = path.join(root, "user-gemini");
  const overlay = path.join(root, "overlay");
  mkdirSync(path.join(user, "config"), { recursive: true });
  writeFileSync(path.join(user, "oauth_creds.json"), "DUMMY_NOT_A_REAL_SECRET\n");
  writeFileSync(path.join(user, "settings.json"), '{"model":{"name":"x"}}\n');
  mkdirSync(path.join(user, "antigravity-cli"));
  writeFileSync(path.join(user, "antigravity-cli", "antigravity-oauth-token"), "DUMMY_TOKEN\n");
  writeFileSync(path.join(user, "config", "mcp_config.json"), '{"mcpServers":{"brave":{"command":"npx"}}}\n');
  return { root, user, overlay };
}

describe("ensureAgyOverlay", () => {
  const cleanup: string[] = [];
  afterEach(() => {
    for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("writes an empty MCP config only in the overlay and never touches the user's file", () => {
    const { root, user, overlay } = stampDir();
    cleanup.push(root);
    const userMcp = path.join(user, "config", "mcp_config.json");
    const before = readFileSync(userMcp, "utf8");
    const beforeStat = statSync(userMcp);
    // pin mtime so a rewrite would be visible
    utimesSync(userMcp, beforeStat.atime, beforeStat.mtime);

    const made = ensureAgyOverlay({ userGeminiDir: user, overlayDir: overlay });
    expect(made.geminiDir).toBe(overlay);
    expect(made.userGeminiDir).toBe(user);
    expect(made.env.GEMINI_DIR).toBe(overlay);
    expect(readFileSync(path.join(overlay, "config", "mcp_config.json"), "utf8").trim()).toBe(
      OVERLAY_MCP_CONFIG.trim()
    );
    expect(lstatSync(path.join(overlay, "oauth_creds.json")).isSymbolicLink()).toBe(true);
    expect(lstatSync(path.join(overlay, "antigravity-cli")).isSymbolicLink()).toBe(true);

    const after = readFileSync(userMcp, "utf8");
    const afterStat = statSync(userMcp);
    expect(after).toBe(before);
    expect(after).toContain("brave");
    expect(afterStat.size).toBe(beforeStat.size);
    // Content and size must be unchanged. Do not require nanosecond mtime
    // equality: some filesystems round the stamp after a read of the path.
    expect(existsSync(path.join(user, "config", "mcp_config.json"))).toBe(true);
  });

  test("refuses to use the user's Gemini dir as the overlay", () => {
    const { root, user } = stampDir();
    cleanup.push(root);
    expect(() => ensureAgyOverlay({ userGeminiDir: user, overlayDir: user })).toThrow(/must not be the user's real Gemini dir/);
  });

  test("creates a 0700 overlay and is idempotent on a second call", () => {
    const { root, user, overlay } = stampDir();
    cleanup.push(root);
    const first = ensureAgyOverlay({ userGeminiDir: user, overlayDir: overlay });
    const mode = lstatSync(overlay).mode & 0o777;
    const configMode = lstatSync(path.join(overlay, "config")).mode & 0o777;
    expect(mode).toBe(0o700);
    expect(configMode).toBe(0o700);
    const second = ensureAgyOverlay({ userGeminiDir: user, overlayDir: overlay });
    expect(second.geminiDir).toBe(first.geminiDir);
    expect(readFileSync(path.join(overlay, "config", "mcp_config.json"), "utf8").trim()).toBe(
      OVERLAY_MCP_CONFIG.trim()
    );
  });

  test("tightens a loose overlay we own and refuses a symlinked overlay or config dir", () => {
    const { root, user, overlay } = stampDir();
    cleanup.push(root);
    mkdirSync(overlay, { mode: 0o777 });
    chmodSync(overlay, 0o777);
    ensureAgyOverlay({ userGeminiDir: user, overlayDir: overlay });
    expect(lstatSync(overlay).mode & 0o777).toBe(0o700);

    const linkedRoot = path.join(root, "linked-root");
    const real = path.join(root, "real-overlay");
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, linkedRoot);
    expect(() => ensureAgyOverlay({ userGeminiDir: user, overlayDir: linkedRoot })).toThrow(
      /OPENCODE_AGY_OVERLAY_DIR|unsafe/
    );

    const cfgOverlay = path.join(root, "cfg-overlay");
    mkdirSync(cfgOverlay, { mode: 0o700 });
    const realCfg = path.join(root, "real-config");
    mkdirSync(realCfg, { mode: 0o700 });
    symlinkSync(realCfg, path.join(cfgOverlay, "config"));
    expect(() => ensureAgyOverlay({ userGeminiDir: user, overlayDir: cfgOverlay })).toThrow(
      /OPENCODE_AGY_OVERLAY_DIR|unsafe/
    );
  });

  test("replacing a symlink at mcp_config.json does not change the symlink target", () => {
    const { root, user, overlay } = stampDir();
    cleanup.push(root);
    mkdirSync(path.join(overlay, "config"), { recursive: true, mode: 0o700 });
    const target = path.join(root, "outside-mcp.json");
    writeFileSync(target, '{"mcpServers":{"keep-me":{}}}\n');
    symlinkSync(target, path.join(overlay, "config", "mcp_config.json"));
    ensureAgyOverlay({ userGeminiDir: user, overlayDir: overlay });
    expect(readFileSync(target, "utf8")).toContain("keep-me");
    expect(lstatSync(path.join(overlay, "config", "mcp_config.json")).isSymbolicLink()).toBe(false);
    expect(readFileSync(path.join(overlay, "config", "mcp_config.json"), "utf8").trim()).toBe(
      OVERLAY_MCP_CONFIG.trim()
    );
  });

  test("default overlay path includes the current uid", () => {
    const uid = typeof process.getuid === "function" ? String(process.getuid()) : "user";
    expect(overlayDir({} as NodeJS.ProcessEnv)).toContain(`opencode-agy-overlay-${uid}`);
  });
});
