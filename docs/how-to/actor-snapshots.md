# Inspect actor snapshots

See which coding actors are stored in the journal. This command does not start a run and does not call a model.

## Steps

1. Point at the same journal your runs use. The default is `~/.vlyn`. `VLYN_HOME` or `--home` overrides it.

   ```sh
   vlyn actors
   vlyn actors --json
   ```

2. Read a line as `id  role  state  version`.

   An empty journal prints `No actors yet.`

## What a row means

The runtime knows five roles: `planner`, `coder`, `reviewer`, `verifier`, `supervisor`. `state` is `idle` or `running`. `version` is how many brain snapshots have been written for that actor.

A snapshot is the state needed to continue the task: working context, the task graph, decisions, claims, hypotheses, and the worktree commit and diff. An idle actor is that snapshot in SQLite. It is not kept as a live object.

## What this command does not do

`vlyn auto` does not create actor rows. There is no `vlyn fork` and no `vlyn revert`.

Spawn, claim, checkpoint, revert, and fork are operations on `ActorRuntime` in `src/actors.ts`. `raceHypotheses` in `src/actor-coding.ts` forks coder siblings from a planner snapshot and accepts a result only when a verifier records `completed`. Those paths are covered by tests. They are not wired to the goal command.

The decision record is [docs/adr/0001-actor-brain-snapshots.md](../adr/0001-actor-brain-snapshots.md).
