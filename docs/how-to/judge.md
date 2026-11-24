# Judge a coding agent's "done"

`vlyn judge` runs an existing coding agent (Claude Code, Codex or Pi) in a detached Git worktree and returns a verdict about its work. It answers one question: how far can you trust this "done"?

It is not an agent harness. Vlyn does not plan, route or write code here. It runs your agent, looks at what changed, and reruns your check itself.

## Before you start

- The directory must be the root of a Git repository with a clean working tree. Vlyn refuses otherwise.
- The agent CLI you pick must be installed and signed in (`claude`, `codex` or `pi`).
- The check is a command that exits 0 when the work is right, for example `npm test`.

## Run it

```sh
vlyn judge . --agent claude \
  --goal "Make slugify handle accented letters" \
  --check "npm test"
```

Your checkout is never touched. The agent works in a temporary worktree at `HEAD`, and Vlyn removes the worktree afterwards.

| Flag | Meaning |
| --- | --- |
| `--agent claude\|codex\|pi` | The agent to run. |
| `--goal TEXT` | The task, in plain words. |
| `--check CMD` | Visible check. Vlyn runs it again after the agent has finished. |
| `--files A,B` | Files or folders the agent may change. Changes elsewhere make the run `unverified`. Default: everything that is not protected. |
| `--protect A,B` | Extra protected paths. They are added to the defaults, never replace them. |
| `--timeout 20m` | Time limit for the agent. A bare number is seconds. |
| `--allow-noop` | An empty diff is not `unverified`. Use it when "nothing to change" is a valid answer. |
| `--no-require-sandbox` | Run the check even when this OS cannot isolate it. By default Vlyn refuses. |
| `--json` | Print the result as JSON (without the diff). |

## Verdicts and exit codes

| Verdict | Exit | Meaning |
| --- | --- | --- |
| `completed` | 0 | The check passes when Vlyn runs it and no gate fired. |
| `failed` | 1 | The agent crashed or timed out, or the check fails. |
| `unverified` | 2 | The check passes, but something makes that pass worth less: see the gates below, or the check could not run. |
| `conflict` | 5 | The check fails and the agent named the test that clashes with the goal. |

Exit 3 means Vlyn refused to start (dirty tree, no sandbox with `--require-sandbox` on, bad input). Exit 4 is an internal error.

## Gates

The verdict comes from the worktree and from Vlyn's own run of the check, not from what the agent says. These gates turn a passing check into `unverified`:

- **Protected files changed.** By default: test folders and test files, test configuration, CI configuration, lockfiles, and the `scripts` of `package.json`.
- **Outside `--files`.** A changed file that is not owned.
- **New skip markers.** For JavaScript and TypeScript (`it.skip`, `xit`, `skip: true`) and Python (`@pytest.mark.skip`, `pytest.skip(`, `@unittest.skip`). Go `t.Skip` is also caught. Only added lines count.
- **Empty diff.** Unless `--allow-noop`.

### What `conflict` means

The task prompt asks the agent to follow the goal, leave tests unchanged, and end with `DONE`, `CONFLICT: <exact test name> - <reason>` or `BLOCKED: <reason>`. A `conflict` needs both: your check fails on Vlyn's rerun, and the agent named a clashing test. A failing check alone is `failed`.

## What is and is not sandboxed

In this phase Vlyn isolates only the **check**, with the platform sandbox that `vlyn doctor` reports. The **agent process is not sandboxed by Vlyn.** Claude Code and Codex run with their own permission settings, and Vlyn starts Claude Code with `--dangerously-skip-permissions` inside the throwaway worktree. Do not point it at a repository whose environment holds secrets you would not give the agent. The worktree limits where the diff lands. It does not limit what the agent process can read or run.

## Record

Each run is written to the journal (`judge_runs`) and to the hash-chained audit log (`judge.start`, `judge.verdict`). `vlyn audit RUN_ID` shows it.

## From code

```ts
import { judge } from './src/judge/index.ts';

const result = await judge({ agent: 'claude', goal, check: 'npm test', root: '.' });
console.log(result.verdict, result.reasons);
```

The CLI is a thin shell over this function. Both give the same verdict.

## Testing without a model

`--agent fake` runs a scripted agent for tests. It reads a JSON script from the file in `VLYN_FAKE_SCRIPT` (`edits`, `commands`, `summary`, `conflicts`, `crash`, `hang`). It makes no network call.
