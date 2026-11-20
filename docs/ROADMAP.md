# Vlyn phases

One file, shared by everyone working on Vlyn (people and bots). Update the status here in the same pull request as the work.

Status: **done** (merged), **in PR** (open, not merged), **next**, **later**. "Verified" means tests ran; nothing below has run against a live model yet.

| # | Phase | Status | Notes |
| --- | --- | --- | --- |
| 1 | Contract rehearsal: check proposed responses against deployed consumer contracts | done | `src/scheduler.ts`, `src/state.ts` |
| 2 | Standalone coding loop with per-task graph | done (PR #1) | `src/coding-agent.ts` |
| 3 | Parallel tasks in isolated Git worktrees | done (PR #2) | `src/parallel.ts` |
| 4 | Goal-driven planning, durable runs, interactive TUI, graph/impact/doctor tools | done (PR #3) | `planner.ts`, `durable.ts`, `tui.ts`, `graph.ts`, `tools.ts` |
| 5 | Every model system, live model refresh from the user's key (LiteLLM etc.) | done (PR #3) | `providers.ts` |
| 6 | Spec, file ownership, convergence of parallel results | done (PR #3) | merge on overlap; out-of-scope edits are `unverified`; `_integration` worktree |
| 7 | Memory, step 1: recall earlier run outcomes before planning | done (PR #3) | `memory.ts`, read from the journal |
| 8 | Memory, steps 2–5: typed memory with provenance, post-run reflection, validated procedures, agent context budget | next | Folded into phase 15. Do not start a second memory design |
| 9 | Run against a live model; fix what scripted tests hid | next | Still the largest unknown. Phase 14 is scripted on purpose and does not close this |
| 10 | `vlyn converge` command and applying a combined result to a branch | next | Folded into phase 17. Convergence today only runs at the end of a run |
| 11 | Cross-repository and deployed-service reasoning (repos, Terraform, YAML, Kubernetes as nodes and edges) | later | Vlyn's main differentiator; not built |
| 12 | Native tool calling per vendor; Gemini and Bedrock without a gateway | later | |
| 13 | GitLab CI alongside GitHub Actions | later | Requested for the wider project 2026-11-17 |
| 14 | Decision journal and `vlyn eval`: confidence recorded before the verdict, Brier score, honesty rate | in PR #7 | Coding outcome: a vain 0.9 cannot hide a failed check. Scripted suite only; no live endpoint in CI. See docs/research/state-of-the-art.md |
| 15 | Lesson store: consolidation, decay, reconsolidation, claim status, reviewed `AGENTS.md` suggestion | done (PR #6) | `src/lessons.ts`. Folds phase 8. `vlyn lessons` prints a suggestion. `--apply` writes only the marked section of AGENTS.md |
| 16 | Actor brain snapshots in the journal: pool, resume, revert, fork, one-for-one supervisor, role templates | done (PR #5) | `src/actors.ts`, `src/actor-coding.ts`, ADR 0001. `vlyn actors` lists rows. A goal run does not create them. No Substrate dependency. Git worktrees still hold the files |
| 17 | Pre-mortem gate, after-action note, `vlyn converge`, apply onto a named new branch | in PR #8 | Folds phase 10. Outcome: ambiguous plans do not edit; apply never checks out the user's branch |
| 18 | Capability sandbox and parent broker | in PR #9 | Keys stay in the parent. Doctor must say if the network is really confined. No Landlock/seccomp claim, no Docker |
| 19 | Toolchain: TypeScript 7 strict flags, Biome, split CI, supply-chain workflows | done (PR #10) | Node 24 and 26 on three OS. `isolatedDeclarations` off while the package is private and `noEmit`. No npm publish. CodeQL and dependency review run only for a public repo or when `ENABLE_CODEQL` / `ENABLE_DEPENDENCY_REVIEW` is set. Private CI uses `npm audit` on the lockfile |

## Research-grounded order

The argument is [research/state-of-the-art.md](research/state-of-the-art.md). Vlyn stays a coding tool. The brain and safety literature is analogy, with the limits in that note. Priority is the coding outcome, then whether a scripted test can show it.

| Order | Phase | Why this, and not a lookalike feature | Effort | How it is measured |
| --- | --- | --- | --- | --- |
| 1 | 16 Actor snapshots | Resume, revert, and fork are the difference between one contaminated workspace and two hypotheses you can compare. Substrate is credited as the idle-checkpoint picture; the implementation is SQLite | New module, journal tables, tests, ADR. Does not replace git worktrees | Cross-connection resume; supervisor restores the pre-crash brain; `raceHypotheses` keeps dissent and accepts only `completed` |
| 2 | 14 Decision journal and eval | Without a number, later phases cannot show they helped. Honesty and calibration are different numbers on purpose | New command and a committed baseline. No new runtime dependency | Pass rate, honesty rate, Brier, estimated tokens. Wall time is recorded and not pinned. Cost is null |
| 3 | 15 Lessons | Phase 8's "typed memory." Stops the planner repeating a known-bad file | Lesson table, recall budget, `--apply` off by default | Usefulness: the prompt contains the lesson and a scripted planner avoids the file. Retracted claims are not recalled. Strength decays when nothing reinforces them |
| 4 | 17 Pre-mortem, review, converge, apply | Phase 10, plus a stop before editing when the independent pass is uneasy | Planner gate, AAR text, branch create | Gate blocks edits; AAR names the failed task; `apply --branch` leaves HEAD and the checkout file bytes unchanged |
| 5 | 18 Capability sandbox | A check that can read the API key or open a socket is a broken coding tool, even if the diff is pretty. Cost has to stay a process, not a VM | Manifest, scrub, audit chain, per-OS driver, doctor line | Denied write does not touch the file. Child env lacks the key. `unshare` test sees `ENETUNREACH` on Linux. Doctor reports Landlock and seccomp off. Sandbox start under 8 s in the test; one sample was ~24 ms |
| later | 9 Live model | Scripted tests cannot see a model ignore the lesson | A person's key, outside CI | Write down which scripted cases hid a real failure. Do not treat phase 14 as a substitute |
| later | 11 Cross-repository | Still the long bet in the table above. Not started | Large | Not this round |
| not planned | Native vendor tool catalogs, tree-sitter repo maps, a general sandbox product | They make Vlyn look like other harnesses. They are in the research note only as things we are not copying | — | — |
## Working together (people and bots)

- Take one phase per branch and pull request; name it after the phase. Do not edit another open PR's files without saying so there.
- Tick the status here when a PR merges. Do not mark a phase done without passing tests and CI.
- Keep README limitations honest: say what is not verified.
- `src/model.ts` is only used by the contract rehearsal tests; leave it alone unless you are changing that.
