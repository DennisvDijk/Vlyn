# Connect a model

Point Vlyn at an endpoint. The binary speaks two protocols: OpenAI-compatible Chat Completions, and Anthropic's native Messages API.

## Pick a protocol

| You have | Set |
| --- | --- |
| OpenAI, OpenRouter, vLLM, LM Studio, or any `/v1/chat/completions` server | `VLYN_API_KEY` and, if it is not `https://api.openai.com/v1`, `VLYN_BASE_URL` |
| LiteLLM proxy | `LITELLM_API_KEY` or `VLYN_API_KEY`, and `VLYN_BASE_URL` to the proxy's `/v1` |
| Anthropic | `ANTHROPIC_API_KEY`. Add `VLYN_PROVIDER=anthropic` when an OpenAI-style key or a base URL is also set |
| Ollama on this machine | `VLYN_BASE_URL=http://127.0.0.1:11434/v1`. No key |

For an OpenAI-compatible endpoint the key order is `VLYN_API_KEY`, then `LITELLM_API_KEY`, then `OPENAI_API_KEY`. The base URL is `--base-url`, then `VLYN_BASE_URL`, then `OPENAI_BASE_URL`, then `LITELLM_BASE_URL`.

Anthropic is selected when `VLYN_PROVIDER=anthropic`, or when no provider is set, no base URL is set, no OpenAI-style key is set, and `ANTHROPIC_API_KEY` is set. That path reads `VLYN_API_KEY`, then `ANTHROPIC_API_KEY`.

A `localhost`, `127.0.0.1`, or `[::1]` URL needs no key. Any other `http://` URL is refused unless `VLYN_ALLOW_INSECURE=1`.

## Steps

1. Export the variables in the shell that will run `vlyn`.

   ```sh
   export VLYN_BASE_URL=https://gateway.example.com/v1
   export VLYN_API_KEY=…
   ```

2. List what that endpoint currently offers.

   ```sh
   vlyn models
   vlyn models --refresh
   ```

   `models` calls `GET /models` with your key and prints ids. Anthropic adds `?limit=1000` on that same path. Without `--refresh`, a fresh cache is reused, and a failed refresh keeps the last list. `--refresh` always fetches, and a failed fetch exits with the error instead of using the cache.

3. Leave the model as `auto` (the default) or pin one.

   ```sh
   export VLYN_MODEL=some-model-id
   # or, per run:
   vlyn auto --model some-model-id --goal "…" --plan-only
   ```

   `auto` picks from the live list with a family heuristic. Pin a model when the choice matters. If a pinned or chosen id is rejected once, Vlyn refreshes the list and retries once.

## Ollama

Ollama's OpenAI-compatible route is the `/v1` prefix, not the native `/api` route.

```sh
export VLYN_BASE_URL=http://127.0.0.1:11434/v1
unset VLYN_API_KEY
vlyn models
```

If `models` fails, the server is down or the prefix is wrong. Vlyn does not start Ollama for you.

## Anthropic

```sh
export ANTHROPIC_API_KEY=…
export VLYN_PROVIDER=anthropic
vlyn models
```

`VLYN_PROVIDER=anthropic` forces the native API even when `OPENAI_API_KEY` is set. The catalog request is still `GET {base}/models`, with `?limit=1000` added. The default base is `https://api.anthropic.com/v1`.

## LiteLLM and other gateways

Point `VLYN_BASE_URL` at the gateway's OpenAI-compatible base, usually ending in `/v1`. The gateway's own key is `VLYN_API_KEY` or `LITELLM_API_KEY`. Model ids are whatever the gateway lists. Vlyn does not translate names.

Gateways that reject JSON mode are retried once without it. Keys are not written into the model cache or into error text.

## What this does not do

Gemini and Bedrock have no native client. Put LiteLLM, or another OpenAI-compatible gateway, in front of them.

The API key stays in the parent process environment. Checks still inherit your environment. A broker that strips secrets from the check is planned, not built. See the limitations in the [README](../../README.md).
