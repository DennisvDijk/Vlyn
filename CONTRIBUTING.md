# Contributing to Vlyn

Vlyn needs Node.js 24.12 or newer. It has no runtime dependencies and uses Node's built-in TypeScript, SQLite and test runner.

```sh
npm ci --ignore-scripts
npm run check   # typecheck
npm test        # all tests, including CLI, durable-run recovery and TUI tests
```

Guidelines:

- Tests use scripted model replies and temporary Git repositories. They never call a live model or the network.
- New behavior that touches the journal needs a recovery test: interrupt it, reopen the journal, and show nothing finished is redone.
- Keep file access inside the project: no symbolic links, no paths outside the root.
- CI runs the same two commands on Linux, macOS and Windows.
