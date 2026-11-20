# Review results

Read what a run changed. Vlyn does not update your branch.

## In the session

When a run stops, the review prompt is `diff N | files N | discard | back`.

| Command | What you get |
| --- | --- |
| `diff 1` | The tracked unified diff of task 1 against the run's base commit. A new untracked file is not in this diff |
| `files 1` | Paths that task changed, then the worktree path |
| `discard` | Deletes that run's worktrees and journal rows |
| `back` | Returns to the main prompt and leaves the run in place |

A task line says `completed`, `unverified`, or `failed`. `completed` means the last check passed after the last edit and the edits stayed inside the owned files. `unverified` means the check was skipped, went stale, failed to prove the claim, or the task wrote a file it does not own. Treat `unverified` as not done.

## The combined tree

If more than one task is `completed`, the run also fills an `_integration` worktree and runs the distinct check commands there. One completed task does not create that tree. Conflicts are listed in the run output. Your checkout is still the commit you started from.

`files N` prints the task worktree. `_integration` is the sibling of those task directories. The parent is `~/.vlyn/runs/<full id>/`, or under `VLYN_HOME` / `--home`. `vlyn runs --json` prints that directory on the run object.

Inspect the integration tree with Git from that directory (`git status`, `git diff`). Do not assume the check there passed because each task passed alone. Read the convergence lines. The passing line is `Integration: all results combine cleanly and checks pass`.

## Apply it yourself

There is no apply command on this branch. To keep a result:

1. Read `diff N` and the integration diff.
2. Copy the hunks you want onto your branch with `git apply`, or cherry-pick commits you create from the integration worktree.
3. Run your own checks on your branch.

`vlyn apply`, which would create a branch from the integration result without moving `HEAD`, is planned. Until that command exists, the copy step is yours.

`vlyn code` is different: it edits the directory you pass it, in place. Do not use it when you wanted an isolated worktree.
