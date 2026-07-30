#!/usr/bin/env bash
#
# agy-delegate.sh — standalone wrapper around the Antigravity CLI (`agy`).
# Matches the behavior of the opencode-agy plugin, with the same review and safety caveats.
# Supports versioned tiers: flash-3.5-hi, flash-3.5-lo, flash-3.5-med, pro-3.1-hi, pro-3.1-lo, flash-3.6-hi, flash-3.6-med (default), and flash-3.6-lo.
# Timeout defaults are 10m for flash-3.5-hi, flash-3.5-lo, flash-3.5-med, flash-3.6-hi, flash-3.6-med, and flash-3.6-lo; pro-3.1-hi and pro-3.1-lo use 15m.
#
# Usage examples:
#   ./scripts/agy-delegate.sh --project . "implement the feature"
#   ./scripts/agy-delegate.sh --tier pro-3.1-hi --dir . "review this diff"
#   echo "task" | ./scripts/agy-delegate.sh -
#
set -euo pipefail

TIER="flash-3.6-med"
TIMEOUT=""           # filled from --timeout or tier-aware default below
EXPLICIT_TIMEOUT=0   # tracks whether --timeout was explicitly supplied
DIR=""
PROJECT=""
YOLO=0
SANDBOX=0
CONTINUE=0
CONV_ID=""
MODEL=""
PROMPT=""

die() { echo "agy-delegate: $*" >&2; exit 1; }
need() { [ "$1" -ge 2 ] || die "option '$2' needs a value"; }

usage() {
  cat <<'EOF'
Usage: agy-delegate.sh [options] "prompt"
       echo "prompt" | agy-delegate.sh -

Options:
  -t, --tier <flash-3.5-hi|flash-3.5-lo|flash-3.5-med|pro-3.1-hi|pro-3.1-lo|flash-3.6-hi|flash-3.6-med|flash-3.6-lo>
                                      Tier (default: flash-3.6-med)
  -d, --dir <path>                  Add workspace dir
      --project <path>              Wrapper alias for agy's project selection; forwarded to upstream agy
      --timeout <dur>               e.g. 5m, 10m, 30m (default 10m for flash-3.5-hi, flash-3.5-lo, flash-3.5-med, flash-3.6-hi, flash-3.6-med, and flash-3.6-lo; 15m for pro-3.1-hi and pro-3.1-lo; hard cap 4h)
      --yolo                        --dangerously-skip-permissions; use only for deliberate reviewed branch or worktree work
      --sandbox                     Run with terminal restrictions; safer, but may block merge or filesystem-heavy work
  -c, --continue                    Resume most recent agy conversation
      --conversation <id>           Resume specific conversation
  -m, --model <exact>               Wrapper-only alias for exact model name, forwarded upstream
  -h, --help
EOF
  exit 0
}

model_for_tier() {
  case "$1" in
    flash-3.5-hi)     echo "Gemini 3.5 Flash (High)" ;;
    flash-3.5-lo)  echo "Gemini 3.5 Flash (Low)" ;;
    flash-3.5-med) echo "Gemini 3.5 Flash (Medium)" ;;
    pro-3.1-hi)       echo "Gemini 3.1 Pro (High)" ;;
    pro-3.1-lo)    echo "Gemini 3.1 Pro (Low)" ;;
    flash-3.6-hi)     echo "Gemini 3.6 Flash (High)" ;;
    flash-3.6-med) echo "Gemini 3.6 Flash (Medium)" ;;
    flash-3.6-lo)  echo "Gemini 3.6 Flash (Low)" ;;
    *) die "unknown tier '$1'" ;;
  esac
}

while [ $# -gt 0 ]; do
  case "$1" in
    -t|--tier)       need "$#" "$1"; TIER="$2"; shift 2 ;;
    -d|--dir)        need "$#" "$1"; DIR="$2"; shift 2 ;;
    --project)      need "$#" "$1"; PROJECT="$2"; shift 2 ;;
    --timeout)       need "$#" "$1"; TIMEOUT="$2"; EXPLICIT_TIMEOUT=1; shift 2 ;;
    --yolo)          YOLO=1; shift ;;
    --sandbox)       SANDBOX=1; shift ;;
    -c|--continue)   CONTINUE=1; shift ;;
    --conversation)  need "$#" "$1"; CONV_ID="$2"; shift 2 ;;
    -m|--model)      need "$#" "$1"; MODEL="$2"; shift 2 ;;
    -h|--help)       usage ;;
    -)               PROMPT="$(cat)"; shift ;;
    --)              shift; [ -n "${*:-}" ] && PROMPT="${*}"; break ;;
    -*)              die "unknown option $1" ;;
    *)               PROMPT="$*"; break ;;
  esac
done

[ -n "$PROMPT" ] || die "no prompt"
command -v agy >/dev/null 2>&1 || die "agy not found on PATH"

# Tier-aware default timeout: Pro family (pro-3.1-hi, pro-3.1-lo) → 15m; all Flash tiers → 10m.
# An explicit --timeout always wins over the tier default.
if [ "$EXPLICIT_TIMEOUT" -eq 0 ]; then
  case "$TIER" in
    pro-3.1-hi|pro-3.1-lo) TIMEOUT="15m" ;;
    *)                  TIMEOUT="10m" ;;
  esac
fi

if [ -z "$MODEL" ]; then
  MODEL="$(model_for_tier "$TIER")"
fi

ARGS=(--model "$MODEL" --print-timeout "$TIMEOUT")
[ -n "$DIR" ] && ARGS+=(--add-dir "$DIR")
[ -n "$PROJECT" ] && ARGS+=(--project "$PROJECT")
[ "$YOLO" -eq 1 ] && ARGS+=(--dangerously-skip-permissions)
[ "$SANDBOX" -eq 1 ] && ARGS+=(--sandbox)
[ "$CONTINUE" -eq 1 ] && ARGS+=(--continue)
[ -n "$CONV_ID" ] && ARGS+=(--conversation "$CONV_ID")

ERR="$(mktemp)"
trap 'rm -f "$ERR"' EXIT

set +e
OUT="$(agy "${ARGS[@]}" -p "$PROMPT" < /dev/null 2>"$ERR")"
RC=$?
set -e

if [ $RC -ne 0 ]; then
  echo "agy-delegate: agy exited $RC" >&2
  [ -s "$ERR" ] && cat "$ERR" >&2
  exit $RC
fi

if [ -z "${OUT//[$' \t\n\r']/}" ]; then
  echo "agy-delegate: empty output" >&2
  exit 3
fi

printf '%s\n' "$OUT"
