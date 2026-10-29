# Cloudflare AI + TypeSafe — NewAPI Task Plugin

An installable, user-owned [NewAPI Task Plugin API v1](https://github.com/QuantumNous/new-api/blob/main/docs/plugin-api/v1.md) adapter for **Cloudflare Workers AI Embeddings**, **Rerank**, and unified **TypeSafe Jev → Cloudflare Clef Flash** decisions. No NewAPI fork, patched TypeSafe plugin, intermediary Cloudflare Worker or separate sidecar is required.

![Plugin icon](icon.svg)

## API routes

| API route (POST) | Client model | Upstream | Usage |
| --- | --- | --- | --- |
| `/cloudflare/v1/embeddings` | `@cf/qwen/qwen3-embedding-0.6b`, `@cf/baai/bge-m3` | Cloudflare Workers AI | OpenAI-compatible embedding responses |
| `/cloudflare/v1/rerank` | `@cf/baai/bge-reranker-base` | Cloudflare Workers AI | Jina-style rerank response |
| `/cloudflare/v1/systemone` | `@cf/cloudflare/clef`, `@cf/cloudflare/clef-flash` | Cloudflare Workers AI | Direct Clef decisions |
| **`/decision/v1/systemone`** | **`jev-latest`** | **TypeSafe primary, Cloudflare Clef Flash fallback** | Unified System One protocol |

Use `Authorization: Bearer NEWAPI_USER_TOKEN` at all paths.

## Production setup: keep the official TypeSafe plugin

The original official **TypeSafe** channel (e.g. #79) remains active and unchanged. It continues to own `POST /typesafe/v1/systemone`.

To offer TypeSafe → Cloudflare automatic failover on a different prefix:

1. Install `plugin.js` as key `cloudflare-ai`, version `0.2.0`, using `icon.svg` as the plugin's optional SVG icon file.
2. Create a new **type-61 Task Plugin channel**, bound to `cloudflare-ai`, with TypeSafe **official** base URL `https://api.typesafe.ai`, the same TypeSafe channel key, models `jev-latest`, group `default`, **priority 2**.
3. On the existing Cloudflare `cloudflare-ai` channel, keep the five declared Cloudflare model IDs. Add `jev-latest` as a *client-facing alias*, with **model mapping**:

   `{"jev-latest":"@cf/cloudflare/clef-flash"}`

   Keep it in `default` group at **priority 1**. The actual Cloudflare account key and base URL remain the same.
4. Add the **billing expression** `cloudflare-ai::jev-latest`:

   `tier("base", u("input_tokens") * u("input_rate") / 1000000)`

   The plugin reports a per-upstream rate (TypeSafe Jev `0.042`; Cloudflare Clef Flash `0.038`, USD per million input tokens), to prevent charging the fallback at TypeSafe's rate.
5. Point clients using System One decision requests to base URL `http://new-api:3000/decision` instead of `http://new-api:3000/typesafe`. **Do not change the model** `jev-latest`, provider mode `typesafe`, or NewAPI bearer token.

NewAPI Task Plugin's built-in retry machinery picks the next priority level for retryable submissions (such as HTTP 429 and supported 5xx failures). User-invalid requests and nonretryable statuses **do not** automatically fail over. A strict session affinity or pinned channel can also suppress retry.

The original TypeSafe plugin and its route stay installed, so other clients using `/typesafe/v1/systemone` are not affected.

### Example unified decision request

```json
{
  "model": "jev-latest",
  "state": { "incident": "Checkout unavailable" },
  "questions": {
    "urgent": { "type": "noul", "instructions": "Is immediate action required?" }
  }
}
```

The primary upstream receives `model:"jev-latest"`. The Cloudflare fallback receives `model:"clef-flash"` at the native Workers AI `/ai/run/@cf/cloudflare/clef-flash` API, while the client-facing model remains `jev-latest`.

## Safety and compatibility boundaries

- **Clef accepts up to 64 typed questions per request**, while Jev accepts larger batches. The fallback refuses requests over 64 questions **without truncation**. The official Task Plugin v1 API accounts for a single billable upstream request per submission; silently making unaccounted-for extra inference calls through a fetch helper is not supported. Splitting a large fallback batch must be done by the client or in a future upstream-supported batch execution API.
- Cloudflare **Clef Flash** currently has a **24K input-token context**; TypeSafe Jev supports up to 64K. Very large Jev requests may not have a usable fallback even when they contain 64 or fewer questions.
- The plugin preserves request JSON member order using the host `json-order@1` capability because Jev may interpret JSON order.
- The plugin accepts textual and structured `state`, with `noul`, `choice` and `score` questions. Image/media input is explicitly rejected.
- The **standard** `/v1/embeddings` and `/v1/rerank` remain **host-owned** NewAPI endpoints. The current Task Plugin API has no host protocol hooks for either; consumers must use the plugin's prefixed routes. Hindsight's OpenAI SDK can use `/cloudflare/v1/embeddings` by setting its Embeddings Base URL to `.../cloudflare/v1`.
- Credentials come only from the selected NewAPI channel and are never embedded in source, logs, or GitHub Actions.

## Icon

`icon.svg` is a self-contained, minimal vector app icon designed for light and dark backgrounds: a cloud plus two diverging decision routes. NewAPI takes the image separately from the JavaScript manifest when installing or upgrading Task Plugins; `meta.icon: "text:AI"` is only the fallback when an image has not yet been uploaded.

## Quality gate

Every change is tested and formally validated **via GitHub Actions only**:

- Node 24 unit tests for Embedding, Rerank, Jev, mapped Clef fallback, billing rates, and malformed requests.
- Self-contained SVG validation.
- Compilation and lint using the unmodified upstream NewAPI Task Plugin CLI.

Source modifications and deployment changes never alter NewAPI or TypeSafe upstream code.
