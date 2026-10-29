// Cloudflare Workers AI and TypeSafe Jev adapters for NewAPI Task Plugin API v1.
// No Node.js modules, global fetch, persistent state, or embedded credentials.
const EMBED = ["@cf/qwen/qwen3-embedding-0.6b", "@cf/baai/bge-m3"];
const RERANK = "@cf/baai/bge-reranker-base";
const DECIDE = ["@cf/cloudflare/clef", "@cf/cloudflare/clef-flash"];
const JEV = "jev-latest";
const DECISION_MODELS = [...DECIDE, JEV];
const MODELS = [...EMBED, RERANK, ...DECISION_MODELS];
const MAX_USAGE_TOKENS = 1000000;
const MAX_CLEF_QUESTIONS = 64;
const MAX_JEV_QUESTIONS = 700;

function upstreamInputRate(model) {
  if (model === JEV) return 0.042;
  if (model === "@cf/cloudflare/clef-flash") return 0.038;
  if (model === "@cf/cloudflare/clef") return 0.24;
  if (model === RERANK) return 0.00311;
  return 0.0118;
}

export const meta = {
  apiVersion: 1,
  key: "cloudflare-ai",
  name: "Cloudflare AI + TypeSafe",
  version: "0.2.0",
  author: { name: "nonlog", url: "https://github.com/nonlog" },
  website: "https://developers.cloudflare.com/workers-ai/",
  icon: "text:AI",
  description: {
    en: "Cloudflare embeddings and rerank with one Jev/Clef decision endpoint and channel-based failover",
    zh: "Cloudflare 向量与重排，Jev/Clef 统一决策接口与渠道故障切换",
  },
  models: MODELS,
  auth: "api_key",
  requiredCapabilities: ["json-order@1"],
  fetchMode: "per_task",
  routes: [
    { method: "POST", path: "/cloudflare/v1/embeddings", type: "submit", action: "embeddings", decode: "embeddings", render: "render", models: EMBED, retainResult: false },
    { method: "POST", path: "/cloudflare/v1/rerank", type: "submit", action: "rerank", decode: "rerank", render: "render", models: [RERANK], retainResult: false },
    { method: "POST", path: "/cloudflare/v1/systemone", type: "submit", action: "systemone", decode: "systemone", render: "render", models: DECIDE, retainResult: false },
    { method: "POST", path: "/decision/v1/systemone", type: "submit", action: "systemone", decode: "systemone", render: "render", models: [JEV], retainResult: false },
  ],
  usageSchema: {
    input_tokens: {
      type: "number",
      unit: "token",
      description: { en: "Input token unit price", zh: "输入 Token 单价" },
    },
    input_rate: {
      type: "number",
      unit: "count",
      unitLabel: { en: "USD per million input tokens", zh: "美元/百万输入 Token" },
      description: { en: "Input token billing rate", zh: "输入 Token 计费费率" },
    },
  },
  usageExamples: [{ label: "1,000 input tokens", facts: { input_tokens: 1000, input_rate: 0.042 } }],
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
  if (!list.includes(body.model)) fail("Unsupported model for this operation");
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
  requireModel(body, DECISION_MODELS);
  if (body.state === undefined || !(typeof body.state === "string" || body.state === null || Array.isArray(body.state) || object(body.state)))
    fail("state must be text, object, array or null");
  if (body.images !== undefined) fail("images are not yet supported by this plugin; do not silently discard media");
  if (!object(body.questions)) fail("questions must be an object");
  const ids = Object.keys(body.questions);
  const limit = body.model === JEV ? MAX_JEV_QUESTIONS : MAX_CLEF_QUESTIONS;
  if (ids.length < 1 || ids.length > limit) fail("questions must contain 1–" + limit + " questions");
  for (const id of ids) {
    if (!/^[a-zA-Z0-9_.-]{1,100}$/.test(id)) fail("Invalid question identifier");
    const q = body.questions[id];
    if (!object(q) || !["noul", "choice", "score"].includes(q.type)) fail("Unsupported question type");
    if (q.instructions !== undefined && q.instructions !== null &&
        !(typeof q.instructions === "string" || Array.isArray(q.instructions) || object(q.instructions)))
      fail("Question instructions must be text, object, array, or null");
    if (q.type === "choice" && (!object(q.criteria) || Object.keys(q.criteria).length < 1 || Object.keys(q.criteria).length > 255))
      fail("Choice questions need 1–255 options");
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
  error: function (_ctx, error) { return { error: { message: error.message, type: "decision_gateway_error" } }; },
};

// Credentials can reach only the selected channel's allowlisted official host.
function apiBase(baseUrl) {
  if (typeof baseUrl !== "string") fail("Channel Base URL is required");
  const base = baseUrl.replace(/\/+$/, "");
  if (/^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/[0-9a-f]{32}\/ai$/i.test(base))
    return { kind: "cloudflare", base };
  if (base === "https://api.typesafe.ai" || base === "https://api.typesafe.ai/v1")
    return { kind: "typesafe", base: base.replace(/\/v1$/, "") };
  return fail("Unsupported channel Base URL; expected official Cloudflare account AI or api.typesafe.ai");
}
function modelOf(ctx) {
  const model = ctx.upstreamModel || ctx.model;
  if (!MODELS.includes(model)) fail("Unknown upstream model");
  return model;
}
function tokenEstimate(input) {
  const size = JSON.stringify(input).length;
  return Math.max(1, Math.min(MAX_USAGE_TOKENS, Math.ceil(size / 4)));
}
function estimatedInput(ctx) {
  const action = ctx.action;
  if (action === "systemone") return modelOf(ctx) === "@cf/cloudflare/clef-flash" ? 24576 : 65536;
  return tokenEstimate(ctx.requestBody);
}
export function buildSubmitRequest(ctx) {
  const { kind, base } = apiBase(ctx.baseUrl);
  const model = modelOf(ctx);
  // NewAPI's official API-key auth provides ctx.authHeader as the BARE key,
  // not an HTTP Authorization header. Both upstreams require Bearer credentials.
  // Use the channel's actual key, never a user-supplied incoming header.
  if (typeof ctx.apiKey !== "string" || !ctx.apiKey.trim()) fail("Missing upstream channel API key");
  const headers = { Authorization: "Bearer " + ctx.apiKey.trim(), "Content-Type": "application/json", Accept: "application/json" };
  const body = ctx.requestBody;
  if (!object(body)) fail("Missing normalized request body");
  if (ctx.action === "embeddings") {
    if (kind !== "cloudflare" || !EMBED.includes(model)) fail("Embeddings require a Cloudflare embedding channel");
    validateEmbeddings(body);
    return { method: "POST", url: base + "/v1/embeddings", headers, body: { model, input: body.input, encoding_format: "float" } };
  }
  if (ctx.action === "rerank") {
    if (kind !== "cloudflare" || model !== RERANK) fail("Rerank requires a Cloudflare rerank channel");
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
    if (kind === "typesafe") {
      if (model !== JEV) fail("TypeSafe channels require the jev-latest model");
      return {
        method: "POST",
        url: base + "/v1/systemone",
        headers,
        body: { model, state: body.state, questions: body.questions },
      };
    }
    if (!DECIDE.includes(model)) fail("Cloudflare Decision requires a channel mapping to Clef or Clef Flash");
    if (Object.keys(body.questions).length > MAX_CLEF_QUESTIONS)
      fail("Cloudflare Clef supports 64 questions at most. No answers were dropped; reduce the decision batch");
    if (body.state === null) fail("Cloudflare Clef requires non-null state");
    return {
      method: "POST",
      url: base + "/run/" + model,
      headers,
      body: { model: model.endsWith("clef-flash") ? "clef-flash" : "clef", state: body.state, questions: body.questions },
    };
  }
  return fail("Unknown plugin action");
}
function unwrap(response) {
  if (response.statusCode < 200 || response.statusCode > 299) {
    const errors = response.body && response.body.errors;
    const code = Array.isArray(errors) && errors.length && Number.isInteger(errors[0].code) ? " code " + errors[0].code : "";
    fail("Decision or Workers AI upstream returned HTTP " + response.statusCode + code);
  }
  const b = response.body;
  if (!object(b)) fail("Upstream returned an invalid JSON response");
  if (b.success === false) fail("Upstream reported unsuccessful inference");
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
  if (!object(raw.answers)) fail("System One decision answers missing");
  for (const id of Object.keys(ctx.requestBody.questions)) {
    if (!object(raw.answers[id]) || raw.answers[id].type !== ctx.requestBody.questions[id].type)
      fail("System One did not return the correct answer type for " + id);
  }
  const served = modelOf(ctx);
  const tokens = served === JEV ? usageFrom(raw, -1) : usageFrom(raw, estimatedInput(ctx));
  if (tokens < 0) fail("TypeSafe input token usage is missing");
  return { model: ctx.model, answers: raw.answers, usage: { input_tokens: tokens } };
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
  const model = modelOf(ctx);
  return { input_tokens: estimatedInput(ctx), input_rate: upstreamInputRate(model) };
}
export function extractUsageOnComplete(ctx, _result, body) {
  const tokens = body && body.usage && body.usage.input_tokens;
  if (!Number.isInteger(tokens) || tokens < 0 || tokens > MAX_USAGE_TOKENS)
    fail("Upstream input-token usage could not be established");
  return { input_tokens: tokens, input_rate: upstreamInputRate(modelOf(ctx)) };
}
// All operations are synchronous. The official v1 per_task interface
// still requires these hooks, which must never poll the upstream.
export function buildQueryRequest() { fail("Synchronous operations cannot be polled"); }
export function parseTaskResult() { return { status: "UNKNOWN", reason: "Synchronous operation" }; }
