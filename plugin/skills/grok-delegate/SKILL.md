---
name: grok-delegate
description: Hand a bounded coding, fix, survey or check task to Grok Build instead of a Claude agent, then review and land it. Use whenever delegating work, unless the task needs Claude (hard design or debugging, a security-sensitive change, or Grok failed twice).
---

# Delegate to Grok

Claude orchestrates and reviews; Grok does the bounded work. That saves Claude usage for the parts that need it.

1. **Brief.** Write a self-contained brief: the repo and area, the problem and evidence, what done looks like, the checks to run, and "end with a summary: files changed, checks run, anything left undone". The wrapper already adds the rules: stay in the worktree, no commits, pushes or PRs, never read .env files, no deploys.
2. **Start.** Use `grok_start` with `name` (a lowercase slug), `repo` (an absolute path to a git checkout with an `origin` remote) and `brief`. Optional: `max_turns` (default `$GROK_MAX_TURNS` or 150; leave it unset unless the task needs a tighter cap) and `model` (default `$GROK_MODEL` or grok-4.7).
3. **Watch.** `grok_list` and `grok_status` give the state, idle time and Grok's last words; the **Grok** pane (`/grok-board`) shows the same live, and a click on a task opens its brief, changes and transcript. Don't poll or wait on the exit file: when the run stops, the plugin sends this session a message with why it stopped (turn limit, exit code, or a diff to review), Grok's last words and the diffstat. Review it then.
4. **Review.** `grok_diff` shows what actually changed. Judge the diff, not Grok's summary, and run the checks yourself in `<repo>/.worktrees/grok-<name>`.
5. **Land.** Commit the way the repo expects, push the `grok/<name>` branch and open the PR as usual. If the diff is wrong, do one small follow-up run with a corrective brief; otherwise take the work to Claude.
6. **Close it out.** Once a PR is open the task shows as *PR open*, and once it merges as *Shipped*, by itself. If you reject the work, or land it without a PR, use `grok_archive` so it leaves *Needs review*.
7. **Efficiency.** One task per run, never a long resume chain. Stop runaway tasks with `grok_stop`. Remove the worktree (`git worktree remove`) after the PR merges.
