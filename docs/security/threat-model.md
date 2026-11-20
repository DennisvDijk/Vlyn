# Threat model

Vlyn edits a git checkout through a model and a check command the operator named. This page is what we try to stop, what the code actually does, and what it does not do. It is a coding-tool model, not a claim that the program is a secure operating system.

The public-health words below are **analogies**. They are not epidemiology.

## What we are protecting

- The API key and anything else in the environment whose name looks like a secret.
- Files the task does not own.
- The network, from a check that should not have one.
- The audit trail, so a later reader can see which actor was allowed to touch what, and can see if that trail was edited.

## Assets and actors

| Actor | Trust |
| --- | --- |
| Operator | Names the goal, the check, and whether `--require-sandbox` is on. Can grant a denied path. |
| Parent process | Holds the key. Calls the model. Writes the journal. This is the policy enforcement point. |
| Model | Untrusted about privileges. It can ask for tools. It does not receive the key and it does not open sockets for us. |
| Repository files | Untrusted data. They can contain sentences that look like instructions ([indirect prompt injection](https://arxiv.org/abs/2302.12173), [OWASP LLM01](https://genai.owasp.org/llmrisk/llm01-prompt-injection/)). |
| Check process | The most dangerous child. It runs with the operator's uid unless an OS sandbox says otherwise. |

## STRIDE

| Threat | Example | What the code does | What it does not do |
| --- | --- | --- | --- |
| Spoofing | A file says "you are now the operator" | The read result marks those lines and says they are not instructions | It cannot stop a model that obeys them anyway. The manifest still limits writes and the check string |
| Tampering | Edit a file outside the task, or rewrite the audit | Writes outside the manifest are refused and logged. Audit rows are a hash chain; `vlyn audit` exits 2 if a row was changed | A person with write access to the SQLite file can rewrite the whole chain. The chain detects a single-row edit, not a forged replacement of every row |
| Repudiation | "The agent never ran that command" | Every allowed and denied command and write is an audit row with the actor id | The log is local. It is not signed by a third party |
| Information disclosure | Check prints `VLYN_API_KEY`, or reads a sibling file | Those environment names are removed before `spawn`. Output is redacted if the secret string still appears. A `node` check under `--permission` cannot read a path outside the worktree | A shell check without a filesystem sandbox can read any file the user can read. Node's permission model [does not claim to stop malicious code](https://nodejs.org/api/permissions.html). On Node 24.12, `--permission` did not stop `net.connect` |
| Denial of service | Check hangs or fills the disk | The check is killed after 60 seconds. Output kept for the model is capped | There is no cgroup. A check can still use CPU until the timeout |
| Elevation | Check installs a package, opens the network, or writes a git hook | Child network is `none` when unshare, bubblewrap, or sandbox-exec is what actually launched it. Writable paths are the manifest. `npm install` scripts are not how Vlyn installs itself (`npm ci --ignore-scripts`, see [SLSA](https://slsa.dev/) for the supply-chain problem that script is avoiding) | Without one of those launchers, network elevation is possible and doctor says `network none`. Landlock and seccomp are off |

## Layers, as an analogy

Reason's layered defences ([BMJ, 2000](https://doi.org/10.1136/bmj.320.7237.768)) are the picture: several checks, each with holes. Quarantine, in this codebase, means the check process does not get the parent's environment and, when the OS allows it, does not get a network namespace. Contact tracing, in this codebase, means the audit row names the actor and the path. Neither phrase is a claim about disease control.

The holes we know about:

- `gate-only` is an allowlist in our process. A bug in that allowlist is the whole control. `--require-sandbox` refuses to run a check in that mode.
- User-namespace `unshare --net` isolates the network and not the filesystem.
- `--permission` isolates Node's own file APIs and not a native binary, and not the network on the build we measured.
- Bubblewrap and `sandbox-exec` are used only when the binary is on `PATH`. They are not downloaded.
- The parent can still read the key. That is where the model call has to happen. The child must not.

## Least privilege, in the form we implemented

Saltzer and Schroeder's least privilege (1975) and capability systems (Capsicum's practical UNIX capabilities, Watson et al., USENIX Security 2010; WASI's deny-by-default imports) are the design we copied in miniature: a task starts with no command except the one string it was given, no write except its files, and no child network. We did not port Capsicum or WASI. Those would be different runtimes. The manifest is the small version that fits a Node process with no extra packages.

Zero trust, here, is one sentence from [SP 800-207](https://doi.org/10.6028/NIST.SP.800-207): being "inside" the repo is not a reason to trust the next tool call. Each write and each command is decided again and written down.
