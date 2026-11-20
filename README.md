# Vlyn

**A coding agent harness where you state a goal and the work splits itself.**

Vlyn plans independent tasks from your goal, gives each its own Git worktree and its own dependency graph, runs them in parallel, and records every step in a journal that survives crashes. No task files, no framework, no runtime dependencies: just Node.js.

```text
$ vlyn
Vlyn — describe a goal, review the plan, let agents work in parallel.
[n]ew goal · [r]esume · [l]ist runs · [d]octor · [q]uit > n
What should Vlyn do? Make error messages consistent across the API and docs
Verification command [npm test]:
Plan for: Make error messages consistent across the API and docs
  1. api-errors — Standardize error messages in src/api
  2. docs-errors — Update the examples in docs/ to match
plan> [go | edit N | drop N | add | replan | cancel] go
```

## Why Vlyn

| | |
| --- | --- |
| **Goals, not task lists** | `vlyn auto --goal "…"` asks the model to split the goal into independent tasks, using your file list and import graph, and warns when two tasks would touch the same file. |
| **Durable execution** | Runs live in a SQLite journal (`~/.vlyn`). Close the terminal, lose power, or press Ctrl+C: `vlyn resume` keeps finished tasks and restarts only the interrupted one from a clean base. |
| **Interactive TUI** | `vlyn` opens a session: describe a goal, edit the plan, watch a live board, review diffs per task. No dependencies; works over SSH. |
| **Task graphs** | Every agent sees a small graph of what it read, edited and checked, plus the static import graph around it. Agents can ask which files and tests a change affects. |
| **Isolation** | One detached worktree per task at the same commit. Your checkout is never touched. |
| **Honest verdicts** | A task is `completed` only if its last check passed after its last edit. Otherwise it is `unverified` or `failed`. |

## Quick start

Needs Node.js 24.12 or newer and Git. A model needs `OPENAI_API_KEY` and a model name that supports Chat Completions JSON mode.

```sh
export OPENAI_API_KEY=…
export VLYN_MODEL=your-model
cd your-project            # a clean Git repository root

vlyn doctor                # check Node, Git, key and tree state
vlyn                       # interactive session
vlyn auto --goal "Add input validation to the CLI" --check "npm test"
vlyn auto --goal "…" --plan-only     # see the generated tasks first
vlyn runs                  # list runs
vlyn resume                # continue the latest unfinished run
```

From a clone, use `node src/cli.ts` in place of `vlyn`, or `npm link` to install the command.

Repository content, including files agents read, is sent to the configured model provider.

## Durable execution

Every state change is committed before work continues: the plan, each task's status, its result, and a timeline of events. Worktrees live in the journal folder, not in a temporary directory.

- **Resume**: `vlyn resume [id]` runs only pending tasks. A task found mid-flight is reset to the run's base revision, with partial edits and untracked files removed, and retried.
- **Single owner**: a run records the process executing it; a second executor is refused while that process is alive.
- **Ctrl+C**: stops claiming new tasks, lets running ones finish and record, and prints the resume command.
- **Where**: `~/.vlyn`, or `VLYN_HOME` / `--home`. The journal is outside your repository, so it never dirties your tree.
- **Cleanup**: `discard` in the review prompt removes a run's worktrees and journal entries.

## Interactive session

| Prompt | Commands |
| --- | --- |
| main | `n` new goal, `r [id]` resume, `l` list runs, `d` doctor, `q` quit |
| plan | `go`, `edit N`, `drop N`, `add`, `replan`, `cancel` |
| review | `diff N`, `files N`, `discard`, `back` |

The board redraws in place on a terminal and prints plain lines when piped.

## Project tools (no model needed)

```sh
vlyn graph .                         # files, imports, cycles, unresolved imports, unreferenced files
vlyn graph . --format mermaid        # or dot, json
vlyn impact . --file src/api.ts      # what imports it, and which tests to run first
vlyn impact . --since main           # same, for everything changed since a revision
vlyn doctor .
```

The graph reads static relative imports in JavaScript and TypeScript (`import`, multi-line imports, `export … from`, `import()`, `require`), maps `.js` specifiers to `.ts` files, and ignores `node_modules`, build output and symbolic links. Dynamic loading and package imports are invisible, so treat results as a lower bound. `graph` exits `2` when it finds an import cycle, which makes it usable in CI.

## Lower-level commands

```sh
vlyn code . --task "Fix the failing test" --check "npm test"      # one agent, working in place
vlyn batch . --tasks tasks.json --model NAME --workers 3          # hand-written task file
```

The agent loads a root `AGENTS.md`, lists and reads files, creates files, applies exact single-match replacements, runs only the check you supplied, and can ask for its task graph or the impact of a file. Files over 200 KB and binary files are refused. A check goes stale when the agent edits afterward; `code` exits `0` only when the final check passed and is current.

## Contract rehearsal

Vlyn's first capability checks proposed JSON responses against consumer contracts recorded in a deployment snapshot, so a rename that breaks a deployed consumer is found before rollout.

```sh
vlyn run examples/payments        # exit 2: export-v1 still reads the removed customer_id
vlyn status examples/payments --json
```

`plan`, `run` and `status` take `--workers N`, `--db PATH` and `--json`; `run` exits `0` for complete passing coverage, `2` for a failing check, `3` for incomplete verification and `1` for input errors. Workspace format: `provider/base.json` and `provider/candidate.json` response captures, `deployment.json` listing environment, inventory (`complete` or `partial`) and deployed service revisions, and `contracts/*.json` with required field `expects`. `run --model NAME` lets the model order checks; the runtime still verifies every one. Live infrastructure discovery is not built yet.

## Architecture

| Module | Role |
| --- | --- |
| `src/coding-agent.ts` | Model loop with scoped tools and a per-task graph |
| `src/planner.ts` | Goal → validated, independent tasks |
| `src/durable.ts` | SQLite journal, run creation, recovery, resumable executor |
| `src/parallel.ts` | One task in one worktree; the batch runner |
| `src/graph.ts`, `src/tools.ts` | Import graph, impact, cycles, doctor |
| `src/tui.ts` | Dependency-free interactive session |
| `src/scheduler.ts`, `src/state.ts` | Contract rehearsal workers and event log |

## Limitations

- Model access is OpenAI Chat Completions only. Other providers are not wired in.
- Tasks are independent by design; Vlyn does not merge worktrees for you. Review with `diff N` or Git and apply what you want.
- The planner can only warn about overlapping files; it cannot guarantee independence.
- Dependency discovery covers JavaScript and TypeScript relative imports.
- Cross-repository reasoning is planned, not built.

## Development

```sh
npm ci --ignore-scripts
npm run check
npm test
```

CI runs both on Linux (Node 24.12 and 26), macOS and Windows. Tests use scripted model replies and temporary Git repositories; see [CONTRIBUTING.md](CONTRIBUTING.md).
