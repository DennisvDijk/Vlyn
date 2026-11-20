# Troubleshoot with `vlyn doctor`

`vlyn doctor` checks the machine and the repository. It does not call a model and it does not change files.

```sh
vlyn doctor
vlyn doctor /path/to/repo
```

Exit `0` means every required row passed. Exit `1` means Node or Git failed. A `warn` row does not change the exit code.

## How to read a row

Each line starts with `ok`, `FAIL`, or `warn`, then the check name, then a detail after `·`.

| Row | What it means |
| --- | --- |
| `Node.js 24.12 or newer` | Required. `FAIL` means this process is older than 24.12. Install Node 24 or Node 26 and run `vlyn` with that binary. |
| `Git available` | Required. `FAIL` means `git` is not on `PATH`, or `git --version` failed. |
| `Project is a Git repository` | Warning. `vlyn auto` needs a repository root. `graph` and `impact` do not. |
| `Working tree is clean` | Warning. The detail text says `batch requires a clean tree`. `vlyn auto` refuses a dirty tree too, with `Runs require a clean working tree.` `vlyn code` will still edit the tree. |
| `Model endpoint configured` | Warning. This only checks that a key and base URL resolve in the environment. It does not open a connection. No key and a non-local URL produce `no key found; set VLYN_API_KEY`. A bad URL that fails the https rule throws into the detail. Use `vlyn models` to see whether the endpoint answers. |

A passing endpoint row does not mean the model id exists.

## Fixes that match the row

- Node too old: the engine field is `>=24.12.0`. A Node 22 binary fails on purpose, because the CLI uses `node:sqlite` and TypeScript type stripping from that line.
- Dirty tree on a run you do not want to commit yet: `git stash -u`, then `vlyn auto`.
- The endpoint row warns on a laptop server until `VLYN_BASE_URL` is `http://127.0.0.1:<port>/v1` (or localhost). An `http` URL on another host is refused unless `VLYN_ALLOW_INSECURE=1`, which sends the key in clear text. Prefer TLS. Doctor still does not connect; `vlyn models` does.
- Doctor passed and `auto` still errors: the next message is from the planner or Git, not from doctor. A missing key at plan time, a dirty tree, or a model that returned an unusable plan are the usual ones.

## What doctor does not report

It does not report a sandbox, Landlock, or seccomp. Those are not in this build. A confinement line is planned with the sandbox work. Until then, assume checks run with your user and your environment.
