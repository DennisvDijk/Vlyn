# Vlyn roadmap

One file, shared by everyone working on Vlyn (people and bots). Update the status here in the same pull request as the work. There is no second roadmap.

Status: **done** (merged), **in PR**, **next**, **later**, **conditional** (built only after a "go" at the decision point). "Verified" means tests ran.

The direction is in [ADR 0003](adr/0003-measurement-first.md): measure first, then build. The design is [design/judge.md](design/judge.md). The measurement and the decision rules are [VALIDATION.md](VALIDATION.md).

## Plan

| Step | Branch | What | Status |
| --- | --- | --- | --- |
| PR 0 | `cursor/reposition-91d7` | Reposition: README, `FROZEN.md`, design, research and validation docs, ADR 0003, STATE and ROADMAP, `(frozen)` labels in `--help` | in PR |
| PR 1 | `cursor/judge-core-91d7` | `src/judge/` library and thin `vlyn judge` CLI. Adapters `fake`, `claude`, `codex`, `pi`. Verdicts `completed`, `unverified`, `conflict`, `failed`. `--protect`, skip detection. `judge_runs` and audit | in review |
| PR 2 | `cursor/judge-calibration-91d7` | Held-out `--accept`, `p_self`, `p_process`, tables `predictions` and `outcomes`, `vlyn calibration` (Brier, ECE, AUROC) | in review |
| PR 3 | `cursor/measurement-91d7` | `vlyn judge --tasks`, baseline adapter, `vlyn report`, example task set and commands for the real measurement. Nothing is run live | in review |
| Decision | — | Apply the pre-registered rules in [VALIDATION.md](VALIDATION.md). Dennis decides | after PR 3 |
| PR 4 | — | Sandbox of the agent process and a key with a budget cap | conditional |
| PR 5 | — | ACP adapter | conditional |
| PR 6 | — | Learning loop: `strategy_values`, `α⁺` and `α⁻`, `ε` exploration, lessons steered by `δ` | conditional |
| PR 7 | — | Extra control (ACC rule) and the delayed merge/revert reward | conditional |

## Earlier phases (frozen, not removed)

The harness phases 1–19 are merged. They are listed here only so nobody rebuilds them. Their per-module fate is in [FROZEN.md](FROZEN.md).

| Phases | What | Where |
| --- | --- | --- |
| 1–7, 11 | Contract rehearsal, coding loop, parallel worktrees, planning, providers, spec and convergence, memory recall | `scheduler.ts`, `coding-agent.ts`, `parallel.ts`, `planner.ts`, `durable.ts`, `providers.ts`, `memory.ts` |
| 8, 15 | Lessons | `lessons.ts` (reused) |
| 10, 17 | Converge, apply to branch, pre-mortem | `durable.ts` (reused), `premortem.ts` |
| 12 | Native tool calls and streaming sessions | `llm/*`, [llm-parity.md](llm-parity.md) |
| 14 | Decision journal and scripted eval | `decision.ts`, `eval.ts` |
| 16 | Actor brain snapshots | `actors.ts`, `actor-coding.ts` |
| 18 | Capability sandbox, broker, audit chain | `sandbox.ts`, `capabilities.ts`, `broker.ts` (reused) |
| 19 | Toolchain and CI | TypeScript, Biome, split CI |

Two old phases are replaced: running against a live model (old phase 9) is now the measurement in PR 3, and cross-repository reasoning (old phase 11) and GitLab CI (old phase 13) are not planned.

## Working together (people and bots)

- One step per branch and pull request, named `cursor/<name>-91d7`. Pull requests are not stacked. Do not edit another open PR's files without saying so there.
- Tick the status here when a PR merges. Do not mark a step done without passing tests and CI.
- Keep README limitations honest: say what is not verified.
- `src/model.ts` is only used by the contract rehearsal tests; leave it alone unless you are changing that.
