#!/usr/bin/env bash
set -u
tool="$(basename "$0")"
here="$(cd "$(dirname "$0")" && pwd)"

real() {
  local IFS=: dir
  for dir in $PATH; do
    [ "$dir" = "$here" ] && continue
    [ -x "$dir/$tool" ] && { echo "$dir/$tool"; return; }
  done
}

block() {
  echo "esteira: bloqueado ($tool $*). O desk check só lê: nada de commit, push, PR, comentário ou gravação no Azure." >&2
  exit 87
}

args=" $* "
case "$tool" in
  git)
    sub=""; skip=0
    for a in "$@"; do
      if [ "$skip" = 1 ]; then skip=0; continue; fi
      case "$a" in
        -C|-c|--git-dir|--work-tree|--namespace|--exec-path|--super-prefix|--config-env) skip=1 ;;
        -*) ;;
        *) sub="$a"; break ;;
      esac
    done
    case "$sub" in
      commit|push|merge|rebase|reset|cherry-pick|revert|am|tag|filter-branch|replace|notes) block "$@" ;;
    esac ;;
  gh)
    case "$args" in
      *" api "*|*" pr create"*|*" pr edit"*|*" pr comment"*|*" pr review"*|*" pr merge"*|*" pr close"*|*" pr ready"*|*" pr reopen"*|\
      *" issue create"*|*" issue edit"*|*" issue comment"*|*" issue close"*|*" release "*|*" repo create"*|*" repo delete"*|*" repo edit"*|\
      *" workflow run"*|*" run rerun"*|*" secret "*|*" variable "*|*" label create"*|*" gist "*) block "$@" ;;
    esac ;;
  az)
    case "$args" in
      *" create"*|*" update"*|*" delete"*|*" add "*|*" remove"*|*" invoke"*|*" rest "*|*" relation "*|*" set "*|*" import"*) block "$@" ;;
    esac ;;
esac

bin="$(real)"
[ -n "$bin" ] || { echo "esteira: $tool não encontrado no PATH" >&2; exit 127; }
exec "$bin" "$@"
