import { test } from "node:test";
import assert from "node:assert/strict";
import { loadRegistry } from "../server/registry.ts";
import { resolveValues, Runner } from "../server/runner.ts";
import { SglangClient } from "../server/sglang.ts";

const { apps } = loadRegistry();
const app = apps.find((a) => a.id === "h3-reference-sglang")!;

function fakeBackend() {
  const requests: { method: string; url: string; body: unknown }[] = [];
  let references = 0;
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    let body: unknown = init?.body;
    if (typeof body === "string" && body) body = JSON.parse(body);
    requests.push({ method, url, body });
    if (url.endsWith("/freefield/prepare")) return new Response(JSON.stringify({ freed: true }), { status: 200 });
    if (url.endsWith("/v1/model/load")) return new Response(JSON.stringify({ accepted: true }), { status: 202 });
    if (url.endsWith("/v1/model/unload?force=false")) return new Response(JSON.stringify({ accepted: true }), { status: 202 });
    if (url.endsWith("/v1/model/status")) return new Response(JSON.stringify({ state: "unloaded" }), { status: 200 });
    if (url.endsWith("/v1/references")) {
      references++;
      return new Response(JSON.stringify({ uri: `file:///workspace/refs/${references}.png`, kind: "image" }), { status: 200 });
    }
    if (url.endsWith("/v1/videos") && method === "POST") {
      return new Response(JSON.stringify({ id: "job-1", status: "queued", progress: 0 }), { status: 202 });
    }
    if (url.endsWith("/v1/videos/job-1") && method === "DELETE") {
      return new Response(JSON.stringify({ deleted: true }), { status: 200 });
    }
    if (url.endsWith("/v1/videos/job-1/content")) {
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { "content-type": "video/mp4" } });
    }
    if (url.endsWith("/v1/videos/job-1")) {
      return new Response(JSON.stringify({ id: "job-1", status: "completed", progress: 100 }), { status: 200 });
    }
    throw new Error(`unexpected request ${method} ${url}`);
  };
  return { fetch, requests };
}

test("an SGLang app uploads references and maps the form to the H3 request", async () => {
  const backend = fakeBackend();
  const runner = new Runner({
    baseUrl: "http://comfy.invalid",
    sglangBaseUrl: "http://sglang.invalid",
    sglangToken: "x".repeat(32),
    fetch: backend.fetch,
    sglangFetch: backend.fetch,
  });
  const image = { bytes: new Uint8Array([1, 2, 3]), name: "face.png", type: "image/png" };
  const values = resolveValues(app, {
    prompt: "use <Picture 1>",
    ref_images: [image],
    aspect: "9:16",
    resolution: 0.4,
    duration: 6,
    steps: 12,
    seed: 42,
    ref_image_size: "max",
  });
  const job = await runner.submit(app, values);
  assert.equal(job.id, "job-1");
  await job.wait();
  assert.equal(job.status, "succeeded");
  assert.equal(job.progress?.value, 1);
  assert.equal(job.outputs.length, 1);
  assert.deepEqual([...await job.outputs[0].toBytes()], [1, 2, 3, 4]);

  const submitted = backend.requests.find((r) => r.url.endsWith("/v1/videos") && r.method === "POST")!;
  assert.deepEqual(submitted.body, {
    prompt: "use <Picture 1>",
    task: "ref2va",
    seconds: 6,
    seed: 42,
    num_inference_steps: 12,
    reference_resize_mode: "max",
    conditions: [{ type: "image", uri: "file:///workspace/refs/1.png", role: "reference" }],
    target: { short_edge: 480, aspect_ratio: "9:16", duration_seconds: 6 },
  });
});

test("unload waits until the supervisor has released the model", async () => {
  const backend = fakeBackend();
  const client = new SglangClient({ baseUrl: "http://sglang.invalid", token: "x".repeat(32), fetch: backend.fetch });
  await client.unload();
  assert.ok(backend.requests.some((r) => r.url.endsWith("/v1/model/unload?force=false")));
  assert.ok(backend.requests.some((r) => r.url.endsWith("/v1/model/status")));
});

test("an SGLang app without a reference is rejected before submission", async () => {
  const backend = fakeBackend();
  const runner = new Runner({
    baseUrl: "http://comfy.invalid",
    sglangBaseUrl: "http://sglang.invalid",
    fetch: backend.fetch,
    sglangFetch: backend.fetch,
  });
  await assert.rejects(
    () => runner.submit(app, resolveValues(app, { prompt: "x", seed: 1 })),
    /at least one image, video, or audio reference/,
  );
});
