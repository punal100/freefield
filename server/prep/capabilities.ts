import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type FrameBudget = { min: number; max: number };

export type PrepCapabilities = {
  available: true;
  authority: string;
  source: {
    fps: number | null;
    dimensions: { width: number; height: number } | null;
    audio: "required" | "optional" | "ignored";
  };
  enhance: {
    windowFrames: number;
    overlapFrames: number;
    minSourceFrames: number;
  } | null;
  extend: {
    contextFrames: FrameBudget;
    requestFrames: FrameBudget;
  } | null;
  export: {
    videoCodec: string;
    audioCodec: string | null;
    pixelFormat: string | null;
    container: string;
  };
};

export type PrepCapabilitiesUnavailable = {
  available: false;
  reason: string;
  authority: string | null;
  missing: string[];
};

export type PrepCapabilitiesResult = PrepCapabilities | PrepCapabilitiesUnavailable;

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function budget(value: unknown, name: string, missing: string[]): FrameBudget | null {
  if (!value || typeof value !== "object") { missing.push(name); return null; }
  const raw = value as Record<string, unknown>;
  if (!positiveInteger(raw.min) || !positiveInteger(raw.max) || raw.max < raw.min) {
    missing.push(`${name} must be a positive integer range`);
    return null;
  }
  return { min: raw.min, max: raw.max };
}

export function validateCapabilities(raw: unknown): PrepCapabilitiesResult {
  if (!raw || typeof raw !== "object") {
    return { available: false, reason: "capability document is missing", authority: null, missing: ["root"] };
  }
  const value = raw as Record<string, unknown>;
  const missing: string[] = [];
  const source = value.source && typeof value.source === "object" ? value.source as Record<string, unknown> : {};
  const fps = source.fps === null ? null : positiveInteger(source.fps) ? source.fps : (missing.push("source.fps"), null);
  const dimensions = source.dimensions && typeof source.dimensions === "object"
    ? source.dimensions as Record<string, unknown> : null;
  const width = dimensions && positiveInteger(dimensions.width) ? dimensions.width : null;
  const height = dimensions && positiveInteger(dimensions.height) ? dimensions.height : null;
  if ((width === null) !== (height === null)) missing.push("source.dimensions");
  const audio = source.audio;
  if (!["required", "optional", "ignored"].includes(String(audio))) missing.push("source.audio");

  const enhanceRaw = value.enhance && typeof value.enhance === "object" ? value.enhance as Record<string, unknown> : null;
  let enhance: PrepCapabilities["enhance"] = null;
  if (enhanceRaw) {
    if (!positiveInteger(enhanceRaw.windowFrames)) missing.push("enhance.windowFrames");
    if (!nonNegativeInteger(enhanceRaw.overlapFrames)) missing.push("enhance.overlapFrames");
    if (!positiveInteger(enhanceRaw.minSourceFrames)) missing.push("enhance.minSourceFrames");
    if (!missing.some((item) => item.startsWith("enhance."))) {
      enhance = {
        windowFrames: enhanceRaw.windowFrames as number,
        overlapFrames: enhanceRaw.overlapFrames as number,
        minSourceFrames: enhanceRaw.minSourceFrames as number,
      };
    } else {
      missing.push("enhance");
    }
  } else {
    missing.push("enhance");
  }

  const extendRaw = value.extend && typeof value.extend === "object" ? value.extend as Record<string, unknown> : null;
  let extend: PrepCapabilities["extend"] = null;
  if (extendRaw) {
    const context = budget(extendRaw.contextFrames, "extend.contextFrames", missing);
    const request = budget(extendRaw.requestFrames, "extend.requestFrames", missing);
    if (context && request) extend = { contextFrames: context, requestFrames: request };
    else missing.push("extend");
  } else {
    missing.push("extend");
  }

  const exportRaw = value.export && typeof value.export === "object" ? value.export as Record<string, unknown> : null;
  let exportSpec: PrepCapabilities["export"] | null = null;
  if (exportRaw) {
    if (typeof exportRaw.videoCodec !== "string" || !exportRaw.videoCodec) missing.push("export.videoCodec");
    if (typeof exportRaw.container !== "string" || !exportRaw.container) missing.push("export.container");
    if (exportRaw.audioCodec !== null && exportRaw.audioCodec !== undefined && typeof exportRaw.audioCodec !== "string") missing.push("export.audioCodec");
    if (exportRaw.pixelFormat !== null && exportRaw.pixelFormat !== undefined && typeof exportRaw.pixelFormat !== "string") missing.push("export.pixelFormat");
    if (!missing.some((item) => item.startsWith("export."))) {
      exportSpec = {
        videoCodec: exportRaw.videoCodec as string,
        audioCodec: typeof exportRaw.audioCodec === "string" ? exportRaw.audioCodec : null,
        pixelFormat: typeof exportRaw.pixelFormat === "string" ? exportRaw.pixelFormat : null,
        container: exportRaw.container as string,
      };
    } else {
      missing.push("export");
    }
  } else {
    missing.push("export");
  }

  if (missing.length || !enhance || !extend || !exportSpec) {
    return {
      available: false,
      reason: "prep capability document is incomplete",
      authority: typeof value.authority === "string" ? value.authority : null,
      missing: [...new Set(missing)],
    };
  }

  return {
    available: true,
    authority: typeof value.authority === "string" ? value.authority : "configuration",
    source: {
      fps,
      dimensions: width !== null && height !== null ? { width, height } : null,
      audio: audio as PrepCapabilities["source"]["audio"],
    },
    enhance,
    extend,
    export: exportSpec,
  };
}

export function loadCapabilities(env: NodeJS.ProcessEnv = process.env): PrepCapabilitiesResult {
  const inline = env.FREEFIELD_PREP_CAPABILITIES;
  const file = env.FREEFIELD_PREP_CAPABILITIES_FILE;
  let raw: unknown = null;
  if (inline) {
    try { raw = JSON.parse(inline); } catch { return { available: false, reason: "FREEFIELD_PREP_CAPABILITIES is not valid JSON", authority: null, missing: [] }; }
  } else if (file) {
    try { raw = JSON.parse(readFileSync(resolve(file), "utf8")); }
    catch (error) { return { available: false, reason: `cannot read prep capabilities: ${(error as Error).message}`, authority: null, missing: [] }; }
  }
  return validateCapabilities(raw);
}


