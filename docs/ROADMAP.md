# Vlyn phases

One file, shared by everyone working on Vlyn (people and bots). Update the status here in the same pull request as the work.

Status: **done** (merged), **in PR** (open, not merged), **next**, **later**. "Verified" means tests ran; nothing below has run against a live model yet.

| # | Phase | Status | Notes |
| --- | --- | --- | --- |
| 1 | Contract rehearsal: check proposed responses against deployed consumer contracts | done | `src/scheduler.ts`, `src/state.ts` |
| 2 | Standalone coding loop with per-task graph | done (PR #1) | `src/coding-agent.ts` |
| 3 | Parallel tasks in isolated Git worktrees | done (PR #2) | `src/parallel.ts` |
| 4 | Goal-driven planning, durable runs, interactive TUI, graph/impact/doctor tools | in PR #3 | `planner.ts`, `durable.ts`, `tui.ts`, `graph.ts`, `tools.ts` |
| 5 | Every model system, live model refresh from the user's key (LiteLLM etc.) | in PR #3 | `providers.ts` |
| 6 | Spec, file ownership, convergence of parallel results | in PR #3 | merge on overlap; out-of-scope edits are `unverified`; `_integration` worktree |
| 7 | Memory, step 1: recall earlier run outcomes before planning | in PR #3 | `memory.ts`, read from the journal |
| 8 | Memory, steps 2–5: typed memory with provenance, post-run reflection, validated procedures, agent context budget | next | Needs real runs to show which lessons recur. Research: Retrieval and spacing, CoALA, Reflexion, Voyager, MemGPT |
| 9 | Run against a live model; fix what scripted tests hid | next | Biggest unknown; do before adding more features |
| 10 | `vlyn converge` command and applying a combined result to a branch | next | Convergence today only runs at the end of a run |
| 11 | Cross-repository and deployed-service reasoning (repos, Terraform, YAML, Kubernetes as nodes and edges) | later | Vlyn's main differentiator; not built |
| 12 | Native tool calling per vendor; Gemini and Bedrock without a gateway | later | |
| 13 | GitLab CI alongside GitHub Actions | later | Requested for the wider project 2026-11-17 |

## Working together (people and bots)

- Take one phase per branch and pull request; name it after the phase. Do not edit another open PR's files without saying so there.
- Tick the status here when a PR merges. Do not mark a phase done without passing tests and CI.
- Keep README limitations honest: say what is not verified.
- `src/model.ts` is only used by the contract rehearsal tests; leave it alone unless you are changing that.
