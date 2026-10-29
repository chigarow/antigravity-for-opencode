---
name: opencode-agy
description: Driving the `agy` tool from the opencode-agy plugin, which runs the Antigravity CLI (Gemini / Claude / Argon) as a headless sub-agent. Use this whenever you hand scoped work to agy, pick an agy model tier, decide whether a task is worth delegating, resume a run that hit `AGY_ERROR [TIMEOUT]`, analyze a local PDF or image with agy, or explain an `AGY_ERROR [CODE]` result. Trigger it on "delegate to agy", "use gemini/antigravity", "/agy", or any plan to offload bulk or cross-model work, even when the plugin is never named.
---

# opencode-agy

`agy` is a single tool that spawns the Antigravity CLI in headless mode. It is a **cold process**: it sees no chat history, no memory of earlier calls, and only the directory you hand it. Every call returns text plus metadata. agy-side failures come back as `AGY_ERROR [CODE]` instead of crashing you.

Nothing agy produces is verified. Reading, diffing, and testing the result is your job, not agy's.

## Is this worth delegating

Delegate when the work is **wide or bulky**: generate tests for a module, scaffold boilerplate, survey a directory, summarize a pile of documents, or get a second opinion from a different model on a design or a diff.

Do it yourself when the work is **small or decided by context you already hold**: a fix under ~20 lines, anything needing an architecture call, or a file you just read. The brief you'd have to write costs more than the edit.

One task per call. Two agy calls that must not fight over the same file are two scopes, not two parallel runs of the same scope.

## Write the brief, not a wish

agy starts from zero, so the prompt must stand alone:

- Absolute paths or workspace-relative paths it can actually open. It only sees `dir`.
- The constraint that matters: language, framework, test runner, style, what not to touch.
- The finish line: the exact command that proves it works, or the exact output shape you want back.
- Prompts are forwarded verbatim. agy expands slash or skill syntax when a prompt begins with `/`, or starts with a newline or tab followed by one. This plugin has no toggle for agy's `--disable-slash-commands`, so start the prompt with a normal word (`Review the diff`, not `/review`).
- Ask for a diff or file list, not prose about what it did. You need something checkable.

## Arguments

| Argument | Notes |
| --- | --- |
| `prompt` | Required. Self-contained, starts with a normal word. |
| `tier` | Model tier, default `flash-3.8-med`. See below. |
| `dir` | Workspace for agy (`--add-dir`). Must be inside `AGY_WORKSPACE_ROOT` (default: current project), otherwise `DIR_NOT_ALLOWED`. |
| `project` | Optional `--project <value>` for a specific Google Cloud project. |
| `timeout` | Duration (`15m`, `300s`, `500ms`, `2h`) or a positive integer of ms (`300000` becomes `5m`). Default `15m`; anything above `4h` is clamped to `4h`. Rejected with `INVALID_TIMEOUT`: `0`, negatives, decimals such as `5.5h`, `1d`, `1h30m`, `05m`, empty or garbage. |
| `yolo` | `--dangerously-skip-permissions`. Needs `sandbox: true` and host `AGY_ALLOW_YOLO=1`, else `YOLO_NOT_APPROVED`. |
| `sandbox` | `--sandbox`: restricts terminal commands only. File reads keep working. |
| `continue` | Resume the latest agy conversation. Cannot be combined with `conversation`. |
| `conversation` | Resume by ID: `ses_...`, a UUID, or a 6 to 64 char slug. |
| `model` | Exact model override. Values starting with `-` are rejected. `tier` is still validated first. |

Output caps: stdout is cut at 100,000 bytes, and stderr is shown at 2,000 chars (the plugin captures 64 KB of stderr internally, for classification only). Truncated stdout is cut at the cap and carries a `[truncated ...]` marker, so look for the marker. A suspiciously short result is something else (a denied tool, `EMPTY_OUTPUT`, an early exit), not truncation.

## Pick the tier

Twelve tier names across four model families. `hi` / `med` / `lo` select the High / Medium / Low variant. Pass tier names only: a CLI slug such as `gemini-3.8-flash-high` as `tier` returns `INVALID_TIER`.

| Tier | Use for |
| --- | --- |
| `flash-3.8-med` | Default. Everyday scoped work, works on every account. |
| `flash-3.8-lo` | Cheap bulk: listings, extraction, format conversion, long low-stakes input. |
| `flash-3.8-hi` | Bulk work that still needs real reasoning before it writes. |
| `claude-sonnet-5-5-{hi,med,lo}` | Code correctness, reviews, careful multi-file edits. Needs a Pro or Ultra plan. |
| `claude-opus-5-5-{hi,med,lo}` | Hardest merges, gnarly refactors, second opinion on a risky diff. Needs a Pro or Ultra plan. |
| `argon-4-{hi,med,lo}` | Needs a **paid** Pro or Ultra plan. Trial, student, and partner-bundled plans do not get it. Run `agy models` to check entitlement. |

Dropped tiers: `flash-3.5-*`, `flash-3.6-*`, `flash-3.7-*`, and `pro-3.1-*` have no aliases and return `INVALID_TIER`, even when `model` is set.

## Recipes

**Bulk generation.** `{ prompt, tier: "flash-3.8-med", dir: "<module dir>" }` with the brief naming the files, the test runner, and the coverage you expect.

**Local file analysis (PDF, PNG, any binary).** Try the cheap path first, then escalate:

1. Call without `yolo`, with `dir` set to the file's parent directory. Headless agy cannot ask for permission, so it soft-denies file tools that need one and prints a stderr notice naming the allow-rule it needs.
2. If the result is denied or empty, retry with all three: `yolo: true`, `sandbox: true`, and `AGY_ALLOW_YOLO=1` in the host environment. `yolo: true` without `sandbox: true` or without host consent returns `YOLO_NOT_APPROVED`. Omitting `yolo` entirely just runs without auto-approve; it is not an error.

```json
{ "prompt": "Extract every line item from report.pdf into a markdown table.",
  "tier": "flash-3.8-lo", "dir": "/abs/path/to/the/files/parent",
  "yolo": true, "sandbox": true }
```

3. `dir` must be the file's parent directory inside the workspace root. `--add-dir` exposes that whole directory, so sibling files are readable too. A file outside the workspace returns `DIR_NOT_ALLOWED`.

**Long task that overruns.** Start merges and heavy refactors with `timeout: "30m"` instead of the default. On `AGY_ERROR [TIMEOUT]`, do not re-prompt from scratch. Read `details.conversationId` and `details.suggestedNextTimeout`, then call again with `conversation: <details.conversationId>`, `timeout: <details.suggestedNextTimeout>`, and a prompt like "keep going, finish the merge". If `conversationId` is missing, there is nothing to resume: narrow the brief and start fresh.

**Cross-model review.** `tier: "claude-opus-5-5-hi"`, prompt: the diff inline plus "list concrete defects with file:line, no summary". Treat findings as hypotheses until you check them.

## Errors map to a next move

agy-side failures come back as `AGY_ERROR [CODE]` with a message, a `details` object, and `details.conversationId` when it is known. Tool results can also come back as `AGY_UNEXPECTED_ERROR` or `UNDEFINED_RESULT` for failures outside agy. Those are plugin or host problems: report them, do not retry in a loop.

| Code | Move |
| --- | --- |
| `TIMEOUT` | Resume with `conversation` and `details.suggestedNextTimeout`, see the recipe above. |
| `DIR_NOT_ALLOWED` | `dir` is empty, flag-like, non-existent, or outside the workspace root. Omitting `dir` defaults to the workspace root, so leave it out for project-wide work. Use a path inside the project. |
| `INVALID_TIER` | Unknown tier, a CLI slug, or a dropped name. Pick from the twelve above. |
| `YOLO_NOT_APPROVED` | Add `sandbox: true` and ask the host for `AGY_ALLOW_YOLO=1`, or drop `yolo`. |
| `INVALID_ARGUMENT` / `INVALID_ARGS` / `INVALID_CONVERSATION_ID` / `INVALID_TIMEOUT` | Argument shape is wrong: a wrong type, empty or flag-like value, malformed conversation ID, or bad timeout. `INVALID_ARGS` means `continue: true` came with `conversation`. Fix the argument; retrying unchanged repeats the error. |
| `MODEL_NOT_FOUND` | The plan lacks the model, or it was removed upstream. Run `agy models`, then fall back to a `flash-3.8-*` tier. |
| `QUOTA_EXHAUSTED` | Quota or rate limit. Needs a human: wait for the reset. Do not retry in a loop. |
| `AUTH_REQUIRED` | Not signed in. Needs a human: run `agy` once interactively to log in. |
| `AGY_NOT_FOUND` | `agy` is not on `PATH` for this host. Report it; retrying will not help. |
| `AGY_FAILED` | agy exited non-zero with no known cause. Read `details.stderr` before deciding. |
| `EMPTY_OUTPUT` | The brief was too vague or the run died early. Narrow it and retry once. |

## After the call

Read the returned diff or file list, run the tests yourself, and check the task actually happened rather than being described. A clean agy summary is a claim. If the work landed wrong, fix it or send one follow-up with the specific defect inside the same `conversation` instead of starting over.
