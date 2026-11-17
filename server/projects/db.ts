// SQLite ledger for long-form projects. node:sqlite is built into the deployment
// Node (22.23: experimental module, unflagged) so there is no native dependency.
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type ProjectKind = "extend" | "refine" | "both";
export type ProjectStatus = "draft" | "planning" | "running" | "paused" | "succeeded" | "failed" | "canceled";
export type SegmentStatus = "queued" | "running" | "succeeded" | "failed" | "stale";

export type AssetRow = {
  id: string;
  sha256: string;
  path: string;
  bytes: number;
  mime: string;
  width: number | null;
  height: number | null;
  fps: number | null;
  frames: number | null;
  duration: number | null;
  has_audio: number;
  audio_rate: number | null;
  video_codec: string | null;
  audio_codec: string | null;
  probe_json: string | null;
  created_at: string;
};

export type ProjectRow = {
  id: string;
  kind: ProjectKind;
  status: ProjectStatus;
  target_seconds: number;
  source_asset: string | null;
  prompt: string | null;
  config_json: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

export type SegmentRow = {
  project_id: string;
  idx: number;
  status: SegmentStatus;
  start_frame: number;
  end_frame: number;
  visible_frames: number;
  context_frames: number;
  prompt: string | null;
  seed: number | null;
  steps: number | null;
  request_json: string | null;
  config_hash: string | null;
  job_id: string | null;
  upstream_id: string | null;
  output_asset: string | null;
  attempts: number;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
};

export type WindowRow = {
  project_id: string;
  idx: number;
  start_frame: number;
  end_frame: number;
  overlap_before: number;
  overlap_after: number;
  input_asset: string | null;
  output_asset: string | null;
  status: SegmentStatus;
  job_id: string | null;
  attempts: number;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
};

export type NewAsset = Omit<AssetRow, "created_at">;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;\nPRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('extend','refine','both')),
  status TEXT NOT NULL,
  target_seconds REAL NOT NULL,
  source_asset TEXT REFERENCES assets(id),
  prompt TEXT,
  config_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL UNIQUE,
  path TEXT NOT NULL UNIQUE,
  bytes INTEGER NOT NULL,
  mime TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  fps REAL,
  frames INTEGER,
  duration REAL,
  has_audio INTEGER NOT NULL DEFAULT 0,
  audio_rate INTEGER,
  video_codec TEXT,
  audio_codec TEXT,
  probe_json TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS project_segments (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  status TEXT NOT NULL,
  start_frame INTEGER NOT NULL,
  end_frame INTEGER NOT NULL,
  visible_frames INTEGER NOT NULL,
  context_frames INTEGER NOT NULL,
  prompt TEXT,
  seed INTEGER,
  steps INTEGER,
  request_json TEXT,
  config_hash TEXT,
  job_id TEXT,
  upstream_id TEXT,
  output_asset TEXT REFERENCES assets(id),
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  started_at TEXT,
  finished_at TEXT,
  PRIMARY KEY (project_id, idx)
);
CREATE TABLE IF NOT EXISTS ic_windows (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  start_frame INTEGER NOT NULL,
  end_frame INTEGER NOT NULL,
  overlap_before INTEGER NOT NULL,
  overlap_after INTEGER NOT NULL,
  input_asset TEXT REFERENCES assets(id),
  output_asset TEXT REFERENCES assets(id),
  status TEXT NOT NULL,
  job_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  started_at TEXT,
  finished_at TEXT,
  PRIMARY KEY (project_id, idx)
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  upstream_id TEXT,
  request_json TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_poll_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_segments_project_status ON project_segments(project_id, status);
CREATE INDEX IF NOT EXISTS idx_windows_project_status ON ic_windows(project_id, status);
CREATE INDEX IF NOT EXISTS idx_jobs_next_poll ON jobs(status, next_poll_at);
CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id, id);
`;

export class ProjectDB {
  readonly root: string;
  readonly mediaDir: string;
  readonly stateDir: string;
  readonly dbPath: string;
  private readonly db: DatabaseSync;

  constructor(root = process.env.FREEFIELD_PROJECTS_DIR || "/workspace/projects", opts: { mediaDir?: string; stateDir?: string } = {}) {
    this.root = resolve(root);
    this.mediaDir = resolve(opts.mediaDir || process.env.FREEFIELD_MEDIA_DIR || join(this.root, "..", "media"));
    this.stateDir = resolve(opts.stateDir || process.env.FREEFIELD_STATE_DIR || join(this.root, "..", "state"));
    mkdirSync(this.root, { recursive: true });
    mkdirSync(this.mediaDir, { recursive: true });
    mkdirSync(this.stateDir, { recursive: true });
    this.dbPath = join(this.stateDir, "freefield.sqlite");
    this.db = new DatabaseSync(this.dbPath, { timeout: 5000 });
    this.db.exec(SCHEMA);
    const row = this.db.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version?: number } | undefined;
    if (!row) this.db.prepare("INSERT INTO schema_version(version) VALUES (1)").run();
  }

  close(): void { this.db.close(); }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* no transaction */ }
      throw error;
    }
  }

  createProject(input: {
    id: string; kind: ProjectKind; targetSeconds: number; prompt?: string; config?: unknown;
  }): ProjectRow {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO projects
      (id, kind, status, target_seconds, source_asset, prompt, config_json, error, created_at, updated_at)
      VALUES (?, ?, 'draft', ?, NULL, ?, ?, NULL, ?, ?)`)
      .run(input.id, input.kind, input.targetSeconds, input.prompt ?? null, JSON.stringify(input.config ?? {}), now, now);
    return this.project(input.id)!;
  }

  project(id: string): ProjectRow | null {
    return (this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined) ?? null;
  }

  projects(limit = 100): ProjectRow[] {
    return this.db.prepare("SELECT * FROM projects ORDER BY created_at DESC LIMIT ?")
      .all(Math.max(1, Math.min(1000, limit))) as unknown as ProjectRow[];
  }

  updateProject(id: string, patch: Partial<Pick<ProjectRow, "status" | "source_asset" | "prompt" | "config_json" | "error">>): void {
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const key of ["status", "source_asset", "prompt", "config_json", "error"] as const) {
      if (key in patch) { fields.push(`${key} = ?`); values.push(patch[key]); }
    }
    if (!fields.length) return;
    fields.push("updated_at = ?"); values.push(new Date().toISOString(), id);
    this.db.prepare(`UPDATE projects SET ${fields.join(", ")} WHERE id = ?`).run(...(values as never[]));
  }

  asset(id: string): AssetRow | null {
    return (this.db.prepare("SELECT * FROM assets WHERE id = ?").get(id) as AssetRow | undefined) ?? null;
  }

  insertAsset(asset: NewAsset): AssetRow {
    const existing = this.asset(asset.id);
    if (existing) return existing;
    this.db.prepare(`INSERT INTO assets
      (id, sha256, path, bytes, mime, width, height, fps, frames, duration, has_audio, audio_rate,
       video_codec, audio_codec, probe_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(asset.id, asset.sha256, asset.path, asset.bytes, asset.mime, asset.width, asset.height, asset.fps,
        asset.frames, asset.duration, asset.has_audio, asset.audio_rate, asset.video_codec, asset.audio_codec,
        asset.probe_json, new Date().toISOString());
    return this.asset(asset.id)!;
  }

  segments(projectId: string): SegmentRow[] {
    return this.db.prepare("SELECT * FROM project_segments WHERE project_id = ? ORDER BY idx")
      .all(projectId) as unknown as SegmentRow[];
  }

  segment(projectId: string, idx: number): SegmentRow | null {
    return (this.db.prepare("SELECT * FROM project_segments WHERE project_id = ? AND idx = ?")
      .get(projectId, idx) as SegmentRow | undefined) ?? null;
  }

  insertSegment(row: SegmentRow): void {
    this.db.prepare(`INSERT OR REPLACE INTO project_segments
      (project_id, idx, status, start_frame, end_frame, visible_frames, context_frames, prompt, seed, steps,
       request_json, config_hash, job_id, upstream_id, output_asset, attempts, error, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.project_id, row.idx, row.status, row.start_frame, row.end_frame, row.visible_frames, row.context_frames,
        row.prompt, row.seed, row.steps, row.request_json, row.config_hash, row.job_id, row.upstream_id,
        row.output_asset, row.attempts, row.error, row.started_at, row.finished_at);
  }

  updateSegment(projectId: string, idx: number, patch: Partial<SegmentRow>): void {
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const key of ["status", "job_id", "upstream_id", "output_asset", "attempts", "error", "started_at", "finished_at"] as const) {
      if (key in patch) { fields.push(`${key} = ?`); values.push(patch[key]); }
    }
    if (!fields.length) return;
    values.push(projectId, idx);
    this.db.prepare(`UPDATE project_segments SET ${fields.join(", ")} WHERE project_id = ? AND idx = ?`).run(...(values as never[]));
  }

  windows(projectId: string): WindowRow[] {
    return this.db.prepare("SELECT * FROM ic_windows WHERE project_id = ? ORDER BY idx")
      .all(projectId) as unknown as WindowRow[];
  }

  insertWindow(row: WindowRow): void {
    this.db.prepare(`INSERT OR REPLACE INTO ic_windows
      (project_id, idx, start_frame, end_frame, overlap_before, overlap_after, input_asset, output_asset,
       status, job_id, attempts, error, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.project_id, row.idx, row.start_frame, row.end_frame, row.overlap_before, row.overlap_after,
        row.input_asset, row.output_asset, row.status, row.job_id, row.attempts, row.error, row.started_at, row.finished_at);
  }

  updateWindow(projectId: string, idx: number, patch: Partial<WindowRow>): void {
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const key of ["input_asset", "output_asset", "status", "job_id", "attempts", "error", "started_at", "finished_at"] as const) {
      if (key in patch) { fields.push(`${key} = ?`); values.push(patch[key]); }
    }
    if (!fields.length) return;
    values.push(projectId, idx);
    this.db.prepare(`UPDATE ic_windows SET ${fields.join(", ")} WHERE project_id = ? AND idx = ?`).run(...(values as never[]));
  }

  clearWindows(projectId: string): void {
    this.db.prepare("DELETE FROM ic_windows WHERE project_id = ?").run(projectId);
  }

  event(projectId: string, kind: string, payload: unknown): void {
    this.db.prepare("INSERT INTO events(project_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?)")
      .run(projectId, kind, JSON.stringify(payload), new Date().toISOString());
  }

  events(projectId: string, after = 0, limit = 200): { id: number; kind: string; payload: unknown; created_at: string }[] {
    return (this.db.prepare("SELECT id, kind, payload_json, created_at FROM events WHERE project_id = ? AND id > ? ORDER BY id LIMIT ?")
      .all(projectId, after, limit) as unknown as { id: number; kind: string; payload_json: string; created_at: string }[])
      .map((r) => ({ id: r.id, kind: r.kind, payload: safeJson(r.payload_json), created_at: r.created_at }));
  }
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}
