# Contributing to Vlyn

Vlyn needs Node.js 24.12 or newer. Node 24 is the Maintenance LTS line and Node 26 is the Active LTS line ([Node.js release schedule](https://github.com/nodejs/release)). Node 27 is still Alpha and is not a CI target. The package has no runtime dependencies. It uses Node's built-in TypeScript stripper, SQLite, and test runner. Install scripts are not run:

```sh
npm ci --ignore-scripts
npm run lint    # Biome, rules only
npm run check   # tsc --noEmit
npm test        # node:test
npm run coverage
```

`npm run format` rewrites files with Biome. CI does not fail on format drift. A whole-tree format would collide with every open change, so formatting is available and not required yet.

## Typecheck

`tsconfig.json` turns on `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, and `erasableSyntaxOnly`. `isolatedDeclarations` is off: this package sets `noEmit` and is consumed by running `src/cli.ts` directly, so it does not publish `.d.ts` files. That flag would require an explicit return type on every export, including tests, without a consumer.

`lib` is `ES2023` plus `@types/node` for the minimum engine (Node 24). DOM globals are not in the program, so a name like `status` is not silently a browser global.

## Tests

Tests use scripted model replies and temporary Git repositories. They never call a live model or the network.

New behavior that touches the journal needs a recovery test: interrupt it, reopen the journal, and show nothing finished is redone.

Keep file access inside the project: no symbolic links, no paths outside the root.

## CI

GitHub Actions runs lint and typecheck once, tests on Linux, macOS, and Windows for Node 24 and Node 26, audits the lockfile, and runs a coverage job. Actions are pinned to commit SHAs. `permissions` stay read-only except where CodeQL, Scorecard, or provenance must write. Dependabot updates npm and Actions weekly. A provenance workflow packs a tarball and attests it. It does not `npm publish`: the package is `"private": true`, so npm provenance is not available yet.

The branch check to require is `CI result`.

This repository is private, and GitHub Code Security is not enabled. Two GitHub APIs then fail closed: code scanning ("Code scanning is not enabled for this repository") and the dependency review API (`403 Forbidden`). The workflows stay, and they call those APIs only when they can succeed:

- The repository is public, or
- An Actions variable opts in: `ENABLE_CODEQL=true` for CodeQL and for the Scorecard SARIF upload, `ENABLE_DEPENDENCY_REVIEW=true` for dependency review, `ENABLE_SCORECARD=true` for OpenSSF Scorecard. Scorecard's default token cannot list commits on a private repository, so the job skips unless the repository is public or that variable is set.

Set the variable only after the matching GitHub feature is enabled. Making the repository public turns both on with no workflow edit and no variable.

Until then, the dependency check that actually runs is `npm audit` against the lockfile, in the `Audit dependencies` job:

```sh
npm audit --package-lock-only --omit=dev --audit-level=high
npm audit --package-lock-only --audit-level=high
```

`--omit=dev` is the production slice. This package has no production dependencies, so that command audits nothing. The second command audits the toolchain devDependencies, which is the whole lockfile, and fails on high or critical npm advisories. It uses the npm advisory database, not GitHub's dependency graph. A high advisory that exists only in GitHub's graph is invisible until dependency review is allowed to run.

## License

Vlyn is under the Apache License, Version 2.0 ([LICENSE](LICENSE)). Contributions are under that same license. Inbound equals outbound: a submitted change is licensed to the project under Apache-2.0.

## Commits

Write the subject in the imperative, and say why in the body. Changesets are not used. They exist to version published packages, and this one is not published.
