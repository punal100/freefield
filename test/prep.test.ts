import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extensionSegmentLimits,
  planEnhanceWindows,
  planExtensionSegments,
  planExtensionTail,
  PrepError,
} from "../server/prep/planner.ts";
import { loadCapabilities, validateCapabilities } from "../server/prep/capabilities.ts";

test("enhance windows follow the supplied capability and pin the final window", () => {
  const windows = planEnhanceWindows({
    sourceFrames: 250,
    capability: { windowFrames: 100, overlapFrames: 10, minSourceFrames: 80 },
  });
  assert.deepEqual(windows.map((w) => w.startFrame), [0, 90, 150]);
  assert.equal(windows.at(-1)?.endFrame, 250);
  assert.equal(windows.at(-1)?.overlapBefore, 60);
  assert.ok(windows.every((w) => w.frames === 100));
});

test("changing only the capability changes window output", () => {
  const first = planEnhanceWindows({
    sourceFrames: 360,
    capability: { windowFrames: 120, overlapFrames: 8, minSourceFrames: 100 },
  });
  const second = planEnhanceWindows({
    sourceFrames: 360,
    capability: { windowFrames: 120, overlapFrames: 20, minSourceFrames: 100 },
  });
  assert.notDeepEqual(first.map((w) => w.startFrame), second.map((w) => w.startFrame));
});

test("enhance planning never invents a missing capability", () => {
  assert.throws(
    () => planEnhanceWindows({ sourceFrames: 250, capability: {} as never }),
    PrepError,
  );
});

test("enhance planning rejects a source below the capability minimum", () => {
  assert.throws(
    () => planEnhanceWindows({
      sourceFrames: 50,
      capability: { windowFrames: 100, overlapFrames: 10, minSourceFrames: 80 },
    }),
    /requires at least/,
  );
});

test("extension tail is selected from the capability context", () => {
  const tail = planExtensionTail({
    sourceFrames: 1000,
    contextFrames: 15,
    capability: { contextFrames: { min: 10, max: 20 }, requestFrames: { min: 40, max: 60 } },
  });
  assert.deepEqual(tail, { startFrame: 985, endFrame: 1000, frames: 15, sourceFrames: 1000 });
});

test("extension visible limits derive from context and request budget", () => {
  const limits = extensionSegmentLimits(
    { contextFrames: { min: 10, max: 20 }, requestFrames: { min: 40, max: 60 } },
    15,
  );
  assert.deepEqual(limits, { minVisibleFrames: 25, maxVisibleFrames: 45 });
});

test("extension segments validate against the supplied capability", () => {
  const segments = planExtensionSegments({
    sourceFrames: 100,
    targetFrames: 260,
    contextFrames: 15,
    visibleFrames: 45,
    capability: { contextFrames: { min: 10, max: 20 }, requestFrames: { min: 40, max: 60 } },
  });
  assert.deepEqual(segments.map((s) => s.visibleFrames), [45, 45, 45, 25]);
  assert.ok(segments.every((s) => s.requestFrames === s.visibleFrames + s.contextFrames));
});

test("extension rejects a visible length outside the capability", () => {
  assert.throws(
    () => planExtensionSegments({
      sourceFrames: 100,
      targetFrames: 260,
      contextFrames: 15,
      visibleFrames: 100,
      capability: { contextFrames: { min: 10, max: 20 }, requestFrames: { min: 40, max: 60 } },
    }),
    /visibleFrames must be/,
  );
});

test("capability validation accepts only a complete document", () => {
  const result = validateCapabilities({
    authority: "fixture",
    source: { fps: 30, dimensions: { width: 640, height: 360 }, audio: "optional" },
    enhance: { windowFrames: 91, overlapFrames: 7, minSourceFrames: 70 },
    extend: { contextFrames: { min: 9, max: 13 }, requestFrames: { min: 31, max: 47 } },
    export: { videoCodec: "h264", audioCodec: "aac", pixelFormat: "yuv420p", container: "mp4" },
  });
  assert.equal(result.available, true);
  if (result.available) assert.equal(result.enhance?.windowFrames, 91);
});

test("capability validation reports missing values instead of defaulting", () => {
  const result = validateCapabilities({ source: { fps: 24, dimensions: null, audio: "optional" } });
  assert.equal(result.available, false);
  if (!result.available) assert.ok(result.missing.includes("enhance"));
});

test("loadCapabilities auto-detects the H3 prep profile when unset", () => {
  const result = loadCapabilities({});
  assert.equal(result.available, true);
  if (result.available) {
    assert.equal(result.authority, "auto:h3-ref2va");
    assert.equal(result.source.fps, 24);
    assert.equal(result.enhance?.windowFrames, 124);
    assert.deepEqual(result.extend?.contextFrames, { min: 48, max: 360 });
  }
});

test("an explicit invalid override fails instead of falling back", () => {
  const result = loadCapabilities({ FREEFIELD_PREP_CAPABILITIES: "{" });
  assert.equal(result.available, false);
});
