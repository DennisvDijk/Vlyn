# ADR 0003: Measure first, then build

Status: accepted (24 Nov 2026)

## Context

Vlyn began as a coding agent harness: goals become parallel tasks, each in its own worktree, with a verdict from a check. A review of commit 506b6d3 found the verdict design strong but the central assumption untested: nothing in the repository had run against a real model, and the eval used hard-coded confidences.

The market also moved. At least four tools already verify coding agents independently (linejudge, swarm-orchestrator, Quarterback, Qodo), agent loops are done better by Claude Code, Codex, Pi and OpenCode, and parallel worktrees by herdr, worktrunk and cmux.

A first measurement on 10 easy tasks (40 runs) found no gap between "done" and really done: 35 of 35 claims held. The open question became narrower: is there such a gap on hard tasks, and can Vlyn predict it better than the agent itself?

## Decision

Reposition Vlyn as a measurement instrument for trust in coding agents, and measure before building more.

- Vlyn runs an existing agent and returns a verdict plus a probability, checked against held-out tests.
- PR 0 repositions and freezes, PR 1–2 build `vlyn judge` and calibration, PR 3 builds the measurement on hard tasks.
- After PR 3 there is a decision point with rules fixed in advance ([VALIDATION.md](../VALIDATION.md)). PR 4–7 are built only on "go".
- Nothing is deleted. Harness modules are frozen ([FROZEN.md](../FROZEN.md)).

## Alternatives considered

| Alternative | Why it fell away |
| --- | --- |
| Keep investing in the harness | Better agents exist and are free to use. No differentiation, and the core assumption stayed untested |
| Build a standalone, generic verifier | Already crowded: linejudge, swarm-orchestrator, Qodo. Vlyn's open niche is a *calibrated probability* with proof, not another gate |
| Stop now | Premature. The first measurement was too easy to say anything about hard tasks. A cheap second measurement can decide with pre-registered rules |
| Build the full learning loop first | A loop without errors has nothing to learn from. It is only worth building if hard tasks show a gap |

## Consequences

- The README, roadmap and state describe Vlyn as a measurement instrument first.
- A negative result is a valid outcome: the rules may end the instrument.
- The real measurement needs keys and a cost cap; until then only the task set and commands are delivered.
- Ideas from other tools are borrowed, their code is not copied. They may run as a baseline CLI in the sandbox.
