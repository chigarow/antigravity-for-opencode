/**
 * Plugin-only Gemini dir overlay.
 *
 * agy's global MCP servers live in ~/.gemini/config/mcp_config.json. Starting
 * agy against that file waits minutes for brave/context7/exa. For plugin
 * calls we point GEMINI_DIR (and `agy acp --gemini-dir`) at a temp overlay
 * that keeps the user's auth via symlinks and writes an empty mcp_config
 * only inside the overlay.
 *
 * Never reads credential contents. Never writes, moves, or edits the user's
 * ~/.gemini/config/mcp_config.json or OpenCode's MCP config.
 */
import {
  mkdirSync,
  existsSync,
  symlinkSync,
  lstatSync,
  readFileSync,
  writeFileSync,
  realpathSync,
  chmodSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const OVERLAY_MCP_CONFIG = '{\n  "mcpServers": {}\n}\n';

const AUTH_LINKS = ["oauth_creds.json", "settings.json", "trustedFolders.json", "antigravity-cli"] as const;

export interface AgyOverlay {
  /** Temp Gemini dir used only by this plugin. */
  geminiDir: string;
  /** The user's real Gemini dir; never written to. */
  userGeminiDir: string;
  env: {
    GEMINI_DIR: string;
    ANTIGRAVITY_GEMINI_DIR: string;
  };
}

export function defaultUserGeminiDir(env: NodeJS.ProcessEnv = process.env, home = env.HOME || env.USERPROFILE): string {
  const fromEnv = env.OPENCODE_AGY_USER_GEMINI_DIR;
  if (fromEnv && fromEnv.length > 0) return path.resolve(fromEnv);
  return path.resolve(home || "", ".gemini");
}

export function overlayDir(env: NodeJS.ProcessEnv = process.env): string {
  const custom = env.OPENCODE_AGY_OVERLAY_DIR;
  if (custom && custom.length > 0) return path.resolve(custom);
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  return path.join(tmpdir(), `opencode-agy-overlay-${uid}`);
}

function sameResolved(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

function ensureSymlink(from: string, to: string): void {
  if (!existsSync(from)) return;
  if (existsSync(to) || isLink(to)) {
    try {
      if (sameResolved(from, to) || (isLink(to) && readLinkSafe(to) === from)) return;
    } catch {
      // recreate below
    }
    return;
  }
  symlinkSync(from, to);
}

function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function readLinkSafe(p: string): string | undefined {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
}

function overlayError(dir: string, why: string): Error {
  return new Error(
    `agy overlay at ${dir} is unsafe (${why}). Set OPENCODE_AGY_OVERLAY_DIR to a private directory you own.`
  );
}

/**
 * Require `dir` to be a real directory owned by this user, with no group or
 * world bits. Create it as 0700 when missing. If we own a too-loose directory,
 * chmod it; otherwise throw.
 */
function ensurePrivateDir(dir: string): void {
  let st: ReturnType<typeof lstatSync> | undefined;
  try {
    st = lstatSync(dir);
  } catch {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
    } catch {
      // best effort after create
    }
    st = lstatSync(dir);
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw overlayError(dir, "must be a real directory, not a symlink or file");
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid != null && st.uid !== uid) {
    throw overlayError(dir, "owned by another user");
  }
  const mode = st.mode & 0o777;
  if (mode & 0o077) {
    if (uid == null || st.uid === uid) {
      chmodSync(dir, 0o700);
    } else {
      throw overlayError(dir, `mode ${mode.toString(8)} is group- or world-accessible`);
    }
  }
}

function writeOverlayMcpConfig(mcpPath: string): void {
  if (!isLink(mcpPath) && existsSync(mcpPath)) {
    const existing = readFileSync(mcpPath, "utf8");
    if (existing.trim() === OVERLAY_MCP_CONFIG.trim()) return;
  }
  const tmpPath = `${mcpPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmpPath, OVERLAY_MCP_CONFIG, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(tmpPath, mcpPath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore
    }
    throw err;
  }
}

/**
 * Create or reuse the overlay. Idempotent. The user's mcp_config.json is
 * never opened for write and is not replaced by this function.
 */
export function ensureAgyOverlay(options: {
  userGeminiDir?: string;
  overlayDir?: string;
  env?: NodeJS.ProcessEnv;
} = {}): AgyOverlay {
  const env = options.env ?? process.env;
  const userGeminiDir = path.resolve(options.userGeminiDir ?? defaultUserGeminiDir(env));
  const geminiDir = path.resolve(options.overlayDir ?? overlayDir(env));

  if (sameResolved(userGeminiDir, geminiDir)) {
    throw new Error("agy overlay dir must not be the user's real Gemini dir");
  }

  ensurePrivateDir(geminiDir);
  ensurePrivateDir(path.join(geminiDir, "config"));

  for (const name of AUTH_LINKS) {
    ensureSymlink(path.join(userGeminiDir, name), path.join(geminiDir, name));
  }

  writeOverlayMcpConfig(path.join(geminiDir, "config", "mcp_config.json"));

  return {
    geminiDir,
    userGeminiDir,
    env: {
      GEMINI_DIR: geminiDir,
      ANTIGRAVITY_GEMINI_DIR: geminiDir,
    },
  };
}

/** Env names the child needs so --print also skips the user's MCP file. */
export function overlayChildEnv(overlay: AgyOverlay, base: Record<string, string>): Record<string, string> {
  return {
    ...base,
    GEMINI_DIR: overlay.env.GEMINI_DIR,
    ANTIGRAVITY_GEMINI_DIR: overlay.env.ANTIGRAVITY_GEMINI_DIR,
  };
}
