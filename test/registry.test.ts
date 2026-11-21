import { test } from "node:test";
import assert from "node:assert/strict";
import { loadRegistry, modelKey, templateVars } from "../server/registry.ts";

const { apps, problems } = loadRegistry();

test("every manifest passes the schema and its bindings resolve", () => {
  const errors = problems.filter((p) => p.severity === "error");
  assert.deepEqual(errors, []);
});

test("ready ComfyUI apps have a workflow on disk", () => {
  for (const app of apps.filter((a) => a.status === "ready" && a.backend !== "sglang" && a.backend !== "projects" && a.backend !== "prep")) {
    assert.ok(app.graph, `${app.id} has no workflow loaded`);
  }
});

test("the SGLang app is registered without a ComfyUI workflow", () => {
  const app = apps.find((a) => a.id === "h3-reference-sglang");
  assert.ok(app);
  assert.equal(app.backend, "sglang");
  assert.equal(app.workflowPath, undefined);
  assert.equal(app.outputs[0].type, "video");
});

test("folder name and id agree, ids are unique", () => {
  const ids = apps.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const a of apps) assert.ok(a.dir.endsWith(a.id), `${a.id} lives in ${a.dir}`);
});

test("IC exposes the full quality controls and does not promise automatic reductions", () => {
  const app = apps.find((a) => a.id === "h3-regenerate-2k-ic")!;
  const input = (id: string) => app.inputs.find((i) => i.id === id)!;
  assert.deepEqual(input("resolution").options?.map((o) => o.value), ["1080p", "2k", "4k"]);
  assert.deepEqual(input("sampler").options?.map((o) => o.value), ["up3", "up4", "hf8"]);
  assert.deepEqual(input("vae").options?.map((o) => o.value), ["fast", "standard"]);
  assert.match(app.notes ?? "", /never automatically reduced/i);
  assert.match(app.notes ?? "", /256\/64/);
});

test("apps that share models produce the same model key, so switching between them does not unload", () => {
  const edit = apps.find((a) => a.id === "edit")!;
  const cinema = apps.find((a) => a.id === "cinema-studio")!;   // FLUX 3 Klein text to image, the same three files as edit
  const video = apps.find((a) => a.id === "video")!;
  assert.equal(modelKey(edit), modelKey(cinema));
  assert.notEqual(modelKey(edit), modelKey(video));
});

test("templateVars finds placeholders", () => {
  assert.deepEqual(templateVars("{prompt}, shot on a {camera}"), ["prompt", "camera"]);
});


