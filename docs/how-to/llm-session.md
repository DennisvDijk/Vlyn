# What a coding model call does

Coding turns (`vlyn`, `vlyn auto`, `vlyn code`, `vlyn batch`) stream when the endpoint allows it. Planning and the pre-mortem stay on one JSON object and do not send tools.

## Which API

| Endpoint | API |
| --- | --- |
| `api.openai.com` | Responses API |
| Any other OpenAI-compatible host | Chat Completions |
| Anthropic | Messages API |

`VLYN_OPENAI_API=responses` or `VLYN_OPENAI_API=chat` overrides the OpenAI choice.

## What you can set

```sh
export VLYN_REASONING_EFFORT=medium   # low, medium, or high. Omit it and no reasoning field is sent
export VLYN_PRICE_INPUT_PER_MILLION=2
export VLYN_PRICE_OUTPUT_PER_MILLION=8
```

Cost stays null until both prices are set. Cached input tokens are counted in `usage.cachedTokens` when the API reports them.

## What the TUI shows

On a terminal, streamed text is the last line of the task board, updated as deltas arrive. Leaving the TUI, deltas are printed as they come.

## What is not the same as Codex or Claude Code

The parity table is [docs/llm-parity.md](../llm-parity.md). The short version: there is no `apply_patch`, no ranged read, no general shell, and no grep/glob. Compaction drops old tool text locally. It does not ask the model to summarize.
