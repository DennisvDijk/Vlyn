# Stop a risky plan, then apply the result

Review the pre-mortem before any edit, rebuild the combined tree, and put that result on a new branch without moving your checkout.

## See the plan without the pre-mortem

```sh
vlyn auto --goal "Make error messages consistent" --check "npm test" --plan-only
```

`--plan-only` prints the tasks and exits. It does not ask the second pass, and it does not create a run.

## Let the pre-mortem block edits

Drop `--plan-only`:

```sh
vlyn auto --goal "Make error messages consistent" --check "npm test"
```

After the plan, a second request reviews that plan as if it had already failed. A risk whose confidence is 0.7 or higher stops the command. The process prints the reason, then `No files were edited. Pass --proceed to continue.`, and exits 1. No worktree is created.

Continue anyway:

```sh
vlyn auto --goal "Make error messages consistent" --check "npm test" --proceed
```

In the interactive session the plan prompt includes `force`. `go` uses the same gate. `force` is the override. `edit`, `drop`, and `replan` are how you change the plan instead of overriding it.

## Rebuild the combined tree

When a run has finished:

```sh
vlyn converge
vlyn converge <id-prefix>
```

With no id, this uses the newest run in the journal. The command rebuilds `_integration`, runs the checks, and prints `integration passed` or `integration failed` with the applied and conflict counts. Exit 0 means the combined checks passed.

## Put it on a branch

```sh
vlyn apply --branch vlyn/error-messages
vlyn apply <id-prefix> --branch vlyn/error-messages
```

`--branch` is required. The name must be a simple ref: it starts with a letter or digit, stays within 81 characters, and must not contain `..`, end in `/`, or end in `.lock`. An existing branch is refused.

If integration has not been run, `apply` runs it. If integration did not pass, nothing is committed and the command exits 1 with `Integration did not pass. Nothing was applied.`

On success the command prints the branch name and the first eight characters of the commit. That commit is created in the integration worktree with signing turned off for this commit only. Your checkout's `HEAD` and current branch stay where they were. Inspect the new branch with `git log vlyn/error-messages` and check it out yourself when you want it.

The journal also stores a short after-action note from the task statuses and the integration result. There is no separate command to print that note.
