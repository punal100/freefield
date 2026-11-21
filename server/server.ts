// Minimal HTTP API for the web UI. Node's built-in http plus the Fetch API types; no framework.
//   GET    /api/apps                         catalog (what the UI needs to draw cards and forms)
//   GET    /api/apps/:id/workflow            the app's ComfyUI workflow in API format, as a download (open it in ComfyUI)
//   POST   /api/apps/:id/run                 multipart form: one field per input id, optional "preset"
//                                            → 202 with the history entry; the run continues in the background
//   GET    /api/history[?app=id]             every run started here, newest first (out/history/)
//   GET    /api/history/:id                  one run, with live progress while it is going
//   GET    /api/history/:id/files/:file      its inputs and outputs (byte ranges)
//   GET    /api/history/:id/preview          the latest live preview frame, when the backend sends them
//   POST   /api/history/:id/cancel           ask the backend to stop it
//   DELETE /api/history/:id                  forget it (and its files)
//   GET    /api/gpu[?device=1]               is the backend warm? (never wakes it; device=1 adds VRAM in use, only when warm)
//   POST   /api/gpu/wake                     start the GPU container now, while you prepare inputs
//   GET    /api/jobs/:id[/outputs/:oid]      raw SDK job view (kept for scripts)
//   GET    /api/flags                        lab examples marked "mediocre" from the UI (lab/flags.json)
//   POST   /api/flags                        JSON { key, mediocre, note? }: mark or unmark one example
// Everything else is served from web/ when it exists (with byte ranges, so videos seek everywhere).
// Hosted (server/guard.ts): FREEFIELD_PASSCODE closes every route behind a passcode, FREEFIELD_MAX_RUNS_PER_DAY and
// FREEFIELD_MAX_ACTIVE cap the runs (429 past them), lab marks become read-only and uploads are capped at
// FREEFIELD_MAX_UPLOAD_MB. FREEFIELD_OUT moves out/ (history, the run count), FREEFIELD_HOST the listening address.
// web/examples/ holds one example per app, written by lab/publish.py; /api/apps carries it along.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { loadRegistry, repoRoot, isFileInput, type App } from "./registry.ts";
import { explainSubmitError, InputError, resolveValues, Runner, type Values } from "./runner.ts";
import { History } from "./history.ts";
import { Flags } from "./flags.ts";
import { DOOR_HTML, Guard } from "./guard.ts";
import { ProjectService } from "./projects/service.ts";
import { handleProjects } from "./projects/routes.ts";
import { PrepService } from "./prep/service.ts";
import { handlePrep } from "./prep/routes.ts";

const root = repoRoot();
const { apps, problems } = loadRegistry(root);
for (const p of problems.filter((x) => x.severity === "error")) console.error(`[registry] ${p.app}: ${p.message}`);
const byId = new Map(apps.map((a) => [a.id, a]));

// VRAM verdicts from tools/catalog.py (optional: the UI just shows less without it)
type VramRow = { id: string; whole_gb: number; largest_phase_gb: number; verdict_24gb: string; measured_peak_gb: number | null };
const vramFile = join(root, "docs", "vram-map.json");
const vram = new Map<string, VramRow>(
  existsSync(vramFile) ? (JSON.parse(readFileSync(vramFile, "utf-8")).apps as VramRow[]).map((r) => [r.id, r]) : [],
);
let runner: Runner | null = null;
const getRunner = () => (runner ??= new Runner());
const draftsAllowed = process.env.FREEFIELD_DRAFTS === "1";
const outDir = process.env.FREEFIELD_OUT || join(root, "out");
let projects: ProjectService | null = null;
let prep: PrepService | null = null;
const getPrep = () => (prep ??= new PrepService(process.env.FREEFIELD_PREP_DIR || join(outDir, "prep")));
const getProjects = () => (projects ??= new ProjectService({
  root: process.env.FREEFIELD_PROJECTS_DIR || join(outDir, "projects"),
}));
const guard = Guard.fromEnv(join(outDir, "limits.json"));
const maxUploadMb = Number(process.env.FREEFIELD_MAX_UPLOAD_MB || (guard.hosted ? 100 : 0));

// the backend scales to zero 10 minutes after its last request (infra/modal_app.py scaledown_window).
// lastContact only moves on real work (a run, a wake): status checks must not keep the GPU alive.
const WARM_MS = 9 * 60 * 1000;
let lastContact = 0;
let waking: { since: number; error?: string } | null = null;
const contact = () => { lastContact = Date.now(); };
const history = new History(join(outDir, "history"), {
  onContact: contact,
  appInfo: (id) => {
    const app = apps.find((a) => a.id === id);
    if (!app) return undefined;
    if (app.backend === "sglang") return { outputs: app.outputs.map((o) => o.node), nodes: 1, classOf: () => "SGLang" };
    if (app.backend === "open-h3-ic") return { outputs: app.outputs.map((o) => o.node), nodes: 1, classOf: () => "Open-H3 IC" };
    const graph = app.graph ?? {};
    return { outputs: app.outputs.map((o) => o.node), nodes: Object.keys(graph).length, classOf: (n) => graph[n]?.class_type ?? null };
  },
  frames: (jobId, signal, appId) => {
    const backend = apps.find((a) => a.id === appId)?.backend;
    return getRunner().frames(jobId, signal, backend);
  },
});
const flags = new Flags(join(root, "lab", "flags.json"), apps);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".txt": "text/plain; charset=utf-8", ".woff2": "font/woff2",
  ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".flac": "audio/flac", ".ogg": "audio/ogg", ".m4a": "audio/mp4",
};

// one example per app (lab/publish.py); read on every catalog request so a new publish shows up without a restart
const examplesFile = join(root, "web", "examples", "index.json");
function loadExamples(): Record<string, unknown> {
  try {
    return existsSync(examplesFile) ? (JSON.parse(readFileSync(examplesFile, "utf-8")).apps ?? {}) : {};
  } catch {
    return {};
  }
}

const runnable = (a: App) => a.backend === "projects" ? true : a.backend === "sglang"
  ? Boolean(process.env.SGLANG_BASE_URL) && (a.status === "ready" || draftsAllowed)
  : a.backend === "open-h3-ic"
  ? Boolean(process.env.OPEN_H3_IC_BASE_URL) && (a.status === "ready" || draftsAllowed)
  : Boolean(a.workflowPath) && (a.status === "ready" || draftsAllowed);

function publicApp(a: App) {
  return {
    id: a.id, name: a.name, section: a.section, summary: a.summary ?? "", status: a.status, pack: a.pack,
    backend: a.backend,
    runnable: runnable(a),
    higgsfield_feature: a.higgsfield_feature ?? null,
    modes: a.modes ?? null,
    mode_label: a.mode_label ?? null,
    inputs: a.inputs.map(({ bind: _bind, options, ...rest }) => ({
      ...rest, ...(options ? { options: options.map(({ sets: _sets, ...o }) => o) } : {}),
    })),
    presets: (a.presets ?? []).map((p) => ({ id: p.id, label: p.label })),
    outputs: a.outputs.map((o) => ({ type: o.type, label: o.label ?? null })),
    models: a.models.map((m) => ({
      name: m.file.split("/").pop(), repo: m.repo, gb: m.gb, license: m.license ?? null,
      gated: Boolean(m.gated), optional: Boolean(m.optional), phase: m.phase,
    })),
    vram: vram.has(a.id) ? {
      whole_gb: vram.get(a.id)!.whole_gb, largest_phase_gb: vram.get(a.id)!.largest_phase_gb,
      verdict: vram.get(a.id)!.verdict_24gb, measured_gb: vram.get(a.id)!.measured_peak_gb,
    } : null,
    credits: a.credits ?? [],
    notes: a.notes ?? null,
  };
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/** A file from disk, honouring Range so <video> can seek. */
function sendFile(req: IncomingMessage, res: ServerResponse, file: string, cache = "no-cache") {
  const size = statSync(file).size;
  const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) {
      res.writeHead(416, { "content-range": `bytes */${size}` });
      return res.end();
    }
    res.writeHead(206, { "content-type": type, "content-length": end - start + 1, "content-range": `bytes ${start}-${end}/${size}`,
      "accept-ranges": "bytes", "cache-control": cache });
    return createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { "content-type": type, "content-length": size, "accept-ranges": "bytes", "cache-control": cache });
  if (req.method === "HEAD") return res.end();
  return createReadStream(file).pipe(res);
}

async function toRequest(req: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).byteLength;
    if (maxUploadMb && size > maxUploadMb * 2 ** 20) throw new InputError(`uploads are limited to ${maxUploadMb} MB here`);
    chunks.push(c as Buffer);
  }
  return new Request(`http://local${req.url}`, {
    method: req.method,
    headers: req.headers as Record<string, string>,
    body: chunks.length ? Buffer.concat(chunks) : undefined,
  });
}

async function readValues(app: App, request: Request): Promise<{ values: Values; preset?: string }> {
  const form = await request.formData();
  const values: Values = {};
  for (const input of app.inputs) {
    if (isFileInput(input)) {
      const list = form.getAll(input.id);
      if (!list.length) continue;
      if (list.some((v) => typeof v === "string")) throw new InputError(`${input.id}: expected a file upload`);
      const files = await Promise.all(list.map(async (v) => {
        const f = v as File;
        return { bytes: new Uint8Array(await f.arrayBuffer()), name: f.name, type: f.type };
      }));
      values[input.id] = input.multiple ? files : files[0];
      continue;
    }
    const v = form.get(input.id);
    if (v === null) continue;
    values[input.id] = v;
  }
  const audioFlags = form.get("ref_video_audio_flags");
  if (typeof audioFlags === "string" && audioFlags) values.ref_video_audio_flags = audioFlags;
  const preset = form.get("preset");
  return { values, preset: typeof preset === "string" && preset ? preset : undefined };
}

async function jobView(id: string) {
  const job = await getRunner().getJob(id);
  return {
    id: job.id,
    status: job.status,
    error: job.error ?? null,
    outputs: job.outputs.map((o, index) => {
      const id = o.id ?? `${job.id}-${index}`;
      return { id, node: o.nodeId, name: o.name, type: o.type, url: `/api/jobs/${job.id}/outputs/${id}` };
    }),
  };
}

/** Submit in the background; the entry tells the UI how it goes. */
function startRun(app: App, values: Values, preset?: string) {
  const entry = history.start(app, values, preset);
  void (async () => {
    try {
      history.note(entry, "Preparing inputs");
      const job = await getRunner().submit(app, values, preset, (stage) => history.note(entry, stage));
      contact();
      await history.follow(entry, job);
    } catch (e) {
      const explained = explainSubmitError(app, e);
      const message = explained ?? (e as Error).message ?? String(e);
      console.error(`[${app.id}] ${message}`);
      history.fail(entry, message);
    }
  })();
  return history.view(entry);
}

const DONE = ["succeeded", "failed", "canceled", "expired", "lost"];
const activeRuns = () => history.list(undefined, 50).filter((e) => !DONE.includes(e.status)).length;

let gpuCache: { at: number; body: unknown } | null = null;
async function gpuStatus(withDevice = false) {
  const configured = Boolean(process.env.COMFY_BASE_URL);
  const host = configured ? (guard.hosted ? "Modal" : new URL(process.env.COMFY_BASE_URL!).host) : null;
  const projectWorking = (() => {
    try {
      const projects = getProjects().list() as { status?: string; working?: boolean }[];
      return projects.some((project) => project.working || ["planning", "running", "paused"].includes(String(project.status)));
    } catch {
      return false;
    }
  })();
  const warm = projectWorking || Date.now() - lastContact < WARM_MS;
  const running = activeRuns();
  const base = { configured, host, warm, last_contact: lastContact ? new Date(lastContact).toISOString() : null,
    waking: waking ? { seconds: Math.round((Date.now() - waking.since) / 1000), error: waking.error ?? null } : null,
    running, demo: guard.hosted ? guard.status(running) : null };
  // only on request and only while warm: looking never starts a GPU, and the background poll never touches it
  if (!withDevice || !warm || !configured) return { ...base, device: null };
  if (gpuCache && Date.now() - gpuCache.at < 5000) return { ...base, device: gpuCache.body };
  let device: unknown = null;
  try {
    const r = getRunner();
    const res = await fetch(`${r.baseUrl}/freefield/status`, {
      headers: r.token ? { authorization: `Bearer ${r.token}` } : {}, signal: AbortSignal.timeout(4000),
    });
    if (res.ok) {
      const s = (await res.json()) as { app?: string; comfyui?: { devices?: { name?: string; vram_total?: number; vram_free?: number }[] } };
      const d = s.comfyui?.devices?.[0];
      device = { app: s.app ?? null, name: d?.name ?? null,
        vram_total_gb: d?.vram_total ? +(d.vram_total / 2 ** 30).toFixed(1) : null,
        vram_used_gb: d?.vram_total && d.vram_free !== undefined ? +((d.vram_total - d.vram_free) / 2 ** 30).toFixed(1) : null };
    }
  } catch { /* status is best effort */ }
  gpuCache = { at: Date.now(), body: device };
  return { ...base, device };
}

function wake() {
  if (waking && !waking.error) return;
  const r = getRunner();   // throws without COMFY_BASE_URL: the caller answers 400
  waking = { since: Date.now() };
  const started = waking;
  fetch(`${r.baseUrl}/health`, { signal: AbortSignal.timeout(15 * 60 * 1000) })
    .then((res) => {
      if (!res.ok) throw new Error(`/health answered ${res.status}`);
      contact();
      if (waking === started) waking = null;
    })
    .catch((e) => { if (waking === started) waking = { ...started, error: (e as Error).message }; });
}

async function workView(): Promise<unknown> {
  const historyEntries = history.list(undefined, 100).map((entry) => history.view(entry)) as Record<string, any>[];
  const projects = getProjects().list() as Record<string, any>[];
  let jobs: Record<string, any>[] = [];
  try {
    jobs = (await getRunner().sglang?.listJobs() ?? []) as unknown as Record<string, any>[];
  } catch { /* manager may be down; project/history still useful */ }
  const jobsById = new Map(jobs.map((job) => [String(job.id), job]));
  const queueOrder = new Map<string, number>();
  jobs.filter((job) => String(job.status) === "queued")
    .forEach((job, index) => queueOrder.set(String(job.id), Number(job.queue_position ?? index + 1)));
  const items: Record<string, any>[] = [];
  for (const entry of historyEntries) {
    const job = entry.job ? jobsById.get(String(entry.job)) : null;
    const progress = job?.progress != null ? Number(job.progress) / 100 : Number(entry.progress?.value ?? 0);
    const rawStatus = String(job?.status ?? entry.status ?? "queued");
    items.push({
      id: entry.id, owner_id: entry.id, app_id: entry.app, app_name: entry.app,
      kind: "app_run", parent_id: null, job_id: entry.job, upstream_id: entry.job,
      status: rawStatus === "in_progress" ? "running" : rawStatus === "completed" ? "succeeded" : rawStatus,
      stage: entry.stage ?? entry.progress?.node ?? (rawStatus === "queued" ? "Queued" : null),
      queue_position: job?.queue_position ?? (queueOrder.get(String(entry.job)) ?? null),
      progress, completed: null, total: null,
      elapsed_seconds: entry.started
        ? Math.max(0, Math.round((Date.now() - new Date(entry.started).getTime()) / 1000))
        : Math.max(0, Math.round((Date.now() - new Date(entry.created).getTime()) / 1000)),
      eta_seconds: entry.eta_seconds ?? null, started_at: entry.started ?? entry.created, finished_at: entry.finished ?? null,
      error: entry.error?.message ?? job?.error ?? null, preview_url: entry.preview ?? null,
      final_url: entry.outputs?.[0]?.url ?? null, created_at: entry.created,
    });
  }
  for (const project of projects) {
    const runtime = project.runtime ?? {};
    const job = runtime.job_id ? jobsById.get(String(runtime.job_id)) : null;
    const status = String(job?.status === "in_progress" ? "running" : job?.status === "completed" ? "succeeded" : (project.status ?? "draft"));
    items.push({
      id: project.id, owner_id: project.id, app_id: "h3-studio", app_name: "H3 Studio",
      kind: "project", parent_id: null, job_id: runtime.job_id ?? null, upstream_id: runtime.upstream_id ?? runtime.job_id ?? null,
      status, stage: runtime.stage ?? null, queue_position: job?.queue_position ?? runtime.queue_position ?? null,
      progress: Number(runtime.progress ?? project.progress ?? 0), completed: project.completed ?? null, total: project.total ?? null,
      elapsed_seconds: runtime.elapsed_seconds ?? null, eta_seconds: runtime.eta_seconds ?? null,
      started_at: runtime.started_at ?? project.created_at, finished_at: project.finished_at ?? null,
      error: project.error ?? null, preview_url: project.source?.url ?? project.master?.url ?? null,
      final_url: project.final?.url ?? null, created_at: project.created_at,
      active_kind: runtime.active_kind ?? null, active_index: runtime.active_index ?? null, active_total: runtime.active_total ?? null,
    });
  }
  const known = new Set(items.map((item) => item.job_id).filter(Boolean));
  for (const job of jobs) {
    if (known.has(String(job.id))) continue;
    items.push({
      id: String(job.id), owner_id: "", app_id: "h3-manager", app_name: "H3 Manager",
      kind: "foreign_job", parent_id: null, job_id: String(job.id), upstream_id: String(job.id),
      status: job.status === "in_progress" ? "running" : job.status === "completed" ? "succeeded" : job.status,
      stage: null, queue_position: queueOrder.get(String(job.id)) ?? null,
      progress: Number(job.progress ?? 0) / 100, completed: null, total: null, elapsed_seconds: null,
      eta_seconds: null, started_at: null, finished_at: null, error: job.error ?? null,
      preview_url: null, final_url: null, created_at: new Date(Number(job.created_at ?? 0) * 1000).toISOString(),
    });
  }
  const rank = (status: string) => status === "running" ? 0 : status === "queued" ? 1 : status === "failed" ? 2 : 3;
  items.sort((a, b) => rank(a.status) - rank(b.status) || String(b.created_at).localeCompare(String(a.created_at)));
  return { items };
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://local");
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (guard.passcode) {
      const key = url.searchParams.get("key");
      const cookie = key !== null ? guard.login(key) : null;
      if (cookie) {   // the passcode leaves the address bar and lives on as a cookie
        url.searchParams.delete("key");
        res.writeHead(303, { "set-cookie": cookie, location: url.pathname + url.search, "cache-control": "no-store" });
        return res.end();
      }
      if (!guard.admits(req.headers.cookie)) {
        if (parts[0] === "api") return send(res, 401, { error: "this demo needs its passcode: open the link you were given" });
        res.writeHead(401, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(DOOR_HTML);
      }
    }
    if (parts[0] === "api") {
      if (req.method === "GET" && parts[1] === "h3" && parts[2] === "capabilities" && parts.length === 3) {
        const official = {
          profile: null, max_seconds: 15, max_refs: 12, max_images: 9, max_videos: 3, max_audios: 3,
          official_max_seconds: 15, reference_clip_seconds: [2, 15],
          reference_total_seconds: { video: 15, audio: 15 }, source: "official", available: false,
        };
        try {
          const caps = await getRunner().sglang?.capabilities();
          return send(res, 200, caps ? { ...official, ...caps, source: "profile", available: true } : official);
        } catch (error) {
          return send(res, 200, { ...official, error: (error as Error).message });
        }
      }
      if (req.method === "GET" && parts[1] === "work" && parts.length === 2) {
        return send(res, 200, await workView());
      }
      if (await handlePrep(getPrep(), req, res, parts, url)) return;
      if (await handleProjects(getProjects(), req, res, parts, url)) return;
      const [, area, id, sub, arg] = parts;
      if (req.method === "GET" && area === "apps" && parts.length === 2) {
        const order = { image: 0, video: 1, audio: 2, utility: 3 } as Record<string, number>;
        const sorted = [...apps].sort((a, b) => order[a.section] - order[b.section]
          || Number(b.status === "ready") - Number(a.status === "ready") || a.name.localeCompare(b.name));
        const examples = loadExamples();
        return send(res, 200, { apps: sorted.map((a) => ({ ...publicApp(a), example: examples[a.id] ?? null })), drafts: draftsAllowed,
          hosted: guard.hosted });
      }
      if (req.method === "GET" && area === "apps" && sub === "workflow") {
        // the app's ComfyUI workflow (API format) as a file: drag it onto ComfyUI's canvas to open the app as nodes
        const app = byId.get(id);
        if (!app?.workflowPath) return send(res, 404, { error: "no workflow" });
        const body = readFileSync(app.workflowPath);
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-length": body.byteLength, "cache-control": "no-cache",
          "content-disposition": `attachment; filename="freefield-${app.id}.json"` });
        return res.end(body);
      }
      if (req.method === "POST" && area === "apps" && sub === "run") {
        const app = byId.get(id);
        if (!app) return send(res, 404, { error: "unknown app" });
        if (app.backend !== "sglang" && app.backend !== "open-h3-ic" && app.backend !== "projects" && !app.workflowPath) throw new InputError(`${app.id} has no workflow yet`);
        if (!runnable(app)) throw new InputError(`${app.id} is a draft or its backend is not configured; start the server with FREEFIELD_DRAFTS=1 and set SGLANG_BASE_URL or OPEN_H3_IC_BASE_URL for its backend`);
        const refused = guard.refuse(activeRuns());
        if (refused) return send(res, 429, { error: refused });
        const { values, preset } = await readValues(app, await toRequest(req));
        const view = startRun(app, resolveValues(app, values), preset);
        guard.record();
        return send(res, 202, view);
      }
      if (area === "history") {
        if (req.method === "GET" && !id) return send(res, 200, { entries: history.list(url.searchParams.get("app") || undefined) });
        if (req.method === "GET" && id && !sub) {
          const e = history.get(id);
          return e ? send(res, 200, e) : send(res, 404, { error: "unknown run" });
        }
        if ((req.method === "GET" || req.method === "HEAD") && sub === "files" && arg) {
          const file = history.file(id, arg);
          return file ? sendFile(req, res, file, "private, max-age=31536000, immutable") : send(res, 404, { error: "not found" });
        }
        if (req.method === "GET" && sub === "preview") {
          const p = history.preview(id);
          if (!p) return send(res, 404, { error: "no preview" });
          res.writeHead(200, { "content-type": p.type, "content-length": p.bytes.byteLength, "cache-control": "no-store" });
          return res.end(p.bytes);
        }
        if (req.method === "POST" && sub === "cancel") return send(res, 200, { canceled: await history.cancel(id) });
        if (req.method === "DELETE" && id && !sub) return send(res, history.remove(id) ? 200 : 404, { removed: id });
      }
      if (area === "gpu") {
        if (req.method === "GET" && !id) return send(res, 200, await gpuStatus(url.searchParams.get("device") === "1"));
        if (req.method === "POST" && id === "wake") {
          try { wake(); } catch (e) { throw new InputError((e as Error).message); }
          return send(res, 202, await gpuStatus());
        }
      }
      if (area === "flags" && parts.length === 2) {
        if (req.method === "GET") return send(res, 200, { mediocre: flags.list() });
        if (req.method === "POST") {
          if (guard.hosted) return send(res, 403, { error: "lab marks are read-only on the hosted demo" });
          const body = await (await toRequest(req)).json().catch(() => null) as { key?: unknown; mediocre?: unknown; note?: unknown } | null;
          if (!body || typeof body.key !== "string" || typeof body.mediocre !== "boolean") throw new InputError("expected JSON { key, mediocre, note? }");
          try {
            return send(res, 200, { mediocre: flags.set(body.key, body.mediocre, typeof body.note === "string" ? body.note : undefined) });
          } catch (e) {
            throw new InputError((e as Error).message);
          }
        }
      }
      if (req.method === "GET" && area === "jobs" && parts.length === 3) {
        return send(res, 200, await jobView(id));
      }
      if (req.method === "GET" && area === "jobs" && sub === "outputs" && arg) {
        const job = await getRunner().getJob(id);
        const out = job.outputs.find((o, index) => (o.id ?? `${job.id}-${index}`) === arg);
        if (!out) return send(res, 404, { error: "unknown output" });
        const bytes = await out.toBytes();
        res.writeHead(200, { "content-type": out.contentType || "application/octet-stream", "content-length": bytes.byteLength });
        return res.end(bytes);
      }
      return send(res, 404, { error: "not found" });
    }
    // static web/
    const webRoot = join(root, "web");
    const rel = normalize(url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1))).replace(/^(\.\.[/\\])+/, "");
    const file = join(webRoot, rel);
    if (file.startsWith(webRoot) && existsSync(file) && statSync(file).isFile()) return sendFile(req, res, file);
    return send(res, 404, { error: "not found" });
  } catch (e) {
    const status = e instanceof InputError ? 400 : 500;
    if (status === 500) console.error(e);
    return send(res, status, { error: (e as Error).message });
  }
});

// runs that were still going when the server stopped are followed again
history.resume(async (jobId, appId) => getRunner().getJob(jobId, apps.find((a) => a.id === appId)?.backend));

server.headersTimeout = 30_000;
server.requestTimeout = 6 * 60 * 60 * 1000;

const port = Number(process.env.PORT ?? 3000);
const host = process.env.FREEFIELD_HOST || "127.0.0.1";
server.listen(port, host, () => {
  console.log(`freefield on http://${host}:${port} (${apps.length} apps)`
    + (guard.passcode ? " · passcode required" : "") + (guard.maxRunsPerDay ? ` · ${guard.maxRunsPerDay} runs a day` : ""));
  getProjects().resume();
});





