# NewAPI Cloudflare Workers AI Task Plugin

This is a user-owned **Task Plugin API v1** extension for Cloudflare Workers AI Embeddings, Rerank and Clef decision models. No intermediary Worker, reverse proxy, NewAPI fork or embedded secrets are required.

**Important limitation:** The current official Task Plugin host does NOT allow plugins to take over the standard POST /v1/embeddings and POST /v1/rerank endpoints. This plugin registers its own native routes. Keep existing channels for clients requiring those original URLs.

## Native routes

| Route | Models | Function |
| --- | --- | --- |
| POST /cloudflare/v1/embeddings | @cf/qwen/qwen3-embedding-0.6b; @cf/baai/bge-m3 | Cloudflare OpenAI-compatible embedding |
| POST /cloudflare/v1/rerank | @cf/baai/bge-reranker-base | Cloudflare native rerank, Jina-style response |
| POST /cloudflare/v1/systemone | @cf/cloudflare/clef; @cf/cloudflare/clef-flash | Cloudflare native System One decisions |

All requests use **Authorization: Bearer YOUR_NEWAPI_USER_TOKEN**. The plugin uses the bound channel's Cloudflare API token for outgoing authenticated requests.

## Install into NewAPI

1. Upload plugin.js in **Task Plugins**, activate plugin key **cloudflare-ai**.
2. Create **one type-61 Task Plugin channel for each Cloudflare account**, select cloudflare-ai, and configure the respective channel API key and Base URL:
   https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/ai
3. Set allowed models, groups, priorities, weights, and explicit input-token pricing before exposing the channels.
4. Test the three new native routes with a NewAPI user token, then migrate compatible clients individually.

A single plugin installation covers both Cloudflare accounts, but two accounts still require two channels because NewAPI keeps and routes channel credentials individually.

### Sample requests

Embedding request body:

    {"model":"@cf/qwen/qwen3-embedding-0.6b","input":["hello","world"]}

Rerank request body:

    {"model":"@cf/baai/bge-reranker-base","query":"What is RAG?","documents":["RAG retrieves passages.","Cars need fuel."],"top_n":1,"return_documents":true}

Decision request body:

    {"model":"@cf/cloudflare/clef-flash","state":"Checkout is failing.","questions":{"urgent":{"type":"noul","instructions":"Is this urgent?"}}}

## Existing production channels

- #6 and #82: currently serve standard OpenAI embedding requests for two different accounts. **Keep them** while existing clients use /v1/embeddings.
- #81: existing Hindsight rerank Worker. **Keep it** while Hindsight uses standard /v1/rerank; only remove the Worker after a compatible endpoint and RAG regression check.
- #83 and #84: currently use the official typesafe plugin for Clef Flash. That official plugin accepts Jev model IDs only, so this is not a valid Clef route. Once the new plugin's System One route is validated, replace those bindings.

The plugin's input-token accounting uses upstream usage when present. Some Workers AI endpoints omit usage; then the plugin uses a **clearly approximate** character-based estimate. Do not treat those numbers as a Cloudflare invoice. These synchronous operations still create NewAPI task billing rows; high-volume embedding traffic is usually better served by the existing native embedding channels.

Limitations: only text embeddings/rerank and JSON/text decision state; Clef image input is deliberately rejected. The plugin does not add generic account/key management, new standard protocol handlers or untested streaming formats.

To get a truly drop-in /v1/embeddings and /v1/rerank plugin, upstream NewAPI must add those host protocols to its JS plugin registry. No upstream code is modified here.

## Verification and build policy

Run all tests and formal validation **only in GitHub Actions**. The CI validates Node unit cases and uses the unmodified official NewAPI plugin linter to compile and verify the plugin contract.
