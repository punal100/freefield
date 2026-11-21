// The waiter: turns form values into a filled workflow using only what app.json says,
// asks the gateway to clear the GPU when the app's models change, and submits with the Comfy SDK.
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import { Comfy } from "@comfyorg/sdk";
import type { App, Input } from "./registry.ts";
import { isFileInput, modelKey } from "./registry.ts";
import type { JobLike } from "./history.ts";
import { SglangClient, SglangJob } from "./sglang.ts";
import { OpenH3IcClient, OpenH3IcJob } from "./open_h3_ic.ts";

const execFileAsync = promisify(execFile);

export type FileValue = { bytes: Uint8Array; name: string; type?: string };
export type Values = Record<string, unknown>;

/** Anything with setInput, so tests can pass a fake instead of the SDK's Workflow. `json` lets the
 * runner prune unused reference branches from the raw API graph. */
export type Settable = { setInput(node: string, field: string, value: unknown): unknown; json?: Record<string, unknown> };

export class InputError extends Error {}

function isFileValue(v: unknown): v is FileValue {
  return typeof v === "object" && v !== null && (v as FileValue).bytes instanceof Uint8Array;
}

function coerce(input: Input, raw: unknown): unknown {
  switch (input.type) {
    case "number":
    case "slider":
    case "seed": {
      const n = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(n)) throw new InputError(`${input.id}: expected a number`);
      if (input.min !== undefined && n < input.min) throw new InputError(`${input.id}: must be ≥ ${input.min}`);
      if (input.max !== undefined && n > input.max) throw new InputError(`${input.id}: must be ≤ ${input.max}`);
      return input.type === "seed" ? Math.trunc(n) : n;
    }
    case "toggle":
      return raw === true || raw === "true" || raw === "1" || raw === "on";
    case "select": {
      if (input.multiple) return picks(input, raw);
      const opts = input.options ?? [];
      const hit = opts.find((o) => o.value === raw || String(o.value) === String(raw));
      if (!hit) throw new InputError(`${input.id}: "${String(raw)}" is not one of the options`);
      return hit.value;
    }
    default:
      return raw;
  }
}

/** A multiple select's value: the picked option values in the order picked, no repeats. The form sends a JSON list. */
function picks(input: Input, raw: unknown): string[] {
  let list: unknown[];
  if (Array.isArray(raw)) list = raw;
  else if (typeof raw === "string" && raw.trim().startsWith("[")) {
    try { list = JSON.parse(raw); } catch { throw new InputError(`${input.id}: expected a list`); }
    if (!Array.isArray(list)) throw new InputError(`${input.id}: expected a list`);
  } else list = raw === "" || raw === null || raw === undefined ? [] : [raw];
  const out: string[] = [];
  for (const r of list) {
    const hit = (input.options ?? []).find((o) => String(o.value) === String(r));
    if (!hit) throw new InputError(`${input.id}: "${String(r)}" is not one of the options`);
    const v = String(hit.value);
    if (v && !out.includes(v)) out.push(v);
  }
  const max = input.multiple?.max;
  if (max && out.length > max) throw new InputError(`${input.id}: at most ${max}`);
  return out;
}

/** The picks of a multiple select as the one string templates and binds get. */
export function joinPicks(input: Input, list: unknown): string {
  const items = Array.isArray(list) ? list.map(String).filter(Boolean) : [];
  if (!items.length) return "";
  const m = input.multiple ?? {};
  return `${m.prefix ?? ""}${items.join(m.join ?? ", ")}${m.suffix ?? ""}`;
}

/** Values as the workflow gets them: multiple selects joined. Media lists stay lists. */
export function textValues(app: App, values: Values): Values {
  const out: Values = { ...values };
  for (const input of app.inputs) {
    if (input.multiple && input.type === "select" && values[input.id] !== undefined) out[input.id] = joinPicks(input, values[input.id]);
  }
  return out;
}

function checkedFile(input: Input, raw: unknown, where: string): FileValue {
  if (!isFileValue(raw)) throw new InputError(`${where}: expected a file`);
  const maxMb = input.limits?.max_mb;
  if (maxMb && raw.bytes.byteLength > maxMb * 1e6) throw new InputError(`${where}: file is over ${maxMb} MB`);
  return raw;
}

/** Fill defaults, coerce types, check required fields. File inputs pass through as FileValue (or FileValue[]). */
export function resolveValues(app: App, values: Values): Values {
  const out: Values = {};
  for (const input of app.inputs) {
    let v = values[input.id];
    // "" is a choice when a select offers it ("Any" in a builder writes nothing); elsewhere it means "use the default"
    const emptyIsOption = input.type === "select" && (Boolean(input.multiple) || (input.options ?? []).some((o) => o.value === ""));
    if (v === undefined || (v === "" && !emptyIsOption)) v = input.default;
    if (input.type === "seed" && (v === undefined || v === -1 || v === "-1")) {
      v = Math.floor(Math.random() * 2 ** 48);
    }
    if (isFileInput(input)) {
      if (v === undefined) {
        if (input.required) throw new InputError(`${input.id}: required`);
        continue;
      }
      if (input.multiple) {
        if (!Array.isArray(v) && !isFileValue(v)) throw new InputError(`${input.id}: expected files`);
        const raw = Array.isArray(v) ? v : [v];
        if (input.required && !raw.length) throw new InputError(`${input.id}: required`);
        const max = input.multiple.max;
        if (max && raw.length > max) throw new InputError(`${input.id}: at most ${max}`);
        const files = raw.map((f, i) => checkedFile(input, f, `${input.id} file ${i + 1}`));
        const totalMb = input.limits?.total_mb;
        const total = files.reduce((n, f) => n + f.bytes.byteLength, 0);
        if (totalMb && total > totalMb * 1e6) throw new InputError(`${input.id}: the files are over ${totalMb} MB together`);
        out[input.id] = files;
      } else {
        out[input.id] = checkedFile(input, v, input.id);
      }
      continue;
    }
    if (v === undefined) {
      if (input.required) throw new InputError(`${input.id}: required`);
      continue;
    }
    out[input.id] = coerce(input, v);
  }
  if (typeof values.ref_video_audio_flags === "string") out.ref_video_audio_flags = values.ref_video_audio_flags;
  return out;
}

export function renderTemplate(template: string, values: Values): string {
  return template
    .replace(/\{([a-z][a-z0-9_]*)\}/g, (_, k: string) => (values[k] === undefined ? "" : String(values[k])))
    .replace(/\s+,/g, ",")
    .replace(/,\s*,+/g, ",")
    .replace(/\s{2,}/g, " ")
    .trim()
    .replace(/,$/, "");
}

/** A value in an option's or preset's `sets`: a string with {placeholders} is filled like a bind template. */
export function setValue(value: unknown, values: Values): unknown {
  return typeof value === "string" && /\{[a-z][a-z0-9_]*\}/.test(value) ? renderTemplate(value, values) : value;
}

/** Remove links to pruned nodes, including links nested in an autogrow input's object. */
function stripRemoved(value: unknown, removed: Set<string>): unknown {
  if (Array.isArray(value)) {
    if (value.length === 2 && typeof value[0] === "string" && removed.has(value[0])) return undefined;
    return value.map((v) => stripRemoved(v, removed)).filter((v) => v !== undefined);
  }
  if (value && typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;   // SDK Asset handles and other class instances
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      const kept = stripRemoved(v, removed);
      if (kept !== undefined) out[key] = kept;
    }
    return out;
  }
  return value;
}

/** Drop whole reference branches (loaders, video components) and the links that pointed at them. */
function pruneNodes(wf: Settable, removed: Set<string>): void {
  const json = wf.json;
  if (!json || !removed.size) return;
  for (const id of removed) delete json[id];
  for (const raw of Object.values(json)) {
    const node = raw as { inputs?: Record<string, unknown> };
    if (!node.inputs) continue;
    for (const [field, value] of Object.entries(node.inputs)) {
      const kept = stripRemoved(value, removed);
      if (kept === undefined) delete node.inputs[field];
      else node.inputs[field] = kept;
    }
  }
}

/**
 * Apply resolved values and an optional preset to a workflow.
 * `asset` turns a FileValue into whatever the workflow expects (an SDK asset handle).
 */
export function applyInputs(
  app: App,
  values: Values,
  wf: Settable,
  asset: (f: FileValue) => unknown,
  presetId?: string,
): void {
  values = textValues(app, values);
  const removed = new Set<string>();
  for (const input of app.inputs) {
    const v = values[input.id];
    if (v === undefined) {
      if (isFileInput(input) && input.multiple) {
        for (const b of input.bind ?? []) for (const node of b.branch ?? [b.node]) removed.add(node);
      }
      continue;
    }
    if (isFileInput(input) && input.multiple) {
      const files = (Array.isArray(v) ? v : [v]).filter(isFileValue);
      for (const b of input.bind ?? []) {
        const index = b.index ?? 0;
        if (index < files.length) wf.setInput(b.node, b.field, asset(files[index]));
        else for (const node of b.branch ?? [b.node]) removed.add(node);
      }
      continue;
    }
    for (const b of input.bind ?? []) {
      if (b.template) wf.setInput(b.node, b.field, renderTemplate(b.template, values));
      else wf.setInput(b.node, b.field, isFileValue(v) ? asset(v) : v);
    }
    // a select option can carry extra fields (the LoRA that goes with a style, an effect's prompt)
    const chosen = input.type === "select" ? input.options?.find((o) => o.value === v) : undefined;
    for (const s of chosen?.sets ?? []) wf.setInput(s.node, s.field, setValue(s.value, values));
  }
  pruneNodes(wf, removed);
  if (presetId) {
    const preset = (app.presets ?? []).find((p) => p.id === presetId);
    if (!preset) throw new InputError(`preset "${presetId}" does not exist in ${app.id}`);
    for (const s of preset.sets) wf.setInput(s.node, s.field, setValue(s.value, values));
  }
}

let ffmpegPath: string | null | undefined;
function ffmpeg(): string {
  if (ffmpegPath === undefined) {
    const cmd = process.env.FREEFIELD_FFMPEG || "ffmpeg";
    try { execFileSync(cmd, ["-version"], { stdio: "ignore" }); ffmpegPath = cmd; } catch { ffmpegPath = null; }
  }
  if (!ffmpegPath) throw new InputError("video conversion needs ffmpeg on the server (set FREEFIELD_FFMPEG)");
  return ffmpegPath;
}

let ffprobePath: string | null | undefined;
function ffprobe(): string {
  if (ffprobePath === undefined) {
    const cmd = process.env.FREEFIELD_FFPROBE || "ffprobe";
    try { execFileSync(cmd, ["-version"], { stdio: "ignore" }); ffprobePath = cmd; } catch { ffprobePath = null; }
  }
  if (!ffprobePath) throw new InputError("reading a video needs ffprobe on the server (set FREEFIELD_FFPROBE)");
  return ffprobePath;
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"]);
const AUDIO_EXTENSIONS = new Set([".wav", ".mp3", ".flac", ".m4a", ".aac", ".ogg"]);

function extensionOf(name: string): string {
  return extname(name).toLowerCase();
}

function videoExtension(name: string): string {
  const ext = extensionOf(name);
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : ".mp4";
}

function withTempFile<T>(file: FileValue, fn: (dir: string, input: string) => Promise<T>): Promise<T> {
  return (async () => {
    const dir = await mkdtemp(join(tmpdir(), "freefield-"));
    try {
      const input = join(dir, `input${videoExtension(file.name)}`);
      await writeFile(input, file.bytes);
      return await fn(dir, input);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  })();
}

type MediaProbe = { seconds: number; fps: number; audio: boolean };
async function probeMedia(file: FileValue): Promise<MediaProbe> {
  return withTempFile(file, async (_dir, input) => {
    let text: string;
    try {
      const result = await execFileAsync(ffprobe(), [
        "-v", "error", "-show_entries", "format=duration:stream=codec_type,avg_frame_rate", "-of", "json", input,
      ], { encoding: "utf8", timeout: 120_000 });
      text = String(result.stdout);
    } catch (e) {
      throw new InputError(`${file.name}: could not read the media (${(e as Error).message})`);
    }
    let data: { format?: { duration?: string }; streams?: { codec_type?: string; avg_frame_rate?: string }[] };
    try { data = JSON.parse(text); } catch { throw new InputError(`${file.name}: ffprobe returned unreadable data`); }
    const seconds = Number(data.format?.duration);
    if (!Number.isFinite(seconds) || seconds <= 0) throw new InputError(`${file.name}: could not read the media duration`);
    const video = data.streams?.find((s) => s.codec_type === "video");
    const [num, den] = String(video?.avg_frame_rate || "0/1").split("/").map(Number);
    const fps = den ? num / den : num;
    return { seconds, fps: Number.isFinite(fps) ? fps : 0, audio: Boolean(data.streams?.some((s) => s.codec_type === "audio")) };
  });
}

/** 24 fps H.264/AAC, because MiniMaxH3ReferenceToVideo treats the frames it is given as 24 fps. */
async function transcode24(file: FileValue, probe: MediaProbe, keepAudio: boolean): Promise<FileValue> {
  const bytes = await withTempFile(file, async (dir, input) => {
    const output = join(dir, "out.mp4");
    const args = ["-y", "-v", "error", "-i", input, "-vf", "fps=24", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"];
    if (probe.audio && keepAudio) args.push("-c:a", "aac", "-b:a", "160k");
    else args.push("-an");
    args.push("-movflags", "+faststart", output);
    try { await execFileAsync(ffmpeg(), args, { timeout: 300_000 }); }
    catch (e) { throw new InputError(`${file.name}: 24 fps conversion failed (${(e as Error).message})`); }
    return readFile(output);
  });
  const base = file.name.replace(/\.[^.]+$/, "") || "reference";
  return { bytes: new Uint8Array(bytes), name: `${base}.mp4`, type: "video/mp4" };
}

/**
 * Check reference clips and convert them to the 24 fps the H3 reference node expects.
 * SGLang also rejects unsupported extensions and out-of-range audio durations here,
 * before any file is uploaded to the supervisor. The conversion is asynchronous so
 * ffmpeg cannot block the Freefield HTTP event loop.
 */
export async function preflightMedia(app: App, values: Values): Promise<void> {
  const sglang = app.backend === "sglang";
  const keepVideoAudio = values.ref_video_audio !== false && values.ref_video_audio !== "false";
  let perVideoAudio: unknown[] = [];
  if (typeof values.ref_video_audio_flags === "string" && values.ref_video_audio_flags) {
    try {
      const parsed = JSON.parse(values.ref_video_audio_flags);
      if (!Array.isArray(parsed)) throw new Error("not a list");
      perVideoAudio = parsed;
    } catch {
      throw new InputError("ref_video_audio_flags: expected a list of booleans");
    }
  }
  for (const input of app.inputs) {
    const raw = values[input.id];
    if (raw === undefined) continue;
    const files = (Array.isArray(raw) ? raw : [raw]).filter(isFileValue);
    if (!files.length) continue;

    if (sglang) {
      const allowed = input.type === "image" ? IMAGE_EXTENSIONS : input.type === "video" ? VIDEO_EXTENSIONS : input.type === "audio" ? AUDIO_EXTENSIONS : null;
      if (allowed) {
        for (const file of files) {
          if (!allowed.has(extensionOf(file.name))) {
            const pretty = input.type === "image" ? "PNG, JPG, JPEG, WebP, or BMP" : input.type === "video" ? "MP4, MOV, MKV, WebM, AVI, or M4V" : "WAV, MP3, FLAC, M4A, AAC, or OGG";
            throw new InputError(`${input.id}: ${file.name} has an unsupported ${input.type} extension; use ${pretty}`);
          }
        }
      }
    }

    if (input.type === "image") continue;
    if (input.type === "audio") {
      const [min, max] = input.limits?.seconds ?? [];
      if (min === undefined && max === undefined) continue;
      const EPS = 0.1;
      let total = 0;
      for (const file of files) {
        const probe = await probeMedia(file);
        if (min !== undefined && probe.seconds < min - EPS) throw new InputError(`${input.id}: ${file.name} is ${probe.seconds.toFixed(1)} s; the minimum is ${min} s`);
        if (max !== undefined && probe.seconds > max + EPS) throw new InputError(`${input.id}: ${file.name} is ${probe.seconds.toFixed(1)} s; the maximum is ${max} s`);
        total += probe.seconds;
      }
      const totalMax = input.limits?.total_seconds;
      if (totalMax && total > totalMax + EPS) throw new InputError(`${input.id}: the audio clips are ${total.toFixed(1)} s together; the maximum is ${totalMax} s`);
      continue;
    }

    if (input.type !== "video") continue;
    if (!input.multiple && input.preprocess !== "video24") continue;
    const [min, max] = input.limits?.seconds ?? [];
    const EPS = 0.1;
    let total = 0;
    for (let i = 0; i < files.length; i++) {
      const probe = await probeMedia(files[i]);
      if (min !== undefined && probe.seconds < min - EPS) throw new InputError(`${input.id}: ${files[i].name} is ${probe.seconds.toFixed(1)} s; the minimum is ${min} s`);
      if (max !== undefined && probe.seconds > max + EPS) throw new InputError(`${input.id}: ${files[i].name} is ${probe.seconds.toFixed(1)} s; the maximum is ${max} s`);
      total += probe.seconds;
      if (input.preprocess === "video24") files[i] = await transcode24(files[i], probe, keepVideoAudio && perVideoAudio[i] !== false);
    }
    const totalMax = input.limits?.total_seconds;
    if (totalMax && total > totalMax + EPS) throw new InputError(`${input.id}: the clips are ${total.toFixed(1)} s together; the maximum is ${totalMax} s`);
    values[input.id] = input.multiple ? files : files[0];
  }
}

type NodeError = { type?: string; message?: string; details?: string; extra_info?: { input_name?: string; received_value?: unknown } };
type NodeErrors = Record<string, { class_type?: string; errors?: NodeError[] } | NodeError[]>;

/**
 * Turn ComfyUI's validation errors (relayed by the proxy as details.node_errors) into lines a
 * person can act on. When a loader asks for a model file the backend does not have, say which
 * pack to download. Returns null for errors that are not workflow validation errors.
 */
export function explainSubmitError(app: App, e: unknown): string | null {
  const err = e as { code?: string; details?: { node_errors?: NodeErrors } | null; message?: string };
  if (err?.code !== "invalid_workflow") return null;
  const modelFiles = new Set(app.models.map((m) => m.file.split("/").pop()));
  const lines: string[] = [];
  let missingModel = false;
  for (const [node, entry] of Object.entries(err.details?.node_errors ?? {})) {
    const errors = Array.isArray(entry) ? entry : entry.errors ?? [];
    const cls = Array.isArray(entry) ? "" : entry.class_type ?? "";
    for (const x of errors) {
      const received = x.extra_info?.received_value ?? /'([^']+)' not in/.exec(x.details ?? "")?.[1];
      if (x.type === "value_not_in_list" && typeof received === "string" && modelFiles.has(received)) {
        missingModel = true;
        lines.push(`${cls || "node"} (node ${node}): model file ${received} is not on the backend`);
      } else {
        const detail = (x.details ?? "").replace(/ not in \[.*$/s, " is not one of the allowed values");
        lines.push(`${cls || "node"} (node ${node}): ${x.message ?? x.type ?? "invalid"}${detail ? ` (${detail.slice(0, 200)})` : ""}`);
      }
    }
  }
  if (!lines.length) lines.push(err.message ?? "workflow rejected");
  if (missingModel) {
    lines.push(`Download the "${app.pack}" pack first:  modal run infra/modal_app.py::download --pack ${app.pack}`);
  }
  return `ComfyUI rejected the workflow:\n${lines.map((l) => `  ${l}`).join("\n")}`;
}

export type RunnerOptions = {
  /** Gateway in front of comfy-api-proxy, e.g. https://you--freefield-serve.modal.run */
  baseUrl?: string;
  /** Token the gateway expects; sent by the SDK as a bearer token. */
  token?: string;
  /** Let draft apps run too (default: FREEFIELD_DRAFTS=1). Drafts have a workflow nobody has run on a GPU yet. */
  allowDrafts?: boolean;
  /** SGLang supervisor, e.g. http://127.0.0.1:39980. SGLang apps are unavailable without it. */
  sglangBaseUrl?: string;
  /** Token the SGLang supervisor expects. Default: SGLANG_API_TOKEN, then H3_API_TOKEN. */
  sglangToken?: string;
  /** Open-H3-Regenerate-2K-IC sidecar, e.g. http://127.0.0.1:30020. */
  openH3IcBaseUrl?: string;
  /** Token the IC sidecar expects. Default: OPEN_H3_IC_TOKEN, then H3_API_TOKEN. */
  openH3IcToken?: string;
  fetch?: typeof fetch;
  sglangFetch?: typeof fetch;
};

export class Runner {
  readonly baseUrl: string;
  readonly token?: string;
  readonly allowDrafts: boolean;
  readonly sglang?: SglangClient;
  readonly ic?: OpenH3IcClient;
  private comfy: Comfy;
  private doFetch: typeof fetch;
  private sglangJobs = new Map<string, JobLike>();
  private icJobs = new Map<string, JobLike>();

  constructor(opts: RunnerOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env.COMFY_BASE_URL ?? "").replace(/\/$/, "");
    if (!this.baseUrl) throw new Error("Set COMFY_BASE_URL to the gateway URL");
    this.token = opts.token ?? process.env.FREEFIELD_TOKEN ?? undefined;
    this.allowDrafts = opts.allowDrafts ?? process.env.FREEFIELD_DRAFTS === "1";
    process.env.COMFY_BASE_URL = this.baseUrl; // the SDK reads its base URL from the environment
    this.doFetch = opts.fetch ?? fetch;
    this.comfy = new Comfy({ apiKey: this.token, clientInfo: "freefield", fetch: opts.fetch });
    const sglangBaseUrl = (opts.sglangBaseUrl ?? process.env.SGLANG_BASE_URL ?? "").replace(/\/$/, "");
    if (sglangBaseUrl) {
      this.sglang = new SglangClient({
        baseUrl: sglangBaseUrl,
        token: opts.sglangToken ?? process.env.SGLANG_API_TOKEN ?? process.env.H3_API_TOKEN,
        fetch: opts.sglangFetch ?? opts.fetch,
      });
    }
    const icBaseUrl = (opts.openH3IcBaseUrl ?? process.env.OPEN_H3_IC_BASE_URL ?? "").replace(/\/$/, "");
    if (icBaseUrl) {
      this.ic = new OpenH3IcClient({
        baseUrl: icBaseUrl,
        token: opts.openH3IcToken ?? process.env.OPEN_H3_IC_TOKEN ?? process.env.H3_API_TOKEN,
        fetch: opts.fetch,
      });
    }
  }

  /**
   * Ask the gateway to make room for this app. It compares the model set with the one
   * loaded last and unloads everything from VRAM when they differ. A backend without the
   * Freefield gateway (a bare comfy-api-proxy, a hosted Comfy API) answers 404 and manages
   * its own memory, so that is not an error.
   */
  async prepare(app: App): Promise<{ freed: boolean; skipped?: boolean }> {
    const res = await this.doFetch(`${this.baseUrl}/freefield/prepare`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify({ app: app.id, models: modelKey(app) }),
    });
    if (res.status === 404 || res.status === 405) return { freed: false, skipped: true };
    if (!res.ok) throw new Error(`gateway /freefield/prepare answered ${res.status}`);
    return (await res.json()) as { freed: boolean };
  }

  async submit(app: App, rawValues: Values, presetId?: string, onStage?: (stage: string) => void) {
    if (app.backend !== "sglang" && app.backend !== "open-h3-ic" && app.backend !== "prep" && !app.workflowPath) throw new InputError(`${app.id} has no workflow yet`);
    if (app.backend === "prep") throw new InputError(`${app.id} uses the preparation API, not a generation backend`);
    if (app.status !== "ready" && !this.allowDrafts) {
      throw new InputError(`${app.id} is a draft; set FREEFIELD_DRAFTS=1 (or pass --draft) to run it anyway`);
    }
    const values = resolveValues(app, rawValues);
    await preflightMedia(app, values);
    if (app.backend === "sglang") {
      if (!this.sglang) throw new InputError(`${app.id} needs SGLANG_BASE_URL`);
      this.sglang.validate(app, values);
      onStage?.("Preparing the GPU");
      await this.prepare(app);   // free the ComfyUI models before SGLang loads
      const job = await this.sglang.submit(app, values, onStage);
      this.sglangJobs.set(job.id, job);
      return job;
    }
    if (app.backend === "open-h3-ic") {
      if (!this.ic) throw new InputError(`${app.id} needs OPEN_H3_IC_BASE_URL`);
      if (this.sglang) await this.sglang.unload();   // one GPU pipeline at a time
      await this.prepare(app);
      const job = await this.ic.submit(app, values);
      this.icJobs.set(job.id, job);
      return job;
    }
    if (this.sglang) await this.sglang.unload();   // one GPU pipeline at a time
    await this.prepare(app);
    const wf = await this.comfy.workflows.fromFile(app.workflowPath!);
    applyInputs(
      app,
      values,
      wf,
      (f) => this.comfy.assets.fromBytes(f.bytes, { filename: f.name, contentType: f.type || undefined }),
      presetId,
    );
    return this.comfy.submit(wf);
  }

  jobs() {
    return this.comfy.jobs;
  }

  /** Resolve a job id after a restart, using the app's backend when known. */
  async getJob(id: string, backend?: "comfyui" | "sglang" | "open-h3-ic" | "projects" | "prep"): Promise<JobLike> {
    if (backend === "prep") throw new Error("prep apps have no generation jobs");
    if (backend === "open-h3-ic") {
      const known = this.icJobs.get(id);
      if (known) return known;
      if (!this.ic) throw new Error("OPEN_H3_IC_BASE_URL is not set");
      const job = new OpenH3IcJob(this.ic, id);
      this.icJobs.set(id, job);
      return job;
    }
    if (backend === "sglang") {
      const known = this.sglangJobs.get(id);
      if (known) return known;
      if (!this.sglang) throw new Error("SGLANG_BASE_URL is not set");
      const job = new SglangJob(this.sglang, id);
      this.sglangJobs.set(id, job);
      return job;
    }
    if (backend === "comfyui") return this.comfy.jobs.get(id);
    const icKnown = this.icJobs.get(id);
    if (icKnown) return icKnown;
    const known = this.sglangJobs.get(id);
    if (known) return known;
    try {
      return await this.comfy.jobs.get(id);
    } catch (e) {
      if (!this.sglang) throw e;
      const job = new SglangJob(this.sglang, id);
      this.sglangJobs.set(id, job);
      return job;
    }
  }

  /**
   * The job's event stream (GET /api/v2/jobs/{id}/events) read as it comes, frame by frame, without the SDK's
   * job.events(): that one drops any progress frame lower than the last, and comfy-api-proxy's first frames
   * can say 1.0 (history.ts, Meter). Reconnects while the signal is alive; a stream that answers anything
   * but 200 (the job is gone) ends quietly: the poll decides.
   */
  async *frames(jobId: string, signal: AbortSignal, backend?: "comfyui" | "sglang" | "open-h3-ic" | "projects" | "prep"): AsyncIterable<Frame> {
    if (backend === "sglang" || backend === "open-h3-ic" || backend === "projects" || this.sglangJobs.has(jobId) || this.icJobs.has(jobId)) return;
    const url = `${this.baseUrl}/api/v2/jobs/${encodeURIComponent(jobId)}/events`;
    const headers = { accept: "text/event-stream", ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) };
    let failures = 0;
    while (!signal.aborted) {
      let res: Response;
      try {
        res = await this.doFetch(url, { headers, signal });
      } catch {
        if (signal.aborted || ++failures > 20) return;
        await new Promise((r) => setTimeout(r, Math.min(10_000, 1000 * failures)));
        continue;
      }
      if (res.status !== 200 || !res.body) return;
      failures = 0;
      try {
        yield* parseSse(res.body);
      } catch {
        if (signal.aborted) return;
      }
      if (!signal.aborted) await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

export type Frame = { event: string; data: Record<string, unknown> };

/** Server-sent events, as the spec reads them: `event:` and `data:` lines, a blank line ends a frame. */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncIterable<Frame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "", event = "message", data: string[] = [];
  const flush = (): Frame | null => {
    const out = data.length ? { event, data: safeJson(data.join("\n")) } : null;
    event = "message"; data = [];
    return out;
  };
  for (;;) {
    const { value, done } = await reader.read();
    buf += done ? "\n\n" : decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (line === "") { const f = flush(); if (f) yield f; }
      else if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (done) return;
  }
}

function safeJson(text: string): Record<string, unknown> {
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : { value: v };
  } catch {
    return { text };
  }
}






