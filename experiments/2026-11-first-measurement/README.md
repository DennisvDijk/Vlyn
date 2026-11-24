# First measurement, 23 November 2026

Ten small JavaScript tasks, each with a visible test and a hidden acceptance test. Two tasks (`09-leap-conflict`, `10-price-conflict`) have a visible test that contradicts the goal. Claude Code and Codex ran each task twice: 40 runs. The write-up is in [docs/VALIDATION.md](../../docs/VALIDATION.md).

| File | What it is |
| --- | --- |
| `PREREGISTRATIE-v2.md` | Decision rules and the `p_process` weights, written before the first valid run (in Dutch, as written) |
| `make-tasks.mjs` | Generates `tasks/` |
| `tasks/` | The ten tasks: goal, starting repo, hidden test |
| `run2.mjs` | Runs one agent on one task and scores it. Reads `VLYN_WORK`, `LJ_PYTHON` and `LJ_BASELINE` from the environment |
| `analyse.py` | Wilson intervals, Brier, AUROC and bootstrap over a `results2/` folder of per-run JSON files |
| `results-summary.csv` | One row per run: claim, the three probabilities, the hidden outcome, cost |

Raw agent logs and final messages are not included. They were not reviewed for paths or personal data. These scripts are the old, ad hoc way. `vlyn judge --tasks` replaces them (PR 1 to 3).
