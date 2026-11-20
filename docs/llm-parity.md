# LLM call parity

Compared with the public Codex CLI (`openai/codex`, `codex-rs`) and Claude Code's Messages API, as of November 2026. "Sends" means Vlyn puts the field on the request. A cache hit still depends on the provider.

| Feature | Vlyn | Codex | Claude Code |
| --- | --- | --- | --- |
| Native tools on coding turns | Yes. Eight actions, `parallel_tool_calls` | Yes. Larger built-in catalog | Yes |
| Parallel tool calls in one turn | Yes. `Promise.all` | Yes | Yes |
| OpenAI Responses API | Yes, for `api.openai.com`, or `VLYN_OPENAI_API=responses` | Yes. Primary path | No |
| Chat Completions | Yes, for other OpenAI-compatible hosts, or `VLYN_OPENAI_API=chat` | Some gateways | No |
| Anthropic `tool_use` / `tool_result` | Yes, including thinking blocks with signatures | No | Yes |
| JSON action fallback | Yes, when the model returns text or the gateway rejects tools | No | No |
| SSE streaming | Yes. Recorded fixtures cover Responses, Chat, and Anthropic | Yes | Yes |
| Incremental TUI text | Yes. The board shows the latest streamed text | Yes | Yes |
| Streaming tool-call deltas | Parsed. `onToolDelta` exists. The TUI does not draw patch hunks | Yes, including `apply_patch` hunks | Yes, `input_json_delta` |
| Prompt cache breakpoints | Anthropic: `cache_control` on the system block, the last tool, the last message, and the request. OpenAI: instructions then a sorted tool list, then history | Yes. Prefix kept stable | Yes |
| Cached token accounting | `cachedTokens` from `cached_tokens` or Anthropic cache read/creation | Yes | Yes |
| Reasoning effort | Only when `VLYN_REASONING_EFFORT` is `low`, `medium`, or `high`. No automatic model detection | Default for reasoning models | Adaptive thinking; extended thinking on older models |
| Reasoning items kept across turns | Responses output items are replayed. Anthropic thinking blocks are replayed with their signature | Yes | Yes, when the model requires it |
| Retries | 408, 409, 429, 529, and other 5xx. `retry-after` wins. Otherwise exponential backoff plus jitter. Three tries. 120 second timeout. AbortSignal cancels the stream and the wait | Yes | Yes |
| Cost | Null unless `VLYN_PRICE_INPUT_PER_MILLION` and `VLYN_PRICE_OUTPUT_PER_MILLION` are both set. No built-in price list | Built-in prices | Built-in prices |
| Context compaction | Old tool bodies are replaced with a one-line digest near 24k estimated tokens. Not a model-written summary | Model compaction | Model summary |
| Large tool output | Truncated to 8,000 characters in the next prompt. The check record keeps its own cap | Yes | Yes |
| `apply_patch` | Not built | Yes | No |
| `str_replace` / exact replace | `replace` is an exact single match. No separate `str_replace` tool | Different patch tool | Yes |
| Read ranges | Not built. `read` returns the whole file up to 200 KB | Yes | Yes |
| Shell with its own timeout | `check` runs the one supplied command and times out at 60 seconds. No general shell tool | Yes | Yes |
| grep / glob | Not built. `graph` and `impact` are import-graph tools | Yes | Yes |
| WebSocket Responses | Not built | Optional | No |
| Live model in CI | No. `VLYN_LIVE_SMOKE=1` is the opt-in smoke test | Their own evals | Their own evals |

Gemini and Bedrock still need an OpenAI-compatible gateway.
