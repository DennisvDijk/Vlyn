# Security

Vlyn is a local coding harness. It sends repository text to the model endpoint you configure, and it can run the check command you name.

Report a vulnerability by opening a private security advisory on this repository if GitHub allows it, or by contacting the repository owner directly. Do not include API keys, tokens, or live customer data in the report.

What this tree already does:

- No runtime dependencies. Development dependencies are installed with `npm ci --ignore-scripts`.
- CI audits `package-lock.json` with `npm audit --package-lock-only --audit-level=high`, including devDependencies, because those are the only packages installed. `npm audit --omit=dev` also runs and currently audits an empty production set. This is the check that works on a private repository. It consults the npm advisory database.
- CodeQL and GitHub dependency review are in the workflows and do not run their APIs here. On a private repository without GitHub Code Security, code scanning returns "not enabled" and the dependency review API returns `403 Forbidden`. They run when the repository is public, or when the Actions variables `ENABLE_CODEQL` and `ENABLE_DEPENDENCY_REVIEW` are set to `true` after those features are turned on. Scorecard still runs on its schedule; its SARIF upload uses the same code-scanning gate as CodeQL.
- Model keys stay out of the journal and out of error text in the provider code that exists today.
- File access for the agent refuses absolute paths, `..`, and symbolic links.

A capability manifest and OS sandbox for check commands is tracked on the roadmap. Until that lands, a check command runs as your user.
