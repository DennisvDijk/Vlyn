# Project state

Handoff for the next session. Update this file at the end of every later pull request. Do not start a second roadmap. The phase table stays [docs/ROADMAP.md](ROADMAP.md).

## Current status

`main` is `4cdddc5` (Ask coding models for native tool calls), 20 November 2026.

| PR | What landed | Merge commit |
| --- | --- | --- |
| #4 | Research basis | `db6a498` |
| #5 | Actor brain snapshots | `56fd063` |
| #6 | Lessons | `7df18d2` |
| #7 | Decision journal and scripted eval | `8e8ae61` |
| #8 | Pre-mortem, converge, apply-to-branch | `c7ea4c7` |
| #9 | Capability sandbox, broker, audit | `c51e8c6` |
| #10 | CI, TypeScript, README, how-tos | `dfe1a47` |
| #12 | Roadmap status for folded memory, Scorecard skip on private repos | `228cc7a` |
| #13 | Apache-2.0 | `3fa644c` |
| #14 | README diagrams of the real run and the actor runtime | `cd1cf10` merged |
| #15 | Native tool calls for coding turns, JSON action as fallback | `4cdddc5` merged |

#4 through #10 and #13 are merged. #14 is merged. #11 is an open Dependabot bump of `@types/node` and is not part of this work.

Nothing on main has called a live model. Tests use scripted replies. `vlyn auto` does not spawn actor rows. `vlyn actors` only lists rows the runtime wrote.

## Validation verdict

An independent review found:

- Vlyn has never run on a live model.
- Parallel worktrees, resume, and memory are commodity features.
- The sandbox in #9 is weaker than Claude Code's sandbox-runtime and the Codex bubblewrap plus seccomp sandbox.
- The wedge is check-gated verdicts plus scored, outcome-derived confidence. No other harness does that pair.

Positioning: the coding agent that knows when it's wrong.

## Queued validation phase

Build these as separate non-stacked pull requests, merge each only when its checks are green, in this order. Items 1 and 2 also have to match the public Codex CLI (`openai/codex` `codex-rs`) and Claude Code call layer: Responses API for OpenAI, Chat Completions for other OpenAI-compatible hosts, Anthropic `tool_use` / `tool_result`, parallel tool calls, SSE streaming and TUI deltas, prompt-cache breakpoints, reasoning items kept across turns, token accounting including cached tokens, retries with jitter and `retry-after`, and structured edit tools (`apply_patch`, exact replace, ranged read, shell timeout, grep/glob). Zero runtime dependencies. Recorded SSE fixtures, not live calls. A parity table in docs must say what is still missing.

1. Native tool calling for OpenAI-compatible and Anthropic providers, JSON action protocol as fallback. #15 is the first slice. The parity list above is not done yet.
2. Live-model readiness: a smoke test skipped in CI unless keys and `VLYN_LIVE_SMOKE=1` are set, token and cost accounting per task and per run, retry and timeout. Do not spend money from this agent unless keys are already configured.
3. Calibration engine. Record a pre-verdict confidence from the model's own number and from process signals (check history, edit/check cycles, diff size, lessons hit, reviewer dissent). Score both with Brier, ECE, and AUROC. `vlyn calibration`. Persist in the SQLite journal.
4. Eval harness for A/B. `vlyn eval` runs a local JSON or YAML task set (repo, goal, check) and a SWE-bench Pro adapter. Flags for lessons on or off, N repetitions, and a baseline that runs Claude Code or Codex CLI headless when installed. Report pass rate, repeat-failure rate, tokens and cost, calibration, markdown and JSON.
5. Wire actor snapshots into normal goal runs: snapshot at task start, after each verdict, and on failure, so resume, fork, and revert work on a real run.
6. Sandbox hardening. Optional or peer dependency on `@anthropic-ai/sandbox-runtime`, or an equivalent bubblewrap plus seccomp or Landlock path on Linux and Seatbelt on macOS, plus a domain-allowlist egress proxy. The key broker stays outside the sandbox. `vlyn doctor` reports the real posture. Measure overhead. Document the dependency.
7. `docs/VALIDATION.md` with the keep/kill criteria below and the commands Dennis runs locally with his own keys.

## Keep or kill

Keep going when all three hold:

- Pass rate is within 10 points of the baseline.
- Vlyn's process confidence beats self-stated confidence on Brier and on AUROC.
- Lessons cut repeat failures by at least 25 percent.

Kill or pivot to a verdict layer that wraps other agents when any one holds:

- Pass rate trails the baseline by more than 20 points.
- The Brier gain is under 0.03.
- Lessons show no effect.

## Working rules

- One feature per branch. Branch names are `cursor/<name>-91d7`. Pull requests are not stacked. Each one targets `main`.
- Update [docs/ROADMAP.md](ROADMAP.md). Do not add another roadmap file.
- Merge only when the required checks are green, including the Windows jobs. Do not merge a red or still-running check.
- CodeQL and dependency review stay in the workflows and run only when the repository is public or the Actions variables `ENABLE_CODEQL` and `ENABLE_DEPENDENCY_REVIEW` are `true`. This repository is private and GitHub Code Security is not on, so those APIs return "code scanning is not enabled" and `403 Forbidden`. The lockfile check that always runs is `npm audit`.
- Scorecard skips on a private repository unless `ENABLE_SCORECARD=true`, because the default token cannot list commits.
- License is Apache-2.0. Copyright 2026 Dennis van Dijk. Contributions are inbound equals outbound. See [LICENSE](../LICENSE) and [NOTICE](../NOTICE).
- Zero runtime dependencies unless a pull request says why and keeps the dependency optional.
- No live model calls in CI. Scripted replies and recorded SSE fixtures.

## Identity

Vlyn is a coding tool first. Every mechanism names a coding outcome and how an eval measures it.

The design is grounded in published brain and society research. Citations live in [docs/research/state-of-the-art.md](research/state-of-the-art.md). Analogies stay analogies. Do not claim Vlyn is a brain, and do not invent findings or numbers.

The actor idea is inherited from Agent Substrate, Hewitt's actors, and Erlang/OTP supervision. It is implemented in the SQLite journal. Do not call Substrate and do not add a Substrate backend.

Security is a lightweight sandbox: default-deny where the OS can enforce it, credentials stay in the parent, and `vlyn doctor` says what is actually on. Do not claim Landlock or seccomp until they are on. Do not claim the sandbox is stricter than Claude Code or Codex. The #9 review says it is not.
