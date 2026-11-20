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
| **Goals, not task lists** | `vlyn auto --goal "…"` asks the model for a spec (non-goals, assumptions, acceptance criteria, risks) and independent tasks, each owning specific files. Tasks that overlap or depend on each other are merged, so what remains can run in parallel. |
| **Contracts, not hopes** | Each agent gets the spec and its file ownership. Edits outside owned files make a task `unverified`. When several tasks finish, Vlyn applies all results onto a fresh copy of the base and re-runs the checks there. |
| **Durable execution** | Runs live in a SQLite journal (`~/.vlyn`). Close the terminal, lose power, or press Ctrl+C: `vlyn resume` keeps finished tasks and restarts only the interrupted one from a clean base. |
| **Interactive TUI** | `vlyn` opens a session: describe a goal, edit the plan, watch a live board, review diffs per task. No dependencies; works over SSH. |
| **Task graphs** | Every agent sees a small graph of what it read, edited and checked, plus the static import graph around it. Agents can ask which files and tests a change affects. |
| **Isolation** | One detached worktree per task at the same commit. Your checkout is never touched. |
| **Honest verdicts** | A task is `completed` only if its last check passed after its last edit. Otherwise it is `unverified` or `failed`. |

## Quick start

Needs Node.js 24.12 or newer and Git, plus a key for any model system (see [Models and gateways](#models-and-gateways)).

```sh
export VLYN_API_KEY=…      # or OPENAI_API_KEY, LITELLM_API_KEY, ANTHROPIC_API_KEY
cd your-project            # a clean Git repository root

vlyn doctor                # check Node, Git, endpoint and tree state
vlyn models                # list the models your key can use
vlyn                       # interactive session
vlyn auto --goal "Add input validation to the CLI" --check "npm test"
vlyn auto --goal "…" --plan-only     # see the generated tasks first
vlyn runs                  # list runs
vlyn resume                # continue the latest unfinished run
```

From a clone, use `node src/cli.ts` in place of `vlyn`, or `npm link` to install the command.

Repository content, including files agents read, is sent to the configured model provider.

## Models and gateways

Vlyn works with any OpenAI-compatible endpoint (OpenAI, LiteLLM and other AI gateways, OpenRouter, vLLM, Ollama, LM Studio) and with Anthropic's native API.

| Setting | Meaning |
| --- | --- |
| `VLYN_API_KEY` | Your key. Falls back to `LITELLM_API_KEY`, `OPENAI_API_KEY`, then `ANTHROPIC_API_KEY`. |
| `VLYN_BASE_URL` / `--base-url` | Endpoint, e.g. `https://gateway.example.com/v1`. Must be https, except for localhost or with `VLYN_ALLOW_INSECURE=1`. Local servers need no key. |
| `VLYN_PROVIDER` | `anthropic` to force the native Anthropic API when both kinds of key are set. |
| `VLYN_MODEL` / `--model` | A model id, or `auto` (the default). |
| `VLYN_MODEL_REFRESH_SECONDS` | How often the TUI refreshes the model list in the background (default 600). |

**Models refresh themselves.** Vlyn reads the model list from your endpoint with your own key (`GET /models`, which LiteLLM, OpenRouter, Ollama and the others expose), caches it by a hash of endpoint and key, and refreshes it when stale. A failed refresh keeps the last known list. With `auto`, Vlyn chooses from the live list; if the chosen model is retired or rejected mid-run it refreshes, chooses again and retries once. Pin a model to opt out. The TUI announces added and removed models as they happen, and `vlyn models --refresh` fetches on demand. The choice among models in `auto` is a heuristic that prefers stronger families; pin a model when it matters.

Gateways that reject JSON mode are retried without it, and JSON is extracted from fenced or prefixed replies. Keys are never written to the cache or to error messages.

## Durable execution

Every state change is committed before work continues: the plan, each task's status, its result, and a timeline of events. Worktrees live in the journal folder, not in a temporary directory.

- **Resume**: `vlyn resume [id]` runs only pending tasks. A task found mid-flight is reset to the run's base revision, with partial edits and untracked files removed, and retried.
- **Single owner**: a run records the process executing it; a second executor is refused while that process is alive.
- **Ctrl+C**: stops claiming new tasks, lets running ones finish and record, and prints the resume command.
- **Where**: `~/.vlyn`, or `VLYN_HOME` / `--home`. The journal is outside your repository, so it never dirties your tree.
- **Cleanup**: `discard` in the review prompt removes a run's worktrees and journal entries.

## Specs, ownership and convergence

The planner writes a short spec before any code is touched, and each task declares the files it owns. Vlyn enforces that contract rather than trusting it:

- Tasks whose owned files overlap, or that depend on one another, are merged into one task.
- Every agent receives the spec, its own files and the files others own, and is told to report assumptions it could not confirm.
- A task that changes files it does not own is `unverified`, even if its check passed.
- **Convergence**: after a run, Vlyn applies every completed task's diff in a separate `_integration` worktree, reports conflicts, and runs the distinct check commands on the combined result. Your checkout is never changed. The result is stored in the journal.

## Memory

Before planning, Vlyn recalls what earlier runs in the same repository learned: which tasks failed, which edited files outside their ownership, which combined results did not integrate. It reads this straight from the journal, so nothing is copied and nothing goes stale, and each item names its run. Recall is ranked by shared goal words and files (failures first) and capped at five items and about 2 KB, so it informs the planner without flooding it. Planned next: turning recurring lessons into reviewed `AGENTS.md` suggestions and validated reusable procedures.

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
| `src/providers.ts` | Any OpenAI-compatible or Anthropic endpoint, live model catalog and refresh |
| `src/memory.ts` | Recall of earlier outcomes from the journal, ranked and size-capped |
| `src/planner.ts` | Goal → spec and validated, independent tasks with file ownership |
| `src/durable.ts` | SQLite journal, run creation, recovery, resumable executor, convergence |
| `src/parallel.ts` | One task in one worktree; the batch runner |
| `src/graph.ts`, `src/tools.ts` | Import graph, impact, cycles, doctor |
| `src/tui.ts` | Dependency-free interactive session |
| `src/scheduler.ts`, `src/state.ts` | Contract rehearsal workers and event log |

## Limitations

- Model access is OpenAI-compatible Chat Completions plus native Anthropic. Native Gemini and Bedrock need a gateway such as LiteLLM in front.
- Tool use is Vlyn's own JSON action protocol, not each vendor's native tool calling.
- Tasks are independent by design. Vlyn builds a combined `_integration` worktree and checks it, but does not change your checkout; review with `diff N` or Git and apply what you want.
- File ownership is declared by the model and checked after the fact; it cannot guarantee semantic independence.
- Dependency discovery covers JavaScript and TypeScript relative imports.
- Cross-repository reasoning is planned, not built.

## Development

```sh
npm ci --ignore-scripts
npm run lint
npm run check
npm test
```

CI lints and typechecks once, then tests on Linux, macOS, and Windows for Node 24 (Maintenance LTS) and Node 26 (Active LTS). Tests use scripted model replies and temporary Git repositories. See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).
