# grok-bridge

A Claude Code plugin that hands bounded coding tasks to [Grok Build](https://x.ai) and lets Claude watch, review and stop them. Claude stays the orchestrator and reviewer; Grok does the work in its own git worktree.

- **MCP tools:** `grok_start`, `grok_list`, `grok_status`, `grok_diff`, `grok_stop`, `grok_archive`
- **Skill:** `grok-delegate`, the brief → run → review the diff → land workflow
- **Pane** (`/grok`): tasks grouped into **Running**, **Needs review**, **PR open** and **Shipped** (a task moves on by itself when its `grok/<name>` PR opens and merges; **Archive** hides any other finished task), each with a live icon (spinner, ⚠ needs a look, ✓ ready, ✕ failed, merged), elapsed time, lines changed (+/− with a bar), tokens, what it is doing right now, and its PR. Click a task for its details:
  - **Stop**, **Ask Claude to review** (sends Claude a review prompt), **Clean up worktree** after the PR merges;
  - **Follow up**: type a correction and Grok gets one more run on the same worktree;
  - brief, changed files, and a transcript whose tool calls fold into expandable groups.
  **+ New Grok task** opens a full form: brief (with a wrapped preview), repo picker, name (suggested from the brief), model and turn limit.
- **Band above the prompt:** each running or recent task with its icon, elapsed time and current step; click to open it. Plus a `Grok: N running` status-line entry and a toast when a task finishes or goes quiet.
- **CLI:** `python3 plugin/bin/grok-watch.py` for a terminal board (`--once`, `--json`, `--detail NAME`, `--start NAME REPO BRIEF`, `--followup NAME TEXT`, `--stop NAME`, `--cleanup NAME`)

## Hands-off review

When a run finishes, fails or stalls, the plugin hands it to Claude by itself: one open session claims it (a lock file per run, so two sessions never both act) and gets a review prompt. Claude then checks the diff, runs the checks, and opens the PR, sends one follow-up, or archives it. `GROK_AUTO_REVIEW=0` turns this off. Every finished card also has **Review** and **Archive** buttons, and so do the band's expanded rows, so nothing needs opening first. A run that writes nothing for `GROK_IDLE_LIMIT` seconds (default 1800) is stopped by a watchdog, so a hung run still reaches review.

## How a task runs

`grok_start` (or `plugin/bin/grok-task.sh <repo> <name> <brief.md> [max-turns] [model]`) does the following:

1. Creates `<repo>/.worktrees/grok-<name>` on a new branch `grok/<name>`, from `$GROK_BASE`, else the repo's `git config grok.base`, else the remote's default branch, else `origin/main`. A repo whose work lands on another branch than its default sets it once: `git -C <repo> config grok.base origin/integration`.
2. Runs `grok -p` there headless, with:
   - a per-task sandbox profile `grok-task-<name>` added to `~/.grok/sandbox.toml` for the run: the workspace profile (writes only to the worktree, `/tmp` and `~/.grok`) plus the worktree's own git admin dir `<repo>/.git/worktrees/<id>`, so git can update its index and HEAD while the shared `.git` stays read-only;
   - no approval prompts, since a headless run can't answer them;
   - deny rules for `git commit/push/reset/checkout/switch/rebase`, `gh`, `ssh`, `scp`, `rsync`, `curl`, `rm -rf`, anything named `deploy`, `doppler`, and reading `.env*`;
   - an appended rule to stay in the worktree and finish with a summary.
3. Puts the worktree's `.git` link back with `git worktree repair` if the run pointed it anywhere else (`--cleanup` does the same before it removes a worktree).
4. Streams Grok's events to `~/.local/state/grok-tasks/<name>/events.ndjson`, and writes `exit` and `diffstat` when the run ends.

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
| `GROK_BASE` | `git config grok.base`, else the remote default branch | ref the task worktree branches from |
| `GROK_AUTO_REVIEW` | `1` | `0` stops the automatic hand-off to Claude |
| `GROK_MAX_TURNS` | `150` | turn limit when none is given; a follow-up gets at least 150 |
| `GROK_IDLE_LIMIT` | `1800` | seconds without output before the watchdog stops a run |

## Safety notes

The deny list and the sandbox are guard rails, not a security boundary against a hostile model: a headless run executes commands without asking. Point it only at repos you'd let an agent edit, keep briefs bounded, and always review the diff before you commit. Task state, transcripts included, stays local in `~/.local/state/grok-tasks/`.

## License

MIT
