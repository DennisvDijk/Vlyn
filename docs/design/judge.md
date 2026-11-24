# Design: vlyn judge

Status: design. PR 1 builds the core, PR 2 the predictions and outcomes, PR 3 the measurement. Whether anything after PR 3 is built depends on the measurement on hard tasks ([VALIDATION.md](../VALIDATION.md), [ADR 0003](../adr/0003-measurement-first.md)).

## Goal and non-goals

`vlyn judge` is the core of Vlyn. It runs an existing coding agent in an isolated worktree and then returns two things: a verdict, and a probability that the work is really correct, which is later checked against a held-out outcome. The verdict is a means. The product is the number.

Goals, in order of importance:

1. **A probability that is right.** `p_process` predicts the held-out outcome demonstrably better than what the agent says itself, and better than existing verifiers.
2. **A verdict that cannot be gamed.** It comes from the worktree, not from the agent's summary. Protected tests, skip detection, held-out checks, and `conflict` instead of a penalty for honest agents.
3. **Provable.** Every prediction sits in the hash-chained audit before the outcome is known.
4. **Agent-independent.** Claude Code, Codex and Pi headless first; an ACP adapter later.
5. **A library first.** The core lives in `src/judge/` and can be called directly from other tools. The CLI is a thin shell around it.

Non-goals:

- No agent loop, toolset or prompt tuning of its own.
- No planner. One task per `judge`. Running in parallel stays with herdr or worktrunk, or with a later `vlyn judge --batch`.
- No merge to the real branch. At most `vlyn apply --branch`, as today.
- No code from existing verifiers in the repository. linejudge, swarm-orchestrator and the like run only as a baseline, in the sandbox, outside the repository. Borrow ideas, not code.

## CLI

```sh
vlyn judge \
  --agent claude|codex|pi \
  --goal "Add input validation to the CLI" \
  --check "npm test" \
  --accept "npm run test:acceptance" \
  [--files src/cli.ts,src/validate.ts] \
  [--protect test/,package.json] \
  [--budget-usd 2] [--timeout 20m] [--allow-noop] \
  [--require-sandbox]            # on by default
vlyn judge --tasks tasks.json    # task set for the measurement
vlyn calibration                 # Brier, ECE, AUROC per predictor
vlyn strategies                  # learned value per agent x task type (after PR 6)
```

| Flag | Meaning |
| --- | --- |
| `--check` | Visible to the agent. Vlyn runs it again itself afterwards, in the sandbox |
| `--accept` | Held out. The agent never sees it. This is the outcome everything is scored against |
| `--files` | Owned files. Empty means everything except `--protect` |
| `--protect` | Check surface. Default: test directories, test config, `package.json` scripts, CI config, lockfiles |

Exit codes: `0` completed · `1` failed · `2` unverified · `3` refused (sandbox unavailable, budget used up) · `4` error in Vlyn itself · `5` conflict.

## Flow

Every run ends with a prediction error. That error steers the choice for the next task. The agent itself never sees the score.

1. Clean repository root.
2. Detached worktree at `HEAD`.
3. Run the agent.
4. Diff (tracked and untracked files).
5. Gates.
6. Run `--check` again through `runGoverned`.
7. Verdict.
8. Write `judge_runs` and the `SecurityLog` chain.

## Verdict rules

The verdict is fixed before the held-out check runs. What the agent says it did does not count, except a reported conflict.

| Verdict | When |
| --- | --- |
| `failed` | The agent crashed, ran out of budget or time, or the check fails while the agent reports no conflict |
| `conflict` | The visible check fails (or a protected test would have to change) **and** the agent names which test clashes with the goal. A human decides. Vlyn applies nothing |
| `unverified` | Something changed inside `--protect` · a changed path is outside `--files` · the check could not run in the sandbox · the diff is empty while the goal asks for a change · new skip markers (`.skip`, `xit`, `@pytest.mark.skip`) were added |
| `completed` | None of the above, and Vlyn's own run of `--check` passes in the sandbox on the final worktree |

Why `conflict`: in the first measurement, agents facing a contradicting test followed the goal and left the test alone. The old rule called that `failed`, and linejudge did too. A verdict that leans on the visible check punishes the honest agent. The adapter asks the agent, in its final summary, to report clashes between a test and the goal.

`conflict` never counts as success and is never applied automatically. Whether a reported conflict was justified is tested by the held-out check. An agent that often reports a conflict without cause gets a lower `p_process`.

What differs from `judgeTask` today:

1. Vlyn runs the check itself, once, afterwards. The stale rule goes away, because the check always comes after the last edit.
2. The check surface is protected. That closes the hole "weaken the tests, then go green". Frontier models often cheat on impossible tasks, and stronger models do it more often.
3. Skip detection: a cheap textual diff check for new skip markers, one regex per language.
4. An empty diff is not a success, unless `--allow-noop`.
5. A failing visible check with a reported conflict is `conflict`, not `failed`.

## Agent adapters

An adapter starts the agent headless in the worktree and returns three things: an event stream (tool calls, edits, commands), a final summary and token usage. Nothing more is needed. The verdict comes from the worktree.

```ts
interface AgentAdapter {
  name: string;
  run(input: {
    worktree: string; goal: string; check: string;
    env: Record<string, string>;      // model endpoint and key only
    signal: AbortSignal;
  }): AsyncIterable<AgentEvent>;      // ends with {type: 'finish', ...}
}
type AgentEvent =
  | { type: 'edit'; path: string }
  | { type: 'command'; command: string; exitCode?: number }
  | { type: 'text'; text: string }
  | { type: 'finish'; summary: string; conflicts?: string[];
      selfConfidence?: number; usage?: ModelUsage };
```

Vlyn asks for `selfConfidence` after the run with one fixed question to the same model: "What is the probability, 0 to 1, that an independent acceptance test passes?" That question does not belong in the task prompt, so the agent cannot tune its work to it.

| Adapter | Call (to be verified against the installed CLI) | Priority |
| --- | --- | --- |
| `claude` | `claude -p` with `--output-format stream-json` | 1 |
| `codex` | `codex exec --json` | 1 |
| `pi` | Pi in print/JSON mode (renew the key) | 1 |
| `opencode` | `opencode run` | 2 |
| `acp` | any ACP agent | later |

## Sandbox of the agent

An external agent writes files itself and calls the model itself. Two guarantees of today change:

- Writes are no longer stopped beforehand, as `canWrite` does now. They are measured afterwards through `git diff` and `--protect`. An agent that writes outside the worktree has to be stopped by the sandbox.
- The key is inside the agent process. "The key stays in the parent" no longer holds. The fix is a short-lived key per run with a hard budget cap, revoked after the run.

| Layer | Linux | macOS |
| --- | --- | --- |
| Files | bubblewrap: only the worktree writable, home empty | Seatbelt profile |
| Network | `--unshare-net` plus a local egress proxy that lets only the model host through | Seatbelt plus the same proxy |
| Secrets | Empty env, except the per-run key | Same |

The fastest route is `@anthropic-ai/sandbox-runtime` as an optional dependency (PR 4). Until then the agent uses its own sandbox, and Vlyn sandboxes only the check.

## Calibration

Vlyn learns from the difference between what it expected and what happened. That is what dopamine does in the brain: dopamine neurons code a prediction error, the difference between expected and received reward. The model itself learns nothing, since its weights do not change. The harness does learn: which agent, which approach, and how much control for which kind of task. The brain is an analogy here, not a model ([motivation and control](../research/motivation-and-control.md)).

### 1. Predict, before the outcome

- `p_self`: the probability the agent itself names (see adapters).
- `p_process`: Vlyn's own probability from process signals:
  - number of edit/check cycles, and whether the agent's own last check was green;
  - diff size and number of changed files;
  - whether it touches `--protect`, or goes outside `--files`;
  - whether the agent reports a conflict;
  - how many lessons match these files;
  - turns, tokens and time relative to the median for this task type.

Start with hand-picked weights. In the first measurement they scored badly (Brier 0.20). After at least 30 outcomes a logistic regression is fitted on the journal (no dependencies, about 40 lines).

### 2. Outcome

- Direct: `r = 1` if `--accept` passes in the sandbox, otherwise `0`.
- Delayed (later): was the branch merged within 14 days without a revert or fix commit? Then a second reward follows on the same run. That is how Vlyn also learns from what a human accepts.

### 3. Prediction error

`δ = r − p_process`. A positive `δ` means better than expected, a negative one worse.

### 4. What `δ` adjusts (after PR 6)

| What | Rule | Brain analogy |
| --- | --- | --- |
| Strategy value `Q[task type][strategy]` | `Q += α⁺·δ` when `δ > 0`, `Q += α⁻·δ` when `δ < 0`, with separate learning rates | Basal ganglia Go/NoGo; distributional dopamine code |
| Lessons | `δ < −0.5` (surprising failure) becomes a candidate lesson. `δ > 0.5` (surprising success) stores a recipe: what the agent did differently | Prioritized replay: the most surprising experiences first |
| Explore or exploit | The running mean of `r` per task type falls: try another strategy more often (`ε` up). It rises: stay with the best | Locus coeruleus, adaptive gain |
| Extra control | `p_self` and `p_process` diverge far, or `p` is near 0.5: a second agent, a reviewer or an extra check. Only if the expected gain is larger than the cost | ACC, expected value of control |

`p`, `δ` and `Q` never enter the agent's prompt. The agent sees only the task and, optionally, lessons.

### 5. Protection against reward hacking

The reward comes only from `--accept` and from human merges. Never from the agent's text and never from the visible check.

Background: dopamine drives the *wanting* of a reward, not the pleasure of it. A strong drive plus a bad reward gives exactly the behaviour you do not want. For LLMs that is called in-context reward hacking.

### 6. Scores

`vlyn calibration` gives, per predictor (`p_self`, `p_process`, baseline), the Brier score, ECE and AUROC, plus the curve of `Q` per strategy over time.

## Journal schema and audit

Everything goes into the same SQLite under `~/.vlyn`. The new tables:

```sql
CREATE TABLE judge_runs (
  id TEXT PRIMARY KEY, root TEXT, base TEXT, goal TEXT, task_type TEXT,
  agent TEXT, strategy TEXT, check_cmd TEXT, accept_cmd TEXT,
  verdict TEXT,                 -- completed | unverified | conflict | failed
  verdict_reasons TEXT,         -- JSON: protected_touched, out_of_scope, skip_markers, conflicts, ...
  diff_sha TEXT, usage TEXT, started_at TEXT, finished_at TEXT
);
CREATE TABLE predictions (      -- written before --accept runs
  run_id TEXT, source TEXT,     -- self | process | baseline
  p REAL, features TEXT, model_version TEXT, at TEXT
);
CREATE TABLE outcomes (
  run_id TEXT, kind TEXT,       -- accept | merged | reverted
  r INTEGER, at TEXT
);
CREATE TABLE strategy_values (  -- from PR 6
  task_type TEXT, strategy TEXT, q REAL, n INTEGER, updated_at TEXT,
  PRIMARY KEY (task_type, strategy)
);
```

Every row in `predictions` and `outcomes` also goes into the existing `security_audit` hash chain. Then it can be shown afterwards that the prediction came before the outcome. `task_type` is a manual label or a simple heuristic in v1 (bugfix, feature, refactor, test, config).

## Reuse and freezer

About half of the current code stays useful. "Freezer" does not mean deleting. It means no maintenance in `main` until an eval gives a reason. The per-module table is in [FROZEN.md](../FROZEN.md).

## Phasing and decision point

Seven separate PRs to `main`, not stacked. Measure first, then build. The decision comes after PR 3; the rest only on "go".

1. **Core and adapters.** `src/judge/` as a library with a thin CLI: worktree, run the agent, re-run the check in the sandbox, `--protect`, skip detection, verdict including `conflict`, `judge_runs`, audit. Tested with a fake agent.
2. **Predictions and outcomes.** `--accept`, `p_self`, `p_process`, the tables `predictions` and `outcomes`, `vlyn calibration`.
3. **Measurement on hard tasks.** See the validation plan. Result in `docs/VALIDATION.md`.
   **Decision point.**
4. (only after "go") Sandbox of the agent process plus a key with a budget cap.
5. (only after "go") ACP adapter.
6. (only after "go") Learning loop: `strategy_values`, separate `α⁺` and `α⁻`, `ε` exploration, lessons steered by `δ`.
7. (only after "go") Extra control (ACC rule) and the delayed merge/revert reward.

The first measurement (10 easy tasks) was done with loose scripts. PR 1 and 2 make it repeatable. For PR 6 and 7 a second measurement applies: the accept rate per task type must rise over 3 rounds against a fixed strategy, otherwise the learning loop is not merged.

## Open questions

- Where do the 20 hard tasks come from: own repositories, or real issues from public repositories? How is contamination avoided?
- Who writes the held-out `--accept` checks, and how do we keep them from resembling the visible checks?
- Which baseline runs in PR 3: linejudge, swarm-orchestrator or both? Do they run reliably headless in the sandbox?
- How does an agent report a conflict: a fixed line in its final summary, or a separate field?
- What counts as "task type" in v1: a label in `tasks.json`, or a heuristic on the diff?
