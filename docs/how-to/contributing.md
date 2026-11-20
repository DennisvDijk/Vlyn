# Contributing

Change Vlyn and prove the change with the scripted tests. Policy and the CI list live in [CONTRIBUTING.md](../../CONTRIBUTING.md). This page is the sequence.

## Steps

1. Use Node 24.12 or newer. `.nvmrc` says `24`.

2. Install without running dependency scripts.

   ```sh
   npm ci --ignore-scripts
   ```

3. Branch from `main`. There are no runtime dependencies. A new one needs an ADR in the same pull request.

4. If you change behavior, add a test under `test/` that drives the public function with a scripted reply. Tests construct `model: async () => ({ text })`. They do not open a network connection to a model host.

5. Run the same commands CI runs.

   ```sh
   npm run lint
   npm run check
   npm test
   ```

   `lint` is `biome lint`. `check` is `tsc --noEmit`. `test` is `node --test test/*.test.ts`. Format is not a CI gate. `npm run format` rewrites the tree; do that only when you mean to.

6. Open the pull request. Describe the coding outcome the change produces and how a test shows it. If you add a command, add or update the how-to in `docs/how-to/` and the row in [docs/reference/commands.md](../reference/commands.md). Describe the command as it behaves on that branch.

## While you are in the tests

- Temporary Git repositories come from `test/helpers.ts`. Do not point tests at the developer’s real checkout.
- Do not put API keys in fixtures. `VLYN_API_KEY` in a test should be a fake string when a test needs the variable to exist.
- `npm run coverage` is optional and still marked experimental by Node. CI uploads it. It is not a merge gate.
