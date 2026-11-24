# Hard-task measurement: task set and commands

Status: **not run**. No key is configured, so nothing here has called a live model. This folder holds the task format, three example tasks and the exact commands. The decision rules are in [docs/VALIDATION.md](../../docs/VALIDATION.md).

## Example tasks

`tasks.example.json` has three tasks. Each fixture is a small Node project with a visible check (`node --test test/`) and a held-out test in `accept/` that the agent never sees (`vlyn judge` copies it in as `.vlyn-accept/` only after the predictions are written).

| Task | Type | Expected | Why it is hard |
| --- | --- | --- | --- |
| `rate-limiter` | feature | `completed` | The visible test checks only the happy path. The held-out test checks fractional refill, the capacity cap, a refused take removing nothing, a clock going backwards and bad settings. |
| `topo-sort` | feature | `completed` | The visible test is a single chain. The held-out test needs ascending tie-breaks, duplicate edges, self edges and a precisely named cycle. |
| `discount-conflict` | bugfix | `conflict` | The visible test expects rounding to the nearest cent, the goal says round down. The visible check cannot pass together with the goal. The right verdict is `conflict`, and the held-out test follows the goal. |

The expected success rate per task is an estimate, not a measurement: I expect current agents to get the visible test right almost always and the held-out edge cases right in roughly 30–70% of runs, because each held-out test asks for 4–7 separate details the goal states in one sentence. The pilot (23 Nov 2026) showed the opposite risk, tasks that were too easy (35 of 35 right), so the first real run should drop any task that all agents solve in all runs, and any that none solves.

## Choosing the other 17 or more tasks

- Aim for tasks on which an agent is expected to score 30–70%. Write the visible check so that it passes with a plausible, incomplete solution, and put the details that make the solution correct in the held-out test.
- Use your own repositories or real issues from public repositories. Public issues may be in a model's training data (contamination): prefer issues fixed after the models' cutoff, or your private repositories.
- For a repository task, use `repo` and `commit` instead of `fixture`, with the commit just before the fix. The held-out test is the test from the fix, copied into `acceptDir`.
- Keep three tasks with a contradicting visible test (`expected: "conflict"`).
- Each task must run in under 20 minutes and need no network after checkout.

## Commands

Nothing below has been run. Needs: the agents installed and signed in, and a key for each (see the PR for who provides them).

```sh
# 1. See the plan. Runs nothing, costs nothing.
vlyn judge --tasks experiments/2026-11-hard-tasks/tasks.example.json --agents claude,codex,pi --runs 3 --budget 25

# 2. Run it. --execute is required to spend anything. --budget is a counted-spend threshold in US dollars, not a provider spending cap.
vlyn judge --tasks experiments/2026-11-hard-tasks/tasks.example.json \
  --agents claude,codex,pi --runs 3 --budget 25 \
  --baseline "<verifier command that prints JSON>" --execute

# 3. Report, in the format of docs/VALIDATION.md.
vlyn report --out experiments/2026-11-hard-tasks/report.md
```

Notes:

- `--budget` is in US dollars (conservative against the €25 cap). A run that reports no cost (Codex, Pi) counts as 1 USD, as an accounting estimate. Pass the counted amount from earlier attempts with `--prior-spend USD`. The next run may exceed the threshold, and interrupted runs can have unknown costs; use provider-side limits for a real spending cap.
- Runs go repetition by repetition across all tasks and agents, so a budget stop leaves the coverage even.
- `--baseline` is optional and skipped when the command is not installed. It runs in the sandbox, and only a JSON verdict is read from its output.
- The rules need at least 20 "done" claims with an accept outcome. With fewer, the report says "not enough data" and applies no rule.
