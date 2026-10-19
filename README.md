# grok-bridge

A Claude Code plugin that hands bounded coding tasks to [Grok Build](https://x.ai) and lets Claude watch, review and stop them. Claude stays the orchestrator and reviewer; Grok does the work in its own git worktree.

- **MCP tools:** `grok_start`, `grok_list`, `grok_status`, `grok_diff`, `grok_stop`
- **Skill:** `grok-delegate`, the brief → run → review the diff → land workflow
- **Pane:** a live **Grok** pane in the Claude desktop app (`/grok-board`) that lists every task (state, files changed, idle time, last words). Click a task to see its brief, model, token count, changed files and the full transcript: text, thinking and every tool call.
- **Status and toasts:** a `Grok: N running · X tokens today` status-line entry, and a toast when a task finishes. `/grok` opens the pane.
- **CLI board:** `python3 plugin/bin/grok-watch.py` for a terminal (`--once`, `--json`, `--detail <name>`)

## How a task runs

`grok_start` (or `plugin/bin/grok-task.sh <repo> <name> <brief.md> [max-turns] [model]`) does the following:

1. Creates `<repo>/.worktrees/grok-<name>` on a new branch `grok/<name>`, from `$GROK_BASE`, else the remote's default branch, else `origin/main`.
2. Runs `grok -p` there headless, with:
   - `--sandbox workspace`, so writes go only to the worktree, `/tmp` and `~/.grok`;
   - no approval prompts, since a headless run can't answer them;
   - deny rules for `git commit/push/reset/checkout`, `gh`, `ssh`, `scp`, `rsync`, `curl`, `rm -rf`, anything named `deploy`, `doppler`, and reading `.env*`;
   - an appended rule to stay in the worktree and finish with a summary.
3. Streams Grok's events to `~/.local/state/grok-tasks/<name>/events.ndjson`, and writes `exit` and `diffstat` when the run ends.

Grok never commits. You, or Claude, review `grok_diff`, run the checks, commit and open the PR.

## Requirements

- [Claude Code](https://claude.com/claude-code). The pane needs the desktop app; the tools and skill work anywhere.
- Grok Build CLI (`grok`) on your PATH, signed in (`grok login`).
- `python3` and `git`.
- macOS or Linux; the workspace sandbox uses the OS sandbox.

## Install

```bash
claude plugin marketplace add noahbalboah/claude-grok-bridge
```

```bash
claude plugin install grok-bridge@grok-bridge
```

Then restart Claude Code, or run `/reload-plugins`.

## Settings

| env | default | what |
|---|---|---|
| `GROK_MODEL` | `grok-4.7` | model for new tasks |
| `GROK_BASE` | remote default branch | ref the task worktree branches from |

## Safety notes

The deny list and the sandbox are guard rails, not a security boundary against a hostile model: a headless run executes commands without asking. Point it only at repos you'd let an agent edit, keep briefs bounded, and always review the diff before you commit. Task state, transcripts included, stays local in `~/.local/state/grok-tasks/`.

## License

MIT
