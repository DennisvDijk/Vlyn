# Vlyn

[![CI](https://github.com/DennisvDijk/Vlyn/actions/workflows/ci.yml/badge.svg)](https://github.com/DennisvDijk/Vlyn/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D24.12-339933?logo=node.js&logoColor=white)](https://github.com/nodejs/release)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**How much should you trust your coding agent's "done"?**

Vlyn runs an existing coding agent (Claude Code, Codex, Pi) in an isolated git worktree and returns a verdict (`completed`, `unverified`, `conflict`, `failed`). Next, it gives a probability that the work is really correct, and checks that probability against a held-out test the agent never saw. Local, auditable, no runtime dependencies.

## Quick start

No runtime dependencies. Node.js 24.12 or newer, and Git.

```sh
npm ci --ignore-scripts
npm link          # from a clone, `node src/cli.ts` is the same command as `vlyn`

# Judge one agent's "done" in an isolated worktree, with a held-out acceptance test
vlyn judge --agent claude --goal "Add input validation" --check "npm test" \
  --accept "node .vlyn-accept/accept.mjs" --accept-dir ../held-out

vlyn calibration  # Brier, ECE and AUROC per predictor
vlyn report       # markdown report with the decision rules applied
```

Measuring many tasks (nothing runs without `--execute`): [how to judge](docs/how-to/judge.md) and [the task set and commands](experiments/2026-11-hard-tasks/README.md).

## Status: a measurement instrument first

Vlyn is rebuilt in small steps and measured before it grows.

- **Built:** `vlyn judge` (verdicts, gates, `--accept`, `p_self`, `p_process`), `vlyn calibration`, and the measurement tooling (`judge --tasks`, baseline adapter, `vlyn report`). See the [design](docs/design/judge.md) and [roadmap](docs/ROADMAP.md).
- **Not run yet:** the measurement on hard tasks. It needs model keys and 17 more tasks. Until then there is no proof that the probability beats the agent's own confidence.
- **Frozen, not removed:** the earlier harness ([FROZEN.md](docs/FROZEN.md)). Its commands still work.

### The first measurement, honestly

On 23 November 2026, 40 runs on 10 easy tasks (Claude Code and Codex) found **no gap**: "done" was right 35 of 35 times (95% interval 90–100%). No agent sabotaged a test. Vlyn's own probability was worse than the agent's own confidence (Brier 0.20 against 0.01), and the old verdict rule wrongly punished honest agents on tasks with a contradicting test, so there is now a verdict `conflict`. The tasks were too easy to say anything about hard ones. Next is the same measurement on hard tasks, with decision rules fixed in advance. Details and limits: [docs/VALIDATION.md](docs/VALIDATION.md).

If hard tasks also show no gap, the rules say the instrument lapses, and that is an accepted outcome ([ADR 0003](docs/adr/0003-measurement-first.md)).

## What Vlyn is and is not

| Vlyn is | Vlyn is not |
| --- | --- |
| A core (library plus thin CLI) you plug in | A harness or agent loop: Pi, Claude Code and OpenCode do that better |
| Works headless with Claude Code, Codex and Pi. ACP later | A generic verifier: linejudge, swarm-orchestrator and Qodo are already there |
| The source of a calibrated probability, with an audit | A router: routing would be a by-product of good probabilities |
| A tool that borrows ideas | A tool that copies code from other tools |

Vlyn is not a brain. Brain research is used as a source of design ideas and stays an analogy ([research](docs/research/motivation-and-control.md)).

## Research

- [Design of `vlyn judge`](docs/design/judge.md)
- [Validation plan and decision rules](docs/VALIDATION.md)
- [Motivation and control: from brain to harness](docs/research/motivation-and-control.md)
- [Memory and decision research](docs/research/state-of-the-art.md)

## Other commands

```sh
vlyn doctor       # which confinement this OS really provides
vlyn audit        # read the hash-chained allow/deny log
vlyn eval         # the scripted suite (measures the harness, not a live model)
vlyn lessons      # lessons from repeated failures
vlyn graph .      # JS/TS import graph, fails on a cycle
```

Guides: [docs/README.md](docs/README.md). Where the project is: [docs/STATE.md](docs/STATE.md).

## Frozen: the earlier harness

`vlyn auto`, `batch`, `plan`, `run`, `resume`, `runs`, `actors`, `code`, `status` and the TUI turn one goal into parallel tasks, each in its own worktree with a check. They keep working and are marked `(frozen)` in `--help`. They get no new features until an eval gives a reason. The per-module table is [docs/FROZEN.md](docs/FROZEN.md).

```sh
export VLYN_API_KEY=…          # or OPENAI_API_KEY, LITELLM_API_KEY, ANTHROPIC_API_KEY
cd your-project                # a clean Git repository root
vlyn auto --goal "Add input validation to the CLI" --check "npm test" --plan-only
```

Repository files the agent reads are sent to the model provider you configured. Your checkout is not modified.

How a frozen goal run works, with diagrams: [docs/FROZEN.md](docs/FROZEN.md#how-a-frozen-goal-run-works).


| Frozen or kept | Command | Guide |
| --- | --- | --- |
| Plan, then run a goal | `vlyn auto --goal "…" --check "npm test"` | [Run a goal](docs/how-to/run-a-goal.md) |
| Continue after Ctrl+C | `vlyn resume` | [Resume a run](docs/how-to/resume-a-run.md) |
| Combine results and put them on a new branch | `vlyn converge`, then `vlyn apply --branch NAME` | [Pre-mortem and apply](docs/how-to/premortem-and-apply.md) |
| Lessons from repeated failures | `vlyn lessons` | [Lessons](docs/how-to/lessons.md) |
| Scripted eval | `vlyn eval` | [Eval](docs/how-to/eval.md) |
| Confinement and audit | `vlyn doctor`, `vlyn audit` | [Sandbox and audit](docs/how-to/sandbox-and-audit.md) |
| Connect a model | `vlyn models` | [Connect a model](docs/how-to/connect-a-model.md) |
| Import cycles in CI | `vlyn graph .` | [Graph and impact](docs/how-to/graph-and-impact-in-ci.md) |

## Security

Checks run with a capability manifest: the task's files, the exact check string, and no child network unless this machine cannot actually enforce that. The API key stays in the parent process. Check environments drop variables whose names look like secrets, and those values are redacted out of tool output and the audit log.

`vlyn doctor` prints which confinement is real on this OS (`unshare`, bubblewrap, `sandbox-exec`, Node's `--permission`, or only the in-process gate). Landlock and seccomp are not on. `--require-sandbox` refuses a check we cannot confine. `vlyn audit [run]` prints the hash-chained log and exits 2 if a row was edited. The external agent run by `vlyn judge` is not sandboxed by Vlyn yet, only the checks are. Guide: [docs/how-to/sandbox-and-audit.md](docs/how-to/sandbox-and-audit.md). Threat model: [docs/security/threat-model.md](docs/security/threat-model.md).

## Limitations

- Nothing here has been scored against a live model in CI. Tests use scripted replies and recorded fixtures.
- The frozen harness has a weak agent loop for real repositories (no grep/glob, no ranged read, no general shell). Documented in [docs/llm-parity.md](docs/llm-parity.md).
- A check is network-confined only when `unshare`, bubblewrap, or `sandbox-exec` launches it. Node's `--permission` did not block `net.connect` on Node 24.12.
- File ownership in the frozen harness is whatever the model declared.
- The import graph is JavaScript and TypeScript relative imports only. Treat it as a lower bound.
- `vlyn eval` scores a scripted suite. It does not score a live model.

## License

Vlyn is licensed under the Apache License, Version 2.0. Copyright 2026 Dennis van Dijk. The terms are in [LICENSE](LICENSE). Attribution is in [NOTICE](NOTICE).

## Development

```sh
npm ci --ignore-scripts
npm run lint
npm run check
npm test
```

CI lints and typechecks once, then tests on Linux, macOS, and Windows for Node 24 and Node 26. See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).
