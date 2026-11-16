// Open-H3-Regenerate-2K-IC backend client. The sidecar owns the upstream
// diffusers/FSDP inference process; Freefield uploads the draft, polls the job
// and fetches the final video.
import { writeFile } from "node:fs/promises";
import type { ComfyEvent } from "@comfyorg/sdk";
import type { JobLike } from "./history.ts";
import type { App } from "./registry.ts";
import type { FileValue, Values } from "./runner.ts";

type Fetch = typeof fetch;

export class OpenH3IcInputError extends Error {}

type JobData = {
  id?: string;
  status?: string;
  progress?: number | null;
  error?: unknown;
  created_at?: number | null;
  started_at?: number | null;
  completed_at?: number | null;
};

const TERMINAL = new Set(["succeeded", "failed", "canceled", "expired", "lost"]);

function statusOf(raw: unknown): string {
  const value = String(raw ?? "").toLowerCase();
  if (value === "completed" || value === "succeeded" || value === "success") return "succeeded";
  if (value === "failed" || value === "error") return "failed";
  if (value === "cancelled" || value === "canceled") return "canceled";
  if (value === "running" || value === "in_progress" || value === "processing") return "running";
  return "queued";
}

function messageOf(data: JobData): string | null {
  if (typeof data.error === "string" && data.error.trim()) return data.error.trim();
  if (data.error && typeof data.error === "object" && "message" in data.error) {
    const message = (data.error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  return null;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("canceled"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("canceled"));
    }, { once: true });
  });

export class OpenH3IcJob implements JobLike {
  readonly id: string;
  status = "queued";
  error: { message?: string; class_type?: string | null; node_id?: string | null } | null = null;
  startedAt: Date | null = null;
  completedAt: Date | null = null;
  progress: { value: number; step: number | null; steps: number | null; currentNodeClass: string | null } | null = null;
  queuePosition: number | null = null;
  private readonly client: OpenH3IcClient;

  constructor(client: OpenH3IcClient, id: string, initial?: JobData) {
    this.client = client;
    this.id = id;
    if (initial) this.apply(initial);
  }

  private apply(data: JobData) {
    const next = statusOf(data.status);
    if (next === "running" || next === "succeeded") this.startedAt ??= new Date();
    this.status = next;
    const value = Number(data.progress);
    if (Number.isFinite(value)) {
      this.progress = {
        value: next === "succeeded" ? 1 : Math.max(0, Math.min(0.99, value)),
        step: null,
        steps: null,
        currentNodeClass: "Open-H3 IC",
      };
    }
    if (TERMINAL.has(next)) {
      this.completedAt ??= new Date();
      if (next !== "succeeded") this.error = { message: messageOf(data) ?? `IC job ${next}` };
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
      name: "h3-2k-ic.mp4",
      type: "video",
      nodeId: "open-h3-ic",
      contentType: "video/mp4",
      toBytes: bytes,
      toFile: async (path: string) => { await writeFile(path, await bytes()); },
    }];
  }

  getOutputs(node?: string) {
    return this.outputs.filter((output) => !node || output.nodeId === node);
  }

  async *events(signal?: AbortSignal): AsyncIterable<ComfyEvent> {
    if (signal?.aborted) return;
  }

  async wait(timeoutMs = 6 * 3600 * 1000, signal?: AbortSignal): Promise<unknown> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (signal?.aborted) throw new Error("canceled");
      await this.refresh(signal);
      if (TERMINAL.has(this.status)) return;
      if (Date.now() >= deadline) throw new Error("2K IC job did not finish before the timeout");
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

export class OpenH3IcClient {
  readonly baseUrl: string;
  readonly token?: string;
  private readonly doFetch: Fetch;

  constructor(opts: { baseUrl: string; token?: string; fetch?: Fetch }) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    if (!this.baseUrl) throw new Error("OPEN_H3_IC_BASE_URL is not set");
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
    try { text = await res.text(); } catch { /* consumed */ }
    if (text) {
      try {
        const body = JSON.parse(text) as { detail?: unknown; error?: unknown };
        const detail = body.detail ?? body.error;
        if (typeof detail === "string" && detail.trim()) return detail.trim();
      } catch { /* plain text */ }
      return text.trim().slice(0, 500) || `Open-H3 IC answered ${res.status}`;
    }
    return `Open-H3 IC answered ${res.status}`;
  }

  async submit(app: App, values: Values): Promise<OpenH3IcJob> {
    if (app.backend !== "open-h3-ic") throw new Error(`${app.id} is not an Open-H3 IC app`);
    const draft = values.draft as FileValue | undefined;
    if (!draft || !(draft.bytes instanceof Uint8Array)) throw new OpenH3IcInputError("draft: required");
    const form = new FormData();
    form.set("draft", new Blob([draft.bytes as unknown as BlobPart], { type: draft.type || "video/mp4" }), draft.name || "draft.mp4");
    form.set("prompt", String(values.prompt ?? ""));
    form.set("resolution", String(values.resolution ?? "2k"));
    form.set("sampler", String(values.sampler ?? "up4"));
    form.set("sharp", String(values.sharp ?? 1));
    form.set("vae", String(values.vae ?? "fast"));
    const seed = Number(values.seed);
    form.set("seed", String(Number.isFinite(seed) && seed >= 0 ? Math.trunc(seed) : 0));
    const res = await this.doFetch(`${this.baseUrl}/v1/regenerate`, {
      method: "POST",
      headers: this.headers(),
      body: form,
    });
    if (!res.ok) throw new OpenH3IcInputError(await this.failure(res));
    const body = await res.json() as JobData;
    if (!body?.id) throw new OpenH3IcInputError("Open-H3 IC returned no job id");
    return new OpenH3IcJob(this, body.id, body);
  }

  async job(id: string, signal?: AbortSignal): Promise<JobData> {
    const res = await this.doFetch(`${this.baseUrl}/v1/regenerate/${encodeURIComponent(id)}`, {
      headers: this.headers(),
      signal,
    });
    if (!res.ok) throw new Error(await this.failure(res));
    return await res.json() as JobData;
  }

  async content(id: string): Promise<Uint8Array> {
    const res = await this.doFetch(`${this.baseUrl}/v1/regenerate/${encodeURIComponent(id)}/content`, {
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(await this.failure(res));
    return new Uint8Array(await res.arrayBuffer());
  }

  async cancel(id: string, signal?: AbortSignal): Promise<void> {
    const res = await this.doFetch(`${this.baseUrl}/v1/regenerate/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: this.headers(),
      signal,
    });
    if (!res.ok && res.status !== 404) throw new Error(await this.failure(res));
  }
}
