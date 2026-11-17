import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { planExtension, planIcWindows, configFingerprint } from "../server/projects/planner.ts";
import { ProjectDB } from "../server/projects/db.ts";

test("extension plan: 15 s source to 120 s at 10 s visible", () => {
  const plan = planExtension({ sourceFrames: 15 * 24, targetFrames: 120 * 24 });
  assert.equal(plan.segments.length, 11);
  assert.equal(plan.segments.at(-1)?.visibleFrames, 5 * 24);
  assert.equal(plan.segments.every((s) => s.requestSeconds >= 4 && s.requestSeconds <= 15), true);
});

test("extension plan folds a short final remainder into the previous segment", () => {
  const plan = planExtension({ sourceFrames: 15 * 24, targetFrames: 26.5 * 24 });
  assert.equal(plan.segments.length, 1);
  assert.equal(plan.segments[0].visibleFrames, 276);
});

test("extension plan: 8-16 visible segments covers 120 s", () => {
  for (const visible of [9, 10, 11, 12]) {
    const plan = planExtension({ sourceFrames: 15 * 24, targetFrames: 120 * 24, visibleFrames: visible * 24 });
    assert.ok(plan.segments.length >= 8 && plan.segments.length <= 16, `${visible}s: ${plan.segments.length}`);
  }
});

test("IC window plan: 120 s", () => {
  const windows = planIcWindows({ totalFrames: 120 * 24 });
  assert.equal(windows.length, 27);
  assert.equal(windows[0].startFrame, 0);
  assert.equal(windows.at(-1)?.startFrame, 120 * 24 - 124);
  assert.equal(windows.at(-1)?.sourceFrames, 124);
});

test("IC window plan: final tail is included", () => {
  const windows = planIcWindows({ totalFrames: 2880 });
  assert.equal(windows.at(-1)?.startFrame, 2756);
  assert.equal(windows.at(-1)?.overlapBefore, 81);
  assert.equal(new Set(windows.map((w) => `${w.startFrame}:${w.sourceFrames}`)).size, windows.length);
});

test("config fingerprints are stable and change with config", () => {
  assert.equal(configFingerprint({ seed: 1, steps: 8 }), configFingerprint({ steps: 8, seed: 1 }));
  assert.notEqual(configFingerprint({ seed: 1, steps: 8 }), configFingerprint({ seed: 2, steps: 8 }));
});

test("project ledger creates a project and segment/event records", async () => {
  const root = await mkdtemp(join(tmpdir(), "freefield-projects-"));
  const db = new ProjectDB(root, { mediaDir: join(root, "media"), stateDir: join(root, "state") });
  try {
    const p = db.createProject({ id: "20261117-000000-abcd", kind: "extend", targetSeconds: 120, prompt: "x", config: {} });
    assert.equal(p.status, "draft");
    db.insertSegment({
      project_id: p.id, idx: 1, status: "queued", start_frame: 360, end_frame: 600,
      visible_frames: 240, context_frames: 63, prompt: "x", seed: 43, steps: 8,
      request_json: "{}", config_hash: "x", job_id: null, upstream_id: null, output_asset: null,
      attempts: 0, error: null, started_at: null, finished_at: null,
    });
    db.updateSegment(p.id, 1, { status: "succeeded" });
    db.event(p.id, "test", { ok: true });
    assert.equal(db.segment(p.id, 1)?.status, "succeeded");
    assert.equal(db.events(p.id)[0]?.kind, "test");
    assert.equal(db.projects()[0].id, p.id);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
