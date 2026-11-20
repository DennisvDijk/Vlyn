# Install and first run

Get a working `vlyn` command and print a plan. This stops before any agent edits a file.

## Before you start

- Node.js 24.12 or newer. `node -v` must report that. Older Node fails `vlyn doctor`.
- Git on `PATH`.
- A Git repository you are willing to send excerpts of to a model. The first run below uses `--plan-only`, so the model sees the goal and the file list the planner reads, and writes nothing back.

## Steps

1. Clone this repository and install the command.

   ```sh
   npm ci --ignore-scripts
   npm link
   ```

   `npm link` puts `vlyn` on your PATH. Without it, run `node src/cli.ts` from this clone. There is no published package.

2. In the project you want to change, confirm the tree.

   ```sh
   cd /path/to/your/project
   git status
   vlyn doctor
   ```

   `doctor` exits 1 when Node or Git is missing or too old. A dirty tree is a warning, not a failure. `vlyn auto` refuses a dirty tree. Commit or stash first.

3. Set a key if you are not talking to a local server. See [Connect a model](connect-a-model.md).

4. Ask for a plan and stop.

   ```sh
   vlyn auto --goal "Add input validation to the CLI" --check "npm test" --plan-only
   ```

   You should see one line per task, `id: instruction`, plus any warning. A warning is how overlap is reported: tasks that own the same files are combined before you see the list. The planner also builds a spec (non-goals, assumptions, acceptance, risks). `--plan-only` does not print that spec, and it does not create a journal run or a worktree. The spec is stored, and handed to each agent, only when a run actually starts.

5. When the plan is the one you want, drop `--plan-only`. That starts the run. Read [Run a goal](run-a-goal.md) before you do.

## If something else happens

- `Missing VLYN_API_KEY` means no key and the base URL is not local. [Connect a model](connect-a-model.md).
- `vlyn: command not found` means `npm link` did not land on this shell's PATH. Use `node /path/to/Vlyn/src/cli.ts`.
- Doctor lines about the endpoint are about reachability, not about whether the model is any good.
