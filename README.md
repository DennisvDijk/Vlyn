# Vlyn

[![CI](https://github.com/DennisvDijk/Vlyn/actions/workflows/ci.yml/badge.svg)](https://github.com/DennisvDijk/Vlyn/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D24.12-339933?logo=node.js&logoColor=white)](https://github.com/nodejs/release)
[![License](https://img.shields.io/badge/license-UNLICENSED-lightgrey)](package.json)

**A coding tool: one goal becomes parallel tasks, each checked, each in its own git worktree.**

The direction is a harness shaped by research on memory and judgment, with an actor whose brain is a journal snapshot and a lightweight sandbox around checks. Those three are **planned**. They are not in this tree yet. What runs today is the planner, the journal, and verdicts that follow the check.

No runtime dependencies. Node.js and Git.

## 60-second quickstart

```sh
# Node 24.12 or newer. From a clone, `node src/cli.ts` is the same command as `vlyn`.
npm ci --ignore-scripts
npm link

export VLYN_API_KEY=…          # or OPENAI_API_KEY, LITELLM_API_KEY, ANTHROPIC_API_KEY
cd your-project                # a clean Git repository root

vlyn doctor
vlyn auto --goal "Add input validation to the CLI" --check "npm test" --plan-only
vlyn auto --goal "Add input validation to the CLI" --check "npm test"
```

`doctor` checks Node, Git, the endpoint, and whether the tree is clean. `--plan-only` prints the tasks and stops. Without it, each task runs in a detached worktree. Your checkout is not modified.

Repository files the agent reads are sent to the model provider you configured.

Guides: [docs/README.md](docs/README.md).

## How it works

```mermaid
flowchart LR
  goal[Goal] --> plan[Spec and owned tasks]
  plan --> trees[One worktree per task]
  trees --> agents[Agents in parallel]
  agents --> journal[(SQLite journal)]
  agents --> integrate[_integration worktree]
  integrate --> verdict[Check on the combined diff]
```

1. The planner returns a short spec and up to eight tasks. Each task names the files it owns. Overlapping or dependent tasks are merged, so what remains can run at once.
2. Each task gets a detached worktree at the same commit. The agent may list, read, replace, and create files, and may run only the check you supplied.
3. Every state change is written to `~/.vlyn` before work continues. `vlyn resume` keeps finished tasks and resets an interrupted one to the base commit.
4. A task is `completed` only when the last check passed after the last edit, inside the owned files. Otherwise it is `unverified` or `failed`.
5. When more than one task completes, Vlyn copies those diffs onto a fresh `_integration` worktree and runs the checks there. Conflicts are reported. Your branch does not move.

## What you can do now

| You want to | Command | Guide |
| --- | --- | --- |
| Install and see a plan | `vlyn doctor`, then `vlyn auto --plan-only` | [Install and first run](docs/how-to/install-and-first-run.md) |
| Point at a model | `VLYN_API_KEY`, `VLYN_BASE_URL`, `vlyn models` | [Connect a model](docs/how-to/connect-a-model.md) |
| Run a goal | `vlyn` or `vlyn auto --goal … --check …` | [Run a goal](docs/how-to/run-a-goal.md) |
| Continue after a crash | `vlyn resume` | [Resume a run](docs/how-to/resume-a-run.md) |
| Read the diff | review prompt: `diff N` | [Review results](docs/how-to/review-results.md) |
| See what a change touches | `vlyn graph`, `vlyn impact` | [Graph and impact in CI](docs/how-to/graph-and-impact-in-ci.md) |
| Check a JSON change against contracts | `vlyn run examples/payments` | [Contract rehearsal](docs/how-to/contract-rehearsal.md) |
| See why the environment is unhappy | `vlyn doctor` | [Troubleshoot](docs/how-to/troubleshoot-with-doctor.md) |

## Limitations

These are limits of the code on this branch, not a roadmap in disguise.

- Model access is OpenAI-compatible Chat Completions, plus Anthropic's native API. Gemini and Bedrock need a gateway such as LiteLLM in front.
- Tools are Vlyn's own JSON action protocol. Vendor-native tool calling is not implemented.
- The check command runs as your user. A sandbox that keeps the API key out of that process is planned, not built. Do not point a check at a secret you would not hand a shell script.
- Convergence builds an `_integration` worktree and stops. There is no `vlyn apply`. Copy or cherry-pick the result yourself. Your checkout stays where it was.
- File ownership is whatever the model declared. Overlap is merged. Semantic independence is not proved.
- The import graph is JavaScript and TypeScript relative imports only. Dynamic imports and package imports are invisible. The default text format and `--format json` exit 2 on a cycle. Mermaid and dot exit 0. Treat the graph as a lower bound.
- Memory is recall of earlier task rows in this repository, capped at five items and about 2 KB. Turning those rows into reviewed `AGENTS.md` lessons is planned.
- Actor snapshots, a decision journal, and `vlyn eval` are planned.
- Cross-repository reasoning is planned.
- Nothing here has been scored against a live model in CI. Tests use scripted replies.

## Development

```sh
npm ci --ignore-scripts
npm run lint
npm run check
npm test
```

CI lints and typechecks once, then tests on Linux, macOS, and Windows for Node 24 (Maintenance LTS) and Node 26 (Active LTS). See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).
