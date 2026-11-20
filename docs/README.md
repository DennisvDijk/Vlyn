# Vlyn documentation

Diátaxis split: how-to guides are tasks, reference is lookup, explanation is why.

## How-to

| Task | Guide |
| --- | --- |
| Install, link the command, and stop before any edit | [Install and first run](how-to/install-and-first-run.md) |
| OpenAI-compatible endpoints, LiteLLM, Anthropic, Ollama | [Connect a model](how-to/connect-a-model.md) |
| Use native tool calls, with JSON as the fallback | [Native tools](how-to/native-tools.md) |
| State a goal, edit the plan, let it run | [Run a goal](how-to/run-a-goal.md) |
| Continue after Ctrl+C, a crash, or a closed terminal | [Resume a run](how-to/resume-a-run.md) |
| Read diffs and the integration worktree | [Review results](how-to/review-results.md) |
| Fail CI on an import cycle, or list tests to run | [Graph and impact in CI](how-to/graph-and-impact-in-ci.md) |
| Check a proposed JSON body against recorded contracts | [Contract rehearsal](how-to/contract-rehearsal.md) |
| Read `vlyn doctor` | [Troubleshoot](how-to/troubleshoot-with-doctor.md) |
| List actor snapshots in the journal | [Actor snapshots](how-to/actor-snapshots.md) |
| Review lesson claims and write the marked section of AGENTS.md | [Lessons](how-to/lessons.md) |
| Score the scripted eval | [Eval](how-to/eval.md) |
| Stop a risky plan, then apply the result to a new branch | [Pre-mortem and apply](how-to/premortem-and-apply.md) |
| Read the sandbox posture and the audit log | [Sandbox and audit](how-to/sandbox-and-audit.md) |
| Change the code | [Contributing](how-to/contributing.md) |

## Reference

[Commands](reference/commands.md) lists what the binary accepts today. Module roles are in that page's table.

## Explanation

[Research note](research/state-of-the-art.md). Memory, judgment, and confinement are analogies for how a coding run plans, remembers, and trusts a check. It is not a how-to.

## Decisions

- [0001 Actor brain snapshots](adr/0001-actor-brain-snapshots.md)
- [0002 Capability sandbox](adr/0002-capability-sandbox.md)

## Later how-tos

A feature pull request updates the guide for the command it adds. Do not describe that command here until the command is on the branch the guide ships with.
