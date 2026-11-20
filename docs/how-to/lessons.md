# Review lessons and apply them

Turn repeated task failures in this repository into a suggestion you can read, and optionally into one marked section of `AGENTS.md`.

## Steps

1. Use the journal that holds the runs. The default is `~/.vlyn`. `VLYN_HOME` or `--home` overrides it.

2. Print the suggestion. This does not write the repository.

   ```sh
   vlyn lessons
   vlyn lessons /path/to/repo
   ```

   The heading is `Lessons proposed from earlier runs`. Each line is `[status] text`. Statuses you will see are `unverified`, `supported`, and `contested`. A `retracted` claim stays in the journal and is left out of this text. No active lessons prints `No active lessons.`

3. Write the suggestion only when you want it in the repo.

   ```sh
   vlyn lessons --apply
   ```

   `--apply` rewrites the block between `<!-- vlyn-lessons:start -->` and `<!-- vlyn-lessons:end -->` in `AGENTS.md`. Lines outside that block are kept. If the file has no block, the block is appended. If the file does not exist, it is created with only that block.

4. Read the diff before you commit `AGENTS.md`. The text says the lines are claims from past checks, not orders.

## What planning already does

`vlyn auto` consolidates lessons for the repository and puts them ahead of ordinary recall. The planner still receives at most five items and about 2 KB. You do not need `--apply` for that. `--apply` is the only path that edits `AGENTS.md`.

A claim starts `unverified` from a failed or out-of-scope task, and becomes `supported` when that happens again. A later clean edit of the same files marks it `contested`. Weight drops when the failures that supported a claim are gone. That factor is an engineering choice in this code, not a fitted forgetting curve.
