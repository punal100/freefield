// SGLang Ref2VA backend: upload Freefield references to the supervisor, submit
// one native H3 request, and expose the supervisor's async job as a Comfy-like
// JobLike so the existing history, progress, cancel, and output paths keep
// working.
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import type { ComfyEvent } from "@comfyorg/sdk";
import type { JobLike } from "./history.ts";
import type { App } from "./registry.ts";
import type { FileValue, Values } from "./runner.ts";
import { ExtendSglangJob, extractTail } from "./extend.ts";

type Fetch = typeof fetch;

export class SglangInputError extends Error {}

type JobData = {
  id?: string;
  status?: string;
  progress?: number | null;
  error?: unknown;
  detail?: unknown;
  queue_position?: number | null;
  created_at?: number | null;
  started_at?: number | null;
  completed_at?: number | null;
  stage?: string | null;
  step?: number | null;
  steps?: number | null;
  step_seconds?: number | null;
  eta_seconds?: number | null;
  elapsed_seconds?: number | null;
};

type Reference = { uri: string; kind: string; name?: string };

const TERMINAL = new Set(["succeeded", "failed", "canceled", "expired", "lost"]);
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("canceled"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("canceled"));
    }, { once: true });
  });

function files(value: unknown): FileValue[] {
  if (Array.isArray(value)) return value.filter((v): v is FileValue => Boolean(v && typeof v === "object" && "bytes" in v));
  return value && typeof value === "object" && "bytes" in value ? [value as FileValue] : [];
}

function statusOf(raw: unknown): string {
  const value = String(raw ?? "").toLowerCase();
  if (value === "completed" || value === "succeeded" || value === "success") return "succeeded";
  if (value === "failed" || value === "error") return "failed";
  if (value === "cancelled" || value === "canceled") return "canceled";
  if (value === "running" || value === "in_progress" || value === "processing") return "running";
  return "queued";
}

function messageOf(data: JobData): string | null {
  for (const raw of [data.error, data.detail]) {
    if (typeof raw === "string" && raw.trim()) return raw.trim();
    if (raw && typeof raw === "object" && "message" in raw && typeof (raw as { message?: unknown }).message === "string") {
      return (raw as { message: string }).message;
    }
  }
  return null;
}

function denoiseTelemetry(): { step: number; steps: number; stepSeconds: number; etaSeconds: number } | null {
  try {
    const text = readFileSync(process.env.H3_SGLANG_LOG || "/workspace/logs/sglang.log", "utf8").slice(-200_000);
    const matches = [...text.matchAll(/minimax_h3 denoise:\s*(\d+)%\|[^\n]*?\|\s*(\d+)\/(\d+)\s+\[[^<]*<([^,]+),\s*([\d.]+)s\/it/g)];
    const last = matches.at(-1);
    if (!last) return null;
    const step = Number(last[2]);
    const steps = Number(last[3]);
    const stepSeconds = Number(last[5]);
    if (!Number.isFinite(step) || !Number.isFinite(steps) || !Number.isFinite(stepSeconds) || steps <= 0) return null;
    return { step, steps, stepSeconds, etaSeconds: Math.max(0, (steps - step) * stepSeconds) };
  } catch {
    return null;
  }
}

/** One manager job. The supervisor returns JSON; progress and status are polled. */
export class SglangJob implements JobLike {
  readonly id: string;
  status = "queued";
  error: { message?: string; class_type?: string | null; node_id?: string | null } | null = null;
  startedAt: Date | null = null;
  completedAt: Date | null = null;
  progress: { value: number; step: number | null; steps: number | null; currentNodeClass: string | null } | null = null;
  queuePosition: number | null = null;
  stage: string | null = null;
  step: number | null = null;
  steps: number | null = null;
  stepSeconds: number | null = null;
  etaSeconds: number | null = null;

  get elapsedSeconds(): number | null {
    if (!this.startedAt) return null;
    const end = this.completedAt ?? new Date();
    return Math.max(0, Math.round((end.getTime() - this.startedAt.getTime()) / 1000));
  }

  private readonly client: SglangClient;

  constructor(client: SglangClient, id: string, initial?: JobData) {
    this.client = client;
    this.id = id;
    if (initial) this.apply(initial);
  }

  private apply(data: JobData) {
    const next = statusOf(data.status);
    if (this.status === "queued" && next !== "queued") this.startedAt ??= new Date();
    if (next === "running" || next === "succeeded") this.startedAt ??= new Date();
    this.status = next;
    const value = Number(data.progress);
    if (Number.isFinite(value)) {
      this.progress = {
        value: next === "succeeded" ? 1 : Math.max(0, Math.min(0.99, value > 1 ? value / 100 : value)),
        step: null,
        steps: null,
        currentNodeClass: "SGLang",
      };
    }
    if (typeof data.queue_position === "number") this.queuePosition = data.queue_position;
    if (typeof data.stage === "string") this.stage = data.stage;
    if (typeof data.step === "number") this.step = data.step;
    if (typeof data.steps === "number") this.steps = data.steps;
    if (typeof data.step_seconds === "number") this.stepSeconds = data.step_seconds;
    if (typeof data.eta_seconds === "number") this.etaSeconds = data.eta_seconds;
    if (next === "running" && (!this.step || !this.steps || !this.stepSeconds)) {
      const telemetry = denoiseTelemetry();
      if (telemetry) {
        this.step = telemetry.step;
        this.steps = telemetry.steps;
        this.stepSeconds = telemetry.stepSeconds;
        this.etaSeconds = telemetry.etaSeconds;
        this.stage = "Denoising";
      }
    }
    if (this.progress) {
      this.progress.step = this.step;
      this.progress.steps = this.steps;
    }
    if (TERMINAL.has(next)) {
      this.completedAt ??= new Date();
      this.queuePosition = null;
      if (next !== "succeeded") this.error = { message: messageOf(data) ?? `SGLang job ${next}` };
    }
  }

  async refresh(signal?: AbortSignal): Promise<void> {
    this.apply(await this.client.job(this.id, signal));
  }

  get outputs(): readonly {
    id: string; name: string; type: string; nodeId: string; contentType: string;
    toBytes(): Promise<Uint8Array>; toFile(path: string): Promise<void>;
  }[] {
    if (this.status !== "succeeded") return [];
    const bytes = () => this.client.content(this.id);
    return [{
      id: `${this.id}-video`,
      name: "h3-ref2va.mp4",
      type: "video",
      nodeId: "sglang",
      contentType: "video/mp4",
      toBytes: bytes,
      toFile: async (path: string) => { await writeFile(path, await bytes()); },
    }];
  }

  getOutputs(node?: string) {
    return this.outputs.filter((output) => !node || output.nodeId === node);
  }

  async *events(signal?: AbortSignal): AsyncIterable<ComfyEvent> {
    // The SGLang supervisor has no SSE stream. The history's polling tick
    // mirrors wait()/progress; yield nothing rather than inventing events.
    if (signal?.aborted) return;
  }

  async wait(timeoutMs = 6 * 3600 * 1000, signal?: AbortSignal): Promise<unknown> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (signal?.aborted) throw new Error("canceled");
      await this.refresh(signal);
      if (TERMINAL.has(this.status)) return;
      if (Date.now() >= deadline) throw new Error("SGLang job did not finish before the timeout");
      await sleep(2000, signal);
    }
  }

  async cancel(signal?: AbortSignal): Promise<unknown> {
    await this.client.cancel(this.id, signal);
    void this.client.unload(true).catch(() => {});
    this.status = "canceled";
    this.completedAt ??= new Date();
    return undefined;
  }
}

/** A thin client for the SGLang supervisor's /v1 API. */
export class SglangClient {
  readonly baseUrl: string;
  readonly token?: string;
  private readonly doFetch: Fetch;

  constructor(opts: { baseUrl: string; token?: string; fetch?: Fetch }) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    if (!this.baseUrl) throw new Error("SGLANG_BASE_URL is not set");
    this.token = opts.token;
    this.doFetch = opts.fetch ?? fetch;
  }

  private headers(json = false): Record<string, string> {
    return {
      ...(json ? { "content-type": "application/json" } : {}),
      ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
    };
  }

  private async failure(res: Response): Promise<string> {
    let text = "";
    try { text = await res.text(); } catch { /* body already consumed */ }
    if (text) {
      try {
        const body = JSON.parse(text) as { detail?: unknown; error?: unknown };
        const detail = body.detail ?? body.error;
        if (typeof detail === "string" && detail.trim()) return detail.trim();
        if (detail && typeof detail === "object" && "message" in detail) {
          const message = (detail as { message?: unknown }).message;
          if (typeof message === "string" && message.trim()) return message.trim();
        }
      } catch { /* plain text */ }
      return text.trim().slice(0, 500) || `SGLang answered ${res.status}`;
    }
    return `SGLang answered ${res.status}`;
  }

  /** Submit an already-built H3 payload. Used by the long-form project worker. */
  async submitPayload(payload: Record<string, unknown>, onStage?: (stage: string) => void): Promise<SglangJob> {
    const seconds = Number(payload.seconds ?? (payload.target as { duration_seconds?: unknown } | undefined)?.duration_seconds ?? 0);
    this.assertDuration(seconds);
    return this.postVideo(payload, onStage);
  }
  async warm(): Promise<void> {
    try {
      await this.doFetch(`${this.baseUrl}/v1/model/load`, {
        method: "POST",
        headers: this.headers(),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      // The load may already be in flight, or /v1/videos will start it. A
      // failure here must not hide the real submit error.
    }
  }

  async upload(kind: "image" | "video" | "audio", file: FileValue): Promise<Reference> {
    const form = new FormData();
    form.set("kind", kind);
    form.set("file", new Blob([file.bytes as unknown as BlobPart], { type: file.type || `${kind}/*` }), file.name || kind);
    const res = await this.doFetch(`${this.baseUrl}/v1/references`, {
      method: "POST",
      headers: this.headers(),
      body: form,
    });
    if (!res.ok) throw new SglangInputError(`reference upload failed: ${await this.failure(res)}`);
    const body = await res.json() as Reference;
    if (!body?.uri) throw new SglangInputError("reference upload returned no URI");
    return body;
  }

  validate(app: App, values: Values): void {
    if (app.adapter === "extend") {
      const contextFrames = Number(values.context ?? 39);
      const contextSeconds = Math.max(1, Math.min(120, contextFrames)) / 24;
      const duration = Number(values.duration ?? 5);
      this.assertDuration(Math.ceil(Math.min(15, Math.max(4, duration + contextSeconds))));
      return;
    }
    this.assertDuration(Number(values.duration ?? 5));
  }

  async submit(app: App, values: Values, onStage?: (stage: string) => void): Promise<SglangJob | ExtendSglangJob> {
    if (app.backend !== "sglang") throw new Error(`${app.id} is not an SGLang app`);
    if (app.adapter === "extend") return this.submitExtend(app, values, onStage);
    const prompt = String(values.prompt ?? "").trim();
    if (!prompt) throw new SglangInputError("prompt: required");

    const duration = Number(values.duration ?? 5);
    this.assertDuration(duration);
    onStage?.("Uploading references");
    const conditions = await this.uploadConditions(values);
    if (!conditions.length) throw new SglangInputError("add at least one image, video, or audio reference");
    if (conditions.every((c) => c.type === "audio")) {
      throw new SglangInputError("audio references need at least one image or video reference");
    }

    const aspect = String(values.aspect ?? "16:9").split(/\s/)[0];
    const resolution = Number(values.resolution ?? 0.98);
    const seed = Number(values.seed);
    onStage?.("Preparing the H3 request");
    const payload = {
      prompt,
      task: "ref2va",
      seconds: duration,
      seed: Number.isFinite(seed) && seed >= 0 ? Math.trunc(seed) : undefined,
      num_inference_steps: Number(values.steps ?? 50),
      reference_resize_mode: String(values.ref_image_size ?? "match"),
      conditions,
      target: {
        short_edge: resolution >= 0.9 ? 768 : 480,
        aspect_ratio: /^\d+:\d+$/.test(aspect) ? aspect : "16:9",
        duration_seconds: duration,
      },
    };
    return this.postVideo(payload, onStage);
  }

  /** Upload image, video and audio references in the order H3 tags them. */
  private async uploadConditions(values: Values): Promise<{ type: string; uri: string; role: string }[]> {
    const conditions: { type: string; uri: string; role: string }[] = [];
    const add = async (kind: "image" | "video" | "audio", value: unknown) => {
      for (const file of files(value)) {
        const ref = await this.upload(kind, file);
        conditions.push({ type: kind, uri: ref.uri, role: "reference" });
      }
    };
    await add("image", values.ref_images);
    await add("video", values.ref_videos);
    await add("audio", values.ref_audios);
    return conditions;
  }

  private assertDuration(seconds: number): void {
    const max = Math.max(1, Number(process.env.H3_MAX_REQUEST_SECONDS || 10));
    if (Number.isFinite(seconds) && seconds > max + 0.01) {
      throw new SglangInputError(`H3 on this GPU profile accepts at most ${max.toFixed(0)} seconds per request; choose ${max.toFixed(0)} seconds or less`);
    }
  }

  private async waitReady(onStage?: (stage: string) => void, timeoutMs = 45 * 60 * 1000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let last = "";
    for (;;) {
      const status = await this.modelStatus();
      if (status.state === "ready") return;
      if (status.state === "error") throw new SglangInputError(status.error ?? "SGLang model load failed");
      if (["unloaded", "parked", "stopped"].includes(status.state)) return;
      const stage = status.state === "downloading" ? "Downloading the H3 model"
        : status.state === "loading" ? "Loading the H3 model"
          : status.state === "parked" ? "Resuming the H3 model"
            : status.state === "unloading" ? "Waiting for the H3 model to unload"
              : `Waiting for the H3 model (${status.state})`;
      if (stage !== last) { last = stage; onStage?.(stage); }
      if (Date.now() >= deadline) throw new SglangInputError("SGLang model did not become ready before the timeout");
      await sleep(1000);
    }
  }

  private assertPayload(payload: Record<string, unknown>): void {
    const seconds = Number(payload.seconds ?? (payload.target as { duration_seconds?: unknown } | undefined)?.duration_seconds ?? 0);
    this.assertDuration(seconds);
    const conditions = Array.isArray(payload.conditions) ? payload.conditions : [];
    const maxRefs = Math.max(1, Number(process.env.H3_MAX_REFERENCES || 12));
    if (conditions.length > maxRefs) {
      throw new SglangInputError(`H3 on this GPU profile accepts at most ${maxRefs} references; remove ${conditions.length - maxRefs}`);
    }
  }

  private async postVideo(payload: Record<string, unknown>, onStage?: (stage: string) => void): Promise<SglangJob> {
    this.assertPayload(payload);
    onStage?.("Starting the H3 backend");
    await this.warm();
    onStage?.("Waiting for the H3 model");
    await this.waitReady(onStage);
    onStage?.("Submitting the H3 job");
    for (let attempt = 0; attempt < 15; attempt++) {
      const res = await this.doFetch(`${this.baseUrl}/v1/videos`, {
        method: "POST",
        headers: this.headers(true),
        body: JSON.stringify(payload),
      });
      if (res.status === 429 && attempt < 14) {
        onStage?.("H3 is busy with another job; waiting for it to finish");
        await sleep(2000);
        continue;
      }
      if (res.status === 429) throw new SglangInputError("H3 is busy with another job; wait for it to finish or cancel it");
      if (!res.ok) throw new SglangInputError(await this.failure(res));
      const body = await res.json() as JobData;
      if (!body?.id) throw new SglangInputError("SGLang returned no job id");
      return new SglangJob(this, body.id, body);
    }
    throw new SglangInputError("H3 is still busy; try again");
  }

  /**
   * Extend uses the source tail as Video 1. The request duration includes the
   * context; the wrapper trims that head and concatenates the source.
   */
  private async submitExtend(app: App, values: Values, onStage?: (stage: string) => void): Promise<ExtendSglangJob> {
    const prompt = String(values.prompt ?? "").trim();
    if (!prompt) throw new SglangInputError("prompt: required");
    const source = files(values.clip)[0];
    if (!source) throw new SglangInputError("clip: required");
    const contextFrames = Number(values.context ?? 39);
    const contextSeconds = Math.max(1, Math.min(120, contextFrames)) / 24;
    const duration = Number(values.duration ?? 5);
    const seconds = Math.ceil(Math.min(15, Math.max(4, duration + contextSeconds)));
    this.assertDuration(seconds);
    const seed = Number(values.seed);
    onStage?.("Preparing the extension");
    const tail = await extractTail(source, Math.max(1, Math.round(contextFrames)));
    const conditions: { type: string; uri: string; role: string }[] = [];
    for (const file of files(values.ref_images)) {
      const ref = await this.upload("image", file);
      conditions.push({ type: "image", uri: ref.uri, role: "reference" });
    }
    const tailRef = await this.upload("video", tail);
    conditions.push({ type: "video", uri: tailRef.uri, role: "reference" });
    for (const file of files(values.ref_videos)) {
      const ref = await this.upload("video", file);
      conditions.push({ type: "video", uri: ref.uri, role: "reference" });
    }
    for (const file of files(values.ref_audios)) {
      const ref = await this.upload("audio", file);
      conditions.push({ type: "audio", uri: ref.uri, role: "reference" });
    }
    const payload = {
      prompt,
      task: "ref2va",
      seconds,
      seed: Number.isFinite(seed) && seed >= 0 ? Math.trunc(seed) : undefined,
      num_inference_steps: Number(values.steps ?? 50),
      reference_resize_mode: "match",
      conditions,
      target: { short_edge: 768, aspect_ratio: "16:9", duration_seconds: seconds },
    };
    const job = await this.postVideo(payload, onStage);
    return new ExtendSglangJob(job, source, contextSeconds);
  }

  async unload(force = false): Promise<void> {
    const res = await this.doFetch(`${this.baseUrl}/v1/model/unload?force=${force ? "true" : "false"}`, {
      method: "POST",
      headers: this.headers(),
    });
    if (res.status === 409) throw new SglangInputError(await this.failure(res));
    if (!res.ok && res.status !== 404) throw new SglangInputError(await this.failure(res));
    if (res.status === 404) return;
    // The unload endpoint acknowledges asynchronously. Do not let ComfyUI
    // allocate while SGLang still owns the VRAM.
    for (let i = 0; i < 120; i++) {
      const status = await this.modelStatus();
      if (["unloaded", "parked", "error", "stopped"].includes(status.state)) {
        if (status.state === "error") throw new SglangInputError(status.error ?? "SGLang unload failed");
        return;
      }
      await sleep(1000);
    }
    throw new SglangInputError("SGLang did not release VRAM before the timeout");
  }

  private async modelStatus(): Promise<{ state: string; error?: string | null }> {
    const res = await this.doFetch(`${this.baseUrl}/v1/model/status`, {
      headers: this.headers(),
    });
    if (!res.ok) throw new SglangInputError(await this.failure(res));
    return await res.json() as { state: string; error?: string | null };
  }

  async listJobs(): Promise<JobData[]> {
    const res = await this.doFetch(`${this.baseUrl}/v1/videos`, { headers: this.headers() });
    if (!res.ok) throw new SglangInputError(await this.failure(res));
    const body = await res.json() as { data?: JobData[] };
    return Array.isArray(body.data) ? body.data : [];
  }

  async cancelQueued(): Promise<void> {
    for (const job of await this.listJobs()) {
      if (String(job.status) === "queued" && job.id) await this.cancel(job.id).catch(() => {});
    }
  }

  async job(id: string, signal?: AbortSignal): Promise<JobData> {
    const res = await this.doFetch(`${this.baseUrl}/v1/videos/${encodeURIComponent(id)}`, {
      headers: this.headers(),
      signal,
    });
    if (!res.ok) throw new Error(await this.failure(res));
    return await res.json() as JobData;
  }

  async content(id: string): Promise<Uint8Array> {
    const res = await this.doFetch(`${this.baseUrl}/v1/videos/${encodeURIComponent(id)}/content`, {
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(await this.failure(res));
    return new Uint8Array(await res.arrayBuffer());
  }

  async cancel(id: string, signal?: AbortSignal): Promise<void> {
    const res = await this.doFetch(`${this.baseUrl}/v1/videos/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: this.headers(),
      signal,
    });
    if (!res.ok && res.status !== 404) throw new Error(await this.failure(res));
  }
}








