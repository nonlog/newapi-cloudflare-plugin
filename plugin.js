// Cloudflare Workers AI adapters for NewAPI's official task-plugin API v1.
// No Node.js modules, global fetch, persistent state, or embedded credentials.
const EMBED = ["@cf/qwen/qwen3-embedding-0.6b", "@cf/baai/bge-m3"];
const RERANK = "@cf/baai/bge-reranker-base";
const DECIDE = ["@cf/cloudflare/clef", "@cf/cloudflare/clef-flash"];
const MODELS = [...EMBED, RERANK, ...DECIDE];
const MAX_USAGE_TOKENS = 1000000;

export const meta = {
  apiVersion: 1,
  key: "cloudflare-ai",
  name: "Cloudflare Workers AI",
  version: "0.1.2",
  author: { name: "nonlog", url: "https://github.com/nonlog" },
  website: "https://developers.cloudflare.com/workers-ai/",
  icon: "text:CF",
  description: {
    en: "Native-route adapters for Cloudflare embeddings, rerank and Clef decisions, without Workers",
    zh: "Cloudflare 向量、重排序、Clef 决策原生路由，无需中转 Worker",
  },
  models: MODELS,
  auth: "api_key",
  fetchMode: "per_task",
  routes: [
    { method: "POST", path: "/cloudflare/v1/embeddings", type: "submit", action: "embeddings", decode: "embeddings", render: "render", models: EMBED, retainResult: false },
    { method: "POST", path: "/cloudflare/v1/rerank", type: "submit", action: "rerank", decode: "rerank", render: "render", models: [RERANK], retainResult: false },
    { method: "POST", path: "/cloudflare/v1/systemone", type: "submit", action: "systemone", decode: "systemone", render: "render", models: DECIDE, retainResult: false },
  ],
  usageSchema: {
    input_tokens: {
      type: "number",
      unit: "token",
      description: { en: "Input tokens (estimated if Cloudflare omits usage)", zh: "输入 Token（缺少上游用量时为估算值）" },
    },
  },
  usageExamples: [{ label: "1,000 input tokens", facts: { input_tokens: 1000 } }],
};

function object(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function fail(reason) {
  throw new Error(reason);
}
function nonemptyText(v, name) {
  if (typeof v !== "string" || v.trim() === "") fail(name + " must be a nonempty string");
  return v;
}
function requireJSON(ctx) {
  if (!ctx.body || ctx.body.kind !== "json" || !object(ctx.body.value)) fail("JSON object body required");
  return ctx.body.value;
}
function requireModel(body, list) {
  if (!list.includes(body.model)) fail("Unsupported model for this Cloudflare operation");
  if (body.stream !== undefined && body.stream !== false) fail("This Cloudflare operation does not support streaming");
}
function textArray(v) {
  const inputs = typeof v === "string" ? [v] : v;
  if (!Array.isArray(inputs) || inputs.length === 0 || inputs.length > 128) fail("input must be text or an array of 1–128 texts");
  for (const item of inputs) nonemptyText(item, "input item");
  return inputs;
}
function validateEmbeddings(body) {
  requireModel(body, EMBED);
  const input = textArray(body.input);
  // The OpenAI Python SDK sends encoding_format="base64" by default, but
  // accepts an array of float values in its response and leaves it unchanged.
  // Cloudflare's embedding API serves float vectors, so translate that SDK
  // hint to float rather than rejecting an otherwise valid request.
  if (body.encoding_format !== undefined && body.encoding_format !== "float" &&
      body.encoding_format !== "base64") fail("Only float or base64 embedding requests are supported");
  return { model: body.model, input, encoding_format: "float" };
}
function validateRerank(body) {
  requireModel(body, [RERANK]);
  const query = nonemptyText(body.query, "query");
  if (!Array.isArray(body.documents) || body.documents.length < 1 || body.documents.length > 128)
    fail("documents must contain 1–128 entries");
  const documents = body.documents.map(function (entry) {
    const text = typeof entry === "string" ? entry : object(entry) ? entry.text : null;
    return { text: nonemptyText(text, "document text") };
  });
  const n = body.top_n === undefined ? body.top_k : body.top_n;
  if (n !== undefined && (!Number.isInteger(n) || n < 1 || n > documents.length)) fail("top_n must be between 1 and documents.length");
  if (body.return_documents !== undefined && typeof body.return_documents !== "boolean") fail("return_documents must be boolean");
  return { model: body.model, query, documents, top_n: n === undefined ? documents.length : n, return_documents: body.return_documents === true };
}
function validateDecision(body) {
  requireModel(body, DECIDE);
  if (body.state === undefined || !(typeof body.state === "string" || body.state === null || Array.isArray(body.state) || object(body.state)))
    fail("state must be text, object, array or null");
  if (body.images !== undefined) fail("images are not yet supported by this plugin; do not silently discard media");
  if (!object(body.questions)) fail("questions must be an object");
  const ids = Object.keys(body.questions);
  if (ids.length < 1 || ids.length > 64) fail("questions must contain 1–64 questions");
  for (const id of ids) {
    if (!/^[a-zA-Z0-9_.-]{1,100}$/.test(id)) fail("Invalid question identifier");
    const q = body.questions[id];
    if (!object(q) || !["noul", "choice", "score"].includes(q.type)) fail("Unsupported question type");
    if (q.type === "choice" && (!object(q.criteria) || Object.keys(q.criteria).length < 2 || Object.keys(q.criteria).length > 255))
      fail("Choice questions need 2–255 options");
    if (q.type === "score" && (!Array.isArray(q.criteria) || q.criteria.length < 2 || q.criteria.length > 10))
      fail("Score questions need 2–10 ordered criteria");
    if (q.type === "noul" && q.criteria !== undefined && q.criteria !== null &&
        (!object(q.criteria) || Object.keys(q.criteria).some(function (k) { return k !== "true" && k !== "false"; })))
      fail("Noul criteria may contain only true and false");
  }
  return { model: body.model, state: body.state, questions: body.questions };
}
function prepareNative(ctx, action) {
  const input = requireJSON(ctx);
  let parsed;
  if (action === "embeddings") parsed = validateEmbeddings(input);
  else if (action === "rerank") parsed = validateRerank(input);
  else parsed = validateDecision(input);
  return { kind: "submit", model: parsed.model, action, requestBody: parsed };
}

export const native = {
  embeddings: function (ctx) { return prepareNative(ctx, "embeddings"); },
  rerank: function (ctx) { return prepareNative(ctx, "rerank"); },
  systemone: function (ctx) { return prepareNative(ctx, "systemone"); },
  render: function (_ctx, task) { return task.data; },
  error: function (_ctx, error) { return { error: { message: error.message, type: "cloudflare_plugin_error" } }; },
};

// Only a base URL rooted at the account's /ai endpoint is supported.
// All appended model paths come from the fixed allowlist, never client input.
function apiBase(baseUrl) {
  if (typeof baseUrl !== "string") fail("Channel Base URL is required");
  const base = baseUrl.replace(/\/+$/, "");
  if (!/^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/[0-9a-f]{32}\/ai$/i.test(base))
    fail("Base URL must be https://api.cloudflare.com/client/v4/accounts/<account-id>/ai");
  return base;
}
function modelOf(ctx) {
  const model = ctx.upstreamModel || ctx.model;
  if (!MODELS.includes(model)) fail("Unknown Cloudflare Workers AI model");
  return model;
}
function tokenEstimate(input) {
  const size = JSON.stringify(input).length;
  return Math.max(1, Math.min(MAX_USAGE_TOKENS, Math.ceil(size / 4)));
}
function estimatedInput(ctx) {
  const action = ctx.action;
  if (action === "systemone") return ctx.model === "@cf/cloudflare/clef-flash" ? 24576 : 65536;
  return tokenEstimate(ctx.requestBody);
}
export function buildSubmitRequest(ctx) {
  const base = apiBase(ctx.baseUrl);
  const model = modelOf(ctx);
  // NewAPI's official API-key auth provides ctx.authHeader as the BARE key,
  // not an HTTP Authorization header. Cloudflare requires Bearer credentials.
  // Use the channel's actual key, never a user-supplied incoming header.
  if (typeof ctx.apiKey !== "string" || !ctx.apiKey.trim()) fail("Missing Cloudflare channel API key");
  const headers = { Authorization: "Bearer " + ctx.apiKey.trim(), "Content-Type": "application/json", Accept: "application/json" };
  const body = ctx.requestBody;
  if (!object(body)) fail("Missing normalized request body");
  if (ctx.action === "embeddings") {
    validateEmbeddings(body);
    return { method: "POST", url: base + "/v1/embeddings", headers, body: { model, input: body.input, encoding_format: "float" } };
  }
  if (ctx.action === "rerank") {
    validateRerank(body);
    return {
      method: "POST",
      url: base + "/run/" + RERANK,
      headers,
      body: { query: body.query, contexts: body.documents, top_k: body.top_n },
    };
  }
  if (ctx.action === "systemone") {
    validateDecision(body);
    return {
      method: "POST",
      url: base + "/run/" + model,
      headers,
      body: { model: model.endsWith("clef-flash") ? "clef-flash" : "clef", state: body.state, questions: body.questions },
    };
  }
  return fail("Unknown Cloudflare action");
}
function unwrap(response) {
  if (response.statusCode < 200 || response.statusCode > 299) {
    const errors = response.body && response.body.errors;
    const code = Array.isArray(errors) && errors.length && Number.isInteger(errors[0].code) ? " code " + errors[0].code : "";
    fail("Cloudflare Workers AI returned HTTP " + response.statusCode + code);
  }
  const b = response.body;
  if (!object(b)) fail("Cloudflare returned an invalid JSON response");
  if (b.success === false) fail("Cloudflare reported unsuccessful inference");
  return object(b.result) ? b.result : b;
}
function usageFrom(raw, fallback) {
  const u = raw.usage;
  const amount = object(u) && (u.input_tokens ?? u.prompt_tokens);
  if (Number.isInteger(amount) && amount >= 0 && amount <= MAX_USAGE_TOKENS) return amount;
  return fallback;
}
function normalizeEmbeddings(ctx, raw) {
  let data = raw.data;
  if (!Array.isArray(data)) fail("Cloudflare embedding data[] missing");
  if (data.length === 0) fail("Cloudflare returned zero embeddings");
  data = data.map(function (entry, index) {
    const values = Array.isArray(entry) ? entry : object(entry) ? entry.embedding : null;
    if (!Array.isArray(values) || values.length === 0 || !values.every(Number.isFinite))
      fail("Cloudflare returned an invalid embedding vector");
    return { object: "embedding", embedding: values, index };
  });
  const tokens = usageFrom(raw, tokenEstimate(ctx.requestBody));
  return { object: "list", data, model: ctx.model, usage: { prompt_tokens: tokens, total_tokens: tokens, input_tokens: tokens } };
}
function normalizeRerank(ctx, raw) {
  const ranked = Array.isArray(raw.response) ? raw.response : raw.results;
  if (!Array.isArray(ranked)) fail("Cloudflare rerank response[] missing");
  const items = ranked.map(function (entry) {
    const index = entry.id ?? entry.index;
    const score = entry.score ?? entry.relevance_score;
    if (!Number.isInteger(index) || index < 0 || index >= ctx.requestBody.documents.length || !Number.isFinite(score))
      fail("Cloudflare returned an invalid rerank index or score");
    const item = { index, relevance_score: score };
    if (ctx.requestBody.return_documents) item.document = ctx.requestBody.documents[index];
    return item;
  });
  items.sort(function (a, b) { return b.relevance_score - a.relevance_score; });
  const tokens = usageFrom(raw, tokenEstimate(ctx.requestBody));
  return { model: ctx.model, object: "list", results: items.slice(0, ctx.requestBody.top_n), usage: { input_tokens: tokens } };
}
function normalizeDecision(ctx, raw) {
  if (!object(raw.answers)) fail("Cloudflare decision answers missing");
  for (const id of Object.keys(ctx.requestBody.questions)) {
    if (!object(raw.answers[id]) || raw.answers[id].type !== ctx.requestBody.questions[id].type)
      fail("Cloudflare did not return the correct answer type for " + id);
  }
  return { model: ctx.model, answers: raw.answers, usage: { input_tokens: usageFrom(raw, estimatedInput(ctx)) } };
}
export function parseSubmitResponse(ctx, response) {
  const raw = unwrap(response);
  if (!ctx.publicTaskId) fail("Missing NewAPI public task ID");
  let result;
  if (ctx.action === "embeddings") result = normalizeEmbeddings(ctx, raw);
  else if (ctx.action === "rerank") result = normalizeRerank(ctx, raw);
  else if (ctx.action === "systemone") result = normalizeDecision(ctx, raw);
  else fail("Unknown Cloudflare action");
  return { taskId: ctx.publicTaskId, taskData: result, immediate: { status: "SUCCESS", progress: "100%" } };
}
export function extractUsage(ctx) {
  if (ctx.usagePurpose === "billing_ratios") return null;
  if (!MODELS.includes(ctx.upstreamModel || ctx.model)) fail("Unknown model for usage");
  return { input_tokens: estimatedInput(ctx) };
}
export function extractUsageOnComplete(_ctx, _result, body) {
  const tokens = body && body.usage && body.usage.input_tokens;
  if (!Number.isInteger(tokens) || tokens < 0 || tokens > MAX_USAGE_TOKENS)
    fail("Cloudflare input-token usage could not be established");
  return { input_tokens: tokens };
}
// All three operations are synchronous. The official v1 per_task interface
// still requires these hooks, which must never poll Cloudflare.
export function buildQueryRequest() { fail("Cloudflare synchronous operations cannot be polled"); }
export function parseTaskResult() { return { status: "UNKNOWN", reason: "Synchronous operation" }; }
