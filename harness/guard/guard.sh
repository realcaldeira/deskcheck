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
    sub=""; skip=0; cfg=0
    for a in "$@"; do
      if [ "$cfg" = 1 ]; then cfg=0; block "$@"; fi
      if [ "$skip" = 1 ]; then skip=0; continue; fi
      case "$a" in
        -c|--config-env|--exec-path) cfg=1 ;;
        -c*|--config-env=*|--exec-path=*) block "$@" ;;
        -C|--git-dir|--work-tree|--namespace|--super-prefix) skip=1 ;;
        -*) ;;
        *) sub="$a"; break ;;
      esac
    done
    case "$sub" in
      commit|push|merge|rebase|reset|cherry-pick|revert|am|tag|filter-branch|replace|notes|apply|stash|clean|restore|switch|add|rm|mv|update-ref|symbolic-ref|commit-tree|send-pack|gc|prune) block "$@" ;;
      remote)
        case "$args" in *" remote "|*" remote -v "*|*" remote show "*|*" remote get-url "*) ;; *) block "$@" ;; esac ;;
      config)
        case "$args" in *" --get "*|*" --get-all "*|*" --get-regexp "*|*" --list "*|*" -l "*) ;; *) block "$@" ;; esac ;;
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
