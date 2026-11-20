# ADR 0002: Capability manifest, parent broker, OS sandbox when it exists

## Status

Accepted. Checks that belong to a task run under this policy. Edits outside the manifest are refused.

## Context

A coding agent reads untrusted repository text and runs a check the user named. The failure mode that matters is not a rude prompt. It is a check, or a model following text in a file, that reads a key, opens a network connection, or writes a file the task does not own.

[NIST SP 800-207](https://doi.org/10.6028/NIST.SP.800-207) says not to trust a request because it came from inside a boundary. [OWASP's prompt-injection entry](https://genai.owasp.org/llmrisk/llm01-prompt-injection/) says to keep privileges in code, not in the model. Node's own permission documentation says `--permission` is a seatbelt for trusted code and does not stop malicious code ([permissions](https://nodejs.org/api/permissions.html)). On Node 24.12, that flag denied a file read outside `--allow-fs-read` and did **not** stop `net.connect`. Landlock and seccomp would be the right Linux mechanisms. Applying them needs a native helper. This tree has no runtime dependencies and will not grow one for a bpf program we cannot test on every architecture.

Agent Substrate's picture (default-deny egress, credentials outside the sandbox, idle actors cost nothing while snapshotted) is the deployment shape. We do not call Substrate. Idle snapshots are the actor journal when that change is merged. This ADR is the confinement for the check and the writes.

## Decision

- Each task gets a manifest: readable roots, writable paths, the exact check string, `network: none` for the child, and an endpoint list for the **parent**.
- The model provider runs in the parent. The child environment is scrubbed of names that look like keys, tokens, secrets, passwords, or `NODE_OPTIONS`. Those values are redacted if they appear in output or in the audit detail.
- Writes outside the manifest throw `Approval required` and are hashed into the audit log. A grant adds the path. The file is not changed first.
- File text is scanned for a few instruction-shaped lines. Those lines are returned as flags. They are not orders.
- The check is launched with the strongest confinement actually present:
  - Linux with `bwrap`: filesystem binds and `--unshare-net`.
  - Linux with `unshare`: user namespace plus `--net`. Node checks also get `--permission`.
  - macOS with `sandbox-exec`: a deny-default profile and `(deny network*)`.
  - Otherwise a `node` check gets `--permission` (files only, on the build we measured).
  - Any other command, with none of the above, is `gate-only`: the allowlist still applies, the process is not confined. `--require-sandbox` refuses that.
- `landlock` and `seccomp` are reported `false`. We do not pretend a flag we did not set.
- Audit rows are a hash chain. `vlyn audit` prints them and exits 2 if the chain does not recompute.
- `vlyn doctor` prints the driver, the file control, and the network control.

## Consequences

- A `node -e` check on Linux here started in about 24 ms versus 21 ms without the sandbox, in one sample (`docs/security/overhead.json`). That is process startup, not a microVM. Other machines will differ. The test ceiling is 8 seconds.
- `npm test` on a machine without bubblewrap, unshare, or sandbox-exec is not network-confined. Doctor says so. `--require-sandbox` stops it.
- Node's permission model is not a boundary against a hostile script. The audit log and the manifest are still useful. They are not a substitute for a kernel sandbox when the check is untrusted.
- Host allowlists apply to the parent's model URL. They are not a per-host filter inside a child that we have already given a network namespace. Child network is all or nothing.
- Secrets that live in files outside the worktree are still readable by a non-node check when the filesystem driver is `none`. Do not put keys next to the repo and then run an unsandboxed shell check.
