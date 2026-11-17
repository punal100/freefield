// Content-addressed media store and ffmpeg helpers. Durable files are named by
// their SHA-256 and are shared by projects; SQLite rows hold the metadata.
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, extname, join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import type { IncomingMessage } from "node:http";
import type { NewAsset } from "./db.ts";
import { ProjectDB } from "./db.ts";

const execFileAsync = promisify(execFile);
const FFMPEG = process.env.FREEFIELD_FFMPEG || "ffmpeg";
const FFPROBE = process.env.FREEFIELD_FFPROBE || "ffprobe";
const IC_OVERLAP_FRAMES = 17;
const IC_STEP_FRAMES = 107;

export class MediaError extends Error {}

export type Probe = {
  bytes: number;
  width: number | null;
  height: number | null;
  fps: number | null;
  frames: number | null;
  duration: number | null;
  hasAudio: boolean;
  audioRate: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  json: unknown;
};

function mimeFor(path: string): string {
  const ext = extname(path).toLowerCase();
  return ({
    ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
    ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4",
  } as Record<string, string>)[ext] ?? "application/octet-stream";
}

async function run(bin: string, args: string[], timeout = 30 * 60_000): Promise<string> {
  try {
    const result = await execFileAsync(bin, args, { encoding: "utf8", timeout, maxBuffer: 8 * 2 ** 20 });
    return String(result.stdout);
  } catch (error) {
    const e = error as { stderr?: string; message?: string };
    throw new MediaError((e.stderr || e.message || `${bin} failed`).trim().slice(0, 1200));
  }
}

export async function probeMedia(path: string): Promise<Probe> {
  const text = await run(FFPROBE, [
    "-v", "error", "-show_format", "-show_streams", "-of", "json", path,
  ], 120_000);
  let data: {
    format?: { duration?: string; size?: string };
    streams?: {
      codec_type?: string; codec_name?: string; width?: number; height?: number;
      avg_frame_rate?: string; r_frame_rate?: string; nb_frames?: string; sample_rate?: string;
    }[];
  };
  try { data = JSON.parse(text); } catch { throw new MediaError("ffprobe returned unreadable JSON"); }
  const video = data.streams?.find((s) => s.codec_type === "video");
  const audio = data.streams?.find((s) => s.codec_type === "audio");
  const [num, den] = String(video?.avg_frame_rate || video?.r_frame_rate || "0/1").split("/").map(Number);
  const fps = den ? num / den : num;
  const duration = Number(data.format?.duration);
  const frames = Number(video?.nb_frames);
  return {
    bytes: statSync(path).size,
    width: video?.width ?? null,
    height: video?.height ?? null,
    fps: Number.isFinite(fps) && fps > 0 ? fps : null,
    frames: Number.isFinite(frames) && frames > 0 ? frames : (Number.isFinite(duration) ? Math.round(duration * (fps || 24)) : null),
    duration: Number.isFinite(duration) && duration > 0 ? duration : null,
    hasAudio: Boolean(audio),
    audioRate: audio?.sample_rate ? Number(audio.sample_rate) : null,
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    json: data,
  };
}

export class AssetStore {
  readonly db: ProjectDB;
  readonly root: string;

  constructor(db: ProjectDB, root = process.env.FREEFIELD_MEDIA_DIR || db.mediaDir) {
    this.db = db;
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true });
  }

  pathFor(assetId: string, ext = ".mp4"): string {
    const safe = /^[a-f0-9]{64}$/.test(assetId) ? assetId : createHash("sha256").update(assetId).digest("hex");
    return join(this.root, "sha256", safe.slice(0, 2), safe.slice(2, 4), `${safe}${ext}`);
  }

  async ingest(sourcePath: string, originalName?: string): Promise<string> {
    const hash = await hashFile(sourcePath);
    const ext = extname(originalName || sourcePath).toLowerCase() || ".mp4";
    const safeExt = /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : ".mp4";
    const target = this.pathFor(hash, safeExt);
    mkdirSync(dirname(target), { recursive: true });
    if (target !== sourcePath) {
      try {
        if (statSync(target).size > 0) {
          rmSync(sourcePath, { force: true });
        } else {
          renameSync(sourcePath, target);
        }
      } catch {
        renameSync(sourcePath, target);
      }
    }
    const probe = await probeMedia(target);
    const rel = relative(this.root, target).replaceAll("\\", "/");
    if (!this.db.asset(hash)) {
      this.db.insertAsset({
        id: hash, sha256: hash, path: rel, bytes: probe.bytes, mime: mimeFor(target),
        width: probe.width, height: probe.height, fps: probe.fps, frames: probe.frames, duration: probe.duration,
        has_audio: probe.hasAudio ? 1 : 0, audio_rate: probe.audioRate, video_codec: probe.videoCodec,
        audio_codec: probe.audioCodec, probe_json: JSON.stringify(probe.json),
      } satisfies NewAsset);
    }
    return hash;
  }

  absolute(assetId: string): string {
    const asset = this.db.asset(assetId);
    if (!asset) throw new MediaError(`asset ${assetId} is missing from the ledger`);
    return join(this.root, asset.path);
  }
}

export async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Stream an HTTP request to a temp file without loading it into Node memory. */
export async function receive(req: IncomingMessage, path: string, maxBytes = 2 ** 30): Promise<number> {
  let bytes = 0;
  const out = createWriteStream(path, { flags: "w" });
  try {
    for await (const chunk of req) {
      bytes += (chunk as Buffer).byteLength;
      if (bytes > maxBytes) throw new MediaError(`upload is over ${Math.round(maxBytes / 2 ** 20)} MB`);
      if (!out.write(chunk)) await new Promise<void>((resolve) => out.once("drain", resolve));
    }
    await new Promise<void>((resolve, reject) => out.end((error?: Error | null) => error ? reject(error) : resolve()));
    return bytes;
  } catch (error) {
    out.destroy();
    rmSync(path, { force: true });
    throw error;
  }
}

export function tempPath(projectRoot: string): string {
  const dir = join(projectRoot, "staging");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${randomUUID()}.part`);
}

export async function extractTail(input: string, output: string, contextFrames: number): Promise<void> {
  const seconds = contextFrames / 24;
  await run(FFMPEG, [
    "-y", "-v", "error", "-sseof", `-${seconds.toFixed(6)}`, "-i", input,
    "-t", seconds.toFixed(6), "-vf", "fps=24,setpts=PTS-STARTPTS",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", output,
  ], 300_000);
}

export async function trimHead(input: string, output: string, seconds: number): Promise<void> {
  await run(FFMPEG, [
    "-y", "-v", "error", "-ss", seconds.toFixed(6), "-i", input,
    "-vf", "fps=24,setpts=PTS-STARTPTS", "-c:v", "libx264", "-preset", "veryfast",
    "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k",
    "-movflags", "+faststart", output,
  ], 300_000);
}

/** Concatenate source + visible segments; stream-copy when possible, re-encode once otherwise. */
export async function concatVideos(inputs: string[], output: string, targetSeconds?: number, audioSource?: string): Promise<void> {
  const dir = dirname(output);
  const list = join(dir, `concat-${randomUUID()}.txt`);
  const escape = (p: string) => p.replaceAll("'", "'\\''");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(list, inputs.map((p) => `file '${escape(resolve(p))}'`).join("\n") + "\n");
  const probes = await Promise.all(inputs.map((input) => probeMedia(input)));
  const first = probes[0];
  const copySafe = Boolean(first) && probes.every((p) => p.videoCodec === first.videoCodec
    && p.width === first.width && p.height === first.height
    && p.hasAudio === first.hasAudio
    && (!first.hasAudio || (p.audioCodec === first.audioCodec && p.audioRate === first.audioRate)));
  if (copySafe) {
    try {
      await run(FFMPEG, ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", ...(targetSeconds ? ["-t", targetSeconds.toFixed(6)] : []), "-movflags", "+faststart", output], 600_000);
      return;
    } catch { /* corrupt input or incompatible container; re-encode below */ }
  }
  try {
    const allAudio = probes.every((p) => p.hasAudio);
    const args = ["-y", "-v", "error"];
    for (const input of inputs) args.push("-i", input);
    const size = first?.width && first.height ? first : null;
    const fit = size ? `scale=${size.width}:${size.height}:force_original_aspect_ratio=decrease,pad=${size.width}:${size.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,` : "";
    const filters: string[] = [];
    for (let i = 0; i < inputs.length; i++) {
      filters.push(`[${i}:v]fps=24,${fit}setpts=PTS-STARTPTS[v${i}]`);
      if (allAudio) filters.push(`[${i}:a]aresample=48000,asetpts=PTS-STARTPTS[a${i}]`);
    }
    const pairs = inputs.map((_, i) => allAudio ? `[v${i}][a${i}]` : `[v${i}]`).join("");
    filters.push(`${pairs}concat=n=${inputs.length}:v=1:a=${allAudio ? 1 : 0}${allAudio ? "[v][a]" : "[v]"}`);
    const videoOnly = join(dir, `concat-video-${randomUUID()}.mp4`);
    args.push("-filter_complex", filters.join(";"), "-map", "[v]", ...(allAudio ? ["-map", "[a]", "-c:a", "aac", "-b:a", "160k"] : ["-an"]), "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", ...(targetSeconds ? ["-t", targetSeconds.toFixed(6)] : []), "-movflags", "+faststart", allAudio || !audioSource ? output : videoOnly);
    await run(FFMPEG, args, 600_000);
    if (!allAudio && audioSource) await muxSourceAudio(videoOnly, audioSource, output, targetSeconds ? Math.round(targetSeconds * 24) : 0);
  } finally {
    rmSync(list, { force: true });
  }
}

/** Extract a 124-frame IC window. */
export async function extractWindow(input: string, output: string, startFrame: number): Promise<void> {
  const start = startFrame / 24;
  await run(FFMPEG, [
    "-y", "-v", "error", "-ss", start.toFixed(6), "-i", input,
    "-frames:v", "124", "-vf", "fps=24,setpts=PTS-STARTPTS",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", output,
  ], 300_000);
}

/**
 * Crossfade 2K IC windows. Every window must be 124 frames. The timeline is
 * trimmed to `targetFrames` and the original source audio is muxed once.
 */
export async function assembleIcWindows(windows: string[], sourceWithAudio: string, output: string, targetFrames: number, starts?: number[]): Promise<void> {
  if (!windows.length) throw new MediaError("IC produced no windows");
  if (windows.length === 1) {
    await muxSourceAudio(windows[0], sourceWithAudio, output, targetFrames);
    return;
  }
  const args = ["-y", "-v", "error"];
  for (const w of windows) args.push("-i", w);
  const filters: string[] = [];
  for (let i = 0; i < windows.length; i++) filters.push(`[${i}:v]setpts=PTS-STARTPTS[v${i}]`);
  let current = "v0";
  for (let i = 1; i < windows.length; i++) {
    const out = `x${i}`;
    const start = starts?.[i] ?? i * IC_STEP_FRAMES;
    const overlap = starts ? Math.max(1, start - (starts[i - 1] ?? 0)) : IC_OVERLAP_FRAMES;
    const duration = Math.min(IC_OVERLAP_FRAMES, overlap, 124);
    filters.push(`[${current}][v${i}]xfade=transition=fade:duration=${(duration / 24).toFixed(6)}:offset=${(start / 24).toFixed(6)}[${out}]`);
    current = out;
  }
  const intermediate = join(dirname(output), `ic-assembled-${randomUUID()}.mp4`);
  args.push("-filter_complex", filters.join(";"), "-map", `[${current}]`, "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", intermediate);
  try {
    await run(FFMPEG, args, 1200_000);
    await muxSourceAudio(intermediate, sourceWithAudio, output, targetFrames);
  } finally {
    rmSync(intermediate, { force: true });
  }
}

async function muxSourceAudio(video: string, source: string, output: string, targetFrames: number): Promise<void> {
  const seconds = targetFrames > 0 ? targetFrames / 24 : null;
  const duration = seconds ? ["-t", seconds.toFixed(6)] : [];
  try {
    await run(FFMPEG, ["-y", "-v", "error", "-i", video, "-i", source, "-map", "0:v:0", "-map", "1:a:0?", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", ...duration, "-movflags", "+faststart", output], 600_000);
  } catch {
    await run(FFMPEG, ["-y", "-v", "error", "-i", video, "-map", "0:v:0", "-an", "-c:v", "copy", ...duration, "-movflags", "+faststart", output], 600_000);
  }
}

export async function copyTo(input: string, output: string): Promise<void> {
  const { copyFileSync } = await import("node:fs");
  mkdirSync(dirname(output), { recursive: true });
  copyFileSync(input, output);
}
