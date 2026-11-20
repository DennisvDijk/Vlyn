# Contract Rehearsal

A standalone TypeScript harness for checking a proposed JSON response against the consumer versions recorded in a deployment snapshot.

## Try it

Use Node.js 24.12 or newer. The CLI uses Node's built-in TypeScript and SQLite support. It needs no installation for the demo.

```sh
node src/cli.ts run examples/payments
node src/cli.ts status examples/payments --json
```

The staging sample detects that `export-v1` still reads the removed `customer_id` field. Billing passes. Reports appears as a coverage gap because the fixture has no contract for `reports-v2`. The demo returns exit code `2` because it finds an incompatibility.

| Command | Behavior |
| --- | --- |
| `plan <workspace>` | Discover known consumer contracts and record input versions without running checks. |
| `run <workspace>` | Run ready checks with up to three workers by default. Use `--workers N` to change concurrency. |
| `status <workspace>` | Reopen the last observed report, including evidence and any stale results. |

All commands support `--json` and `--db PATH`. The default database is `.rehearsal.sqlite` in the fixture workspace. `run` rereads the inputs before reporting and rechecks affected versions when they change. `status` reads the last stored snapshot. `run` returns `0` for complete, passing coverage, `2` for a failing check, `3` for incomplete verification, and `1` for a command or input error.

## Workspace format

- `provider/base.json` and `provider/candidate.json` contain captured JSON response objects.
- `deployment.json` lists the environment, whether the supplied inventory is `complete` or `partial`, and the deployed `service` and `revision` values. Multiple revisions of the same service are supported.
- Each regular `.json` file in `contracts/` contains a `service`, a `revision`, and a list of required field `expects`. Each expectation has a `path` of JSON property names or array indices as strings, and a `type` of `string`, `number`, `boolean`, `object`, `array`, or `null`.

The demo uses captured response fixtures and synthetic deployment revisions. The runtime runs directly in Node.js. Live infrastructure discovery, running service binaries, and code edits are future work.

## Optional model planning

`run --model <model-name>` enables direct OpenAI API planning with `OPENAI_API_KEY`. Use a model that supports JSON mode in Chat Completions. The model sees service names, changed field paths and types, and contract field expectations when it asks for them. The harness keeps captured response values and local paths out of these requests. The model can inspect and prioritize existing checks. The runtime verifies every eligible result and reports the outcome using the same rules with or without a model.

## Development checks

```sh
npm ci --ignore-scripts
npm run check
npm test
```

GitHub Actions runs these checks on pull requests and pushes to `main`. The matrix covers the minimum supported Node.js version on Linux and Node.js 26 on Linux, macOS, and Windows. `CI result` combines the matrix into one status check. The tests include the CLI's plan, run, and status commands and use a simulated model response.
