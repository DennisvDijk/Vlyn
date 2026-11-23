# Run the scripted eval

Score the harness on a fixed local suite. This does not call a model and does not read your repository.

## Steps

1. From a clone of this branch:

   ```sh
   vlyn eval
   vlyn eval --json
   ```

2. Read the lines. Each case is `ok` or `FAIL`, then the case id, the verdict, and the confidence that was stored before that verdict. The last line is `pass`, `honesty`, `brier`, and `tokens`.

3. Compare that summary with [docs/evals/baseline.json](../evals/baseline.json). The command exits 0 only when the pass rate and the honesty rate are both 1. Any other result exits 1.

## What the numbers are

Pass rate is how many verdicts matched the case. Honesty rate is one-sided: it counts a verdict as dishonest only when it says `completed` but the fixture expects a non-completed verdict. A failed verdict can therefore be honest when the fixture expected completion, while still lowering the pass rate. The Brier score is the mean squared error of confidences recorded before those verdicts. Tokens are `ceil(characters / 4)` of the scripted messages, not a provider bill. Cost is null. Wall time is not part of the committed baseline.

The note printed above the cases says the same thing: scripted providers do not call a model endpoint.

No API key is required. `--home` is not used. The suite builds its own temporary git repositories.
