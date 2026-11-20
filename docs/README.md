# Vlyn documentation

Diátaxis split: how-to guides are tasks, reference is lookup, explanation is why. This tree has the how-to set and a command reference. The explanation note and the ADRs are not merged yet.

## How-to

| Task | Guide |
| --- | --- |
| Install, link the command, and stop before any edit | [Install and first run](how-to/install-and-first-run.md) |
| OpenAI-compatible endpoints, LiteLLM, Anthropic, Ollama | [Connect a model](how-to/connect-a-model.md) |
| State a goal, edit the plan, let it run | [Run a goal](how-to/run-a-goal.md) |
| Continue after Ctrl+C, a crash, or a closed terminal | [Resume a run](how-to/resume-a-run.md) |
| Read diffs and the integration worktree | [Review results](how-to/review-results.md) |
| Fail CI on an import cycle, or list tests to run | [Graph and impact in CI](how-to/graph-and-impact-in-ci.md) |
| Check a proposed JSON body against recorded contracts | [Contract rehearsal](how-to/contract-rehearsal.md) |
| Read `vlyn doctor` | [Troubleshoot](how-to/troubleshoot-with-doctor.md) |
| Change the code | [Contributing](how-to/contributing.md) |

## Reference

[Commands](reference/commands.md) lists what the binary accepts today. Module roles are in that page's table.

## Explanation

Planned. `docs/research/state-of-the-art.md` is the place for the research note: memory, judgment, and confinement as analogies for how a coding run plans, remembers, and trusts a check. That file is not in this branch. When it lands, it stays an explanation. It is not a how-to.

## Decisions

Planned. `docs/adr/` will hold architecture decision records. None are in this branch. Feature pull requests add their own ADR next to the code they change.

## Later how-tos

A feature pull request updates the guide for the command it adds. Do not describe that command here until the command is on the branch the guide ships with.
