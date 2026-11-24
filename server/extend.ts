// Extension adapter for the SGLang Ref2VA backend.
//
// The model receives the source tail as Video 1 and generates a continuation
// that includes that context. The visible result is:
//   original clip + generated clip with the context head removed.
//
// ffmpeg is used for the tail cut, context trim, concat and audio mux. All
// calls run asynchronously so the Freefield HTTP event loop is never blocked.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import type { JobLike } from "./history.ts";
import type { FileValue } from "./runner.ts";

const execFileAsync = promisify(execFile);

export class ExtendMediaError extends Error {}

function ffmpegBinary(): string {
  return process.env.FREEFIELD_FFMPEG || "ffmpeg";
}

function ffprobeBinary(): string {
  return process.env.FREEFIELD_FFPROBE || "ffprobe";
}

function ext(name: string): string {
  const value = extname(name).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(value) ? value : ".mp4";
}

async function withSource(file: FileValue, fn: (dir: string, input: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "freefield-extend-"));
  try {
    const input = join(dir, `source${ext(file.name)}`);
    await writeFile(input, file.bytes);
    await fn(dir, input);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function hasAudio(input: string): Promise<boolean> {
  try {
    const result = await execFileAsync(ffprobeBinary(), [
      "-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", input,
    ], { encoding: "utf8", timeout: 60_000 });
    return Boolean(String(result.stdout).trim());
  } catch {
    return false;
  }
}

/** The last `contextFrames` frames as a short 24 fps reference clip with its audio tail. */
export async function extractTail(source: FileValue, contextFrames: number): Promise<FileValue> {
  const seconds = contextFrames / 24;
  let output: Uint8Array | null = null;
  await withSource(source, async (dir, input) => {
    const tail = join(dir, "tail.mp4");
    const args = [
      "-y", "-v", "error", "-sseof", `-${seconds.toFixed(6)}`, "-i", input,
      "-t", seconds.toFixed(6), "-vf", "fps=24",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", tail,
    ];
    try {
      await execFileAsync(ffmpegBinary(), args, { timeout: 300_000 });
      output = new Uint8Array(await readFile(tail));
    } catch (e) {
      throw new ExtendMediaError(`could not cut the source tail: ${(e as Error).message}`);
    }
  });
  if (!output) throw new ExtendMediaError("could not read the source tail");
  return { bytes: output, name: "extend-tail.mp4", type: "video/mp4" };
}

/**
 * Join the original clip and the generated continuation. The generated file's
 * first `contextSeconds` are removed because they are the conditioning tail,
 * not visible new content. Source audio and generated audio are preserved.
 */
export async function concatExtension(source: FileValue, generated: Uint8Array, contextSeconds: number): Promise<Uint8Array> {
  let output: Uint8Array | null = null;
  await withSource(source, async (dir, input) => {
    const continuation = join(dir, "continuation.mp4");
    const result = join(dir, "extended.mp4");
    await writeFile(continuation, generated);
    const sourceAudio = await hasAudio(input);
    const generatedAudio = await hasAudio(continuation);
    const args: string[] = ["-y", "-v", "error", "-i", input, "-i", continuation];
    if (!sourceAudio) args.push("-f", "lavfi", "-i", "anullsrc=r=32000:cl=stereo");
    if (!generatedAudio) {
      if (sourceAudio) args.push("-f", "lavfi", "-i", "anullsrc=r=32000:cl=stereo");
      else args.push("-f", "lavfi", "-i", "anullsrc=r=32000:cl=stereo");
    }
    const sourceAudioIndex = sourceAudio ? "0:a" : "2:a";
    const generatedAudioIndex = generatedAudio ? "1:a" : (sourceAudio ? "2:a" : "3:a");
    const filter = [
      "[0:v]fps=24,setpts=PTS-STARTPTS[v0]",
      `[1:v]trim=start=${contextSeconds.toFixed(6)},fps=24,setpts=PTS-STARTPTS[v1]`,
      `[${sourceAudioIndex}]aresample=32000,asetpts=PTS-STARTPTS[a0]`,
      `[${generatedAudioIndex}]atrim=start=${contextSeconds.toFixed(6)},aresample=32000,asetpts=PTS-STARTPTS[a1]`,
      "[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]",
    ].join(";");
    args.push(
      "-filter_complex", filter, "-map", "[v]", "-map", "[a]",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", result,
    );
    try {
      await execFileAsync(ffmpegBinary(), args, { timeout: 600_000 });
      output = new Uint8Array(await readFile(result));
    } catch (e) {
      throw new ExtendMediaError(`could not concatenate the extension: ${(e as Error).message}`);
    }
  });
  if (!output) throw new ExtendMediaError("could not read the extended video");
  return output;
}

/**
 * Wrap a submitted SGLang job so its visible output is the extended clip, not
 * the raw continuation. Status/progress/events remain the inner job's.
 */
export class ExtendSglangJob implements JobLike {
  readonly inner: JobLike;
  readonly source: FileValue;
  readonly contextSeconds: number;
  private generated: Uint8Array | null = null;

  constructor(inner: JobLike, source: FileValue, contextSeconds: number) {
    this.inner = inner;
    this.source = source;
    this.contextSeconds = contextSeconds;
  }

  get id(): string { return this.inner.id; }
  get status(): string { return this.inner.status; }
  get error(): JobLike["error"] { return this.inner.error; }
  get startedAt(): Date | null { return this.inner.startedAt; }
  get completedAt(): Date | null { return this.inner.completedAt; }
  get progress(): JobLike["progress"] { return this.inner.progress; }
  readonly progressIsFraction = true;
  get queuePosition(): JobLike["queuePosition"] { return this.inner.queuePosition; }
  get stage(): string | null { return this.inner.stage ?? null; }
  get etaSeconds(): number | null { return this.inner.etaSeconds ?? null; }

  get outputs(): readonly {
    id: string; name: string; type: string; nodeId: string; contentType: string;
    toBytes(): Promise<Uint8Array>; toFile(path: string): Promise<void>;
  }[] {
    if (this.status !== "succeeded") return [];
    return [{
      id: `${this.id}-extended-video`,
      name: "h3-extended.mp4",
      type: "video",
      nodeId: "sglang",
      contentType: "video/mp4",
      toBytes: async () => {
        if (!this.generated) {
          const raw = this.inner.outputs[0];
          if (!raw) throw new ExtendMediaError("SGLang returned no continuation video");
          this.generated = await concatExtension(this.source, await raw.toBytes(), this.contextSeconds);
        }
        return this.generated;
      },
      toFile: async (path: string) => { await writeFile(path, await this.outputs[0].toBytes()); },
    }];
  }

  getOutputs(node?: string) {
    return this.outputs.filter((output) => !node || output.nodeId === node);
  }

  events(signal?: AbortSignal): AsyncIterable<import("@comfyorg/sdk").ComfyEvent> {
    return this.inner.events(signal);
  }

  wait(timeoutMs?: number, signal?: AbortSignal): Promise<unknown> {
    return this.inner.wait(timeoutMs, signal);
  }

  cancel(signal?: AbortSignal): Promise<unknown> {
    return this.inner.cancel(signal);
  }
}
