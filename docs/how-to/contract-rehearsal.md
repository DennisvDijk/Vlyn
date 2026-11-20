# Rehearse a contract

Check a proposed JSON response against consumer contracts recorded in a workspace snapshot. No model is required unless you pass `--model`.

## Run the example

From a clone of this repository:

```sh
vlyn run examples/payments
```

Exit `2` is expected. `export-v1` still reads `customer_id`, and the candidate response removed it. That is the rehearsal finding the break.

```sh
vlyn status examples/payments --json
```

## What the workspace contains

| Path | Role |
| --- | --- |
| `provider/base.json` | Response capture before the change |
| `provider/candidate.json` | Response capture after the change |
| `deployment.json` | Environment, inventory (`complete` or `partial`), deployed revisions |
| `contracts/*.json` | One consumer. Required field: `expects` |

## Check your own workspace

1. Put the four kinds of file above in a directory.
2. Record it.

   ```sh
   vlyn plan path/to/workspace
   ```

3. Run the checks.

   ```sh
   vlyn run path/to/workspace
   vlyn run path/to/workspace --model some-model-id
   ```

   `--model` lets the model order the checks. The runtime still evaluates every check. A skipped check is not a pass.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Inventory is complete and every check passed |
| 2 | A check failed |
| 3 | Verification is incomplete, including a partial inventory |
| 1 | The workspace or the arguments are invalid |

`--db PATH` stores the snapshot somewhere other than `.rehearsal.sqlite` in the workspace. `--json` prints the snapshot instead of the text report.

Live discovery of what is deployed is not built. The inventory is whatever `deployment.json` says. If that file says `partial`, `run` exits `3` even when the recorded checks passed.
