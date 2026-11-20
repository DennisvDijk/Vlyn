# Security

Vlyn is a local coding harness. It sends repository text to the model endpoint you configure, and it can run the check command you name.

Report a vulnerability by opening a private security advisory on this repository if GitHub allows it, or by contacting the repository owner directly. Do not include API keys, tokens, or live customer data in the report.

What this tree already does:

- No runtime dependencies. Development dependencies are installed with `npm ci --ignore-scripts`.
- Model keys stay out of the journal and out of error text in the provider code that exists today.
- File access for the agent refuses absolute paths, `..`, and symbolic links.

A capability manifest and OS sandbox for check commands is tracked on the roadmap. Until that lands, a check command runs as your user.
