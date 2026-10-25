#!/usr/bin/env bash
#
# agy-delegate.sh — standalone wrapper around the Antigravity CLI (`agy`).
# Matches the behavior of the opencode-agy plugin, with the same review and safety caveats.
# Supports 12 versioned tiers: flash-3.8-hi, flash-3.8-med, flash-3.8-lo, claude-sonnet-5-5-hi, claude-sonnet-5-5-med, claude-sonnet-5-5-lo, claude-opus-5-5-hi, claude-opus-5-5-med, claude-opus-5-5-lo, argon-4-hi, argon-4-med, and argon-4-lo (default: flash-3.8-med).
# Timeout default is 15m for every tier; explicit values above 4h are clamped to 4h (enforced here, like the plugin).
# Safety rules:
#   - `--yolo` requires `--sandbox` AND host consent (`AGY_ALLOW_YOLO=1`).
#   - `--dir` must exist and resolve (realpath) inside the workspace root —
#     `AGY_WORKSPACE_ROOT` when set, otherwise `$PWD` — or it is rejected (DIR_NOT_ALLOWED).
#   - `--conversation` must match the plugin's conversation-ID shape.
#   - Captured stdout is capped at 100KB, surfaced stderr at 2KB (with
#     truncation markers) and secret-shaped strings are redacted before printing.
#   - `--continue` and `--conversation` are mutually exclusive.
#   - agy runs with a per-run 0700 temp dir holding its log file, removed on exit.
#
# Usage examples:
#   ./scripts/agy-delegate.sh --project . "implement the feature"
#   ./scripts/agy-delegate.sh --tier claude-opus-5-5-hi --dir . "review this diff"
#   echo "task" | ./scripts/agy-delegate.sh -
#
set -euo pipefail

TIER="flash-3.8-med"
TIMEOUT=""           # normalized --timeout value, or the 15m default
TIMEOUT_IN=""        # raw --timeout value as supplied
EXPLICIT_TIMEOUT=0   # tracks whether --timeout was explicitly supplied
DIR=""
RESOLVED_DIR=""
ROOT=""
PROJECT=""
YOLO=0
SANDBOX=0
CONTINUE=0
CONV_ID=""
MODEL=""
PROMPT=""

die() { echo "agy-delegate: $*" >&2; exit 1; }
# Usage-conflict class of errors: exit 2 (mirrors the plugin's INVALID_ARGS).
die_conflict() { echo "agy-delegate: $*" >&2; exit 2; }
need() { [ "$1" -ge 2 ] || die "option '$2' needs a value"; }

# Option values must be non-empty and must not start with '-', so
# `--model --foo` or `--timeout --yolo` cannot smuggle the next flag in as
# a value. execve cannot pass NUL bytes inside argv strings, so there is no
# NUL case to handle here.
checkval() {
  case "$2" in
    ""|-*) die "option '$1' requires a non-empty value that does not start with '-'" ;;
  esac
}

# Conversation IDs are echoed back to the parent model and later become a
# --conversation argv value, so they must not carry shell-, flag-, path- or
# markup-shaped payloads. Mirrors isValidConversationId (src/agy-runner.ts)
# exactly: a ses_ id, a UUID, or a plain slug of 6-64 characters; no leading
# '-', no '..', none of whitespace " ' / \ < >.
CONV_ID_BAD_RE="[[:space:]\"'/\\\\<>]"
CONV_ID_SHAPE_RE='^(ses_[A-Za-z0-9_-]{4,64}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[A-Za-z0-9][A-Za-z0-9_-]{5,63})$'
validate_conversation_id() {
  id="$1"
  case "$id" in
    -*|*..*) die "invalid conversation ID '$id' (expected a ses_ id, a UUID, or a 6-64 character slug)" ;;
  esac
  if printf '%s' "$id" | grep -qE "$CONV_ID_BAD_RE"; then
    die "invalid conversation ID '$id' (expected a ses_ id, a UUID, or a 6-64 character slug)"
  fi
  if ! printf '%s' "$id" | grep -qE "$CONV_ID_SHAPE_RE"; then
    die "invalid conversation ID '$id' (expected a ses_ id, a UUID, or a 6-64 character slug)"
  fi
}

usage() {
  cat <<'EOF'
Usage: agy-delegate.sh [options] "prompt"
       echo "prompt" | agy-delegate.sh -

Options:
  -t, --tier <flash-3.8-hi|flash-3.8-med|flash-3.8-lo|claude-sonnet-5-5-hi|claude-sonnet-5-5-med|claude-sonnet-5-5-lo|claude-opus-5-5-hi|claude-opus-5-5-med|claude-opus-5-5-lo|argon-4-hi|argon-4-med|argon-4-lo>
                                      Tier (default: flash-3.8-med)
  -d, --dir <path>                  Add workspace dir; must resolve (realpath) inside the
                                    workspace root (AGY_WORKSPACE_ROOT when set, else $PWD).
                                    Missing or escaping paths are rejected (DIR_NOT_ALLOWED).
      --project <path>              Wrapper alias for agy's project selection; forwarded to upstream agy
      --timeout <dur>               e.g. 5m, 10m, 300s (default 15m for all tiers; values above 4h are clamped to 4h)
      --yolo                        --dangerously-skip-permissions; requires --sandbox AND
                                    host consent (AGY_ALLOW_YOLO=1 in the environment)
      --sandbox                     Run with terminal restrictions; safer, but may block merge or filesystem-heavy work
   -c, --continue                    Resume most recent agy conversation
      --conversation <id>           Resume specific conversation (validated: ses_ id, UUID,
                                    or 6-64 char slug; no -, .., whitespace, quotes, /\<>)
                                    (--continue and --conversation are mutually exclusive)
  -m, --model <exact>               Wrapper-only alias for exact model name, forwarded upstream
  -h, --help
EOF
  exit 0
}

model_for_tier() {
  case "$1" in
    flash-3.8-hi)  echo "Gemini 3.8 Flash (High)" ;;
    flash-3.8-med) echo "Gemini 3.8 Flash (Medium)" ;;
    flash-3.8-lo)  echo "Gemini 3.8 Flash (Low)" ;;
    claude-sonnet-5-5-hi)  echo "Claude Sonnet 5.5 (High)" ;;
    claude-sonnet-5-5-med) echo "Claude Sonnet 5.5 (Medium)" ;;
    claude-sonnet-5-5-lo)  echo "Claude Sonnet 5.5 (Low)" ;;
    claude-opus-5-5-hi)  echo "Claude Opus 5.5 (High)" ;;
    claude-opus-5-5-med) echo "Claude Opus 5.5 (Medium)" ;;
    claude-opus-5-5-lo)  echo "Claude Opus 5.5 (Low)" ;;
    argon-4-hi)  echo "Gemini 4 Argon (High)" ;;
    argon-4-med) echo "Gemini 4 Argon (Medium)" ;;
    argon-4-lo)  echo "Gemini 4 Argon (Low)" ;;
    *) die "unknown tier '$1'" ;;
  esac
}

# Normalize --timeout exactly like the plugin's normalizeTimeout (src/agy-runner.ts):
#   - positive integer (ms)      -> >=60000 -> minutes (ceil), else seconds (ceil)
#   - ^[1-9][0-9]*\s*(h|m|s|ms)$ (case-insensitive) -> canonical lowercase form,
#     clamped to "4h" when above the 4h hard cap (MAX_TIMEOUT_MS)
#   - 0, 0-prefixed, negatives, fractions, unknown units, junk -> fatal
normalize_timeout() {
  v="$1"
  case "$v" in
    *[!0-9]*)
      if ! printf '%s' "$v" | grep -Eq '^[1-9][0-9]*[[:space:]]*([hH]|[mM]|[sS]|[mM][sS])$'; then
        die "invalid timeout '$v' (expected a positive ms integer like 300000, or a duration like 45s / 5m / 2h; values above 4h are clamped to 4h)"
      fi
      n="${v%%[!0-9]*}"
      u="$(printf '%s' "${v#"$n"}" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')"
      # Length guard: 13+ digits of any unit is far above 4h; avoids 64-bit overflow.
      if [ "${#n}" -gt 12 ]; then echo "4h"; return; fi
      case "$u" in
        h)  ms=$((n * 3600000)) ;;
        m)  ms=$((n * 60000)) ;;
        s)  ms=$((n * 1000)) ;;
        ms) ms=$n ;;
      esac
      if [ "$ms" -gt 14400000 ]; then echo "4h"; else echo "$n$u"; fi
      ;;
    *)
      case "$v" in
        0*) die "invalid timeout '$v' (must be a positive number of ms like 300000, or a duration like 45s / 5m / 2h)" ;;
      esac
      # Length guard: 13+ digits of ms is far above 4h; avoids 64-bit overflow.
      if [ "${#v}" -gt 12 ]; then echo "4h"; return; fi
      if [ "$v" -ge 60000 ]; then
        echo "$(((v + 59999) / 60000))m"
      else
        echo "$(((v + 999) / 1000))s"
      fi
      ;;
  esac
}

# Secret-shaped strings are redacted before anything captured from agy is
# printed (same patterns for stdout and stderr). Minimum token lengths are
# kept low so short ghp_/xox/AIza-shaped values are still redacted.
REDACT_RULES=(
  's/([Bb][Ee][Aa][Rr][Ee][Rr][[:space:]]+)[^[:space:]]+/\1[REDACTED]/g'
  's/(^|[^A-Za-z0-9_-])sk-[A-Za-z0-9_-]+/\1[REDACTED]/g'
  's/AIza[0-9A-Za-z_-]{10,}/[REDACTED]/g'
  's/gh[pousr]_[A-Za-z0-9_]{6,}/[REDACTED]/g'
  's/github_pat_[A-Za-z0-9_]+/[REDACTED]/g'
  's/A[SK]IA[0-9A-Z]{16}/[REDACTED]/g'
  's/xox[baprs]-[A-Za-z0-9-]{4,}/[REDACTED]/g'
  's/(aws_secret_access_key|AWS_SECRET_ACCESS_KEY|[A-Z0-9_]+_KEY|[A-Z0-9_]+_TOKEN|[A-Z0-9_]+_SECRET|[A-Z0-9_]+_PASSWORD|[Pp]assword|[Pp]asswd|[Pp]wd|[Tt]oken|[Ss]ecret|api_key|apikey|client_secret|access_key|private_key)([[:space:]]*[=:][[:space:]]*)[^[:space:]]+/\1\2[REDACTED]/g'
)
redact() {
  # PEM-style blocks span lines, which single-line sed rules cannot span:
  # fold each BEGIN..END block to one [REDACTED] line first.
  # ponytail: assumes BEGIN/END markers start their line; upgrade to a
  # character-stream redactor if inline PEM ever shows up.
  awk '
    /-----BEGIN/ { inpem = 1; print "[REDACTED]"; next }
    inpem        { if (/-----END/) inpem = 0; next }
                   { print }
  ' "$1" | {
    args=(sed -E)
    r=""
    for r in "${REDACT_RULES[@]}"; do args+=(-e "$r"); done
    "${args[@]}"
  }
}

while [ $# -gt 0 ]; do
  case "$1" in
    -t|--tier)       need "$#" "$1"; checkval "$1" "$2"; TIER="$2"; shift 2 ;;
    -d|--dir)        need "$#" "$1"; checkval "$1" "$2"; DIR="$2"; shift 2 ;;
    --project)       need "$#" "$1"; checkval "$1" "$2"; PROJECT="$2"; shift 2 ;;
    --timeout)       need "$#" "$1"; checkval "$1" "$2"; TIMEOUT_IN="$2"; EXPLICIT_TIMEOUT=1; shift 2 ;;
    --yolo)          YOLO=1; shift ;;
    --sandbox)       SANDBOX=1; shift ;;
    -c|--continue)   CONTINUE=1; shift ;;
    --conversation)  need "$#" "$1"; checkval "$1" "$2"; CONV_ID="$2"; shift 2 ;;
    -m|--model)      need "$#" "$1"; checkval "$1" "$2"; MODEL="$2"; shift 2 ;;
    -h|--help)       usage ;;
    -)               PROMPT="$(cat)"; shift ;;
    --)              shift; [ -n "${*:-}" ] && PROMPT="${*}"; break ;;
    -*)              die "unknown option $1" ;;
    *)               PROMPT="$*"; break ;;
  esac
done

[ -n "$PROMPT" ] || die "no prompt"
command -v agy >/dev/null 2>&1 || die "agy not found on PATH"

if [ "$CONTINUE" -eq 1 ] && [ -n "$CONV_ID" ]; then
  die_conflict "--continue and --conversation are mutually exclusive; pass only one of them"
fi

# yolo is auto-approval of every tool inside the child. It requires both host
# consent and the terminal sandbox, so a single model-chosen flag can never
# grant it on its own (same gate as src/agy-runner.ts + resolvePolicy).
if [ "$YOLO" -eq 1 ]; then
  if [ "$SANDBOX" -eq 0 ] || [ "${AGY_ALLOW_YOLO:-}" != "1" ]; then
    die "--yolo requires --sandbox AND host consent: export AGY_ALLOW_YOLO=1 in the environment and pass --sandbox alongside --yolo"
  fi
fi

# --conversation must match the plugin's conversation-ID shape before it can
# reach the child's argv.
if [ -n "$CONV_ID" ]; then
  validate_conversation_id "$CONV_ID"
fi

# Uniform default timeout: 15m for every tier.
# An explicit --timeout is validated/normalized exactly like the plugin.
if [ "$EXPLICIT_TIMEOUT" -eq 1 ]; then
  TIMEOUT="$(normalize_timeout "$TIMEOUT_IN")"
else
  TIMEOUT="15m"
fi

# --dir containment: resolve with realpath; must equal or sit under the
# workspace root (AGY_WORKSPACE_ROOT when set, else $PWD).
if [ -n "$DIR" ]; then
  [ -d "$DIR" ] || die "DIR_NOT_ALLOWED: '$DIR' does not exist"
  RESOLVED_DIR="$(realpath "$DIR" 2>/dev/null)" || die "DIR_NOT_ALLOWED: cannot resolve '$DIR'"
  if [ -n "${AGY_WORKSPACE_ROOT:-}" ]; then
    ROOT="$(realpath "$AGY_WORKSPACE_ROOT" 2>/dev/null)" || die "DIR_NOT_ALLOWED: AGY_WORKSPACE_ROOT '${AGY_WORKSPACE_ROOT}' does not resolve"
  else
    ROOT="$(pwd -P)"
  fi
  case "$RESOLVED_DIR" in
    "$ROOT"|"$ROOT"/*) ;;
    *) die "DIR_NOT_ALLOWED: '$DIR' resolves to '$RESOLVED_DIR', outside workspace root '$ROOT'" ;;
  esac
fi

# Always validate tier via model_for_tier (unknown tier dies). Keep explicit --model if set.
TIER_MODEL="$(model_for_tier "$TIER")"
if [ -z "$MODEL" ]; then
  MODEL="$TIER_MODEL"
fi

ARGS=(--model "$MODEL" --print-timeout "$TIMEOUT")
[ -n "$RESOLVED_DIR" ] && ARGS+=(--add-dir "$RESOLVED_DIR")
[ -n "$PROJECT" ] && ARGS+=(--project "$PROJECT")
[ "$YOLO" -eq 1 ] && ARGS+=(--dangerously-skip-permissions)
[ "$SANDBOX" -eq 1 ] && ARGS+=(--sandbox)
[ "$CONTINUE" -eq 1 ] && ARGS+=(--continue)
[ -n "$CONV_ID" ] && ARGS+=(--conversation "$CONV_ID")

RUNDIR="$(mktemp -d "${TMPDIR:-/tmp}/agy-delegate.XXXXXX")"
chmod 700 "$RUNDIR"
ARGS+=(--log-file "$RUNDIR/agy.log")

# Single trap removes the per-run temp dir on any way out.
trap 'rm -rf "$RUNDIR"' EXIT INT TERM

set +e
agy "${ARGS[@]}" -p "$PROMPT" < /dev/null > "$RUNDIR/out.raw" 2> "$RUNDIR/err.raw"
RC=$?
set -e

if [ "$RC" -ne 0 ]; then
  echo "agy-delegate: agy exited $RC" >&2
  if [ -s "$RUNDIR/err.raw" ]; then
    # Surface at most 2KB of child stderr (parity with MAX_STDERR_BYTES),
    # with a marker when cut; redaction still applies to what is shown.
    head -c 2000 "$RUNDIR/err.raw" > "$RUNDIR/err.cap"
    ERR_BYTES="$(wc -c < "$RUNDIR/err.raw" | tr -d '[:space:]')"
    if [ "${ERR_BYTES:-0}" -gt 2000 ]; then
      printf '\n[agy-delegate: stderr truncated at 2KB]\n' >> "$RUNDIR/err.cap"
    fi
    redact "$RUNDIR/err.cap" >&2
  fi
  exit "$RC"
fi

# Cap captured stdout at 100KB, appending a truncation marker when cut.
head -c 102400 "$RUNDIR/out.raw" > "$RUNDIR/out.cap"
RAW_BYTES="$(wc -c < "$RUNDIR/out.raw" | tr -d '[:space:]')"
if [ "${RAW_BYTES:-0}" -gt 102400 ]; then
  printf '\n[agy-delegate: output truncated at 100KB]\n' >> "$RUNDIR/out.cap"
fi

if [ -z "$(tr -d '[:space:]' < "$RUNDIR/out.cap")" ]; then
  echo "agy-delegate: empty output" >&2
  exit 3
fi

redact "$RUNDIR/out.cap"
