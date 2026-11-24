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
    sub=""; skip=0; rest=()
    for a in "$@"; do
      if [ -n "$sub" ]; then rest+=("$a"); continue; fi
      if [ "$skip" = 1 ]; then skip=0; continue; fi
      case "$a" in
        -c|--config-env|--exec-path|-c*|--config-env=*|--exec-path=*) block "$@" ;;
        -C|--git-dir|--work-tree|--namespace|--super-prefix) skip=1 ;;
        --version|--help|-h|-v) sub="version" ;;
        -*) ;;
        *) sub="$a" ;;
      esac
    done
    first="${rest[0]:-}"
    case "$sub" in
      ""|version|help|status|log|diff|show|rev-parse|rev-list|ls-files|ls-tree|ls-remote|cat-file|blame|grep|describe|merge-base|shortlog|name-rev|check-ignore|check-attr|whatchanged|fetch|clone|archive) ;;
      branch)
        for a in "${rest[@]:-}"; do
          case "$a" in ""|--list|-l|-a|--all|-r|--remotes|-v|-vv|--verbose|--show-current|--contains|--merged|--no-merged|--format=*|--sort=*) ;; -*) block "$@" ;; esac
        done
        case "$first" in ""|-*) ;; *) block "$@" ;; esac ;;
      remote)
        case "$first" in
          "") ;;
          -v|--verbose) [ "${#rest[@]}" -le 1 ] || block "$@" ;;
          show|get-url) ;;
          *) block "$@" ;;
        esac ;;
      config)
        case "$first" in --get|--get-all|--get-regexp|--list|-l) ;; *) block "$@" ;; esac ;;
      worktree|stash)
        [ "$first" = "list" ] || block "$@" ;;
      *) block "$@" ;;
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
