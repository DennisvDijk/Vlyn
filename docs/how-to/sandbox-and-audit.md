# Read the sandbox and the audit log

See what this machine can actually confine, refuse a check when it cannot, and read the hash-chained log.

## See the posture

```sh
vlyn doctor
```

Besides Node, Git, the tree, and the endpoint, there is a `Check sandbox` row. It is a warning. A weak sandbox does not by itself make `doctor` exit 1. Node and Git still do.

The detail is `driver · files <mode> · network <mode> · landlock off · seccomp off`. Landlock and seccomp are always reported off. The row is `ok` when the driver isolates the process. That includes Node's `--permission` even when `network` is `none`, which means the network was not cut. The row is `warn`, and the driver is `gate-only`, when the only control is the in-process gate.

Node's `--permission` flag limits file reads for a `node` check. On Node 24.12 it did not stop `net.connect`. Trust the `network` field in the doctor line, not the presence of the flag.

## Refuse a weak machine

```sh
vlyn auto --goal "Add input validation" --check "npm test" --require-sandbox
vlyn code --task "Fix the failing test" --check "npm test" --require-sandbox
```

The check is refused before it starts in two cases. If the manifest wants no child network and this driver cannot cut the network, the error is `Refusing <command>: this OS has no network sandbox (<driver>). Landlock and seccomp are not active.` If the only control is the in-process gate, the error is `Refusing <command>: only the in-process gate is available (<driver>).` The process then exits 1.

`vlyn resume --require-sandbox` uses the same flag, because resume and auto share that path. `vlyn batch` does not pass the flag through. A batch check is not refused for a missing sandbox.

## Read the audit log

```sh
vlyn audit
vlyn audit <run-id-prefix>
vlyn audit --json
```

The first line is `audit chain ok`, or `audit chain broken at <n>`. The command exits 2 when the chain is broken and 0 when it is intact. Later lines are `allow` or `deny`, the actor id, the action, and the target. No rows prints `No audit events.`

With a run id, the events are that run's. The chain check still walks the whole log. An unknown id exits 1 with `No matching run.`

`--json` prints `ok`, `brokenAt`, and `events`.

## What the check is allowed to see

The API key stays in the parent process. The check's environment drops variables whose names look like secrets, and those values are redacted out of tool output and this log. A child gets no network unless the manifest asks for unrestricted network, and only when the driver can enforce that. If the driver cannot, `--require-sandbox` is the way to stop.

The threat model is [docs/security/threat-model.md](../security/threat-model.md). The decision is [docs/adr/0002-capability-sandbox.md](../adr/0002-capability-sandbox.md). One timing sample is [docs/security/overhead.json](../security/overhead.json). That sample is one machine, not a limit.
