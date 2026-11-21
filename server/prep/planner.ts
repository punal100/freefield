// Pure planning helpers for long-video preparation. Every limit is supplied by
// a capability document; this module owns no product defaults.

export class PrepError extends Error {}

export type FrameRange = {
  startFrame: number;
  endFrame: number;
  frames: number;
};

export type PrepWindow = FrameRange & {
  index: number;
  sourceFrames: number;
  overlapBefore: number;
  overlapAfter: number;
};

export type EnhanceCapability = {
  windowFrames: number;
  overlapFrames: number;
  minSourceFrames: number;
};

export type ExtensionCapability = {
  contextFrames: { min: number; max: number };
  requestFrames: { min: number; max: number };
};

export type ExtensionTail = FrameRange & {
  sourceFrames: number;
};

export type ExtensionSegment = FrameRange & {
  index: number;
  visibleFrames: number;
  contextFrames: number;
  requestFrames: number;
};

function positiveInt(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) throw new PrepError(`${name} must be a positive integer`);
}

function nonNegativeInt(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) throw new PrepError(`${name} must be a non-negative integer`);
}

function requireRange(name: string, range: { min: number; max: number }): void {
  positiveInt(`${name}.min`, range.min);
  positiveInt(`${name}.max`, range.max);
  if (range.max < range.min) throw new PrepError(`${name}.max must be at least ${name}.min`);
}

export function planEnhanceWindows(opts: {
  sourceFrames: number;
  capability: EnhanceCapability;
}): PrepWindow[] {
  const sourceFrames = Math.round(opts.sourceFrames);
  const { windowFrames, overlapFrames, minSourceFrames } = opts.capability;
  positiveInt("sourceFrames", sourceFrames);
  positiveInt("capability.windowFrames", windowFrames);
  nonNegativeInt("capability.overlapFrames", overlapFrames);
  positiveInt("capability.minSourceFrames", minSourceFrames);
  if (overlapFrames >= windowFrames) throw new PrepError("overlapFrames must be smaller than windowFrames");
  if (sourceFrames < minSourceFrames) throw new PrepError(`source has ${sourceFrames} frames; capability requires at least ${minSourceFrames}`);
  if (sourceFrames < windowFrames) throw new PrepError("source is shorter than one enhancement window");

  const step = windowFrames - overlapFrames;
  if (step <= 0) throw new PrepError("windowFrames - overlapFrames must be positive");
  const starts: number[] = [];
  for (let start = 0; start + windowFrames <= sourceFrames; start += step) starts.push(start);
  const lastStart = sourceFrames - windowFrames;
  if (starts.at(-1) !== lastStart) starts.push(lastStart);

  return starts.map((start, index) => ({
    index,
    startFrame: start,
    endFrame: start + windowFrames,
    frames: windowFrames,
    sourceFrames: Math.min(windowFrames, sourceFrames - start),
    overlapBefore: index === 0 ? 0 : starts[index - 1] + windowFrames - start,
    overlapAfter: index === starts.length - 1 ? 0 : start + windowFrames - starts[index + 1],
  }));
}

export function planExtensionTail(opts: {
  sourceFrames: number;
  contextFrames: number;
  capability: ExtensionCapability;
}): ExtensionTail {
  const sourceFrames = Math.round(opts.sourceFrames);
  const contextFrames = Math.round(opts.contextFrames);
  positiveInt("sourceFrames", sourceFrames);
  positiveInt("contextFrames", contextFrames);
  requireRange("capability.contextFrames", opts.capability.contextFrames);
  if (contextFrames < opts.capability.contextFrames.min || contextFrames > opts.capability.contextFrames.max) {
    throw new PrepError(`contextFrames must be ${opts.capability.contextFrames.min}-${opts.capability.contextFrames.max}`);
  }
  if (sourceFrames < contextFrames) throw new PrepError("source is shorter than the requested motion context");
  const startFrame = sourceFrames - contextFrames;
  return { startFrame, endFrame: sourceFrames, frames: contextFrames, sourceFrames };
}

export function extensionSegmentLimits(capability: ExtensionCapability, contextFrames: number): {
  minVisibleFrames: number;
  maxVisibleFrames: number;
} {
  requireRange("capability.contextFrames", capability.contextFrames);
  requireRange("capability.requestFrames", capability.requestFrames);
  positiveInt("contextFrames", contextFrames);
  if (contextFrames < capability.contextFrames.min || contextFrames > capability.contextFrames.max) {
    throw new PrepError(`contextFrames must be ${capability.contextFrames.min}-${capability.contextFrames.max}`);
  }
  const minVisibleFrames = capability.requestFrames.min - contextFrames;
  const maxVisibleFrames = capability.requestFrames.max - contextFrames;
  if (maxVisibleFrames <= 0) throw new PrepError("contextFrames consume the whole request budget");
  if (minVisibleFrames <= 0) throw new PrepError("contextFrames leave no valid visible range");
  return { minVisibleFrames, maxVisibleFrames };
}

export function planExtensionSegments(opts: {
  sourceFrames: number;
  targetFrames: number;
  contextFrames: number;
  visibleFrames: number;
  capability: ExtensionCapability;
}): ExtensionSegment[] {
  const sourceFrames = Math.round(opts.sourceFrames);
  const targetFrames = Math.round(opts.targetFrames);
  const contextFrames = Math.round(opts.contextFrames);
  const visibleFrames = Math.round(opts.visibleFrames);
  positiveInt("sourceFrames", sourceFrames);
  positiveInt("targetFrames", targetFrames);
  if (targetFrames <= sourceFrames) return [];
  const limits = extensionSegmentLimits(opts.capability, contextFrames);
  if (visibleFrames < limits.minVisibleFrames || visibleFrames > limits.maxVisibleFrames) {
    throw new PrepError(`visibleFrames must be ${limits.minVisibleFrames}-${limits.maxVisibleFrames} for this context`);
  }

  const segments: ExtensionSegment[] = [];
  let cursor = sourceFrames;
  while (cursor < targetFrames) {
    const remaining = targetFrames - cursor;
    const visible = Math.min(visibleFrames, remaining);
    if (visible < limits.minVisibleFrames) {
      throw new PrepError(`remaining ${visible} visible frames is below the capability minimum ${limits.minVisibleFrames}`);
    }
    const requestFrames = visible + contextFrames;
    if (requestFrames < opts.capability.requestFrames.min || requestFrames > opts.capability.requestFrames.max) {
      throw new PrepError(`request of ${requestFrames} frames is outside the capability range`);
    }
    segments.push({
      index: segments.length,
      startFrame: cursor,
      endFrame: cursor + visible,
      frames: visible,
      visibleFrames: visible,
      contextFrames,
      requestFrames,
    });
    cursor += visible;
  }
  return segments;
}

