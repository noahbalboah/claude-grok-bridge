#!/bin/sh
# grok-task.sh <repo> <name> <brief.md> [max-turns] [model]
# Hand one bounded task to Grok Build headless and leave everything an orchestrator needs to check it:
#   - makes <repo>/.worktrees/grok-<name> on a fresh branch grok/<name> from $GROK_BASE, else the remote's default
#     branch (origin/HEAD), else origin/main
#   - runs `grok -p` there: workspace sandbox (writes only to that worktree, /tmp and ~/.grok), no approval prompts
#     (a headless run cannot answer them), deny rules against publishing or reaching other machines, NDJSON events,
#     no commits
#   - writes ~/.local/state/grok-tasks/<name>/{brief.md,meta,pid,events.ndjson,stderr.log,exit,diffstat}; `exit` is
#     the completion sentinel
# Efficiency: one task per fresh run (never a long --continue chain), tight briefs, low max-turns.
set -u
repo=$1; name=$2; brief=$3; turns=${4:-60}; model=${5:-${GROK_MODEL:-grok-4.7}}
state="$HOME/.local/state/grok-tasks/$name"
wt="$repo/.worktrees/grok-$name"
mkdir -p "$state"
rm -f "$state/exit" "$state/diffstat"
cp "$brief" "$state/brief.md"
printf 'repo=%s\nworktree=%s\nmodel=%s\nmax_turns=%s\nstarted=%s\n' "$repo" "$wt" "$model" "$turns" "$(date -u +%FT%TZ)" >"$state/meta"
echo $$ >"$state/pid"
git -C "$repo" fetch -q origin
base=${GROK_BASE:-$(git -C "$repo" symbolic-ref -q --short refs/remotes/origin/HEAD)}
[ -n "$base" ] || base=origin/main
[ -d "$wt" ] || git -C "$repo" worktree add -q "$wt" -b "grok/$name" "$base" || { echo 1 >"$state/exit"; exit 1; }
rules="Work only inside $wt. Do not commit, push, open PRs, or touch other worktrees. Never read .env files, tokens or credentials. Never deploy or restart anything. When done, end with a short summary: files changed, checks run and their results, anything left undone."
grok -p "$(cat "$brief")" -m "$model" --cwd "$wt" --sandbox workspace --permission-mode bypassPermissions \
  --deny 'Bash(git commit*)' --deny 'Bash(git push*)' --deny 'Bash(git reset*)' --deny 'Bash(git checkout*)' \
  --deny 'Bash(gh *)' --deny 'Bash(ssh *)' --deny 'Bash(scp *)' --deny 'Bash(rsync *)' --deny 'Bash(curl *)' \
  --deny 'Bash(rm -rf*)' --deny 'Bash(*deploy*)' --deny 'Bash(doppler *)' --deny 'Read(**/.env*)' \
  --rules "$rules" --max-turns "$turns" --no-subagents --output-format streaming-json \
  >"$state/events.ndjson" 2>"$state/stderr.log" </dev/null
echo $? >"$state/exit"
git -C "$wt" status --short >"$state/diffstat"
git -C "$wt" diff --stat >>"$state/diffstat"
echo "grok task $name exit $(cat "$state/exit"); state $state"
