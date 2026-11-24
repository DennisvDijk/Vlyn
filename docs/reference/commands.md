# Commands

Lookup for the `vlyn` binary on this branch. Paths below assume the command is on `PATH`. From a clone without `npm link`, prefix with `node src/cli.ts`.

Flags common to several commands: `--json`, `--home PATH` (journal directory, else `VLYN_HOME`, else `~/.vlyn`), `--model NAME`, `--base-url URL`, `--workers N` (1–16).

## Judge

| Command | What it does |
| --- | --- |
| `vlyn judge [dir] --agent claude\|codex\|pi --goal TEXT --check CMD [--files A,B] [--protect A,B] [--timeout 20m] [--allow-noop] [--no-require-sandbox]` | Run an existing agent in a detached worktree and print a verdict. Exit 0 `completed`, 1 `failed`, 2 `unverified`, 3 refused, 4 internal error, 5 `conflict`. See [Judge](../how-to/judge.md). `--accept CMD` and `--accept-dir DIR` add the held-out check and the predictions. |
| `vlyn judge --tasks FILE [--agents A,B] [--runs N] [--budget USD] [--baseline CMD] [--baseline-dir DIR] [--execute]` | Measure many tasks. Prints the plan and runs nothing unless `--execute` is given. `--budget` is a counted-spend threshold in US dollars, not a provider spending cap; include earlier attempts with `--prior-spend`. |
| `vlyn report [--out FILE]` | Markdown report of measured runs: "done" accuracy with 95% interval, Brier and AUROC per predictor, `conflict` recognition, cost, and the decision rules applied. |
| `vlyn calibration [--json]` | Brier, ECE and AUROC per predictor (`self`, `process`) from judged runs that have an accept outcome. |

## Goal runs

| Command | What it does |
| --- | --- |
| `vlyn` or `vlyn tui [dir]` | Interactive session. Needs a TTY for the prompts. |
| `vlyn auto [dir] --goal TEXT [--check CMD] [--plan-only]` | Plan from a goal. `--plan-only` prints tasks and exits. Otherwise runs them. |
| `vlyn resume [id]` | Continue the named run, or the latest unfinished one. |
| `vlyn runs` | List journaled runs. Ids are printed as eight characters. `--json` includes the full id and the worktree directory. |
| `vlyn actors` | List journaled actors: id, role, state, version. Empty journal prints `No actors yet.` |
| `vlyn lessons [dir] [--apply]` | Print lesson claims. `--apply` rewrites only the `<!-- vlyn-lessons:start/end -->` block of `AGENTS.md`. |
| `vlyn eval` | Scripted suite. Exit 0 when pass rate and honesty rate are both 1. No model and no journal. |
| `vlyn converge [id]` | Rebuild `_integration` and re-run checks. No id uses the newest run. Exit 0 when integration passed. |
| `vlyn apply [id] --branch NAME` | Commit the integration result onto a new branch. Does not move HEAD. Refuses an existing branch and a failed integration. |
| `vlyn audit [id]` | Print the hash-chained capability log. Exit 2 if a row was edited. |

`auto` and `resume` exit 0 only when the run is finished and every task is `completed`.

## One task, or a file of tasks

| Command | What it does |
| --- | --- |
| `vlyn code [dir] --task TEXT [--check CMD]` | One agent, in the directory you name. This can edit that checkout. |
| `vlyn batch [dir] --tasks FILE [--workers N]` | Tasks from a JSON file. Requires a clean git root. Worktrees go under a temporary directory. |

`code` exits 0 only when the agent finished and, if you passed `--check`, the last check passed and no edit came after it.

Task file: an array of 1 to 32 objects. Fields are `id`, `task`, and optional `check` and `files`. Unknown fields are rejected.

## Repository tools

| Command | Exit |
| --- | --- |
| `vlyn graph [dir] [--format text\|json\|mermaid\|dot]` | 2 if text or json finds an import cycle. Mermaid and dot exit 0 |
| `vlyn impact [dir] (--file PATH)...` or `--since REV` | 0, or 1 if a named file was not scanned or `--since` has no scanned changes |
| `vlyn doctor [dir]` | 1 if Node is older than 24.12 or Git is missing. Other rows warn |
| `vlyn models [--refresh]` | 0 when the endpoint listed models |

`graph` and `impact` see JavaScript and TypeScript relative imports only.

## Contract rehearsal

| Command | Exit |
| --- | --- |
| `vlyn plan [dir]` | 0 after recording the workspace |
| `vlyn run [dir] [--model NAME]` | 0 compatible, 2 failed check, 3 incomplete, 1 bad input |
| `vlyn status [dir]` | 0 when a snapshot is stored |

`--db PATH` overrides `.rehearsal.sqlite` in the workspace. These commands do not use the `~/.vlyn` journal.

## Modules

| File | Role |
| --- | --- |
| `src/cli.ts` | Command entry. Run directly by Node. |
| `src/actors.ts`, `src/actor-coding.ts` | Actor pool, brain snapshots, hypothesis race |
| `src/lessons.ts` | Lesson claims, decay, and the AGENTS.md suggestion |
| `src/decision.ts`, `src/eval.ts` | Decision journal and the scripted eval |
| `src/premortem.ts` | Pre-mortem gate and after-action note |
| `src/sandbox.ts`, `src/broker.ts`, `src/capabilities.ts` | Check confinement, secret scrubbing, and the audit chain |
| `src/planner.ts` | Goal to spec and owned tasks |
| `src/coding-agent.ts` | Tool loop and per-task graph |
| `src/providers.ts` | OpenAI-compatible and Anthropic HTTP |
| `src/parallel.ts` | One task in one worktree |
| `src/durable.ts` | SQLite journal, resume, convergence |
| `src/memory.ts` | Recall from earlier runs |
| `src/graph.ts`, `src/tools.ts` | Import graph, impact, doctor |
| `src/tui.ts` | Interactive session |
| `src/scheduler.ts`, `src/state.ts`, `src/workspace.ts` | Contract rehearsal |
