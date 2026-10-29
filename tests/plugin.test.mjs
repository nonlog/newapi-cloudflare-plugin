import test from "node:test";
import assert from "node:assert/strict";
import { meta, native, buildSubmitRequest, parseSubmitResponse, extractUsage, extractUsageOnComplete } from "../plugin.js";

const BASE = "https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai";
const QWEN = "@cf/qwen/qwen3-embedding-0.6b";
const BGE = "@cf/baai/bge-m3";
const RERANK = "@cf/baai/bge-reranker-base";
const FLASH = "@cf/cloudflare/clef-flash";
const CLEF = "@cf/cloudflare/clef";
const decode = (action, payload) => native[action]({ body: { kind: "json", value: payload } });
function context(intent) {
  // Mirrors the real NewAPI auth: api_key yields a BARE authHeader.
  return { ...intent, baseUrl: BASE, apiKey: "test-only", authHeader: "test-only", upstreamModel: intent.model, publicTaskId: "task-test" };
}
const parse = (ctx, result) => parseSubmitResponse(ctx, { statusCode: 200, body: result });

test("manifest offers exactly three separate native routes, never claims unavailable host protocols", () => {
  assert.equal(meta.apiVersion, 1);
  assert.equal(meta.fetchMode, "per_task");
  assert.deepEqual(meta.routes.map((r) => r.path), [
    "/cloudflare/v1/embeddings",
    "/cloudflare/v1/rerank",
    "/cloudflare/v1/systemone",
  ]);
  for (const route of meta.routes) {
    assert.equal(route.retainResult, false);
    assert.equal(route.type, "submit");
  }
  assert.equal(meta.protocols, undefined);
  assert.equal(meta.models.length, 5);
});

test("embeddings normalize a single input, use native account-scoped OpenAI endpoint", () => {
  const req = decode("embeddings", { model: QWEN, input: "hello" });
  assert.deepEqual(req.requestBody.input, ["hello"]);
  const sent = buildSubmitRequest(context(req));
  assert.equal(sent.url, BASE + "/v1/embeddings");
  assert.equal(sent.headers.Authorization, "Bearer test-only");
  assert.equal(sent.body.model, QWEN);
  const result = parse(context(req), { object: "list", data: [
    { index: 0, object: "embedding", embedding: [0.1, 0.4] },
  ], usage: { prompt_tokens: 4, total_tokens: 4 } });
  assert.equal(result.immediate.status, "SUCCESS");
  assert.equal(result.taskData.data[0].embedding.length, 2);
  assert.equal(result.taskData.usage.input_tokens, 4);
  assert.deepEqual(native.render({}, { data: result.taskData }), result.taskData);
  assert.deepEqual(extractUsageOnComplete({}, null, result.taskData), { input_tokens: 4 });
});

test("Cloudflare always receives Bearer channel API key; never raw ctx.authHeader", () => {
  for (const intent of [
    decode("embeddings", { model: QWEN, input: "hello" }),
    decode("rerank", { model: RERANK, query: "hello", documents: ["world"] }),
    decode("systemone", { model: FLASH, state: "hello", questions: { answer: { type: "noul" } } }),
  ]) {
    const ctx = context(intent);
    assert.equal(ctx.authHeader, "test-only");
    assert.equal(buildSubmitRequest(ctx).headers.Authorization, "Bearer test-only");
    assert.equal(buildSubmitRequest({ ...ctx, authHeader: "Bearer wrong-token" }).headers.Authorization, "Bearer test-only");
  }
});

test("embeddings support the Cloudflare data-of-vectors format and missing usage", () => {
  const req = decode("embeddings", { model: BGE, input: ["first", "second"] });
  const result = parse(context(req), { success: true, result: { data: [[1, 2, 3], [4, 5, 6]], shape: [2, 3] } });
  assert.equal(result.taskData.data.length, 2);
  assert.equal(result.taskData.data[1].index, 1);
  assert.ok(result.taskData.usage.input_tokens > 0);
});

test("OpenAI Python SDK defaults to base64: route still returns float vectors", () => {
  const req = decode("embeddings", {
    model: QWEN,
    input: ["first document", "second document"],
    encoding_format: "base64",
  });
  const ctx = context(req);
  const upstream = buildSubmitRequest(ctx);
  assert.equal(upstream.body.encoding_format, "float");
  assert.deepEqual(upstream.body.input, ["first document", "second document"]);
  const result = parse(ctx, {
    success: true,
    result: { data: [{ embedding: [0.2, 0.8] }, { embedding: [0.6, 0.4] }] },
  });
  assert.equal(result.taskData.data.length, 2);
  assert.deepEqual(result.taskData.data.map((row) => row.index), [0, 1]);
  assert.deepEqual(result.taskData.data[0].embedding, [0.2, 0.8]);
  assert.equal(result.taskData.object, "list");
  assert.equal(result.taskData.usage.total_tokens, result.taskData.usage.prompt_tokens);
});

test("embeddings reject unsupported token arrays and unknown encodings", () => {
  assert.throws(() => decode("embeddings", { model: QWEN, input: [[1, 2]] }), /input item/);
  assert.throws(() => decode("embeddings", { model: QWEN, input: "test", encoding_format: "packed64" }), /float or base64/);
  assert.throws(() => decode("embeddings", { model: RERANK, input: "test" }), /Unsupported model/);
});

test("rerank uses Cloudflare query+contexts and maps sorted scores to standard results", () => {
  const req = decode("rerank", {
    model: RERANK, query: "What is CF?", documents: ["a snail", { text: "cloud workers" }],
    top_n: 1, return_documents: true,
  });
  const ctx = context(req);
  const sent = buildSubmitRequest(ctx);
  assert.equal(sent.url, BASE + "/run/" + RERANK);
  assert.deepEqual(sent.body.contexts, [{ text: "a snail" }, { text: "cloud workers" }]);
  assert.equal(sent.body.top_k, 1);
  const parsed = parse(ctx, { success: true, result: { response: [{ id: 0, score: 0.01 }, { id: 1, score: 0.92 }] } });
  assert.equal(parsed.taskData.results.length, 1);
  assert.equal(parsed.taskData.results[0].index, 1);
  assert.equal(parsed.taskData.results[0].relevance_score, 0.92);
  assert.deepEqual(parsed.taskData.results[0].document, { text: "cloud workers" });
  assert.ok(extractUsage(ctx).input_tokens > 0);
});

test("rerank rejects invalid documents, invalid top_n and malformed scores", () => {
  assert.throws(() => decode("rerank", { model: RERANK, query: "q", documents: [""] }), /document text/);
  assert.throws(() => decode("rerank", { model: RERANK, query: "q", documents: ["d"], top_n: 2 }), /top_n/);
  const req = context(decode("rerank", { model: RERANK, query: "q", documents: ["d"] }));
  assert.throws(() => parse(req, { success: true, result: { response: [{ id: 4, score: 0.5 }] } }), /invalid rerank/);
});

test("Clef Flash maps model selector and returns matching typed decisions", () => {
  const req = decode("systemone", {
    model: FLASH, state: { incident: "checkout broken" }, questions: { urgent: { type: "noul", instructions: "Urgent?" } },
  });
  const ctx = context(req);
  const sent = buildSubmitRequest(ctx);
  assert.equal(sent.url, BASE + "/run/" + FLASH);
  assert.equal(sent.body.model, "clef-flash");
  const parsed = parse(ctx, { success: true, result: {
    model: "clef-flash", answers: { urgent: { type: "noul", value: 0.99 } }, usage: { input_tokens: 123 },
  } });
  assert.equal(parsed.taskData.answers.urgent.type, "noul");
  assert.deepEqual(extractUsageOnComplete({}, null, parsed.taskData), { input_tokens: 123 });
});

test("Clef original selector and safe conservative reservations", () => {
  const req = decode("systemone", {
    model: CLEF, state: "check", questions: { severity: { type: "score", criteria: ["low", "high"] } },
  });
  assert.equal(buildSubmitRequest(context(req)).body.model, "clef");
  assert.equal(extractUsage(context(req)).input_tokens, 65536);
  const flashReq = context(decode("systemone", {
    model: FLASH, state: "check", questions: { urgent: { type: "noul" } },
  }));
  assert.equal(extractUsage(flashReq).input_tokens, 24576);
});

test("cannot redirect API credentials to arbitrary hosts or construct arbitrary model URL", () => {
  const req = context(decode("embeddings", { model: QWEN, input: "hi" }));
  assert.throws(() => buildSubmitRequest({ ...req, baseUrl: "https://evil.example/ai" }), /Base URL/);
  assert.throws(() => buildSubmitRequest({ ...req, upstreamModel: "@cf/evil/inject" }), /Unknown/);
  assert.throws(() => buildSubmitRequest({ ...req, apiKey: "", authHeader: "" }), /Missing.*key/);
});

test("rejected upstream status, failed Cloudflare response, unknown response and model mismatch", () => {
  const req = context(decode("embeddings", { model: QWEN, input: "hi" }));
  assert.throws(() => parseSubmitResponse(req, { statusCode: 503, body: { errors: [{ code: 10001 }] } }), /HTTP 503 code 10001/);
  assert.throws(() => parseSubmitResponse(req, { statusCode: 200, body: { success: false } }), /unsuccessful/);
  assert.throws(() => parse(req, { object: "list", data: [{ embedding: ["bad"] }] }), /invalid embedding/);
  assert.throws(() => parseSubmitResponse({ ...req, publicTaskId: "" }, { statusCode: 200, body: { data: [[0.1]] } }), /task ID/);
});

test("rejects lost media, malformed typed question and unsupported streaming", () => {
  const b = { model: FLASH, state: "state", questions: { a: { type: "noul" } } };
  assert.throws(() => decode("systemone", { ...b, images: ["https://example.com/image.png"] }), /images/);
  assert.throws(() => decode("systemone", { ...b, questions: { a: { type: "unknown" } } }), /question type/);
  assert.throws(() => decode("systemone", { ...b, stream: true }), /streaming/);
});
