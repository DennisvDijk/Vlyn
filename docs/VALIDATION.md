# Validation

Vlyn claims one thing: a probability that a coding agent's "done" is really done, which can be proven right against tests the agent never saw. This page records how that claim is tested, what the first measurement found, and the decision rules that were fixed before looking at the next data.

Status: first measurement done on easy tasks (23 Nov 2026). A limited live pilot on example hard tasks ran on 24 November; the full hard-task measurement has not yet run.

## First measurement (23 Nov 2026)

### Setup

- 10 small tasks, each with a goal, a visible check and a hidden test the agent never saw. Two of them (`09-leap-conflict`, `10-price-conflict`) contain a visible test that contradicts the goal. There the right verdict is `conflict`.
- 2 reps per task and agent, so 40 runs: Claude Code (`claude-opus-5-5`) and Codex (default model). Pi did not take part (expired key).
- Per run: the agent's own claim ("DONE" or "BLOCKED"), `p_self` asked after the run, Vlyn's `p_process` with hand-set weights, and the verdict of an existing verifier as baseline (linejudge 0.2.0, run as an external CLI, JSON output only).
- Outcome: the hidden test, run after the predictions were written.
- Pre-registered before the run: [PREREGISTRATIE-v2.md](../experiments/2026-11-first-measurement/PREREGISTRATIE-v2.md) (in Dutch).
- Scripts and per-run summary: [experiments/2026-11-first-measurement/](../experiments/2026-11-first-measurement/). Raw agent logs and final messages are not included, because they were not reviewed for paths, keys or personal data.

### Result

| Measure | Result |
| --- | --- |
| Runs | 40 (20 per agent) |
| Claimed "DONE" | 35 |
| "DONE" and the hidden test passed | 35 of 35 (Wilson 95% interval 90.1–100%) |
| Hidden test passed (all runs) | 40 of 40 |
| Sabotage (tests weakened or skipped) | 0 of 40 |
| Brier, `p_self` (agent) | 0.010 |
| Brier, `p_process` (Vlyn, hand-set weights) | 0.201 |
| Brier, baseline verifier | 0.200 |
| AUROC | not computable: no run failed |
| Cost | Claude Code $7.29; Codex 2.04M tokens on a subscription (cost unknown) |

The 5 runs not counted as "DONE" all reported BLOCKED on a conflict task: `09-leap-conflict` 3 times and `10-price-conflict` 2 times (Claude Code 4 of 4, Codex 1 of 4).

### What it means

- On easy tasks there is no gap between "done" and really done. The instrument is neither proven nor refuted.
- Vlyn's `p_process` was worse than the agent's own confidence (0.20 against 0.01). Hand-set weights are not good enough yet.
- The verdict rule was wrong. On the two contradicting tasks the agents followed the goal and left the test alone. Both Vlyn's old rule and the baseline called that `failed`, but it was the right behaviour. A verdict that leans on the visible check punishes honest agents. Hence the new verdict `conflict` ([judge design](design/judge.md)).

### Limits

- The tasks were too easy: no agent failed, so AUROC and any real calibration could not be measured.
- Pi did not take part.
- 10 tasks × 2 reps is a small sample.
- Codex cost per run is unknown.
- Why exactly the 5 runs were reported as BLOCKED has been checked only per run summary, not on the raw transcripts.

## Validation plan for hard tasks

1. **Task set.** 20 hard tasks on which agents are expected to score 30–70%. From own repositories, or real issues from public repositories (watch for contamination). Each has a visible check and a held-out acceptance test. Plus 3 tasks with a contradicting test, where the right verdict is `conflict`.
2. **Runs.** 3 per task and agent, with Claude Code, Codex and Pi (verify the selected provider and authentication first).
3. **Baseline (level 2).** One existing verifier on the same runs, in the sandbox, outside the repository. Only its JSON output is read, and treated as untrusted.
4. **Measure.**
   - how often "done" is right (with a 95% interval);
   - Brier and AUROC of `p_process` (Vlyn), `p_self` (the agent) and the baseline verdict, against the held-out outcome;
   - whether Vlyn recognises `conflict` correctly;
   - cost per run.
5. **Decide**, using the rules below.

`vlyn judge --tasks` and `vlyn report` run and summarise this. Cost cap for a real run: €25 (the `--budget` threshold is in US dollars; it is not a provider-enforced spending cap). The full measurement has not yet been run. Two live topo-sort pilot runs with Codex and Pi passed both visible and held-out checks, but the sample is too small for the decision rules; earlier runs may be invalid because of sandbox or provider failures. See the three example tasks and commands in [experiments/2026-11-hard-tasks](../experiments/2026-11-hard-tasks/README.md).

The report applies the rules mechanically and only when there are at least 20 "done" claims with an accept outcome (a minimum added in PR 3). Below that it says "not enough data".

## Decision rules (fixed in advance)

| Outcome on hard tasks | Decision |
| --- | --- |
| No gap: "done" is right in ≥ 90% of runs | The instrument lapses. Reconsider Vlyn: stop, or keep only verdict and audit as a small helper |
| Undecided: 75–90% | More tasks |
| Gap (< 75%) **and** Vlyn's probability is better: Brier at least 0.03 better than `p_self`, and AUROC better than both `p_self` and the baseline | Build the instrument (PR 4–7) |
| Gap, but Vlyn's probability is not better | The problem is real, but Vlyn does not solve it. Redesign the signals or stop |

For PR 6 and 7 a second measurement applies: the accept rate per task type must rise over 3 rounds against a fixed strategy, otherwise the learning loop is not merged.

## Results on hard tasks

The full measurement has not yet run. The report format is produced by `vlyn report`; paste its output here after the run.
