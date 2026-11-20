# Use graph and impact in CI

Fail a job when the JavaScript or TypeScript import graph has a cycle, and print which tests mention a changed file. Neither command calls a model.

## Graph

```sh
vlyn graph .
vlyn graph . --format mermaid
vlyn graph . --format dot
vlyn graph . --format json
```

Exit code `2` means at least one import cycle, for the default text format and for `--format json`. `--format mermaid` and `--format dot` draw the graph and exit `0` even when a cycle is present, so they will not fail a job. Use the default format in CI:

```yaml
- run: npm ci --ignore-scripts
- run: node src/cli.ts graph .
```

The scanner reads relative `import`, `export … from`, `import()`, and `require` in `.js`, `.jsx`, `.ts`, and `.tsx`. A `.js` specifier can resolve to a `.ts` file. It skips `node_modules`, build output, and symbolic links. Dynamic path construction and package imports are invisible, so a green graph is a lower bound, not a proof of acyclicity for the whole program.

## Impact

One file:

```sh
vlyn impact . --file src/api.ts
```

Everything changed since a revision:

```sh
vlyn impact . --since main
```

The text output lists importers and test files that mention the path. `--json` prints the same data for a script. A `--file` path that was not scanned makes the command throw `Not a scanned project file` and exit `1`. `--since` with no scanned changes throws `Give at least one --file, or --since REVISION with changes`.

A CI job can print impact without failing the build:

```yaml
- run: node src/cli.ts impact . --since "${{ github.base_ref }}"
```

`--since` shells out to `git diff`. The checkout has to contain that revision.

## What not to expect

Impact does not run tests. It does not see Python, Go, or Rust. It does not follow barrels that re-export through a package name. When the graph misses an edge, impact misses it too.
