#!/bin/bash
# herdr の別ペインで対話コマンドを script 記録つきで起動し、人間の入力に任せる。
#   run-interactive.sh start [--prompt REGEX] [--log FILE] -- <command...>   → "PANE=<id> LOG=<file>" を出力
#   run-interactive.sh wait <pane> <log>                                      → 終了まで待ち、exit code と記録本文を出力
#   run-interactive.sh status <pane>                                          → running | done
#   run-interactive.sh log <file>                                             → ANSI/CR を除いた記録本文
set -euo pipefail

jq_py() { python3 -c "import sys,json; print($1)"; }

case "${1:-}" in
start)
  shift; prompt=""; log=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --prompt) prompt=$2; shift 2 ;;
      --log) log=$2; shift 2 ;;
      --) shift; break ;;
      *) break ;;
    esac
  done
  cmd="$*"
  log=${log:-$PWD/workdir/run-interactive-$(date +%Y%m%d-%H%M%S).log}
  mkdir -p "$(dirname "$log")"
  self=$(herdr pane current | jq_py 'json.load(sys.stdin)["result"]["pane"]["pane_id"]')
  pane=$(herdr pane split "$self" --direction right | jq_py 'json.load(sys.stdin)["result"]["pane"]["pane_id"]')
  q=$(printf %q "$cmd; echo RI_EXIT=\$?")   # ; や引用符を含んでも 1 つのコマンド列として渡し、終了マーカーを出す
  if [ "$(uname -s)" = Darwin ]; then wrapped="script -q $log bash -c $q"; else wrapped="script -q -c $q $log"; fi
  herdr pane run "$pane" "cd $PWD && $wrapped"
  if [ -n "$prompt" ]; then
    herdr pane wait-output "$pane" --regex "$prompt" --timeout 15000 >/dev/null \
      || { echo "prompt not seen; screen:" >&2; herdr pane read "$pane" --source visible --lines 20 >&2; }
  fi
  herdr pane focus --pane "$self" --direction right >/dev/null || true
  echo "PANE=$pane LOG=$log"
  ;;
wait)
  herdr pane wait-output "$2" --regex 'RI_EXIT=[0-9]+' --source recent-unwrapped >/dev/null
  code=$(herdr pane read "$2" --source recent-unwrapped --lines 200 | grep -o 'RI_EXIT=[0-9]*' | tail -1 | cut -d= -f2)
  sleep 0.5   # script がログを閉じるのを待つ
  echo "EXIT=$code"; echo "--- log ---"; bash "$0" log "$3" | sed '/^RI_EXIT=/d'
  ;;
status)
  herdr pane process-info --pane "$2" \
    | jq_py '"done" if all(p["name"] in ("zsh","bash","sh") for p in json.load(sys.stdin)["result"]["process_info"]["foreground_processes"]) else "running"'
  ;;
log)
  tr -d '\r' < "$2" | sed -E $'s/\x1b\\[[0-9;?]*[A-Za-z]|\x1b[=>]//g'
  ;;
*)
  sed -n '2,5p' "$0"; exit 2 ;;
esac
