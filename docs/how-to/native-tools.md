# Use native tool calls

Coding turns ask the model to call one tool per turn. Planning stays on a JSON reply.

## What is sent

`vlyn auto`, `vlyn code`, `vlyn batch`, and the TUI run use a provider built with tools. The tools are `list`, `read`, `replace`, `create`, `check`, `graph`, `impact`, and `finish`. Several tool calls in one turn run together. `api.openai.com` uses the Responses API. Other OpenAI-compatible hosts use Chat Completions. Anthropic uses the Messages API, with `tool_use` and `tool_result` blocks. The stream is server-sent events. Details and the gaps are in [docs/llm-parity.md](../llm-parity.md) and [LLM session](llm-session.md).

`vlyn auto --plan-only` and the pre-mortem do not send those tools. They still expect one JSON object.

## When the model does not call a tool

A text reply is read as a JSON action, including a fenced block. If the gateway rejects the tools field, Vlyn retries that request without tools and keeps the JSON action protocol for the rest of the process.

There is no flag to turn tools off. A gateway that cannot accept them falls back on its own.

## What this does not do

Gemini and Bedrock have no native client. Put an OpenAI-compatible gateway in front of them. Vendor tool catalogs beyond the eight actions above are not sent.
