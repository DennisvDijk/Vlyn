# Resume an interrupted run

Continue a run after Ctrl+C, a closed terminal, or a crash. Finished tasks stay finished. A task that was mid-flight is reset and tried again.

## Steps

1. List what the journal has.

   ```sh
   vlyn runs
   ```

   Both this command and the interactive list print the first eight characters of the id. `vlyn resume` accepts that prefix when it matches exactly one run. `vlyn runs --json` includes the full id and the worktree directory.

2. Resume the latest unfinished run, or name one.

   ```sh
   vlyn resume
   vlyn resume <id-or-prefix>
   ```

   In the interactive session, `r` asks for an id and leaves it blank to take the latest unfinished run.

3. Wait for the remaining tasks. The review prompt opens when they stop. [Review results](review-results.md).

## What resume actually does

- Pending tasks run. Tasks already `completed`, `unverified`, or `failed` are left as recorded.
- A task found `running` is put back on the base commit of the run. Partial edits and untracked files in that worktree are removed, and the task starts over.
- A second process is refused while the recorded owner is still alive. If the owner died, the next resume takes the run.
- Ctrl+C stops claiming new tasks, lets the ones already running record their result, and prints the resume command.

The journal is `~/.vlyn`, or `VLYN_HOME`, or `--home`. It sits outside the repository.

## If resume refuses

- `Run <eight characters> is already being executed by process <pid>` means the other `vlyn` is still running. Finish or stop that process.
- `No matching unfinished run. Use runs to list them.` means every recorded run is `finished`, the prefix matched more than one run, or the journal is empty. The interactive session prints `No matching run.` instead. Start a new goal, or pass a longer prefix.
