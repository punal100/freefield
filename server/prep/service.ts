import { execFile } from "node:child_process";
import { createReadStream, mkdirSync, rmSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join, extname } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { receive } from "../projects/assets.ts";
import { configFingerprint } from "../projects/planner.ts";
import { loadCapabilities, validateCapabilities, type PrepCapabilities } from "./capabilities.ts";
import {
  planEnhanceWindows,
  planExtensionSegments,
  planExtensionTail,
  PrepError,
  type FrameRange,
  type PrepWindow,
} from "./planner.ts";

const runFile = promisify(execFile);

export class PrepInputError extends Error {}

export type PrepProbe = {
  path: string;
  bytes: number;
  duration: number | null;
  fps: number | null;
  frames: number | null;
  width: number | null;
  height: number | null;
  rotation: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  hasAudio: boolean;
  variableFrameRate: boolean | null;
};

export type PrepSource = {
  id: string;
  name: string;
  path: string;
  probe: PrepProbe;
  createdAt: string;
};

export type PrepExportFile = {
  name: string;
  url: string;
  bytes: number;
};

export type PrepExportResult = {
  id: string;
  mode: "enhance" | "extend";
  files: PrepExportFile[];
  manifest: Record<string, unknown>;
};

function numberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function frameRate(value: unknown): number | null {
  const [num, den] = String(value ?? "").split("/").map(Number);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
  return num / den;
}

export async function probeSource(path: string): Promise<PrepProbe> {
  let text: string;
  try {
    text = String((await runFile(process.env.FREEFIELD_FFPROBE || "ffprobe", [
      "-v", "error", "-show_format", "-show_streams", "-of", "json", path,
    ], { timeout: 120_000, maxBuffer: 8 * 2 ** 20 })).stdout);
  } catch (error) {
    throw new PrepInputError((error as Error).message);
  }
  const data = JSON.parse(text) as {
    format?: { duration?: string; size?: string; format_name?: string };
    streams?: {
      codec_type?: string; codec_name?: string; width?: number; height?: number;
      avg_frame_rate?: string; r_frame_rate?: string; nb_frames?: string;
      duration?: string; side_data_list?: { rotation?: number }[];
      tags?: Record<string, string>;
    }[];
  };
  const video = data.streams?.find((stream) => stream.codec_type === "video");
  const audio = data.streams?.find((stream) => stream.codec_type === "audio");
  if (!video) throw new PrepInputError("source has no video stream");
  const avg = frameRate(video.avg_frame_rate);
  const real = frameRate(video.r_frame_rate);
  const rotation = Number(
    video.side_data_list?.find((item) => typeof item.rotation === "number")?.rotation
    ?? video.tags?.rotate
    ?? 0,
  );
  return {
    path,
    bytes: Number(data.format?.size) || statSync(path).size,
    duration: numberOrNull(data.format?.duration ?? video.duration),
    fps: avg ?? real,
    frames: video.nb_frames ? Number(video.nb_frames) : null,
    width: video.width ?? null,
    height: video.height ?? null,
    rotation: Number.isFinite(rotation) ? rotation : null,
    videoCodec: video.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    hasAudio: Boolean(audio),
    variableFrameRate: avg !== null && real !== null ? Math.abs(avg - real) > 0.001 : null,
  };
}

function scaleFilter(capability: PrepCapabilities): string[] {
  const filters: string[] = [];
  if (capability.source.fps !== null) filters.push(`fps=${capability.source.fps}`);
  if (capability.source.dimensions) {
    const { width, height } = capability.source.dimensions;
    filters.push(`scale=${width}:${height}:force_original_aspect_ratio=increase`, `crop=${width}:${height}`);
  }
  filters.push("setpts=PTS-STARTPTS");
  return filters;
}

function totalFrames(probe: PrepProbe): number {
  if (probe.frames !== null && Number.isInteger(probe.frames) && probe.frames > 0) return probe.frames;
  if (probe.duration !== null && probe.fps !== null) {
    const frames = Math.round(probe.duration * probe.fps);
    if (frames > 0) return frames;
  }
  throw new PrepInputError("source frame count is unavailable; configure a probe that reports frames or duration+fps");
}

function extensionFor(container: string): string {
  const clean = container.replace(/^\./, "").toLowerCase();
  return clean.includes("/") ? ".bin" : `.${clean}`;
}

function sourceStem(name: string): string {
  const stem = basename(name, extname(name)).normalize("NFKD")
    .replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return stem || "source";
}

function rangeStem(sourceName: string, kind: string, index: number | null, range: FrameRange): string {
  const label = index === null ? "tail" : `w${String(index + 1).padStart(3, "0")}`;
  const start = String(range.startFrame).padStart(6, "0");
  const end = String(range.endFrame).padStart(6, "0");
  return `${sourceStem(sourceName)}-${kind}-${label}-f${start}-${end}`;
}

async function extractRange(
  input: string,
  output: string,
  range: FrameRange,
  capability: PrepCapabilities,
  includeAudio: boolean,
): Promise<void> {
  const fps = capability.source.fps;
  if (fps === null) throw new PrepInputError("capability does not provide source fps; cannot cut frame range");
  const args = [
    "-y", "-v", "error",
    "-ss", (range.startFrame / fps).toFixed(6),
    "-i", input,
    "-frames:v", String(range.frames),
    "-vf", scaleFilter(capability).join(","),
    "-c:v", capability.export.videoCodec,
  ];
  if (capability.export.pixelFormat) args.push("-pix_fmt", capability.export.pixelFormat);
  if (includeAudio && capability.export.audioCodec) args.push("-c:a", capability.export.audioCodec);
  else args.push("-an");
  args.push("-movflags", "+faststart", output);
  await runFile(process.env.FREEFIELD_FFMPEG || "ffmpeg", args, { timeout: 600_000, maxBuffer: 8 * 2 ** 20 });
}

export class PrepService {
  readonly root: string;
  private readonly sources = new Map<string, PrepSource>();
  private readonly exports = new Map<string, PrepExportResult>();
  private capabilities: PrepCapabilitiesResult;

  constructor(root: string) {
    this.root = root;
    this.capabilities = loadCapabilities();
    mkdirSync(root, { recursive: true });
  }

  capabilityResult() { return this.capabilities; }

  setCapabilities(raw: unknown): PrepCapabilitiesResult {
    this.capabilities = validateCapabilities(raw);
    return this.capabilities;
  }

  private capability(): PrepCapabilities {
    if (!this.capabilities.available) throw new PrepInputError(`prep capabilities unavailable: ${(this.capabilities as { reason: string }).reason}`);
    return this.capabilities;
  }

  async analyze(req: IncomingMessage, filename: string): Promise<PrepSource> {
    this.capability();
    const id = randomUUID();
    const folder = join(this.root, id);
    mkdirSync(folder, { recursive: true });
    const path = join(folder, `source${extname(filename) || ".video"}`);
    const configuredLimit = process.env.FREEFIELD_PREP_MAX_UPLOAD_MB;
    const limitMb = configuredLimit === undefined || configuredLimit === "" ? 2048 : Number(configuredLimit);
    const limit = limitMb * 2 ** 20;
    if (!Number.isFinite(limit) || limit <= 0) {
      rmSync(folder, { recursive: true, force: true });
      throw new PrepInputError("FREEFIELD_PREP_MAX_UPLOAD_MB must be a positive number");
    }
    await receive(req, path, limit);
    const probe = await probeSource(path);
    const source: PrepSource = { id, name: filename, path, probe, createdAt: new Date().toISOString() };
    this.sources.set(id, source);
    return source;
  }

  plan(body: Record<string, unknown>): unknown {
    const capability = this.capability();
    const source = this.source(String(body.sourceId ?? ""));
    const mode = String(body.mode ?? "");
    if (mode === "enhance") {
      if (!capability.enhance) throw new PrepInputError("enhance capability is unavailable");
      return planEnhanceWindows({ sourceFrames: totalFrames(source.probe), capability: capability.enhance });
    }
    if (mode === "extend") {
      if (!capability.extend) throw new PrepInputError("extend capability is unavailable");
      const contextFrames = Number(body.contextFrames);
      const tail = planExtensionTail({ sourceFrames: totalFrames(source.probe), contextFrames, capability: capability.extend });
      const targetFrames = body.targetFrames === undefined ? null : Number(body.targetFrames);
      const visibleFrames = body.visibleFrames === undefined ? null : Number(body.visibleFrames);
      const segments = targetFrames !== null && visibleFrames !== null
        ? planExtensionSegments({
          sourceFrames: totalFrames(source.probe),
          targetFrames,
          contextFrames,
          visibleFrames,
          capability: capability.extend,
        })
        : [];
      return { tail, segments };
    }
    throw new PrepInputError("mode must be enhance or extend");
  }

  async export(body: Record<string, unknown>): Promise<PrepExportResult> {
    const capability = this.capability();
    const source = this.source(String(body.sourceId ?? ""));
    if (!source.probe.hasAudio && capability.source.audio === "required") {
      throw new PrepInputError("source has no audio; the configured capability requires audio");
    }
    const mode = String(body.mode ?? "");
    const id = randomUUID();
    const folder = join(this.root, id);
    mkdirSync(folder, { recursive: true });
    const manifest: Record<string, unknown> = {
      id, mode, source: { id: source.id, name: source.name, probe: source.probe },
      capability, createdAt: new Date().toISOString(),
    };
    const files: PrepExportFile[] = [];
    if (mode === "enhance") {
      if (!capability.enhance) throw new PrepInputError("enhance capability is unavailable");
      const planned = planEnhanceWindows({ sourceFrames: totalFrames(source.probe), capability: capability.enhance });
      const requested = body.windowIndices ?? (body.windowIndex !== undefined ? [body.windowIndex] : null);
      let windows = planned;
      if (requested !== null) {
        if (!Array.isArray(requested) || requested.length === 0) throw new PrepInputError("windowIndices must select at least one window");
        const indexes = [...new Set(requested.map(Number))];
        if (indexes.some((index) => !Number.isInteger(index))) throw new PrepInputError("windowIndices must be integers");
        if (indexes.some((index) => !planned.some((window) => window.index === index))) {
          throw new PrepInputError("windowIndices contains a window outside the current plan");
        }
        const selected = new Set(indexes);
        windows = planned.filter((window) => selected.has(window.index));
        manifest.windowIndices = windows.map((window) => window.index);
      }
      for (const window of windows) {
        const name = `${rangeStem(source.name, "enhance", window.index, window)}${extensionFor(capability.export.container)}`;
        const output = join(folder, name);
        await extractRange(source.path, output, window, capability, capability.source.audio !== "ignored");
        const probe = await probeSource(output);
        files.push({ name, url: `/api/prep/files/${id}/${name}`, bytes: probe.bytes });
      }
      manifest.planFingerprint = configFingerprint({ sourceId: source.id, mode, windows: planned });
      manifest.windows = windows;
    } else if (mode === "extend") {
      if (!capability.extend) throw new PrepInputError("extend capability is unavailable");
      const tail = planExtensionTail({ sourceFrames: totalFrames(source.probe), contextFrames: Number(body.contextFrames), capability: capability.extend });
      const name = `${rangeStem(source.name, "extend", null, tail)}${extensionFor(capability.export.container)}`;
      const output = join(folder, name);
      await extractRange(source.path, output, tail, capability, capability.source.audio !== "ignored");
      const probe = await probeSource(output);
      files.push({ name, url: `/api/prep/files/${id}/${name}`, bytes: probe.bytes });
      manifest.tail = tail;
      manifest.planFingerprint = configFingerprint({ sourceId: source.id, mode, tail });
    } else {
      throw new PrepInputError("mode must be enhance or extend");
    }
    const manifestPath = join(folder, "manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    const result: PrepExportResult = { id, mode: mode as "enhance" | "extend", files, manifest };
    this.exports.set(id, result);
    return result;
  }

  file(exportId: string, name: string): string | null {
    const result = this.exports.get(exportId);
    if (!result || !result.files.some((file) => file.name === name)) return null;
    if (name.includes("/") || name.includes("\\") || name.includes("..")) return null;
    return join(this.root, exportId, name);
  }

  source(id: string): PrepSource {
    const source = this.sources.get(id);
    if (!source) throw new PrepInputError("source not found or expired");
    return source;
  }
}

type PrepCapabilitiesResult = ReturnType<typeof loadCapabilities>;





