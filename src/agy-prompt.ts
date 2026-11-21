/**
 * Slim the payload sent to agy: the task, plus only the files it needs.
 * Paths must already be confined to the workspace by the caller.
 */
import { openSync, readSync, closeSync, statSync, realpathSync } from "node:fs";
import path from "node:path";

/** Per-file cap so a huge log cannot blow the prompt. */
export const MAX_FILE_CHARS = 80_000;
/** Total attached-file cap. */
export const MAX_ATTACH_CHARS = 400_000;

const PATH_RE =
  /(?:^|[\s`'"(])((?:\.?\/|[\w.@-]+\/|\/)?[\w.@+-]+(?:\/[\w.@+-]+)*\.[A-Za-z0-9]{1,8})/g;

export function mentionedPaths(prompt: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  PATH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PATH_RE.exec(prompt))) {
    const raw = m[1]!;
    if (seen.has(raw)) continue;
    seen.add(raw);
    found.push(raw);
  }
  return found;
}

function readCapped(filePath: string, remaining: number): { text: string; truncated: boolean } | undefined {
  const cap = Math.min(MAX_FILE_CHARS, remaining);
  if (cap <= 0) return undefined;
  let fd: number | undefined;
  try {
    const st = statSync(filePath);
    if (!st.isFile()) return undefined;
    fd = openSync(filePath, "r");
    // Read at most cap*4 bytes so a multi-byte UTF-8 prefix cannot exceed the
    // character cap after decode, while still not loading a huge file.
    const maxBytes = Math.min(st.size, cap * 4);
    const buf = Buffer.alloc(maxBytes);
    const n = readSync(fd, buf, 0, maxBytes, 0);
    const raw = buf.subarray(0, n).toString("utf8");
    if (raw.length <= cap && n >= st.size) return { text: raw, truncated: false };
    const text = raw.length > cap ? raw.slice(0, cap) : raw;
    const omitted = raw.length > cap ? raw.length - cap : 0;
    // If we only read a prefix of a larger file, report a conservative omission.
    const more = n < st.size && omitted === 0 ? 1 : omitted;
    return {
      text: `${text}\n... [truncated ${more || "some"} chars]`,
      truncated: true,
    };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

export interface SlimPromptInput {
  prompt: string;
  /** Absolute, already-confined paths to attach. */
  files?: readonly string[];
  /** Workspace root used to resolve mentioned relative paths. */
  workspaceRoot: string;
  /**
   * Extra candidates taken from the prompt. Each is resolved against the
   * workspace and ignored when it does not exist or escapes the root.
   */
  mentionRoot?: string;
}

export function isInsideRoot(candidate: string, root: string): boolean {
  const resolved = path.resolve(candidate);
  const base = path.resolve(root);
  return resolved === base || resolved.startsWith(base + path.sep);
}

export function resolveWorkspaceFile(raw: string, root: string): string | undefined {
  if (!raw || raw.includes("\0") || raw.startsWith("-")) return undefined;
  try {
    const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);
    const realRoot = realpathSync(root);
    const realCand = realpathSync(abs);
    if (!(realCand === realRoot || realCand.startsWith(realRoot + path.sep))) return undefined;
    return realCand;
  } catch {
    return undefined;
  }
}

/**
 * Build the prompt actually sent to agy. The original task is kept first;
 * requested or mentioned workspace files are appended, each once, under a
 * size cap. Missing or out-of-root paths are skipped, never invented.
 */
export function slimPrompt(input: SlimPromptInput): string {
  const task = input.prompt.trimEnd();
  const mentionRoot = input.mentionRoot ?? input.workspaceRoot;
  const wanted: string[] = [];
  const seen = new Set<string>();
  const add = (p: string | undefined) => {
    if (!p || seen.has(p)) return;
    seen.add(p);
    wanted.push(p);
  };
  // Explicit attachments are confined to the workspace root, even when
  // `mentionRoot` is a subdirectory (the selected `dir`).
  for (const f of input.files ?? []) add(resolveWorkspaceFile(f, input.workspaceRoot));
  for (const m of mentionedPaths(input.prompt)) add(resolveWorkspaceFile(m, mentionRoot));

  if (wanted.length === 0) return input.prompt;

  const parts: string[] = [task, "", "Attached files (only the paths this task needs):"];
  let remaining = MAX_ATTACH_CHARS;
  for (const filePath of wanted) {
    if (remaining <= 0) {
      parts.push(`\n--- ${filePath} ---`, "... [omitted: attachment budget exhausted]");
      continue;
    }
    const body = readCapped(filePath, remaining);
    if (!body) continue;
    parts.push(`\n--- ${filePath} ---`, body.text);
    remaining -= body.text.length;
  }
  return parts.join("\n");
}
