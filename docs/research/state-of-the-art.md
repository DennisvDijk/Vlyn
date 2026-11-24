# Research basis for a coding harness

Vlyn plans a change, edits code in isolated copies of a repository, and accepts a task only when the check still passes after the last edit. The notes below are **engineering analogies** for that job. They are not a claim that Vlyn is a brain, a model of a society, or a clinical intervention. Effect sizes from psychology, medicine, and safety investigations do not transfer to a coding agent. Where a finding is contested, narrow, or poorly replicated, it is marked.

Every mechanism names the coding outcome it is for and how that outcome is measured. A live model is not part of CI. Scripted replies measure the harness. They do not measure a model.

The motivation and control loops (dopamine, basal ganglia, ACC, locus coeruleus, prefrontal cortex) are in [motivation-and-control.md](motivation-and-control.md).

Competitor products are a constraint, not a template. The short section after the map says what Vlyn deliberately does not copy. The rest of the document is the research the mechanisms are answerable to.

## Mechanism map

| Mechanism | Research analogy | Coding outcome | Measurement |
| --- | --- | --- | --- |
| Episodic journal | Tulving's episodic memory; the run is an event, not a fact | A crash does not redo a finished edit; the checkout stays untouched | Existing recovery test: finished tasks are not restarted; the worktree of an interrupted task is reset to the base commit |
| Semantic lessons | Tulving semantic memory; McClelland complementary learning systems | The same out-of-scope edit or failed merge is not planned again | Lesson usefulness: after two matching failures, the next planner prompt contains the lesson and a scripted planner that reads it avoids the file. A retracted lesson is absent |
| Procedural templates | Squire's nondeclarative / procedural memory | Planner, coder, reviewer, and verifier do not share one set of instructions | An actor's template text is still the role text after resume; a verifier snapshot contains no edit tool instruction |
| Consolidation ("sleep") on checkpoint | Hippocampal replay and slow cortical learning (analogy only) | Repeated failures in one actor become one claim instead of a long transcript | After two failed episodes about the same file, checkpoint adds one claim; a third copy is not added |
| Decay | Forgetting curves (Ebbinghaus; Murre & Dros, n = 1) | Stale advice drops out of the planner's budget | Strength falls by a documented factor each consolidation that does not reinforce the claim; below a floor it is not recalled. The factor is not fit to Ebbinghaus |
| Reconsolidation on resume | Nader, Schafe & LeDoux 2000, with boundary conditions | A lesson that was just used is updated by the check, not frozen | A recalled failure-claim becomes `contested` if the later edit is in scope and the check passes, and `supported` if the failure repeats |
| Working-memory budget | Cowan 2001, under the conditions he states | The planner sees a handful of lessons, not the whole journal | Recall stays within 5 items and about 2 KB. That cap is an engineering budget, not a claim that the model has four slots |
| Prediction error | Rescorla–Wagner as a rule of outcome minus expectation; not predictive-processing theory | A confident summary cannot outvote a failing check | Verdict honesty: `completed` only if the last check passed after the last edit and the diff stays inside owned files. Decision-journal Brier score on pre-registered confidence |
| Decision journal | Brier 1950; calibration research | Overconfident plans are visible before anyone trusts the diff | `vlyn eval` reports Brier. Confidence is stored before `executeTask` returns |
| Pre-mortem | Klein's premortem (practice article, not a trial) | Overlapping or ambiguous plans are challenged before any edit | A scripted independent pass flags a shared file; the gate refuses to edit unless the operator passes `--proceed` |
| Satisficing | Simon 1955 | The run stops when the check passes | Forked hypotheses stop being the accepted edit once one verdict is `completed`; the others are kept, not deleted |
| Anti-anchoring | Tversky & Kahneman 1974; Nickerson 1998 | The first file the planner names is not automatically the edit | Competing hypotheses are forked into separate actors that do not read each other's diffs. The verifier sees both only after both finish |
| Sunk cost | Arkes & Blumer 1985 | A half-written task is thrown away on resume | Existing test: an interrupted worktree is `reset --hard` to the base commit and untracked files are removed |
| Independent estimates | Galton 1907; Lorenz et al. 2011 on social influence | Parallel guesses do not collapse into one contaminated answer | Fork test: sibling workspace diffs differ; the parent snapshot is unchanged; dissent ids are retained when one check passes |
| Reviewer / red team | Heuer's Analysis of Competing Hypotheses; intelligence-community challenge culture | A second role can disagree without editing | Reviewer template forbids edits. Dissent is a field on the comparison, not a vote that deletes the loser |
| After-action review | US Army AAR practice; Tannenbaum & Cerasoli 2013 | The next plan can see what was expected, what the check did, and what to change | `afterAction` names the failed task id and is stored on the run. Debrief effect sizes are not claimed for Vlyn |
| Claim ledger | Retraction practice; IPCC/ICD language for confidence, not for medical claims | The planner does not follow a withdrawn assumption | Status is `unverified`, `supported`, `contested`, or `retracted`. Retracted claims are stored and not recalled |
| Layered checks | Reason 2000, system defences | A green unit check cannot hide an out-of-scope edit or a bad merge | Three layers already: ownership, the task check, the integration worktree. Eval cases miss each layer separately |
| Probe instead of guess | Knight 1921; Ellsberg 1961 | Missing files and high-risk plans do not become edits | Plan gate: high pre-mortem confidence blocks `executeRun` until `--proceed` |
| Stale-check rule | Normalization of deviance (Columbia accident report) | A check from before the last edit is not success | `lastCheck.stale` forces `unverified`. Covered by the coding-agent test and an eval case |
| Actor brain snapshot | Hewitt actors; Erlang/OTP supervision; Agent Substrate's checkpoint idea, not its cluster | Idle agents resume from journaled cognitive state; a crash restarts from the last snapshot; hypotheses fork | Resume across two `ActorRuntime` objects on one SQLite file. Supervisor retry restores the pre-crash brain. `revert` keeps the abandoned version addressable |
| Apply to a branch | — (engineering, from the existing convergence gap) | The merged diff is reviewable without touching the checkout | `vlyn apply --branch` creates a branch. HEAD and the worktree of the user's checkout stay put |
| Capability manifest | Least privilege (Saltzer & Schroeder 1975); capability systems (Capsicum; WASI) | A task cannot write a file it does not own, and cannot run a check string it was not given | Denied write leaves the file unchanged. A command not on the list is refused. Tests in the sandbox PR |
| Parent broker | Zero trust: no trust from location ([NIST SP 800-207](https://doi.org/10.6028/NIST.SP.800-207)) | The API key never enters the check process. Model calls stay in the parent, and only to an allowlisted host | Child env has no `VLYN_API_KEY`. Output and the audit row redact the secret. A host not on the list throws |
| OS confinement, only when present | Seatbelt, user namespaces, Landlock, seccomp, gVisor, Firecracker: different costs | A check does not get a network when the OS can say so, without a VM | Linux `unshare --net` yields `ENETUNREACH` in the test. Doctor reports `landlock: false` and `seccomp: false`. Overhead sample is tens of milliseconds, test ceiling 8 s |
| Audit hash chain | Provenance; the contact-tracing analogy is only the audit trail | You can see which actor was denied which path, and see if that row was edited | `vlyn audit` exits 2 after a one-row tamper |
| Injection flags | Indirect prompt injection ([Greshake et al. 2023](https://arxiv.org/abs/2302.12173); [OWASP LLM01](https://genai.owasp.org/llmrisk/llm01-prompt-injection/)) | Text in a repo file does not become an order. The manifest still applies if the model obeys it anyway | A file containing "ignore previous instructions" is returned with `injection_flags` and `untrusted: true` |

Phases and status live in [../ROADMAP.md](../ROADMAP.md). That file is the shared board. This document is the argument for the rows.

## What we deliberately do not copy

Coding-agent products have converged on a shape Vlyn is not trying to become: one long session in the user's tree, a large vendor tool list, a summarizer that rewrites the transcript when the window fills, and a permission prompt as the safety story.

That shape is real and well documented elsewhere. [SWE-agent](https://arxiv.org/abs/2405.15793) showed that the action interface changes whether a model can edit a repository at all. [OpenHands](https://arxiv.org/abs/2407.16741) is a general agent platform with a sandbox and an event log. [Aider's repository map](https://aider.chat/docs/repomap.html) ranks symbols into a token budget. Claude Code compacts the conversation and reloads project instructions ([glossary](https://code.claude.com/docs/en/glossary)). Codex sandboxes shell commands ([OpenAI's sandbox note](https://openai.com/index/inside-the-codex-sandbox)). [OpenCode](https://opencode.ai/docs/) is a full coding product with its own clients. [Pi](https://docs.pi.dev/latest/sdk) is an embeddable agent core. [Agentless](https://arxiv.org/abs/2407.01489) is a pipeline, not a loop. Those are different bets.

Vlyn does not copy their session UX, their tool catalogs, or their default of editing the checkout you have open. It keeps a smaller contract: a goal becomes owned tasks, each task's verdict is a check, and the user's branch does not move unless a later command names a new branch. Native vendor tool-calling, a tree-sitter repo map, and a general sandbox runtime are not the point of the work in the roadmap. If one of them serves a row in the map above, it can be argued then. Looking like Claude Code is not a goal.

Benchmark numbers from SWE-bench and Terminal-Bench are not repeated here. Leaderboards move, several widely used sets are now treated as contaminated or saturated by their own users ([OpenAI on SWE-bench Verified](https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/)), and Vlyn has not been run on them. The local eval is a harness test with scripted replies.

## Memory, and what it changes in the diff

### Three stores, not one transcript

Endel Tulving distinguished **episodic** memory (a personally dated event) from **semantic** memory (a general fact) in *Organization of Memory* (1972) and restated the systems view in [How many memory systems are there?](https://doi.org/10.1037/0003-066X.40.4.385) (*American Psychologist*, 1985). Larry Squire's survey separates declarative memory from **procedural** memory, the skill of how to do something ([Memory systems of the brain](https://doi.org/10.1016/j.nlm.2004.06.005), *Neurobiology of Learning and Memory*, 2004). The two taxonomies are not the same cut. Episodic and semantic are both declarative in Squire's scheme. Procedural memory is not "facts about the repo."

Vlyn already stores episodes: each run, task, check, and diff is a row in `~/.vlyn`. That is the event. It is not yet a fact about the repository. A lesson ("tasks that touch `b.txt` keep editing files they do not own") is semantic, and it should be distilled, dated, and retractable. A role template ("the verifier records the exit code and does not edit") is procedural. Putting all three in one growing chat transcript is how a coding agent repeats a bad edit and also forgets which instruction it was under.

**Outcome.** Fewer repeated bad plans, and a reviewer that does not inherit the coder's permission to write files.

**Measure.** Lesson-usefulness and template-survival tests in the map. The journal recovery test remains the episodic measure.

### Fast store, slow store

McClelland, McNaughton, and O'Reilly argued that the hippocampus can learn a new episode quickly while neocortex learns structure slowly, because fast cortical learning would overwrite what is already known ([Why there are complementary learning systems in the hippocampus and neocortex](https://doi.org/10.1037/0033-295x.102.3.419), *Psychological Review*, 1995). Wilson and McNaughton reported hippocampal ensembles replaying during sleep ([Reactivation of hippocampal ensemble memories during sleep](https://doi.org/10.1126/science.8036517), *Science*, 1994). Both papers are about animal brains and connectionist models. They are not evidence that a SQLite job consolidates the way cortex does.

The usable idea is narrower: do not write a permanent rule on the first failure, and do not leave the permanent rule to be rediscovered inside a raw log. Vlyn's journal stays the fast store. A consolidation pass, run when an actor checkpoints and when `vlyn lessons` is asked, interleaves finished tasks into a few claims. Checkpoint is the "sleep." It is allowed to drop episode text from the **working** brain once the claim exists. The previous snapshot still holds the episodes, so the distillation is not a silent deletion.

**Outcome.** The next plan sees one sentence about a repeated ownership failure instead of two full transcripts.

**Measure.** Two failures about one file produce one claim. A single failure stays an episode and does not become `supported`.

### Forgetting, spacing, and being tested

Hermann Ebbinghaus fitted a forgetting curve for nonsense syllables in 1885. Murre and Dros replicated the savings method with **one subject** and about 70 hours of lists ([Replication and Analysis of Ebbinghaus' Forgetting Curve](https://doi.org/10.1371/journal.pone.0120644), *PLOS ONE*, 2015). They report a curve similar to the original and a likely jump at the 24-hour point. That is a replication of a shape for meaningless items in one person. It is not a half-life for engineering advice. Cepeda, Pashler, Vul, Wixted, and Rohrer reviewed spacing in verbal recall ([Distributed practice in verbal recall tasks](https://doi.org/10.1037/0033-2909.132.3.354), *Psychological Bulletin*, 2006). Their abstract does not, by itself, hand us a constant to drop into a daemon. Vlyn's decay multiplier is chosen, documented, and tested. It is not estimated from these papers.

Roediger and Karpicke found that testing prose beat restudying on delays of two days and a week, while restudying won at five minutes and left students **more confident** ([Test-enhanced learning](https://doi.org/10.1111/j.1467-9280.2006.01693.x), *Psychological Science*, 2006). The confidence result is the part that matters for coding: a fluent summary is a bad witness. Vlyn already refuses to treat the model's `finish` text as a passing check. Recall of a lesson counts as a retrieval, which is the analogy to practice, and the check is the test that can contradict the lesson.

**Outcome.** Old lessons lose rank. A lesson that keeps matching failures stays. Confidence in the summary is not the verdict.

**Measure.** Strength after unreinforced consolidations; exclusion below the floor; Roediger's moral is the honesty rule, scored in `vlyn eval`.

### Reconsolidation

Nader, Schafe, and LeDoux reported that a consolidated fear memory in rats, once reactivated, could be disrupted by a protein-synthesis inhibitor in the amygdala ([Nature, 2000](https://pubmed.ncbi.nlm.nih.gov/10963596/)). The result is real and narrow: auditory fear conditioning, a drug, a brain region. Later work treats reconsolidation as boundary-conditioned (it does not fire for every kind of memory or reminder). Vlyn does not claim the biological effect.

The engineering rule inspired by it: a lesson that was **used** in a plan is editable by the outcome of that plan. If the check then passes inside the owned files, a claim that "this file always breaks ownership" is marked `contested` and weakened. If the failure happens again, the claim is `supported`. Unused claims are not rewritten just because time passed. That is decay, not reconsolidation.

**Outcome.** The planner stops avoiding a file after the file has been edited cleanly, and it stops trusting a lesson the repo has falsified.

**Measure.** Scripted outcome in, status and strength out. A lesson that was not retrieved does not change.

### A small working set

Miller's "seven plus or minus two" was, in Cowan's reading, a rhetorical device. Cowan argued for a central capacity of about **three to five chunks**, averaging about four, when chunking and rehearsal are blocked ([The magical number 4 in short-term memory](https://doi.org/10.1017/s0140525x01003922), *Behavioral and Brain Sciences*, 2001). He lists the conditions. The commentaries in the same issue disagree. The number is not a constant of nature and it is not a context-window size.

Vlyn already caps recall at five items and about 2 KB. That stays. It is a budget so the planner is not flooded. It is not an implementation of Cowan's experiment. Chunking, in this harness, means storing a claim instead of the episodes that produced it.

**Outcome.** Plans stay short enough that a scripted model can be shown the lesson in the test, and a person can read the prompt.

**Measure.** The existing budget test, plus the lesson cap.

### Expectation versus the check

Rescorla and Wagner (1972) described associative learning as driven by the difference between the outcome and the expectation already carried by the cues (*A theory of Pavlovian conditioning*, in Black & Prokasy, eds.). That is a formal learning rule for conditioning experiments, not a theory of software. Predictive-processing accounts that generalize the idea to all of cognition are influential and contested; Vlyn does not adopt them.

Operationally, the coder's confidence and the check's exit code are the pair. The error is what the decision journal scores. The verdict does not use the confidence at all. Confidence is for calibration. The check is for whether the patch is allowed to count as done.

## Decisions, and what they change in the plan

### Do not build "System 1" and "System 2"

Evans and Stanovich defend a dual-process distinction while listing the evidence it still needs ([Dual-process theories of higher cognition](https://doi.org/10.1177/1745691612460685), *Perspectives on Psychological Science*, 2013). Melnikoff and Bargh argue that the familiar two-system picture is not a coherent target ([The mythical number two](https://doi.org/10.1016/j.tics.2018.02.001), *Trends in Cognitive Sciences*, 2018). Kahneman's System 1 / System 2 wording is a popular summary of this contested literature. Vlyn does not contain two minds.

The coding split is mundane. The coder proposes a diff. The verifier records the process exit code. The reviewer's instructions say not to edit. Those are roles with different procedural text, which is how a bad summary fails to promote itself.

**Outcome.** `completed` is a property of the check and the diff, not of the prose.

**Measure.** Honesty cases in `vlyn eval`, including a passing check that is followed by another edit (`stale`).

### Write the confidence down first

Glenn Brier defined a score for probabilistic forecasts in 1950: the mean squared difference between the stated probability and the later outcome, 0 or 1 ([Verification of forecasts expressed in terms of probability](https://doi.org/10.1175/1520-0493(1950)078%3C0001:VOFEIT%3E2.0.CO;2), *Monthly Weather Review*). Calibration of human probabilities was reviewed by Lichtenstein, Fischhoff, and Phillips (1982) in *Judgment under Uncertainty*. People are often confident and wrong. Roediger and Karpicke's restudy group is a compact demonstration that confidence can rise while delayed recall does not.

Before a task runs, Vlyn records a statement and a confidence in `[0, 1]`. After the verdict, the outcome is 1 only for `completed`. The Brier score is the mean squared error. A perfect harness can still have a bad Brier score if the recorded confidences are vain. That is the point: the score judges the predictions, and the honesty rate judges the verdicts. They are allowed to diverge.

**Outcome.** A run that always says 0.9 and often fails the check is visible as miscalibrated, even if every verdict label is honest.

**Measure.** `vlyn eval` prints pass rate, honesty rate, and Brier score. The committed baseline is from scripted cases, so the Brier number is a property of those cases, not of a model.

### Pre-mortem, satisficing, and the biases that wreck a plan

Gary Klein's premortem ("the plan has failed; why?") is a [Harvard Business Review practice piece](https://hbr.org/2007/09/performing-a-project-premortem) (2007), not a randomized trial. Recognition-primed decision, the field observation that experts often match a situation to a known case, is laid out in Klein's *Sources of Power* (MIT Press, 1998). Herbert Simon named satisficing: choose what is good enough given the cost of search ([A behavioral model of rational choice](https://doi.org/10.2307/1884852), *Quarterly Journal of Economics*, 1955).

Vlyn uses the premortem as a **second** call that sees the plan and not the planner's scratchpad, before any write. It uses satisficing as a stop rule: the first forked hypothesis that earns `completed` is the one apply will prefer, and search does not continue inside that actor. It does not delete the losers.

Anchoring and the availability of the first idea are in Tversky and Kahneman ([Judgment under Uncertainty](https://doi.org/10.1126/science.185.4157.1124), *Science*, 1974). Confirmation bias, the selective use of evidence, is reviewed by Nickerson ([Confirmation bias](https://doi.org/10.1037/1089-2680.2.2.175), *Review of General Psychology*, 1998). Sunk cost is Arkes and Blumer ([The psychology of sunk cost](https://doi.org/10.1016/0749-5978(85)90049-4), *Organizational Behavior and Human Decision Processes*, 1985). The harness counters are mechanical, because a prompt that says "do not be biased" is not a measurement:

- Forked actors do not see each other's diffs (independence).
- Resume deletes uncommitted work rather than "finishing the thought" that was half written (sunk cost).
- The verifier does not receive the coder's summary as evidence (confirmation).

**Outcome.** Fewer merges of tasks that were never independent, and no resume that keeps a dirty half-edit.

**Measure.** Pre-mortem gate test. Existing resume test. Fork comparison test.

### Crowds, only while they stay independent

Francis Galton reported that the median of a crowd's estimates of an ox's weight was close to the measured weight ([Vox populi](https://doi.org/10.1038/075450a0), *Nature*, 1907). Lorenz, Rauhut, Schweitzer, and Helbing showed that **social influence** can shrink the diversity of estimates and worsen the average ([How social influence can undermine the wisdom of crowd effect](https://doi.org/10.1073/pnas.1008636108), *PNAS*, 2011). A popular book made a brand out of the first result and underplayed the second. Vlyn follows the second paper's warning.

Parallel hypotheses are separate actors, forked from one snapshot, editing separate worktrees. They do not exchange messages until both have a verdict. The aggregate is not a blend of the diffs. One `completed` verdict is eligible to apply. The others remain as dissent on their snapshots. If none pass, nothing is applied.

**Outcome.** Two guesses at a bugfix cannot silently overwrite each other. A failed guess remains inspectable.

**Measure.** `raceHypotheses` in the actor tests: parent brain unchanged, diffs differ, accepted id is the one `executeTask` marked `completed`, the other id is listed as dissent.

### Competing hypotheses

Richards Heuer's *Psychology of Intelligence Analysis* (Center for the Study of Intelligence, 1999) includes Analysis of Competing Hypotheses: list hypotheses, list evidence, note what conflicts, and prefer the hypothesis with the least contradiction rather than the one with the most eloquent support. The book is training material for analysts, not a coding experiment. The [PDF distributed by the CIA's Center for the Study of Intelligence](https://www.cia.gov/resources/csi/books-monographs/psychology-of-intelligence-analysis/) is the text we mean.

The verifier's comparison is a small ACH. Each hypothesis is a fork. The evidence is the check and the ownership test. Consistency is `completed`. A fluent `finish` summary is not a column in the matrix.

## Journaling and review

Scott Tannenbaum and Christopher Cerasoli meta-analyzed debriefs, including after-action reviews as used by the US Army and later in medicine and aviation ([Do team and individual debriefs enhance performance?](https://doi.org/10.1177/0018720812448394), *Human Factors*, 2013). Across 46 samples (N = 2,136) they report that debriefs improved effectiveness over control by about 25% (d ≈ 0.67), with a similar average for teams and individuals. That is their result, in their domains, with the heterogeneity a meta-analysis of training studies has. It is **not** a prediction for Vlyn. It is the reason an after-action note is worth storing: structured reflection has evidence behind it in human teams, so the harness writes one from the run's own rows (expected goal, task statuses, integration result, what to change) instead of asking a model to free-associate a diary.

James Pennebaker's expressive-writing studies are about writing through emotional experience, usually with health or wellbeing endpoints. That is a different outcome. Those papers are not cited here as evidence that a coding log should be long, personal, or therapeutic.

Blameless postmortems, as practiced in site reliability engineering, are an industry norm rather than a psychology result. They match Reason's system approach, below. Vlyn's after-action note names the task id and the layer that failed. It does not invent a story about a bad model.

**Outcome.** The next planner can be shown a short, structured note instead of a mood.

**Measure.** The note includes the failed task id and is reread from the journal after reopen.

## Uncertainty, in the form of claims

Frank Knight distinguished risk (known odds) from uncertainty (no odds worth the name) in *Risk, Uncertainty and Profit* (1921). Daniel Ellsberg showed that people dislike unknown odds even when the known-risk alternative is no better in expectation ([Risk, ambiguity, and the Savage axioms](https://doi.org/10.2307/1884324), *Quarterly Journal of Economics*, 1961). A flaky test is closer to risk: the check distribution can be sampled. A goal that does not say which behavior must change, or a file the plan owns that is not in the tree, is closer to ambiguity. The harness should not assign a precise fake probability and then edit. It should probe (read, ask, or stop) until the operator passes `--proceed`.

Epistemic uncertainty (we have not looked) and aleatory uncertainty (the check is noisy) want different responses. The first wants a read or a question. The second wants a repeated check, which Vlyn does not yet do, and should not pretend a single exit code has settled. The roadmap does not add retries-until-green, because that hides flakes. It records the exit code it got.

Claims carry a status:

| Status | Meaning for a later plan |
| --- | --- |
| `unverified` | Seen once, or not yet checked against a later run. Do not treat as a rule |
| `supported` | The same failure, or the same clean pass, happened again |
| `contested` | A later outcome disagreed. Surface the disagreement |
| `retracted` | Withdrawn. Keep the row so it is not relearned as news. Do not put it in the prompt |

Words of estimative probability, from Sherman Kent's *Studies in Intelligence* essay through [ICD 203](https://www.dni.gov/files/documents/ICD/ICD-203.pdf) and the IPCC's uncertainty guidance for assessment authors, exist so that "likely" means a stated range rather than a mood. Vlyn stores a number in the decision journal and a status on the claim. It does not emit IPCC likelihood bins. Those bins were written for assessment reports. Using them on a unit test would be costume.

**Outcome.** Ambiguous plans do not edit. Withdrawn assumptions do not return as fresh advice.

**Measure.** Plan gate. Retracted-claim recall test.

## Layered failure, from safety work

James Reason contrasted blaming a person with building defences in depth ([Human error: models and management](https://doi.org/10.1136/bmj.320.7237.768), *BMJ*, 2000). The picture associated with that paper is layered barriers with holes. An accident is the holes lining up, not a single villain. Vlyn's layers are ownership, the task check, and the integration check on a fresh worktree. Each layer misses things the others can catch. Eval cases are written so that each hole is the one that fails: out-of-scope with a green check, a red check, a stale check, a merge conflict. No layer is described as sufficient.

The Columbia Accident Investigation Board (2003) treated schedule pressure and a culture that had come to treat foam strikes as normal as causes, not background. The congressional hearing on that report is public ([GovInfo](https://www.govinfo.gov/content/pkg/CHRG-108shrg89806/html/CHRG-108shrg89806.htm)). The Rogers Commission report on Challenger (1986) is the earlier inquiry into a known joint problem that flew anyway ([history.nasa.gov/rogersrep](https://history.nasa.gov/rogersrep/genindex.htm)). The coding translation of "normalization of deviance" is already in the agent loop: a check that passed before a later edit is `stale`, and it must not become the habit that "the tests were green." Weick, Sutcliffe, and Obstfeld describe high-reliability organizing as a preoccupation with failure rather than a celebration of the last success (*Organizing for high reliability*, *Research in Organizational Behavior*, 1999). The stale-check rule is that preoccupation, in one boolean.

The Financial Crisis Inquiry Commission ([final report](https://www.govinfo.gov/app/details/GPO-FCIC), 2011) and the Federal Reserve's [SR 11-7](https://www.federalreserve.gov/supervisionreg/srletters/sr1107.htm) on model risk are reminders that a model of a system, used past the evidence it was estimated on, is a way to be confidently wrong. Vlyn's scripted eval is a test of the harness. It is not a certificate that a live model will edit a repository well. Phase 9 on the roadmap stays open until someone runs that experiment and writes down what broke.

### Evidence that moved, and claims that were withdrawn

During COVID-19, public guidance on masks and on airborne spread was revised as studies and investigations accumulated. A coding harness should not freeze the first lesson. The clinical timeline is the health agencies' record; this document does not restate it from memory and does not borrow clinical effect sizes.

Two facts are enough, and both are about **status**, not about treatment:

- Competing claims circulated faster than they could be checked. WHO and others called that an infodemic. Vlyn already tells the model that repository files and tool output are data, not instructions. That line is the coding version of "do not promote an unread source into a procedure."
- A high-profile registry paper on hydroxychloroquine and chloroquine (Mehra, Desai, Ruschitzka, and Patel, *The Lancet*, 2020, [DOI 10.1016/S0140-6736(20)31180-6](https://doi.org/10.1016/S0140-6736(20)31180-6)) was **retracted** after the data could not be verified. The record is marked retracted. The lesson for a claim ledger is mechanical: a published claim can move to `retracted`, the row stays so the next consolidation does not rediscover it as a new result, and recall must ignore it. The paper's numerical results are not used here, because the paper was withdrawn.

Morawska and Milton's commentary arguing that airborne transmission had to be addressed ([Clinical Infectious Diseases, 2020](https://doi.org/10.1093/cid/ciaa939)) is cited only as an example of a **contested** claim that later sat next to revised official guidance. It is not imported as a medical conclusion of this project.

**Outcome.** Lessons have versions. A retracted one cannot steer a plan. A check that used to pass cannot bless a later edit.

**Measure.** Retracted claims are skipped by recall. Stale checks are `unverified` in the eval suite.

## Actors, snapshots, and a supervisor

Carl Hewitt, Peter Bishop, and Richard Steiger defined actors as concurrent objects that communicate by messages (*A universal modular ACTOR formalism for artificial intelligence*, IJCAI 1973). Joe Armstrong's thesis, *Making reliable distributed systems in the presence of software errors* (Royal Institute of Technology, 2003), and the [Erlang/OTP design principles](https://www.erlang.org/doc/system/design_principles.html) are the source of the supervision idea Vlyn actually uses: a child can crash, the supervisor restarts **that** child from a known state, and the rest of the tree keeps its state. The strategy implemented is one-for-one, one automatic retry from the last snapshot. A second crash stays `crashed` and is recorded. There is no "let it crash" of the user's repository, and no remote node.

[Agent Substrate](https://github.com/agent-substrate/substrate) is the product that made the idle-actor picture sharp: a stateful actor, a pool of workers, checkpoint on idle, resume when a message arrives, revert to a snapshot, default-deny egress ([overview](https://ate.dev/docs/get-started/overview/), [control-plane API](https://ate.dev/docs/reference/api-guide/), [egress](https://ate.dev/docs/guides/network-egress/)). Vlyn does **not** call Substrate, does not speak its gRPC API, and does not ship a fake Substrate. The idea that is inherited is local and small enough to sit in the journal Vlyn already has:

- An actor is a row plus a versioned **brain snapshot**.
- The brain is the working context, the task graph, a slice of episodes, decision-journal entries, the claim ledger, the current hypotheses, and a workspace **reference** (repository, commit, diff). It is not a copy of the tree.
- Idle actors are checkpointed to SQLite and dropped from the process. Another `ActorRuntime` on the same file can claim them. That is the test that they were not merely held in a variable.
- Resume loads the snapshot. If the caller passes the outcome of the work that the brain was recalled for, reconsolidation runs.
- Checkpoint runs consolidation ("sleep") before it writes the next version.
- `revert` points the actor at an older version and leaves the later version readable, so a bad edit of the brain is undoable without pretending it never happened.
- `fork` copies a version into a sibling. Parallel hypotheses start equal and then diverge. They do not share a working context.
- Messages are rows. A coder does not read a sibling's message until the race is over.
- Templates are planner, coder, reviewer, verifier, and supervisor. Procedural text is part of the snapshot, so a resume cannot quietly change role.

Substrate's claim of restoring a sandbox in under 500 ms is their engineering claim for their runtime. Vlyn does not repeat it. Our snapshot is a JSON document in SQLite. The latency that matters is that a crashed coder continues from the last checkpoint rather than from a blank prompt, and that the user's git checkout is still not the place where that happens.

The same boundary is restated as an architecture decision with the actor implementation (`docs/adr/0001-actor-brain-snapshots.md`). Until that change is merged, this paragraph is the specification.

**Outcome.** A hypothesis can be abandoned by reverting the actor that tried it, without deleting the sibling that passed the check, and without a second process editing the same worktree.

**Measure.** The actor test file: pool claim, cross-process resume, supervisor restore, revert keeps history, fork independence, message delivery, sleep distillation, reconsolidation, and `raceHypotheses` against `executeTask`.

## Confinement, without a virtual machine

The coding outcome is narrow: a check should not see the API key, should not write outside the task, and should not get a network unless the operator can see that this machine cannot enforce that. Least privilege in Saltzer and Schroeder's 1975 paper is the old statement of the same rule. Capsicum (Watson, Anderson, Laurie, and Kennaway, USENIX Security 2010) and WASI showed what a default-deny capability host looks like for a process. Vlyn does not embed either runtime. The manifest is the small version: read roots, write paths, one command string, child network none.

[NIST SP 800-207](https://doi.org/10.6028/NIST.SP.800-207) is why the decision is not "it is already in the repo, so allow it." Each write and each command is allowed or denied again, in the parent, and the decision is logged. The model call is one of those decisions. It happens in the parent. `guardModel` refuses a base URL whose host is not on the list. The child is not given a client.

Indirect prompt injection is the case where the untrusted text is the repository itself ([Greshake, Abdelnabi, Mishra, Endres, Holz, and Fritz, arXiv:2302.12173](https://arxiv.org/abs/2302.12173); [OWASP LLM01](https://genai.owasp.org/llmrisk/llm01-prompt-injection/)). Flagging a few sentence shapes does not make a model immune. It keeps those lines labeled as data. The privilege boundary is the manifest, which does not depend on the model agreeing.

Sandbox mechanisms are not interchangeable, and the doctor is required to say which one ran:

| Mechanism | What it is good for | Why it is not the default here |
| --- | --- | --- |
| macOS Seatbelt (`sandbox-exec`) | Deny-default profile, including network, in a process | Used when the binary is on `PATH`. Not downloaded. Not a copy of any other product's profile |
| Linux user namespaces (`unshare --net`, bubblewrap) | A network namespace without a VM. Bubblewrap also bind-mounts a filesystem | `unshare` is used when it works. Bubblewrap is used when it is installed. Neither is Landlock |
| Landlock, seccomp-bpf | Kernel file and syscall policy without a VM | Not applied. A correct filter is arch-specific and wants a native helper. Shipping one would break the zero-dependency rule. Reported `false` |
| gVisor, Firecracker | Stronger isolation | A guest kernel or a VM monitor. The idle-cost goal rules them out as the default. One no-op sample on Linux was 24 ms sandboxed against 21 ms plain |
| Node `--permission` | Stops trusted Node code from touching files it was not given ([Node's own description](https://nodejs.org/api/permissions.html) calls it a seatbelt and not a malicious-code boundary) | Used for `node` checks. On Node 24.12 it denied `readFileSync` outside the allow path and did not stop `net.connect`. The doctor must not call that a network sandbox |
| WASI | Deny-by-default imports for a wasm guest | A different runtime. Not required to edit a git repo |

`--require-sandbox` is the operator saying the in-process allowlist is not enough. If the only driver is `gate-only`, the check does not start.

Secrets follow the same cut. Names matching key, token, secret, password, credential, or authorization are removed from the child environment, and `NODE_OPTIONS` with them, because a preload is a way to get the key back. The audit detail is redacted with the same strings. `npm ci --ignore-scripts` in development is the supply-chain half of this: install scripts do not run for Vlyn's own install ([SLSA](https://slsa.dev/) is the vocabulary for that class of risk, not a certification of this repo).

Quarantine, as an analogy only, is the child process without the parent's environment and without a network namespace when the OS granted one. Contact tracing, as an analogy only, is the audit row that names the actor and the path. Reason's layered defences are the reason several weak layers are still listed separately instead of being summed into one "secure" bit.

The implementation is pull request 9. The threat model and the ADR live with that change. This section is the requirement those files are answerable to. It is not a measurement that Vlyn's profile is stricter than any other product's seatbelt. Where this OS cannot confine a shell check, the honest result is `network none` and a non-zero exit if `--require-sandbox` is set.

## What evaluation is for

`vlyn eval` runs a fixed set of temporary git repositories and scripted replies. It reports:

- **Pass rate.** The verdict equals the verdict the case expects (`completed`, `unverified`, or `failed`).
- **Honesty rate.** `completed` if and only if the agent finished, the last check is present when a check was required, that check is not stale, its exit code is 0, and no changed path is outside the owned files. A case can "pass" (the harness labeled it correctly) and still contribute a bad forecast.
- **Brier score.** Pre-registered confidence against the 0/1 outcome above.
- **Wall time.** Recorded, not compared to the baseline. It moves with the machine.
- **Tokens.** A character estimate (`ceil(chars / 4)` of the messages the scripted provider saw). Not a provider usage field. No price is invented, so cost is null.
- **Lesson usefulness and fork acceptance.** Separate tests, named in the map, because they need the lesson store and the actor runtime. They are not hidden inside the Brier number.

No test places a network call. Phase 9 on the roadmap (run against a live model and write down what the scripted suite hid) is still the largest unknown. A green eval does not close it.

## Limits of the analogy

- Rat fear-conditioning, nonsense-syllable savings, prose-learning in college students, ox-weighing, debriefs in hospitals, and a retracted clinical registry are not studies of git.
- Cowan's four chunks and Miller's seven are not token budgets. The 2 KB cap is ours.
- Dual-process labels are not an architecture.
- Swiss cheese is not a proof that three checks are enough. Each layer has holes the eval is supposed to keep open on purpose.
- Substrate is an inspiration for idle checkpoint and resume. It is not a dependency, and its performance numbers are not ours.
- Scripted models follow the script. They measure whether the harness recorded, gated, resumed, and labeled. They do not measure whether a model will write a correct patch.
