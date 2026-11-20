// Long-form project service: SQLite ledger + content-addressed media + SGLang/IC workers.
// The HTTP surface is intentionally async: start returns immediately, the worker
// advances segments/windows and the UI polls /api/projects/:id.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { ProjectDB, type ProjectKind, type ProjectRow, type SegmentRow, type WindowRow } from "./db.ts";
import { AssetStore, assembleIcWindows, concatVideos, extractRange, extractTail, extractWindow, MediaError, probeMedia, receive, scanQuality, spliceRange, tempPath, trimHead } from "./assets.ts";
import { configFingerprint, planExtension, planIcWindows, type ExtensionPlanSegment, type IcWindow } from "./planner.ts";
import { SglangClient } from "./../sglang.ts";
import { OpenH3IcClient } from "./../open_h3_ic.ts";

export type ProjectConfig = {
  visibleSeconds: number;
  contextFrames: number;
  steps: number;
  targetResolution: "1080p" | "2k";
  sampler: "up3" | "up4" | "hf8";
  aspect: string;
  story?: string;
  segmentPrompts?: string[];
  seedBase?: number;
  sourceName?: string;
  references: { kind: "image" | "video" | "audio"; asset: string; name?: string }[];
  manual?: boolean;
  masterAsset?: string;
  finalAsset?: string;
  qc?: { checkedAt: string; black: number; freeze: number; silence: number; warnings: string[] };
};

export type CreateProjectInput = {
  kind: ProjectKind;
  targetSeconds: number;
  prompt?: string;
  story?: string;
  segmentPrompts?: string[];
  seedBase?: number;
  visibleSeconds?: number;
  contextFrames?: number;
  steps?: number;
  targetResolution?: "1080p" | "2k";
  sampler?: "up3" | "up4" | "hf8";
  manual?: boolean;
};

const EXT = /^\.[a-z0-9]{1,8}$/;

function projectId(): string {
  const now = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}-${randomBytes(2).toString("hex")}`;
}

function extensionSegmentRow(projectId: string, plan: ExtensionPlanSegment, prompt: string, seed: number, steps: number): SegmentRow {
  const configHash = configFingerprint({ index: plan.index, visible: plan.visibleFrames, request: plan.requestFrames, seed, steps, prompt });
  return {
    project_id: projectId, idx: plan.index, status: "queued",
    start_frame: plan.startFrame, end_frame: plan.startFrame + plan.visibleFrames,
    visible_frames: plan.visibleFrames, context_frames: plan.requestFrames - plan.visibleFrames,
    prompt, seed, steps, request_json: JSON.stringify(plan), config_hash: configHash,
    job_id: null, upstream_id: null, output_asset: null, attempts: 0, error: null,
    started_at: null, finished_at: null,
  };
}

function icWindowRow(projectId: string, window: IcWindow): WindowRow {
  return {
    project_id: projectId, idx: window.index, start_frame: window.startFrame,
    end_frame: window.startFrame + window.sourceFrames - 1,
    overlap_before: window.overlapBefore, overlap_after: window.overlapAfter,
    input_asset: null, output_asset: null, status: "queued", job_id: null,
    attempts: 0, error: null, started_at: null, finished_at: null,
  };
}

export class ProjectService {
  readonly db: ProjectDB;
  readonly assets: AssetStore;
  readonly root: string;
  readonly sglang?: SglangClient;
  readonly ic?: OpenH3IcClient;
  private active = new Map<string, { cancelled: boolean; job?: { cancel(): Promise<unknown> } }>();

  constructor(opts: {
    root?: string; sglang?: SglangClient; ic?: OpenH3IcClient;
    sglangBaseUrl?: string; sglangToken?: string; icBaseUrl?: string; icToken?: string;
  } = {}) {
    this.root = opts.root || process.env.FREEFIELD_PROJECTS_DIR || "/workspace/projects";
    this.db = new ProjectDB(this.root);
    this.assets = new AssetStore(this.db);
    const sb = opts.sglangBaseUrl ?? process.env.SGLANG_BASE_URL;
    const ib = opts.icBaseUrl ?? process.env.OPEN_H3_IC_BASE_URL;
    this.sglang = opts.sglang ?? (sb ? new SglangClient({
      baseUrl: sb,
      token: opts.sglangToken ?? process.env.SGLANG_API_TOKEN ?? process.env.H3_API_TOKEN,
    }) : undefined);
    this.ic = opts.ic ?? (ib ? new OpenH3IcClient({
      baseUrl: ib,
      token: opts.icToken ?? process.env.OPEN_H3_IC_TOKEN ?? process.env.H3_API_TOKEN,
    }) : undefined);
    this.reconcileOrphans();
  }

  private settleWork(id: string, status: "failed" | "stale", error: string | null): void {
    for (const segment of this.db.segments(id)) {
      if (segment.status === "running" || segment.status === "queued") {
        this.db.updateSegment(id, segment.idx, { status, error, finished_at: new Date().toISOString() });
      }
    }
    for (const window of this.db.windows(id)) {
      if (window.status === "running" || window.status === "queued") {
        this.db.updateWindow(id, window.idx, { status, error, finished_at: new Date().toISOString() });
      }
    }
  }

  private reconcileOrphans(): void {
    for (const project of this.db.projects()) {
      if (project.status === "running" || project.status === "planning") continue;
      const hasWork = this.db.segments(project.id).some((s) => s.status !== "succeeded")
        || this.db.windows(project.id).some((w) => w.status !== "succeeded");
      if (project.status === "draft" && this.config(project).manual && hasWork && !this.config(project).finalAsset) {
        this.db.updateProject(project.id, { status: "failed", error: "manual session interrupted; no active job" });
        this.settleWork(project.id, "failed", "manual session interrupted; no active job");
      } else if (project.status === "failed") this.settleWork(project.id, "failed", project.error ?? "project failed");
      else if (project.status === "canceled") this.settleWork(project.id, "stale", "canceled by user");
      else this.settleWork(project.id, "stale", null);
    }
  }

  projectDir(id: string): string { return join(this.root, id); }

  assetPath(assetId: string): string { return this.assets.absolute(assetId); }

  finalPath(id: string): string | null {
    const project = this.db.project(id);
    if (!project) return null;
    const config = this.config(project);
    return config.finalAsset ? this.assets.absolute(config.finalAsset) : null;
  }

  create(input: CreateProjectInput): ProjectRow {
    if (!["extend", "refine", "both"].includes(input.kind)) throw new MediaError("kind must be extend, refine or both");
    if (!Number.isFinite(input.targetSeconds) || input.targetSeconds <= 0) throw new MediaError("targetSeconds must be positive");
    const prompt = String(input.prompt ?? "").trim().slice(0, 7000);
    const story = String(input.story ?? "").trim().slice(0, 7000);
    const segmentPrompts = (input.segmentPrompts ?? []).map((value) => String(value).trim().slice(0, 7000));
    if (!prompt && !story && !segmentPrompts.some(Boolean)) throw new MediaError("add a prompt or continuity story");
    const seedBase = Number.isFinite(input.seedBase) ? Math.max(0, Math.min(2 ** 31 - 1, Math.trunc(Number(input.seedBase)))) : 42;
    const config: ProjectConfig = {
      visibleSeconds: Math.max(2, Math.min(7, input.visibleSeconds ?? 5)),
      contextFrames: input.contextFrames ?? 63,
      steps: Math.max(1, Math.min(50, input.steps ?? 8)),
      targetResolution: input.targetResolution ?? "2k",
      sampler: input.sampler ?? "up3",
      aspect: "16:9",
      story,
      segmentPrompts,
      seedBase,
      references: [],
    };
    if (input.manual) config.manual = true;
    if (config.contextFrames < 48) throw new MediaError("contextFrames must be at least 48 (2 seconds)");
    if (config.visibleSeconds * 24 + config.contextFrames > 240) throw new MediaError("H3 on this GPU profile accepts at most 10 seconds including context; reduce the visible length or context");
    const id = projectId();
    mkdirSync(this.projectDir(id), { recursive: true });
    const project = this.db.createProject({ id, kind: input.kind, targetSeconds: input.targetSeconds, prompt, config });
    this.db.event(id, "created", { kind: input.kind, targetSeconds: input.targetSeconds, segments: segmentPrompts.filter(Boolean).length });
    this.exportProject(id);
    return project;
  }

  list(): unknown[] {
    return this.db.projects().map((p) => this.view(p, false));
  }

  /** Resume one paused project, or (without an id) ledger-running projects after restart. */
  resume(id?: string): unknown {
    if (!id) {
      for (const project of this.db.projects(1000)) {
        if (project.status !== "running" && project.status !== "planning") continue;
        if (this.active.has(project.id)) continue;
        this.active.set(project.id, { cancelled: false });
        void this.run(project.id).catch((error) => this.fail(project.id, error));
      }
      return undefined;
    }
    const project = this.require(id);
    if (project.status !== "paused") throw new MediaError("project is not paused");
    return this.start(id);
  }

  get(id: string): unknown | null {
    const p = this.db.project(id);
    return p ? this.view(p, true) : null;
  }

  /** Stream a source upload directly to staging, then ingest it. */
  async uploadSource(id: string, req: Parameters<typeof receive>[0], name = "source.mp4"): Promise<unknown> {
    const project = this.require(id);
    if (project.status !== "draft") throw new MediaError("source can only be uploaded before the project starts");
    const temp = tempPath(this.projectDir(id));
    await receive(req, temp, Number(process.env.FREEFIELD_MAX_PROJECT_UPLOAD_MB || 2048) * 2 ** 20);
    const asset = await this.assets.ingest(temp, EXT.test(name.slice(name.lastIndexOf(".")).toLowerCase()) ? name : `${name}.mp4`);
    const config = this.config(project);
    config.sourceName = name;
    this.db.updateProject(id, { source_asset: asset, config_json: JSON.stringify(config) });
    this.db.event(id, "source", { asset });
    this.exportProject(id);
    return this.get(id);
  }

  async addReference(id: string, kind: "image" | "video" | "audio", req: Parameters<typeof receive>[0], name: string): Promise<unknown> {
    const project = this.require(id);
    if (project.status !== "draft" && project.status !== "planning") throw new MediaError("references can only be added before a project starts");
    if (!["image", "video", "audio"].includes(kind)) throw new MediaError("reference kind must be image, video or audio");
    const temp = tempPath(this.projectDir(id));
    await receive(req, temp, 200 * 2 ** 20);
    const asset = await this.assets.ingest(temp, name || `${kind}.bin`);
    const assetRow = this.db.asset(asset);
    if (kind !== "image" && (!assetRow?.duration || assetRow.duration < 1.99 || assetRow.duration > 15.01)) {
      throw new MediaError(`${kind} references must be 2–15 seconds (got ${(assetRow?.duration ?? 0).toFixed(2)} s)`);
    }
    const config = this.config(project);
    const sameKind = config.references.filter((r) => r.kind === kind).length;
    const limit = kind === "image" ? 9 : kind === "video" ? 2 : 3;
    if (sameKind >= limit) throw new MediaError(`at most ${limit} ${kind} references are allowed (the motion tail counts as a video)`);
    if (config.references.length >= 11) throw new MediaError("at most 11 references are allowed (the motion tail counts as the 12th file)");
    config.references.push({ kind, asset, name });
    this.db.updateProject(id, { config_json: JSON.stringify(config) });
    this.db.event(id, "reference", { kind, asset, name });
    this.exportProject(id);
    return this.get(id);
  }

  start(id: string): unknown {
    const project = this.require(id);
    if (this.config(project).manual) throw new MediaError("manual project: use the manual extend and enhance actions");
    if (!project.source_asset) throw new MediaError("upload a source video first");
    if (project.status === "running") throw new MediaError("project is already running");
    if (project.status === "succeeded") throw new MediaError("project already succeeded; create a new project to change settings");
    const busy = this.db.projects().find((other) => other.id !== id
      && (other.status === "running" || other.status === "planning"));
    if (busy) throw new MediaError("another project is already running; cancel it before starting this one");
    const source = this.db.asset(project.source_asset);
    if (!source) throw new MediaError("source asset is missing");
    const config = this.config(project);
    const sourceFrames = source.frames ?? Math.round((source.duration ?? 0) * 24);
    if (!sourceFrames) throw new MediaError("could not determine the source frame count");
    if ((source.duration ?? 0) < 1.99) throw new MediaError("the source clip must be at least 2 seconds");
    const targetFrames = Math.round(project.target_seconds * 24);
    if (project.kind === "refine") this.assertIcSource(source);

    if (project.kind !== "refine") {
      const plan = planExtension({ sourceFrames, targetFrames, visibleFrames: config.visibleSeconds * 24, contextFrames: config.contextFrames });
      this.db.transaction(() => {
        for (const s of plan.segments) {
          if (!this.db.segment(id, s.index)) {
            this.db.insertSegment(extensionSegmentRow(id, s, this.segmentPrompt(project, config, s.index), (config.seedBase ?? 42) + s.index, config.steps));
          }
        }
      });
      if (!plan.segments.length) throw new MediaError("target duration must be longer than the source for extension");
    }
    if (project.kind !== "extend") {
      // A refine-only project works on the uploaded master; its length, not the
      // requested target, decides how many 124-frame windows are needed.
      const icFrames = project.kind === "refine" ? sourceFrames : targetFrames;
      const windows = planIcWindows({ totalFrames: icFrames, windowFrames: 124, overlapFrames: 17 });
      if (!windows.length) throw new MediaError("source is shorter than one 124-frame IC window");
      this.db.transaction(() => {
        for (const w of windows) if (!this.db.windows(id).some((x) => x.idx === w.index)) this.db.insertWindow(icWindowRow(id, w));
      });
    }
    this.db.updateProject(id, { status: "running", error: null });
    this.db.event(id, "started", {});
    this.exportProject(id);
    this.active.set(id, { cancelled: false });
    void this.run(id).catch((error) => this.fail(id, error));
    return this.get(id);
  }

  async manualExtend(id: string, input: Record<string, unknown>): Promise<unknown> {
    const project = this.require(id);
    if (this.active.has(id)) throw new MediaError("project is already running");
    const config = this.config(project);
    const sourceAsset = String(input.sourceAsset ?? project.source_asset ?? "");
    const source = this.db.asset(sourceAsset);
    if (!source) throw new MediaError("manual source asset is missing");
    const seconds = Math.ceil(Math.max(4, Math.min(7, Number(input.seconds ?? config.visibleSeconds ?? 5))));
    const contextFrames = Math.max(48, Math.min(303, Math.round(Number(input.contextFrames ?? config.contextFrames ?? 63))));
    const visibleFrames = seconds * 24;
    const requestFrames = visibleFrames + contextFrames;
    if (visibleFrames < 48) throw new MediaError("manual extension must be at least 2 seconds");
    if (requestFrames > 240) throw new MediaError("H3 on this GPU profile accepts at most 10 seconds including context; reduce the visible length or context");
    const prompt = String(input.prompt ?? project.prompt ?? "").trim();
    if (!prompt) throw new MediaError("manual extension needs a prompt");
    const steps = Math.max(1, Math.min(50, Math.round(Number(input.steps ?? config.steps ?? 8))));
    const seed = Math.max(0, Math.min(2 ** 31 - 1, Math.round(Number(input.seed ?? config.seedBase ?? 42))));
    const idx = (this.db.segments(id).at(-1)?.idx ?? 0) + 1;
    const requestSeconds = +(requestFrames / 24).toFixed(6);
    const segment: SegmentRow = {
      project_id: id, idx, status: "queued",
      start_frame: 0, end_frame: visibleFrames, visible_frames: visibleFrames, context_frames: contextFrames,
      prompt, seed, steps, request_json: JSON.stringify({ manual: true, requestSeconds }),
      config_hash: configFingerprint({ manual: true, index: idx, requestFrames, seed, steps, prompt }),
      job_id: null, upstream_id: null, output_asset: null, attempts: 0, error: null,
      started_at: null, finished_at: null,
    };
    this.db.insertSegment(segment);
    this.db.event(id, "manual_extend", { index: idx, sourceAsset, seconds, contextFrames });
    this.db.updateProject(id, { status: "running", error: null });
    this.active.set(id, { cancelled: false });
    try {
      await this.runSegment(id, project, config, segment, sourceAsset);
      if (this.db.project(id)?.status === "running") this.db.updateProject(id, { status: "draft", error: null });
    } catch (error) {
      const current = this.db.project(id)?.status;
      if (current !== "canceled") {
        this.db.updateProject(id, { status: "failed", error: (error as Error).message });
        this.settleWork(id, "failed", (error as Error).message);
      }
      throw error;
    } finally {
      this.active.delete(id);
    }
    return this.get(id);
  }

  async manualEnhance(id: string, input: Record<string, unknown>): Promise<unknown> {
    const project = this.require(id);
    if (this.active.has(id)) throw new MediaError("project is already running");
    if (!this.ic) throw new MediaError("OPEN_H3_IC_BASE_URL is not configured");
    const config = this.config(project);
    const sourceAsset = String(input.sourceAsset ?? project.source_asset ?? "");
    const source = this.db.asset(sourceAsset);
    if (!source) throw new MediaError("manual source asset is missing");
    const sourceFrames = source.frames ?? Math.round((source.duration ?? 0) * 24);
    const startFrame = Math.max(0, Math.min(sourceFrames - 1, Math.round(Number(input.startFrame ?? 0))));
    const endFrame = Math.max(startFrame + 1, Math.min(sourceFrames, Math.round(Number(input.endFrame ?? sourceFrames))));
    if (endFrame - startFrame < 48) throw new MediaError("manual enhancement needs at least 2 seconds");
    let clipAsset = sourceAsset;
    if (startFrame > 0 || endFrame < sourceFrames) {
      const clip = join(this.projectDir(id), "staging", `manual-range-${randomBytes(3).toString("hex")}.mp4`);
      await extractRange(this.assets.absolute(sourceAsset), clip, startFrame, endFrame);
      clipAsset = await this.assets.ingest(clip, "manual-range.mp4");
    }
    const clip = this.db.asset(clipAsset)!;
    const totalFrames = clip.frames ?? Math.round((clip.duration ?? 0) * 24);
    const overlapFrames = Math.max(1, Math.min(60, Math.round(Number(input.overlapFrames ?? 17))));
    const windows = planIcWindows({ totalFrames, windowFrames: 124, overlapFrames });
    if (!windows.length) throw new MediaError("selected range is shorter than one 124-frame IC window");
    config.targetResolution = input.resolution === "2k" ? "2k" : "1080p";
    config.sampler = input.sampler === "up4" || input.sampler === "hf8" ? input.sampler : "up3";
    this.updateConfig(id, config);
    this.db.clearWindows(id);
    this.db.transaction(() => { for (const window of windows) this.db.insertWindow(icWindowRow(id, window)); });
    this.db.event(id, "manual_enhance", { sourceAsset: clipAsset, startFrame, endFrame, overlapFrames, windows: windows.length });
    this.db.updateProject(id, { status: "running", error: null });
    this.active.set(id, { cancelled: false });
    try {
      let finalAsset = await this.runIc(id, project, config, clipAsset);
      if (startFrame > 0 || endFrame < sourceFrames) {
        const output = join(this.projectDir(id), "final", "manual-enhanced.mp4");
        await spliceRange(this.assets.absolute(sourceAsset), this.assets.absolute(finalAsset), output, startFrame, endFrame, sourceFrames);
        finalAsset = await this.assets.ingest(output, "manual-enhanced.mp4");
      }
      config.finalAsset = finalAsset;
      this.updateConfig(id, config);
      if (this.db.project(id)?.status === "running") this.db.updateProject(id, { status: "draft", error: null });
    } catch (error) {
      const current = this.db.project(id)?.status;
      if (current !== "canceled") {
        this.db.updateProject(id, { status: "failed", error: (error as Error).message });
        this.settleWork(id, "failed", (error as Error).message);
      }
      throw error;
    } finally {
      this.active.delete(id);
    }
    return this.get(id);
  }

  async manualAssemble(id: string, input: Record<string, unknown>): Promise<unknown> {
    const project = this.require(id);
    const assets = Array.isArray(input.assets) ? input.assets.map(String) : [];
    if (!assets.length) throw new MediaError("select at least one clip to assemble");
    for (const asset of assets) if (!this.db.asset(asset)) throw new MediaError(`asset ${asset} is missing`);
    const stage = join(this.projectDir(id), "staging", `manual-final-${randomBytes(3).toString("hex")}.mp4`);
    await concatVideos(assets.map((asset) => this.assets.absolute(asset)), stage);
    const finalAsset = await this.assets.ingest(stage, "manual-final.mp4");
    const config = this.config(project);
    config.finalAsset = finalAsset;
    this.updateConfig(id, config);
    this.db.event(id, "manual_assemble", { assets, finalAsset });
    return this.get(id);
  }

  pause(id: string): unknown {
    const project = this.require(id);
    if (project.status !== "running" && project.status !== "planning") throw new MediaError("only a running project can be paused");
    const state = this.active.get(id);
    if (state) {
      state.cancelled = true;
      state.job?.cancel().catch(() => {});
    }
    this.db.updateProject(id, { status: "paused", error: null });
    this.settleWork(id, "stale", null);
    this.db.event(id, "paused", {});
    this.exportProject(id);
    return this.get(id);
  }

  cancel(id: string): unknown {
    const project = this.require(id);
    const state = this.active.get(id);
    if (state) {
      state.cancelled = true;
      state.job?.cancel().catch(() => {});
    }
    this.db.updateProject(id, { status: "canceled", error: "canceled by user" });
    this.settleWork(id, "stale", "canceled by user");
    this.db.event(id, "canceled", {});
    this.exportProject(id);
    return this.get(id);
  }

  resetFailedSegment(id: string, idx: number): unknown {
    const project = this.require(id);
    const segment = this.db.segment(id, idx);
    if (!segment) throw new MediaError(`segment ${idx} does not exist`);
    // A retry invalidates this segment and every later dependent segment, and
    // any IC windows derived from the old master.
    this.db.transaction(() => {
      for (const s of this.db.segments(id)) {
        if (s.idx >= idx) {
          this.db.updateSegment(id, s.idx, { status: "stale", output_asset: null, error: null, finished_at: null });
        }
      }
      for (const window of this.db.windows(id)) {
        this.db.updateWindow(id, window.idx, { status: "stale", input_asset: null, output_asset: null, error: null, finished_at: null });
      }
    });
    this.db.updateProject(id, { status: "planning", error: null });
    this.db.event(id, "retry", { index: idx });
    this.exportProject(id);
    return this.get(id);
  }

  /** Re-run only the 2K IC pass from the retained 768p master. */
  refine(id: string, opts: { targetResolution?: "1080p" | "2k"; sampler?: "up3" | "up4" | "hf8" } = {}): unknown {
    const project = this.require(id);
    if (this.active.has(id)) throw new MediaError("project is already running");
    const config = this.config(project);
    const master = config.masterAsset ?? (project.kind === "refine" ? project.source_asset : null);
    if (!master) throw new MediaError("finish the extension stage before re-running 2K IC");
    const asset = this.db.asset(master);
    if (!asset) throw new MediaError("IC master asset is missing");
    this.assertIcSource(asset);
    config.targetResolution = opts.targetResolution ?? config.targetResolution ?? "2k";
    config.sampler = opts.sampler ?? config.sampler ?? "up3";
    const windows = planIcWindows({ totalFrames: asset.frames!, windowFrames: 124, overlapFrames: 17 });
    if (!windows.length) throw new MediaError("source is shorter than one 124-frame IC window");
    this.db.transaction(() => {
      this.db.clearWindows(id);
      for (const window of windows) this.db.insertWindow(icWindowRow(id, window));
    });
    this.updateConfig(id, config);
    this.db.updateProject(id, { status: "planning", error: null });
    this.db.event(id, "refine", { targetResolution: config.targetResolution, sampler: config.sampler, windows: windows.length });
    this.exportProject(id);
    this.active.set(id, { cancelled: false });
    void this.runIcOnly(id, config, master).catch((error) => this.fail(id, error));
    return this.get(id);
  }

  private async runIcOnly(id: string, config: ProjectConfig, master: string): Promise<void> {
    try {
      const project = this.require(id);
      this.db.updateProject(id, { status: "running", error: null });
      const finalAsset = await this.runIc(id, project, config, master);
      config.masterAsset = master;
      config.finalAsset = finalAsset;
      await this.qualityCheck(id, config, finalAsset);
      this.updateConfig(id, config);
      this.db.updateProject(id, { status: "succeeded", error: null });
      this.db.event(id, "succeeded", { finalAsset, qc: config.qc ?? null });
      this.exportProject(id);
    } finally {
      this.active.delete(id);
    }
  }

  private async run(id: string): Promise<void> {
    const project = this.require(id);
    const config = this.config(project);
    try {
      let masterAsset = project.source_asset!;
      let finalAsset = masterAsset;
      if (project.kind !== "refine") {
        masterAsset = await this.runExtension(id, project, config);
        config.masterAsset = masterAsset;
        this.updateConfig(id, config);
      }
      if (project.kind !== "extend") {
        this.assertIcSource(this.db.asset(masterAsset));
        finalAsset = await this.runIc(id, project, config, masterAsset);
      }
      config.masterAsset = masterAsset;
      config.finalAsset = finalAsset;
      await this.qualityCheck(id, config, finalAsset);
      this.updateConfig(id, config);
      this.db.updateProject(id, { status: "succeeded", error: null });
      this.db.event(id, "succeeded", { finalAsset, qc: config.qc ?? null });
      this.exportProject(id);
    } finally {
      this.active.delete(id);
    }
  }

  private async qualityCheck(id: string, config: ProjectConfig, assetId: string): Promise<void> {
    if (process.env.FREEFIELD_QC === "0") return;
    try {
      config.qc = await scanQuality(this.assets.absolute(assetId));
      this.db.event(id, "qc", config.qc);
    } catch (error) {
      this.db.event(id, "qc", { error: (error as Error).message });
    }
  }

  private async runExtension(id: string, project: ProjectRow, config: ProjectConfig): Promise<string> {
    const segments = this.db.segments(id);
    const source = project.source_asset!;
    let previous = source;
    for (const segment of segments) {
      if (this.active.get(id)?.cancelled) throw new Error("canceled");
      if (segment.status === "succeeded" && segment.output_asset) { previous = segment.output_asset; continue; }
      const output = await this.runSegment(id, project, config, segment, previous);
      previous = output;
    }
    const inputs = [this.assets.absolute(source), ...this.db.segments(id).map((s) => this.assets.absolute(s.output_asset!))];
    const stage = join(this.projectDir(id), "staging", `master-${randomBytes(3).toString("hex")}.mp4`);
    await concatVideos(inputs, stage, project.target_seconds, this.assets.absolute(source));
    const asset = await this.assets.ingest(stage, "master.mp4");
    const assetRow = this.db.asset(asset)!;
    const expectedFrames = Math.round(project.target_seconds * 24);
    if ((assetRow.frames ?? 0) < expectedFrames - 2) {
      throw new MediaError(`extension master has ${assetRow.frames ?? 0} frames, expected about ${expectedFrames}`);
    }
    if (assetRow.fps && Math.abs(assetRow.fps - 24) > 0.1) {
      throw new MediaError(`extension master is ${assetRow.fps.toFixed(2)} fps; expected 24 fps`);
    }
    const sourceRow = this.db.asset(source);
    if (sourceRow?.has_audio && !assetRow.has_audio) {
      throw new MediaError("extension master lost the source audio track");
    }
    return asset;
  }

  private async runSegment(id: string, project: ProjectRow, config: ProjectConfig, segment: SegmentRow, previousAsset: string): Promise<string> {
    if (!this.sglang) throw new MediaError("SGLANG_BASE_URL is not configured");
    const current = this.assets.absolute(previousAsset);
    const projectDir = this.projectDir(id);
    const contextFrames = segment.context_frames;
    const requestSeconds = Math.ceil(segment.request_json ? Number(JSON.parse(segment.request_json).requestSeconds) : (segment.visible_frames + contextFrames) / 24);
    if (requestSeconds > 10) throw new MediaError("H3 on this GPU profile accepts at most 10 seconds including context; reduce the visible length or context");
    const tailPath = join(projectDir, "staging", `tail-${segment.idx}-${randomBytes(3).toString("hex")}.mp4`);
    await extractTail(current, tailPath, contextFrames);
    const conditions: { type: string; uri: string; role: string }[] = [];
    const tailBytes = await readFile(tailPath);
    const tail = await this.sglang.upload("video", { bytes: new Uint8Array(tailBytes), name: "tail.mp4", type: "video/mp4" });
    conditions.push({ type: "video", uri: tail.uri, role: "reference" });

    let videoSeconds = contextFrames / 24;
    let audioSeconds = 0;
    let videoCount = 1;
    let audioCount = 0;
    let imageCount = 0;
    for (const ref of config.references) {
      const asset = this.db.asset(ref.asset);
      if (!asset) throw new MediaError(`reference ${ref.asset} is missing`);
      const path = this.assets.absolute(ref.asset);
      if (ref.kind === "video") { videoSeconds += asset.duration ?? 0; videoCount++; }
      if (ref.kind === "audio") { audioSeconds += asset.duration ?? 0; audioCount++; }
      if (ref.kind === "image") imageCount++;
      const bytes = await readFile(path);
      const uploaded = await this.sglang.upload(ref.kind, { bytes: new Uint8Array(bytes), name: ref.name || `ref${ref.asset.slice(0, 6)}`, type: `${ref.kind}/${ref.kind === "image" ? "png" : ref.kind === "video" ? "mp4" : "wav"}` });
      conditions.push({ type: ref.kind, uri: uploaded.uri, role: "reference" });
    }
    if (conditions.length > 12) throw new MediaError("H3 allows at most 12 reference files including the motion tail");
    if (videoCount > 3) throw new MediaError("H3 allows at most 3 video references including the motion tail");
    if (imageCount > 9) throw new MediaError("H3 allows at most 9 image references");
    if (audioCount > 3) throw new MediaError("H3 allows at most 3 audio references");
    if (videoSeconds > 15.01) throw new MediaError(`reference video total is ${videoSeconds.toFixed(1)} s; the maximum is 15 s`);
    if (audioSeconds > 15.01) throw new MediaError(`reference audio total is ${audioSeconds.toFixed(1)} s; the maximum is 15 s`);

    const payload = {
      prompt: segment.prompt || project.prompt || "",
      task: "ref2va",
      seconds: requestSeconds,
      seed: segment.seed ?? 42,
      num_inference_steps: segment.steps ?? config.steps,
      reference_resize_mode: "match",
      conditions,
      target: {
        short_edge: 768,
        aspect_ratio: config.aspect || "16:9",
        duration_seconds: requestSeconds,
      },
    };
    if (segment.job_id) {
      await this.sglang.cancel(segment.job_id).catch(() => {});
      await this.sglang.unload(true).catch(() => {});
    }
    await this.sglang.cancelQueued().catch(() => {});
    this.db.updateSegment(id, segment.idx, {
      status: "running", started_at: new Date().toISOString(), attempts: segment.attempts + 1, error: null,
      progress: 0, stage: "Submitting", job_status: "queued", last_heartbeat_at: new Date().toISOString(),
    });
    this.db.event(id, "segment", { index: segment.idx, status: "running" });
    const job = await this.sglang.submitPayload(payload);
    this.active.get(id)!.job = job;
    this.db.updateSegment(id, segment.idx, { job_id: job.id, upstream_id: job.id });
    try {
      const started = Date.now();
      const stallMs = Math.max(5, Number(process.env.FREEFIELD_JOB_STALL_MINUTES || 15)) * 60 * 1000;
      let lastProgress = -1;
      let lastStep: number | null = null;
      let lastChange = Date.now();
      for (;;) {
        await job.refresh();
        if (this.active.get(id)?.cancelled) throw new Error("canceled");
        const now = Date.now();
        const progress = job.progress?.value ?? (job.status === "succeeded" ? 1 : 0);
        const stage = job.stage ?? (job.status === "queued" ? "Queued" : job.status === "running" ? "Running" : null);
        this.db.updateSegment(id, segment.idx, {
          progress,
          stage,
          queue_position: job.queuePosition,
          job_status: job.status,
          last_heartbeat_at: new Date().toISOString(),
        });
        this.db.updateProject(id, { last_heartbeat_at: new Date().toISOString() });
        if (progress !== lastProgress || job.step !== lastStep) {
          lastProgress = progress;
          lastStep = job.step;
          lastChange = now;
        }
        if (["succeeded", "failed", "canceled", "expired", "lost"].includes(job.status)) break;
        if (job.status === "running" && now - lastChange > stallMs) {
          await job.cancel();
          throw new MediaError(`generation stalled at ${Math.round(progress * 100)}%`);
        }
        if (now - started > 6 * 3600 * 1000) {
          await job.cancel();
          throw new MediaError("generation exceeded the six-hour limit");
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      if (this.active.get(id)?.cancelled) throw new Error("canceled");
      if (job.status !== "succeeded") throw new MediaError(job.error?.message || `SGLang job ${job.status}`);
      const generated = join(this.projectDir(id), "staging", `generated-${segment.idx}-${randomBytes(3).toString("hex")}.mp4`);
      await writeFile(generated, await this.sglang.content(job.id));
      const visible = join(this.projectDir(id), "staging", `visible-${segment.idx}-${randomBytes(3).toString("hex")}.mp4`);
      await trimHead(generated, visible, contextFrames / 24);
      const visibleProbe = await probeMedia(visible);
      if ((visibleProbe.frames ?? 0) < segment.visible_frames - 2) {
        throw new MediaError(`segment ${segment.idx} has ${visibleProbe.frames ?? 0} visible frames, expected ${segment.visible_frames}`);
      }
      if (visibleProbe.fps && Math.abs(visibleProbe.fps - 24) > 0.1) {
        throw new MediaError(`segment ${segment.idx} is ${visibleProbe.fps.toFixed(2)} fps; expected 24 fps`);
      }
      const asset = await this.assets.ingest(visible, `segment-${segment.idx}.mp4`);
      this.db.updateSegment(id, segment.idx, {
        status: "succeeded", output_asset: asset, finished_at: new Date().toISOString(), error: null,
      });
      this.db.event(id, "segment", { index: segment.idx, status: "succeeded", asset });
      rmSync(generated, { force: true });
      rmSync(tailPath, { force: true });
      return asset;
    } catch (error) {
      const interrupted = Boolean(this.active.get(id)?.cancelled || this.db.project(id)?.status === "canceled");
      this.db.updateSegment(id, segment.idx, {
        status: interrupted ? "stale" : "failed",
        error: (error as Error).message,
        job_status: interrupted ? "canceled" : "failed",
        finished_at: new Date().toISOString(),
      });
      this.db.event(id, "segment", { index: segment.idx, status: interrupted ? "interrupted" : "failed", error: (error as Error).message });
      rmSync(tailPath, { force: true });
      throw error;
    }
  }

  private async runIc(id: string, project: ProjectRow, config: ProjectConfig, sourceAsset: string): Promise<string> {
    if (!this.ic) throw new MediaError("OPEN_H3_IC_BASE_URL is not configured");
    if (this.sglang && !this.active.get(id)?.cancelled) {
      this.db.event(id, "ic", { status: "unloading_h3" });
      await this.sglang.unload();
    }
    const sourcePath = this.assets.absolute(sourceAsset);
    const source = this.db.asset(sourceAsset)!;
    const totalFrames = source.frames ?? Math.round((source.duration ?? 0) * 24);
    const windows = this.db.windows(id);
    const windowDir = join(this.projectDir(id), "ic", "windows");
    const refinedDir = join(this.projectDir(id), "ic", "refined");
    mkdirSync(windowDir, { recursive: true });
    mkdirSync(refinedDir, { recursive: true });

    for (const window of windows) {
      if (this.active.get(id)?.cancelled) throw new Error("canceled");
      if (window.status === "succeeded" && window.output_asset) continue;
      const input = join(windowDir, `${String(window.idx).padStart(6, "0")}.mp4`);
      if (!window.input_asset || !this.db.asset(window.input_asset)) {
        await extractWindow(sourcePath, input, window.start_frame);
        const inputProbe = await probeMedia(input);
        if ((inputProbe.frames ?? 0) < 124 || inputProbe.width !== 1344 || inputProbe.height !== 768) {
          throw new MediaError(`IC window ${window.idx} is ${inputProbe.width}×${inputProbe.height}/${inputProbe.frames ?? 0}f; expected 1344×768/124f`);
        }
        const asset = await this.assets.ingest(input, `window-${window.idx}.mp4`);
        this.db.updateWindow(id, window.idx, { input_asset: asset });
      }
    }

    const pending = this.db.windows(id).filter((w) => w.status !== "succeeded" || !w.output_asset);
    if (pending.length) {
      const jobRows: { input: string; output: string; caption: string }[] = [];
      for (const window of pending) {
        const inputAsset = this.db.asset(window.input_asset!);
        if (!inputAsset) throw new MediaError(`IC window ${window.idx} input is missing`);
        jobRows.push({
          input: this.assets.absolute(window.input_asset!),
          output: join(refinedDir, `${String(window.idx).padStart(6, "0")}.mp4`),
          caption: this.segmentPrompt(project, config, window.idx + 1),
        });
      }
      const jobsPath = join(this.projectDir(id), "ic", "jobs.jsonl");
      writeFileSync(jobsPath, jobRows.map((row) => JSON.stringify(row)).join("\n") + "\n");
      this.db.event(id, "ic", { status: "running", windows: jobRows.length, totalFrames });
      const batchTimeout = Math.max(7200, Math.min(604800, jobRows.length * 180));
      const job = await this.ic.submitBatch(jobsPath, { resolution: config.targetResolution, sampler: config.sampler, seed: config.seedBase ?? 42, timeout: batchTimeout });
      this.active.get(id)!.job = job;
      await job.wait((batchTimeout + 600) * 1000);
      if (this.active.get(id)?.cancelled) throw new Error("canceled");
      if (job.status !== "succeeded") throw new MediaError(job.error?.message || `IC batch ${job.status}`);
    }
    const expected = config.targetResolution === "1080p" ? [1920, 1080] : [2560, 1440];
    for (const window of this.db.windows(id)) {
      if (window.status === "succeeded" && window.output_asset && this.db.asset(window.output_asset)) continue;
      const output = join(refinedDir, `${String(window.idx).padStart(6, "0")}.mp4`);
      try {
        const probe = await probeMedia(output);
        if ((probe.frames ?? 0) < 113) throw new MediaError(`IC window ${window.idx} has only ${probe.frames ?? 0} frames`);
        if (probe.width !== expected[0] || probe.height !== expected[1]) {
          throw new MediaError(`IC window ${window.idx} is ${probe.width}×${probe.height}; expected ${expected[0]}×${expected[1]}`);
        }
        const asset = await this.assets.ingest(output, `refined-${window.idx}.mp4`);
        this.db.updateWindow(id, window.idx, { status: "succeeded", output_asset: asset, finished_at: new Date().toISOString(), error: null });
      } catch (error) {
        this.db.updateWindow(id, window.idx, { status: "failed", error: (error as Error).message, finished_at: new Date().toISOString() });
        throw error;
      }
    }
    const paths = this.db.windows(id).map((w) => this.assets.absolute(w.output_asset!));
    const output = join(this.projectDir(id), "final", "final-2k.mp4");
    mkdirSync(join(this.projectDir(id), "final"), { recursive: true });
    await assembleIcWindows(paths, sourcePath, output, totalFrames, this.db.windows(id).map((w) => w.start_frame));
    const finalProbe = await probeMedia(output);
    if ((finalProbe.frames ?? 0) < totalFrames - 2) throw new MediaError(`final IC output has ${finalProbe.frames ?? 0} frames; expected ${totalFrames}`);
    if (finalProbe.width !== expected[0] || finalProbe.height !== expected[1]) throw new MediaError(`final IC output is ${finalProbe.width}×${finalProbe.height}; expected ${expected[0]}×${expected[1]}`);
    if (!finalProbe.hasAudio) throw new MediaError("final IC output lost the original audio");
    const final = await this.assets.ingest(output, "final-2k.mp4");
    this.db.event(id, "ic", { status: "succeeded", finalAsset: final });
    return final;
  }

  private fail(id: string, error: unknown): void {
    const message = (error as Error)?.message || String(error);
    const current = this.db.project(id);
    if (current?.status === "canceled" || current?.status === "paused") {
      this.active.delete(id);
      return;
    }
    this.db.updateProject(id, { status: "failed", error: message });
    this.settleWork(id, "failed", message);
    this.db.event(id, "failed", { error: message });
    this.exportProject(id);
    this.active.delete(id);
  }

  private require(id: string): ProjectRow {
    const project = this.db.project(id);
    if (!project) throw new MediaError("unknown project");
    return project;
  }

  private config(project: ProjectRow): ProjectConfig {
    try { return JSON.parse(project.config_json || "{}") as ProjectConfig; } catch { return {
      visibleSeconds: 5, contextFrames: 63, steps: 8, targetResolution: "2k", sampler: "up3", aspect: "16:9", references: [],
    }; }
  }

  private segmentPrompt(project: ProjectRow, config: ProjectConfig, index: number): string {
    return [config.story, project.prompt, config.segmentPrompts?.[index - 1]]
      .map((part) => String(part ?? "").trim())
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 7000);
  }

  private assertIcSource(source: ReturnType<ProjectDB["asset"]>): void {
    if (!source) throw new MediaError("IC source asset is missing");
    if (!source.frames || source.frames < 124) throw new MediaError("2K IC needs a source with at least 124 frames");
    if (source.fps && Math.abs(source.fps - 24) > 0.1) throw new MediaError(`2K IC needs a 24 fps source (got ${source.fps.toFixed(2)} fps)`);
    if (!source.has_audio) throw new MediaError("2K IC needs source audio to preserve; the draft has no audio track");
    if (!source.width || !source.height) throw new MediaError("could not read the IC source dimensions");
    if (source.width % 32 || source.height % 32) throw new MediaError("2K IC dimensions must be divisible by 32");
    if (source.width * source.height > 1344 * 768) throw new MediaError("2K IC source must fit within 1344×768 (area limit)");
  }

  private updateConfig(id: string, config: ProjectConfig): void {
    this.db.updateProject(id, { config_json: JSON.stringify(config) });
  }

  /** Portable snapshot; SQLite remains authoritative. */
  private exportProject(id: string): void {
    try {
      const project = this.db.project(id);
      if (!project) return;
      const path = join(this.projectDir(id), "project.json");
      const temp = `${path}.${randomBytes(3).toString("hex")}.tmp`;
      writeFileSync(temp, JSON.stringify(this.view(project, true), null, 2));
      renameSync(temp, path);
    } catch { /* snapshot must not break the worker */ }
  }

  private view(project: ProjectRow, full: boolean): unknown {
    const config = this.config(project);
    const segments = full ? this.db.segments(project.id).map((s) => ({
      ...s, output: s.output_asset ? this.assetView(s.output_asset) : null,
    })) : undefined;
    const windows = full ? this.db.windows(project.id).map((w) => ({
      ...w, output: w.output_asset ? this.assetView(w.output_asset) : null,
    })) : undefined;
    const segmentRows = this.db.segments(project.id);
    const windowRows = this.db.windows(project.id);
    const segmentsTotal = segmentRows.length;
    const windowsTotal = windowRows.length;
    const completed = segmentRows.filter((s) => s.status === "succeeded").length
      + windowRows.filter((w) => w.status === "succeeded").length;
    const total = segmentsTotal + windowsTotal;
    const activeSegment = segmentRows.find((s) => s.status === "running") ?? null;
    const activeWindow = windowRows.find((w) => w.status === "running") ?? null;
    const active = activeSegment ?? activeWindow;
    const activeKind = activeSegment ? "segment" : activeWindow ? "window" : null;
    const working = Boolean(active);
    const runtimeProgress = active?.progress ?? (project.status === "succeeded" ? 1 : 0);
    const runtimeStart = active?.started_at ?? project.created_at;
    const runtimeState = active?.job_status === "queued"
      ? "queued"
      : active?.stage?.startsWith("Denoising") || active
        ? "running"
        : project.status === "succeeded" ? "completed" : project.status === "failed" ? "interrupted" : "idle";
    const base = `/api/projects/${project.id}`;
    const runtime = {
      state: runtimeState,
      stage: active?.stage ?? null,
      progress: active ? runtimeProgress : total ? completed / total : 0,
      queue_position: active?.queue_position ?? null,
      started_at: runtimeStart,
      elapsed_seconds: runtimeStart ? Math.max(0, Math.round((Date.now() - new Date(runtimeStart).getTime()) / 1000)) : null,
      last_heartbeat_at: project.last_heartbeat_at ?? active?.last_heartbeat_at ?? null,
      active_kind: activeKind,
      active_index: active?.idx ?? null,
      active_total: activeKind === "segment" ? segmentsTotal : activeKind === "window" ? windowsTotal : null,
      job_id: active?.job_id ?? null,
      upstream_id: active?.job_id ?? null,
      job_status: active?.job_status ?? null,
      step: active?.step ?? null,
      steps: active?.denoise_steps ?? null,
      step_seconds: active?.step_seconds ?? null,
      eta_seconds: active?.eta_seconds ?? null,
      message: active?.stage ?? project.error ?? null,
    };
    return {
      ...project,
      source: project.source_asset ? this.assetView(project.source_asset) : null,
      master: config.masterAsset ? this.assetView(config.masterAsset) : null,
      final: config.finalAsset ? { ...this.assetView(config.finalAsset), url: `${base}/files/final` } : null,
      config,
      progress: runtime.progress,
      completed,
      total,
      working,
      runtime,
      segments,
      windows,
      events: this.db.events(project.id).slice(-40),
    };
  }

  private assetView(assetId: string): { id: string; url: string; width?: number | null; height?: number | null; duration?: number | null; frames?: number | null } | null {
    const asset = this.db.asset(assetId);
    if (!asset) return null;
    return { id: asset.id, url: `/api/projects/assets/${asset.id}`, width: asset.width, height: asset.height, duration: asset.duration, frames: asset.frames };
  }
}








