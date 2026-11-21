/**
 * Auto-route a plugin call to a model tier when the caller did not pick one.
 *
 * Explicit `tier` or `model` always wins. When both are omitted:
 *   simple tasks  → flash-3.8-med
 *   normal coding → hydrogen-4-med
 *   hard tasks    → hydrogen-4-hi  (callers who want Opus 5.5 pass that tier)
 */
export type TaskKind = "simple" | "coding" | "hard";

export const TASK_TIER = {
  simple: "flash-3.8-med",
  coding: "hydrogen-4-med",
  hard: "hydrogen-4-hi",
} as const;

const HARD_RE =
  /\b(architect(?:ure|ing)?|system design|design a (?:system|framework|platform)|threat model|security audit|large-?scale|multi-repo|entire code(?:base)?|from scratch|distributed|concurren(?:cy|t)|formal verif|compiler|production incident|performance (?:overhaul|audit)|deep refactor|migrate(?: the| this)? (?:system|monolith|codebase)|rewrite the (?:system|platform|engine))\b/i;

const CODING_RE =
  /\b(implement|refactor|scaffold|unit tests?|add tests?|fix (?:the )?(?:bug|type error|compile error|failing test)|write (?:a )?(?:function|class|hook|component|module|script|api|endpoint|test)|type(?:script| error)|source code|code review|pull request|\bpr\b|linter|compile|debug this (?:function|file|test))\b/i;

const SIMPLE_RE =
  /\b(what is|what's|explain|summarize|translate|rephrase|reply with|say hello|how do i (?:say|spell)|typo in this sentence)\b/i;

const CODE_EXT_RE = /\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|cs|cpp|cc|c|h|hpp|swift|scala|sh|bash|zsh|sql|vue|svelte|json|yml|yaml|toml|mdx)(?:\b|$)/i;

export function classifyTask(prompt: string, files?: readonly string[]): TaskKind {
  const text = prompt ?? "";
  const fileList = files ?? [];
  if (HARD_RE.test(text)) return "hard";
  // Count with a separate global regex. Do not add /g/ to CODE_EXT_RE:
  // that same expression is used with .test() below, and a shared /g/ regex
  // would skip matches after lastIndex advances.
  const extGlobal = new RegExp(CODE_EXT_RE.source, "gi");
  const mentionsManyFiles = fileList.length >= 6 || (text.match(extGlobal) || []).length >= 6;
  if (mentionsManyFiles && /\b(refactor|migrate|rewrite|architect)/i.test(text)) return "hard";
  if (CODING_RE.test(text) || fileList.some((f) => CODE_EXT_RE.test(f)) || CODE_EXT_RE.test(text)) {
    return "coding";
  }
  if (SIMPLE_RE.test(text)) return "simple";
  // Short, unspecific prompts stay on Flash. Long briefs without keywords
  // are treated as normal coding work.
  if (text.trim().length >= 800) return "coding";
  return "simple";
}

export function autoTier(prompt: string, files?: readonly string[]): (typeof TASK_TIER)[TaskKind] {
  return TASK_TIER[classifyTask(prompt, files)];
}
