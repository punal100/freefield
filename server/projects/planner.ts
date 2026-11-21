// Pure planning helpers for long-form projects. They do not touch the GPU or disk,
// which makes the hard parts (duration framing, overlap, stale dependencies) testable.

export const FPS = 24;
export const DEFAULT_CONTEXT_FRAMES = 63; // 2.625 s: the shortest valid Ref2VA reference at 24 fps
export const DEFAULT_VISIBLE_FRAMES = 240; // 10 s
export const IC_WINDOW_FRAMES = 124;
export const IC_OVERLAP_FRAMES = 17;
export const MAX_H3_SECONDS = 15;
export const MIN_H3_SECONDS = 4;

export type ExtensionPlanSegment = {
  index: number;
  startFrame: number;
  visibleFrames: number;
  requestFrames: number;
  requestSeconds: number;
};

export type ExtensionPlan = {
  sourceFrames: number;
  targetFrames: number;
  contextFrames: number;
  visibleFrames: number;
  segments: ExtensionPlanSegment[];
};

function positiveInt(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
}

/**
 * Plan visible extension segments. Segment 0 is the source itself; each plan entry
 * is one H3 request whose generated clip includes `contextFrames` at its head.
 *
 * A remainder shorter than 2 seconds is folded into the previous visible segment
 * (the request still has to stay <=15 s). A single short remainder with no previous
 * segment is rejected: H3 cannot generate a sub-4 s request.
 */
export function planExtension(opts: {
  sourceFrames: number;
  targetFrames: number;
  visibleFrames?: number;
  contextFrames?: number;
}): ExtensionPlan {
  const sourceFrames = Math.max(0, Math.round(opts.sourceFrames));
  const targetFrames = Math.max(0, Math.round(opts.targetFrames));
  const contextFrames = opts.contextFrames ?? DEFAULT_CONTEXT_FRAMES;
  const visibleFrames = opts.visibleFrames ?? DEFAULT_VISIBLE_FRAMES;
  positiveInt("sourceFrames", sourceFrames);
  positiveInt("targetFrames", targetFrames);
  positiveInt("contextFrames", contextFrames);
  positiveInt("visibleFrames", visibleFrames);
  if (contextFrames < FPS * 2) throw new Error("contextFrames must cover at least 2 seconds");
  if (visibleFrames < FPS * 2) throw new Error("visibleFrames must be at least 2 seconds");

  const maxVisible = Math.floor((MAX_H3_SECONDS * FPS) - contextFrames);
  if (visibleFrames > maxVisible) {
    throw new Error(`visibleFrames + contextFrames must fit in ${MAX_H3_SECONDS} seconds`);
  }
  if (targetFrames <= sourceFrames) {
    return { sourceFrames, targetFrames, contextFrames, visibleFrames, segments: [] };
  }

  const segments: ExtensionPlanSegment[] = [];
  let cursor = sourceFrames;
  while (cursor < targetFrames) {
    const remaining = targetFrames - cursor;
    let visible = Math.min(visibleFrames, remaining);

    if (remaining < FPS * 2) {
      const previous = segments.at(-1);
      if (!previous) {
        throw new Error("the requested extension is shorter than the 2 second minimum");
      }
      const combined = previous.visibleFrames + remaining;
      if (combined > maxVisible) {
        throw new Error("the remaining tail cannot be folded into the previous segment without exceeding 15 seconds");
      }
      previous.visibleFrames = combined;
      previous.requestFrames = combined + contextFrames;
      previous.requestSeconds = +(previous.requestFrames / FPS).toFixed(6);
      cursor = targetFrames;
      break;
    }

    if (visible < FPS * 2) visible = FPS * 2;
    const requestFrames = visible + contextFrames;
    if (requestFrames < MIN_H3_SECONDS * FPS || requestFrames > MAX_H3_SECONDS * FPS) {
      throw new Error(`H3 request length ${requestFrames} frames is outside the supported 4-15 second range`);
    }
    segments.push({
      index: segments.length + 1,
      startFrame: cursor,
      visibleFrames: visible,
      requestFrames,
      requestSeconds: +(requestFrames / FPS).toFixed(6),
    });
    cursor += visible;
  }

  return { sourceFrames, targetFrames, contextFrames, visibleFrames, segments };
}

export type IcWindow = {
  index: number;
  startFrame: number;
  sourceFrames: number;
  overlapBefore: number;
  overlapAfter: number;
};

/**
 * Plan 124-frame IC windows. `step = windowFrames - overlapFrames`; a final
 * window is pinned to `totalFrames - windowFrames` so the timeline ends exactly
 * on the source. The last overlap can therefore be larger than the normal one.
 */
export function planIcWindows(opts: {
  totalFrames: number;
  windowFrames?: number;
  overlapFrames?: number;
}): IcWindow[] {
  const totalFrames = Math.round(opts.totalFrames);
  const windowFrames = opts.windowFrames ?? IC_WINDOW_FRAMES;
  const overlapFrames = opts.overlapFrames ?? IC_OVERLAP_FRAMES;
  positiveInt("totalFrames", totalFrames);
  positiveInt("windowFrames", windowFrames);
  positiveInt("overlapFrames", overlapFrames);
  if (windowFrames < FPS * 2) throw new Error("windowFrames must be at least 2 seconds");
  if (overlapFrames <= 0 || overlapFrames >= windowFrames) throw new Error("overlapFrames must be between 1 and windowFrames-1");
  if (totalFrames < windowFrames) return [];
  const step = windowFrames - overlapFrames;
  if (step <= 0) throw new Error("overlap must be smaller than the window");

  const starts: number[] = [];
  for (let start = 0; start + windowFrames <= totalFrames; start += step) starts.push(start);
  const lastStart = totalFrames - windowFrames;
  if (starts.at(-1) !== lastStart) starts.push(lastStart);

  return starts.map((start, index) => ({
    index,
    startFrame: start,
    sourceFrames: Math.min(windowFrames, totalFrames - start),
    overlapBefore: index === 0 ? 0 : starts[index - 1] + windowFrames - start,
    overlapAfter: index === starts.length - 1 ? 0 : start + windowFrames - starts[index + 1],
  }));
}

/** A stable, short hash of the values that affect one segment/window's output. */
export function configFingerprint(value: unknown): string {
  const text = JSON.stringify(value, Object.keys(value as Record<string, unknown>).sort());
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

