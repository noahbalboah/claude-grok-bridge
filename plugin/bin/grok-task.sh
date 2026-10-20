#!/bin/sh
# grok-task.sh <repo> <name> <brief.md> [max-turns] [model]
# Hand one bounded task to Grok Build headless and leave everything an orchestrator needs to check it:
#   - makes <repo>/.worktrees/grok-<name> on a fresh branch grok/<name> from $GROK_BASE, else the remote's default
#     branch (origin/HEAD), else origin/main
#   - runs `grok -p` there: a per-task sandbox profile `grok-task-<name>` (the workspace profile, which writes only to
#     that worktree, /tmp and ~/.grok, plus the worktree's own git admin dir <repo>/.git/worktrees/<id>, so git can
#     update the index and HEAD; the shared .git stays read-only), no approval prompts (a headless run cannot answer
#     them), deny rules against publishing or reaching other machines, NDJSON events, no commits
#   - repairs the worktree's .git link afterwards if the run pointed it anywhere else
#   - writes ~/.local/state/grok-tasks/<name>/{brief.md,meta,pid,events.ndjson,stderr.log,exit,diffstat}; `exit` is
#     the completion sentinel
# Efficiency: one task per fresh run (never a long --continue chain), tight briefs, low max-turns.
set -u
repo=$1; name=$2; brief=$3; turns=${4:-${GROK_MAX_TURNS:-150}}; model=${5:-${GROK_MODEL:-grok-4.7}}
state="$HOME/.local/state/grok-tasks/$name"
wt="$repo/.worktrees/grok-$name"
mkdir -p "$state"
# The Claude session that started the task reviews it; a follow-up keeps the first owner.
owner=${GROK_OWNER:-${CLAUDE_CODE_SESSION_ID:-}}
[ -n "$owner" ] || owner=$(sed -n 's/^owner=//p' "$state/meta" 2>/dev/null)
rm -f "$state/exit" "$state/diffstat"
cp "$brief" "$state/brief.md"
printf 'repo=%s\nworktree=%s\nmodel=%s\nmax_turns=%s\nstarted=%s\nowner=%s\n' "$repo" "$wt" "$model" "$turns" "$(date -u +%FT%TZ)" "$owner" >"$state/meta"
echo $$ >"$state/pid"
git -C "$repo" fetch -q origin
base=${GROK_BASE:-$(git -C "$repo" symbolic-ref -q --short refs/remotes/origin/HEAD)}
[ -n "$base" ] || base=origin/main
[ -d "$wt" ] || git -C "$repo" worktree add -q "$wt" -b "grok/$name" "$base" || { echo 1 >"$state/exit"; exit 1; }

# The worktree's .git file must point at its admin dir in the repo; a run that rewrote it (an earlier version could not
# write that dir and pointed .git at a copy in /tmp) is put back with git's own repair before and after each run.
relink() {
  git -C "$repo" worktree repair "$wt" >/dev/null 2>&1
  now=$(git -C "$wt" rev-parse --absolute-git-dir 2>/dev/null)
  [ "$now" = "$admin" ] || echo "worktree .git does not point at $admin (now: ${now:-unreadable})" >>"$state/stderr.log"
}
common=$(git -C "$repo" rev-parse --path-format=absolute --git-common-dir)
git -C "$repo" worktree repair "$wt" >/dev/null 2>&1
admin=$(git -C "$wt" rev-parse --absolute-git-dir 2>/dev/null)
case $admin in
  "$common"/worktrees/*) ;;
  *) echo "no git admin dir for $wt (got: ${admin:-nothing})" >"$state/stderr.log"; echo 1 >"$state/exit"; exit 1 ;;
esac
case $admin in *"'"*) echo "admin dir path has a quote: $admin" >"$state/stderr.log"; echo 1 >"$state/exit"; exit 1 ;; esac

# Per-task sandbox profile in Grok's sandbox.toml: the workspace profile plus this worktree's admin dir. Profiles take
# literal paths only, so each task adds its own block (under a lock, other tasks edit the same file) and removes it
# when the run ends. Grok reads the profile once at start.
sbx="${GROK_HOME:-$HOME/.grok}/sandbox.toml"
profile="grok-task-$name"
edit_profile() {
  n=0
  until mkdir "$sbx.grok-bridge.lock" 2>/dev/null; do
    # A lock older than 30 s was left by a killed run: edits take milliseconds.
    n=$((n + 1)); [ "$n" -gt 30 ] && rmdir "$sbx.grok-bridge.lock" 2>/dev/null
    sleep 1
  done
  touch "$sbx"
  awk -v b="# grok-bridge $profile begin" -v e="# grok-bridge $profile end" \
    '$0 == b {skip = 1} !skip {print} $0 == e {skip = 0}' "$sbx" >"$sbx.grok-bridge.tmp"
  [ "$1" = add ] && printf '%s\n[profiles.%s]\nextends = "workspace"\nread_write = [%s]\n%s\n' \
    "# grok-bridge $profile begin" "$profile" "'$admin'" "# grok-bridge $profile end" >>"$sbx.grok-bridge.tmp"
  mv "$sbx.grok-bridge.tmp" "$sbx"
  rmdir "$sbx.grok-bridge.lock"
}
trap 'edit_profile remove; relink' EXIT
trap 'exit 143' TERM INT HUP
edit_profile add

rules="Work only inside $wt. Do not commit, push, open PRs, or touch other worktrees. Never edit or replace the worktree's .git file or copy its git dir elsewhere: its admin dir $admin is writable, and the branch and base are set for you; if git refuses something or the base looks wrong, stop and say so. Never read .env files, tokens or credentials. Never deploy or restart anything. When done, end with a short summary: files changed, checks run and their results, anything left undone."
grok -p "$(cat "$brief")" -m "$model" --cwd "$wt" --sandbox "$profile" --permission-mode bypassPermissions \
  --deny 'Bash(git commit*)' --deny 'Bash(git push*)' --deny 'Bash(git reset*)' --deny 'Bash(git checkout*)' \
  --deny 'Bash(git switch*)' --deny 'Bash(git rebase*)' \
  --deny 'Bash(gh *)' --deny 'Bash(ssh *)' --deny 'Bash(scp *)' --deny 'Bash(rsync *)' --deny 'Bash(curl *)' \
  --deny 'Bash(rm -rf*)' --deny 'Bash(*deploy*)' --deny 'Bash(doppler *)' --deny 'Read(**/.env*)' \
  --rules "$rules" --max-turns "$turns" --no-subagents --output-format streaming-json \
  >"$state/events.ndjson" 2>"$state/stderr.log" </dev/null &
gpid=$!
# Watchdog: a run that has written nothing for GROK_IDLE_LIMIT seconds (default 30 min) is hung, often right after its
# final summary; stop it so its result gets reviewed instead of waiting forever.
limit=${GROK_IDLE_LIMIT:-1800}
while kill -0 "$gpid" 2>/dev/null; do
  sleep 20
  mt=$(stat -f %m "$state/events.ndjson" 2>/dev/null || stat -c %Y "$state/events.ndjson" 2>/dev/null || date +%s)
  if [ $(( $(date +%s) - mt )) -gt "$limit" ]; then
    echo "watchdog: no output for over ${limit}s, stopped" >>"$state/stderr.log"
    kill "$gpid" 2>/dev/null
    sleep 5
    kill -9 "$gpid" 2>/dev/null
  fi
done
wait "$gpid"
code=$?
relink
echo "$code" >"$state/exit"
git -C "$wt" status --short >"$state/diffstat"
git -C "$wt" diff --stat >>"$state/diffstat"
echo "grok task $name exit $(cat "$state/exit"); state $state"
