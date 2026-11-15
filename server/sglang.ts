// SGLang Ref2VA backend: upload Freefield references to the supervisor, submit
// one native H3 request, and expose the supervisor's async job as a Comfy-like
// JobLike so the existing history, progress, cancel, and output paths keep
// working.
import { writeFile } from "node:fs/promises";
import type { ComfyEvent } from "@comfyorg/sdk";
import type { JobLike } from "./history.ts";
import type { App } from "./registry.ts";
import type { FileValue, Values } from "./runner.ts";

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

/** One manager job. The supervisor returns JSON; progress and status are polled. */
export class SglangJob implements JobLike {
  readonly id: string;
  status = "queued";
  error: { message?: string; class_type?: string | null; node_id?: string | null } | null = null;
  startedAt: Date | null = null;
  completedAt: Date | null = null;
  progress: { value: number; step: number | null; steps: number | null; currentNodeClass: string | null } | null = null;
  queuePosition: number | null = null;

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

  async submit(app: App, values: Values): Promise<SglangJob> {
    if (app.backend !== "sglang") throw new Error(`${app.id} is not an SGLang app`);
    const prompt = String(values.prompt ?? "").trim();
    if (!prompt) throw new SglangInputError("prompt: required");

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
    if (!conditions.length) throw new SglangInputError("add at least one image, video, or audio reference");
    if (conditions.every((c) => c.type === "audio")) {
      throw new SglangInputError("audio references need at least one image or video reference");
    }

    const aspect = String(values.aspect ?? "16:9").split(/\s/)[0];
    const resolution = Number(values.resolution ?? 0.98);
    const duration = Number(values.duration ?? 5);
    const seed = Number(values.seed);
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
    await this.warm();
    const res = await this.doFetch(`${this.baseUrl}/v1/videos`, {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new SglangInputError(await this.failure(res));
    const body = await res.json() as JobData;
    if (!body?.id) throw new SglangInputError("SGLang returned no job id");
    return new SglangJob(this, body.id, body);
  }

  async unload(): Promise<void> {
    const res = await this.doFetch(`${this.baseUrl}/v1/model/unload?force=false`, {
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
