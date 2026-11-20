# ADR 0001: Actor brain snapshots live in the journal

## Status

Accepted for the actor runtime. Git worktrees remain the default place a task edits files.

## Context

A coding run needs to pause while a model or a person responds, survive a crash, and try two hypotheses without letting them overwrite each other. [Agent Substrate](https://github.com/agent-substrate/substrate) separates a stateful actor from a worker pool: idle actors are checkpointed, resumed when a message arrives, and reverted to a snapshot, with default-deny egress ([overview](https://ate.dev/docs/get-started/overview/), [API guide](https://ate.dev/docs/reference/api-guide/), [egress](https://ate.dev/docs/guides/network-egress/)). That picture fits. Substrate's cluster, gRPC control plane, and sandbox images do not. Vlyn has no runtime dependencies, and tests must not call a real control plane.

The actor model we are implementing is the one in Hewitt, Bishop, and Steiger (IJCAI 1973): addressable parties that exchange messages. The crash rule is Erlang/OTP's one-for-one supervision ([design principles](https://www.erlang.org/doc/system/design_principles.html)): restart the child that died, from a known state, and leave its siblings alone. Armstrong's thesis (*Making reliable distributed systems in the presence of software errors*, 2003) is the write-up of that idea. We do not run Erlang.

The memory analogy is in [the research note](../research/state-of-the-art.md). Checkpoint distills repeated failures ("sleep"). Resume with an outcome updates claims that were just used (reconsolidation). Neither is a claim about brains.

## Decision

- An actor is a row in the existing SQLite journal (`actors`, `brain_snapshots`, `actor_messages`).
- A brain snapshot is JSON: working context, task graph, a short episode slice, decision-journal entries (confidence before the outcome), claims, hypotheses, procedural text for the role, and an optional workspace reference `{ root, commit, diff }`. The diff is capped. The git tree is not copied into SQLite.
- Roles are templates: `supervisor`, `planner`, `coder`, `reviewer`, `verifier`. Procedural text is stored in the snapshot, so resume cannot silently change what the role is allowed to do.
- Idle means checkpointed and absent from the process map. A second `ActorRuntime` on the same file can claim the actor. That is the test that eviction is real.
- `revert` moves the current-version pointer. Older and newer snapshots stay readable, so a fork can still be compared with the attempt that was abandoned.
- `fork` copies one version into a sibling. Hypothesis races fork coders from one planner snapshot and edit separate worktrees. They do not read each other's diffs. The verifier accepts a hypothesis only when `executeTask` says `completed`.
- `supervise` retries the child once from the last snapshot. Unsaved mutations on the clone are discarded. A second throw leaves the actor `crashed`.
- No network client, no Substrate SDK, no new package.

## Consequences

- Crash recovery of *cognitive* state is the snapshot. Crash recovery of *files* is still `git reset --hard` on the task worktree, which the durable runner already does.
- Two hypotheses cost two worktrees, as parallel tasks already do. The actor layer adds a journaled brain so the loser remains inspectable after the winner is chosen.
- Snapshots can grow with diffs. The cap keeps a single brain from storing the repository. It also means a huge diff is truncated in the brain; the worktree still has the full diff.
- This does not sandbox the check command. Default-deny networking is Substrate's property, not ours, until a later phase says otherwise.
- A live model has not been run through actors. Scripted tests cover resume, revert, fork, supervision, and the hypothesis race.
