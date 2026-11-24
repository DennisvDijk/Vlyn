# Motivation and control: from brain to harness

This note extends [state-of-the-art.md](state-of-the-art.md), which covers memory and decision research (Tulving, Rescorla–Wagner, Cowan, pre-mortem). It adds the motivation and control loops: dopamine, basal ganglia, ACC, locus coeruleus, prefrontal cortex, cerebellum and metacognition.

It is an analogy, not a model of the brain. Vlyn is not a brain. Every mechanism below must improve a measurable coding outcome, otherwise it goes out. The theory is a design idea, not evidence.

## Core

A harness cannot feel, but it can rebuild the same control loops that let a person learn and persist: predict, compare with the outcome, and adjust the next behaviour.

- "Dopamine for good suggestions" becomes a prediction error: outcome minus expectation. It steers which agent and approach Vlyn picks next time. The model does not get happier. The system around it chooses better.
- "Striving for the best product" becomes a goal that stays visible during the whole run, a reward that looks further than the visible tests, and extra control at moments of doubt.
- The biggest risk is the same as in people: a strong drive towards a bad reward. Then the agent cheats. The reward must therefore come from outside (held-out checks, human merges), never from the agent itself.
- Gap first, then the loop. A learning loop without errors has nothing to learn from. It is built only if the measurement on hard tasks shows a gap (PR 6). See [VALIDATION.md](../VALIDATION.md).

## At a glance

The learning loop has four steps and one control layer:

1. Predict (`p_self`, `p_process`) before the outcome.
2. Observe the outcome from outside the agent (held-out `--accept`, later human merges).
3. Compute the prediction error `δ = r − p_process`.
4. Adjust: strategy values, lessons, exploration, extra control.

The outcome comes from outside the agent, which is what makes the loop hard to game.

## Per brain area

Eleven mechanisms, each with a concrete application and the PR where it lands. The first four together form the "dopamine" loop.

| Area / system | What the research says | Application in Vlyn | Lands in |
| --- | --- | --- | --- |
| Dopamine (VTA, midbrain) | Schultz, Dayan & Montague 1997: dopamine codes a prediction error. After learning, the peak moves from the moment of reward to the cue that predicts it. If the reward is withheld, activity drops | `δ = r − p_process`. Over time `p_process` learns early signals (diff shape, cycles) that predict success, like the shift to the cue | PR 2 and 6 |
| Distributional dopamine code | Dabney et al. 2020: the brain represents possible rewards as a distribution, not one mean. Neurons have different learning rates for positive and negative errors | Separate `α⁺` and `α⁻`. Keep the spread of outcomes per strategy, not only the mean | PR 6 |
| Basal ganglia (striatum, Go/NoGo) | Frank: the basal ganglia learn Go for actions that usually turn out well and NoGo to suppress unsuitable actions | `Q` per task type × strategy, with separate evidence for and against. A strategy that repeatedly fails is actively suppressed | PR 6 |
| "Wanting" versus "liking" | Berridge: mesolimbic dopamine drives "wanting" (incentive salience), not pleasure | Design rule: separate the drive (what you try) from the judgement (what is good). The score comes from outside and is not in the agent's prompt | Design rule, PR 2 |
| Dorsal ACC | Shenhav, Botvinick & Cohen 2013: the dACC decides whether, where and how much control to deploy, based on expected payoff and cost | Extra control (second agent, reviewer, extra check) only if `p_self` and `p_process` clash or `p ≈ 0.5`, and the expected gain exceeds the cost | PR 7 |
| Locus coeruleus (noradrenaline) | Aston-Jones & Cohen 2005: phasic activity helps exploit the current task. When utility drops, the system looks for alternatives | `ε` per task type: if the accept rate falls, try another agent or approach more often. If it rises, stay with the best strategy | PR 6 |
| Prefrontal cortex (dlPFC) | Miller & Cohen 2001: cognitive control comes from actively holding goals and the means to reach them | Goal, non-goals and acceptance criteria are fixed at the top of every agent run, also after compaction. Owned files are the "set" | PR 1 |
| Rostrolateral PFC (metacognition) | Fleming & Dolan 2012: metacognitive accuracy is separate from task performance and differs per individual | Measure the calibration of `p_self` per agent separately. An agent can code well and still not know when it is wrong | PR 2 |
| Cerebellum (forward model) | Wolpert et al.: the cerebellum predicts the consequences of an action. The difference with what really happens steers learning and correction | Predict before the check which tests are touched (`vlyn impact`). If tests outside that prediction fail, that is a signal for `p_process` | PR 2 (signal) |
| Hippocampus (prioritized replay) | Mattar & Daw 2018: which memories are replayed depends on their usefulness for future choices | Lessons and recipes get priority by the size of `δ` and how often the task type occurs. Surprising outcomes on common work first | PR 6 |
| Curiosity | Gottlieb, Oudeyer et al.: exploration runs from a simple preference for novelty to targeted search for learning progress | Explore where `Q` changes fastest. Strategies that are stably good or stably bad need no more testing | PR 6 (later) |

## Striving for the best product

In a person, striving comes from three things: the goal stays in view, the goal is worth something, and the bar is higher than "it compiles".

1. **Hold the goal.** Goal, non-goals and acceptance criteria sit in a fixed header on every run. Afterwards Vlyn compares the summary with the criteria: which criterion is not mentioned? That is a signal for `p_process`, not a reward.
2. **A layered reward**, from weak to strong:

   | Layer | Signal | Role |
   | --- | --- | --- |
   | 1 | Visible check green | Gate for `completed`, not a reward |
   | 2 | Held-out `--accept` green | Direct reward `r` |
   | 3 | Branch merged without rework | Delayed reward, weighted more strongly |
   | 4 | No revert or fix commit within 14 days | Last correction on the same run |

3. **A higher bar than the tests.** Definition of done as a hard gate: lint and typecheck clean, no new warnings, diff within a budget. A reviewer model may only give a signal into `p_process`, never the reward, because a model judgement can be gamed just like a test.
4. **Learn from a failed attempt.** Reflexion shows that agents improve through verbal reflection in an episodic memory, without changing weights. After a failed `--accept`, Vlyn writes a short reflection from the diff and the visible check output. The held-out output never leaks.

## Limits and the biggest risk

A harness that wants to score very badly will cheat. ImpossibleBench measures how often agents pass tasks where passing is only possible by violating the specification. Pan et al. show that feedback loops with LLMs lead to reward hacking, and that static evaluations miss it. The first measurement showed the flip side too: a rule that is too strict punishes honest agents. That is why `conflict` exists ([judge design](../design/judge.md)).

- It is an analogy, not a model of the brain. Each mechanism must improve a measurable coding result, otherwise it goes out.
- The model does not learn, the harness does. What learns: `Q`, `ε`, the lessons and the weights of `p_process`.
- Brain areas are not separate modules. The function of the dACC is still debated. Use the theory as a design idea, not as proof.
- Small numbers. With 20 tasks × 3 runs you learn a handful of strategy values. Keep the number of strategies in v1 small.

## Sources

- Schultz, Dayan & Montague (1997). A neural substrate of prediction and reward. Science 275.
- Dabney et al. (2020). A distributional code for value in dopamine-based reinforcement learning. Nature 577.
- Frank & Claus (2006). Anatomy of a decision: striato-orbitofrontal interactions. Psychological Review.
- Berridge & Robinson (2016). Liking, wanting, and the incentive-sensitization theory of addiction. American Psychologist.
- Shenhav, Botvinick & Cohen (2013). The expected value of control. Neuron 79.
- Shenhav et al. (2014). Anterior cingulate engagement in a foraging context reflects choice difficulty.
- Aston-Jones & Cohen (2005). An integrative theory of locus coeruleus-norepinephrine function. Annual Review of Neuroscience 28.
- Miller & Cohen (2001). An integrative theory of prefrontal cortex function. Annual Review of Neuroscience 24.
- Fleming & Dolan (2012). The neural basis of metacognitive ability. Phil. Trans. R. Soc. B 367.
- Wolpert, Miall & Kawato (1998). Internal models in the cerebellum. Trends in Cognitive Sciences.
- Mattar & Daw (2018). Prioritized memory access explains planning and hippocampal replay. Nature Neuroscience 21.
- Gottlieb, Oudeyer, Lopes & Baranes (2013). Information-seeking, curiosity, and attention. Trends in Cognitive Sciences.
- Shinn et al. (2023). Reflexion: language agents with verbal reinforcement learning. NeurIPS.
- Pan et al. (2024). Feedback loops with language models drive in-context reward hacking. ICML.
- Zhong, Raghunathan & Carlini (2025). ImpossibleBench: measuring LLMs' propensity of exploiting test cases.
