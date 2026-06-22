#!/usr/bin/env bash
#
# agy-delegate.sh — standalone robust wrapper around the Antigravity CLI (`agy`).
# Matches the behavior of the opencode-agy plugin.
#
# Usage examples:
#   ./scripts/agy-delegate.sh "implement the feature"
#   ./scripts/agy-delegate.sh --tier pro --dir . "review this diff"
#   ./scripts/agy-delegate.sh --continue "continue the previous task"
#   echo "task" | ./scripts/agy-delegate.sh -
#
set -euo pipefail

TIER="flash"
TIMEOUT="5m"
DIR=""
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
  -t, --tier <flash|flash-lo|pro>   Tier (default: flash)
  -d, --dir <path>                  Add workspace dir
      --timeout <dur>               e.g. 5m, 10m (default 5m)
      --yolo                        --dangerously-skip-permissions
      --sandbox                     Run with terminal restrictions
  -c, --continue                    Resume most recent agy conversation
      --conversation <id>           Resume specific conversation
  -m, --model <exact>               Exact model name (future-proof)
  -h, --help
EOF
  exit 0
}

model_for_tier() {
  case "$1" in
    flash)    echo "Gemini 3.5 Flash (High)" ;;
    flash-lo) echo "Gemini 3.5 Flash (Low)" ;;
    pro)      echo "Gemini 3.1 Pro (High)" ;;
    *) die "unknown tier '$1'" ;;
  esac
}

while [ $# -gt 0 ]; do
  case "$1" in
    -t|--tier)       need "$#" "$1"; TIER="$2"; shift 2 ;;
    -d|--dir)        need "$#" "$1"; DIR="$2"; shift 2 ;;
    --timeout)       need "$#" "$1"; TIMEOUT="$2"; shift 2 ;;
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

if [ -z "$MODEL" ]; then
  MODEL="$(model_for_tier "$TIER")"
fi

ARGS=(--model "$MODEL" --print-timeout "$TIMEOUT")
[ -n "$DIR" ] && ARGS+=(--add-dir "$DIR")
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
