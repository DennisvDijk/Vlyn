# Project state

Handoff for the next session. Update this file at the end of every pull request. Do not start a second roadmap. The phase plan is [docs/ROADMAP.md](ROADMAP.md).

## Where the project is

Vlyn is being rebuilt as a **measurement instrument for trust in coding agents**: how much should you trust your coding agent's "done"? See [ADR 0003](adr/0003-measurement-first.md) and [design/judge.md](design/judge.md).

Base for the rebuild: `main` at `506b6d3` (Stream coding turns through Responses, Chat, and Anthropic, #17), 24 November 2026. The earlier harness is frozen, not removed ([FROZEN.md](FROZEN.md)).

| Step | What | Status |
| --- | --- | --- |
| PR 0 `reposition` | README, docs, freeze, `--help` labels | in progress (this PR) |
| PR 1 `judge-core` | `vlyn judge`, adapters, verdicts incl. `conflict` | next |
| PR 2 `judge-calibration` | `--accept`, predictions, outcomes, `vlyn calibration` | after PR 1 |
| PR 3 `measurement` | task set, baseline adapter, `vlyn report` | after PR 2 |
| Decision point | Apply the pre-registered rules in [VALIDATION.md](VALIDATION.md) | after PR 3 |
| PR 4–7 | Agent sandbox, ACP, learning loop, extra control | only after "go" |

## What the evidence says

- First measurement (23 Nov 2026, 40 runs, 10 easy tasks, Claude Code and Codex): "done" was right 35 of 35 times. No gap on easy tasks. Vlyn's `p_process` (Brier 0.201) was worse than the agent's own confidence (0.010). The old verdict rule wrongly punished honest agents on tasks with a contradicting test, which led to the verdict `conflict`. Details: [VALIDATION.md](VALIDATION.md).
- Nothing on `main` has called a live model in CI. Tests use scripted replies and recorded fixtures.
- Whether a gap exists on hard tasks is not known yet. That decides everything after PR 3.

## Known weak points of the earlier code

Found in the review of `506b6d3`; PR 1 and 2 address the ones that touch the verdict.

- The eval uses hard-coded confidences (`src/eval.ts`).
- Without owned files, `manifestFor` allows writes to the whole root, so tests can be weakened (`src/capabilities.ts`).
- Without a sandbox, `planLaunch` falls back to a gate-only run with `shell: true`, and `--require-sandbox` is off by default (`src/sandbox.ts`).
- The agent loop is weak for real repositories (`src/coding-agent.ts`). It is frozen, not fixed.

## Decisions to confirm

Open questions from the design, answered with the most conservative option until confirmed. They are also listed in each PR.

- Task set source for hard tasks, who writes `--accept`, which baseline runs, how a conflict is reported, and what counts as task type: see [design/judge.md](design/judge.md#open-questions).

## Working rules

- One feature per branch. Branch names are `cursor/<name>-91d7`. Pull requests are not stacked. Each one targets `main`, and the next starts only after the previous is merged.
- Update [docs/ROADMAP.md](ROADMAP.md). Do not add another roadmap file.
- Merge only when the required checks are green, including the Windows jobs and Node 24 and 26. Do not merge a red or still-running check.
- The repository is public. CodeQL and dependency review run as required checks.
- License is Apache-2.0. Copyright 2026 Dennis van Dijk. Contributions are inbound equals outbound. See [LICENSE](../LICENSE) and [NOTICE](../NOTICE).
- Zero runtime dependencies unless a pull request says why and keeps the dependency optional. `@anthropic-ai/sandbox-runtime` belongs to PR 4.
- No live model calls in CI. Scripted replies and recorded fixtures only.
- Do not change or skip existing tests. If a test looks wrong, stop and report.
- Do not claim a sandbox that is not there.
- Remove nothing from the freezer.

## Identity

Vlyn is a measurement instrument, not a harness, a generic verifier, or a router. It is never called a brain. Brain research is an analogy for design ideas ([research/motivation-and-control.md](research/motivation-and-control.md)), and every mechanism must improve a measurable result or go out.

Security is a lightweight sandbox: default-deny where the OS can enforce it, credentials stay in the parent, and `vlyn doctor` says what is actually on. Do not claim Landlock or seccomp until they are on, and do not claim the sandbox is stricter than Claude Code or Codex. In the first `judge` phase Vlyn sandboxes only the check, not the agent process.

Borrow ideas from other tools, not code. Existing verifiers may run only as a baseline CLI in the sandbox, with only their JSON output read.
