# Run a goal and review the plan

Turn one sentence into a spec and a task list, change that list, then start the run.

## Interactive session

From a clean Git root:

```sh
vlyn
```

The main prompt is `[n]ew goal · [r]esume · [l]ist runs · [m]odels · [d]octor · [q]uit`.

1. Press `n`. Type the goal. Press Enter on the verification command to keep `npm test`, or type another command.
2. Read the numbered tasks. Each line is the task id and the instruction. Warnings are printed under the list. Owned files are not printed. The plan prompt is `go | edit N | drop N | add | replan | cancel`.
3. `edit 2` replaces that task's instruction. It does not change the files the task owns. `drop 2` removes the task. `add` appends an instruction you write, with the same check command and no owned-file list. `replan` asks the model again and discards the current list.
4. `go` starts the work. `cancel` returns to the main prompt and does not create a run.

The board redraws on a terminal and prints plain lines when stdout is not a TTY.

## From a script

```sh
vlyn auto --goal "Make error messages consistent across the API and docs" --check "npm test" --plan-only
vlyn auto --goal "Make error messages consistent across the API and docs" --check "npm test"
```

`--plan-only` is the review step for a script: it prints the plan and exits without a journal run. The script form cannot `edit` a task. Change the goal, or use the interactive session, when the plan is wrong.

## What you are agreeing to

- Each task owns the files the model named. Overlapping owners are merged into one task before anything runs.
- The agent in that task may change those files in a detached worktree. Your checkout is not the worktree.
- `--check` is the only command the agent is allowed to run. It runs as you.
- The planner also receives a short recall of earlier runs in this repository: failures first, at most five items, about 2 KB. That recall is journal rows, not a separate memory store.

## After `go`

Watch the status lines. Then use the review prompt. That is [Review results](review-results.md). If you stop the process, [Resume a run](resume-a-run.md).
