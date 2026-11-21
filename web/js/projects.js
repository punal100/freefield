// Long-form projects: create a resumable extension / 2K refinement project,
// stream the source, then watch segment and IC-window progress from the server.
// The browser never talks to SGLang or the IC sidecar directly.
import { api, el, icon, store, toast } from "./util.js";
import { sideResizer } from "./workspace.js";

const ACTIVE = new Set(["planning", "running", "paused"]);
const TARGETS = [
  ["2 min", 120], ["5 min", 300], ["30 min", 1800], ["2 h", 7200],
];
const STATUS_LABEL = {
  draft: "Draft", planning: "Planning", running: "Running", paused: "Paused",
  succeeded: "Complete", failed: "Failed", canceled: "Canceled",
  queued: "Queued", stale: "Stale",
};

function fmtDuration(seconds) {
  const value = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(value / 3600);
  const m = Math.floor((value % 3600) / 60);
  const s = value % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

function runtimeProgressText(data) {
  const runtime = data.runtime || {};
  const pct = Math.round((data.progress || 0) * 100);
  const unit = runtime.active_kind === "segment"
    ? `Segment ${runtime.active_index}/${runtime.active_total}`
    : runtime.active_kind === "window"
      ? `IC window ${runtime.active_index}/${runtime.active_total}`
      : null;
  const stage = runtime.stage ? String(runtime.stage) : runtime.state === "queued" ? "Queued" : null;
  const step = runtime.step && runtime.steps ? `${runtime.step}/${runtime.steps}` : null;
  const eta = Number(runtime.eta_seconds) > 0 ? `ETA ~${fmtDuration(runtime.eta_seconds)}` : runtime.state === "running" ? "ETA estimating" : null;
  return [unit, stage, step ? `step ${step}` : null, `${pct}%`, eta].filter(Boolean).join(" · ");
}

function runtimeElapsedText(data) {
  const runtime = data.runtime || {};
  const started = runtime.started_at ? new Date(runtime.started_at).getTime() : null;
  if (!started) return "";
  return `Elapsed ${fmtDuration((Date.now() - started) / 1000)}`;
}

function statusTag(status) {
  return el("span", { class: `tag ${status === "succeeded" ? "" : status === "failed" ? "pink" : "dark"}` }, STATUS_LABEL[status] || status);
}

async function upload(path, file) {
  const res = await fetch(path, {
    method: "POST",
    body: file,
    headers: { "content-type": file.type || "application/octet-stream" },
  });
  let body = null;
  try { body = await res.json(); } catch { /* no body */ }
  if (!res.ok) throw new Error(body?.error || `${res.status} ${res.statusText}`);
  return body;
}

function fileDrop({ label, hint, accept, multiple = false, iconName }) {
  const input = el("input", { type: "file", accept, multiple: multiple ? "" : undefined, hidden: "" });
  const text = el("b", {}, label);
  const note = el("small", {}, hint);
  const drop = el("label", { class: "drop proj-drop" },
    input, el("span", { class: "ic" }, icon(iconName)), text, note);
  input.onchange = () => {
    const files = input.files || [];
    drop.classList.toggle("has", files.length > 0);
    text.textContent = files.length ? `${files.length} ${files.length === 1 ? "file" : "files"} selected` : label;
    note.textContent = files.length ? Array.from(files, (f) => f.name).join(" · ") : hint;
  };
  const reset = () => { input.value = ""; text.textContent = label; note.textContent = hint; drop.classList.remove("has"); };
  return { input, drop, reset };
}

function estimate(targetSeconds, visibleSeconds, kind, sourceSeconds) {
  const extension = kind === "refine" ? 0 : Math.max(1, Math.ceil(Math.max(0, targetSeconds - (sourceSeconds || 15)) / visibleSeconds));
  const frames = Math.round(targetSeconds * 24);
  const windows = kind === "extend" ? 0 : Math.max(1, Math.ceil((frames - 124) / 107) + 1);
  return { extension, windows };
}

function stageRow(name, detail, done, active) {
  return el("div", { class: `proj-stage-row${done ? " done" : active ? " active" : ""}` },
    el("span", { class: "stage-dot" }, done ? icon("check") : ""),
    el("span", { class: "stage-name" }, name),
    el("span", { class: "stage-detail" }, detail));
}

function projectCard(p, actions) {
  const full = actions.detail(p.id) || p;
  const pct = Math.round((full.progress || 0) * 100);
  const qc = full.config?.qc;
  const stages = full.segments || [];
  const windows = full.windows || [];
  const extensionDone = stages.length > 0 && stages.every((s) => s.status === "succeeded");
  const icDone = windows.length > 0 && windows.every((w) => w.status === "succeeded");
  const isRefineOnly = full.kind === "refine";
  const manual = Boolean(full.config?.manual);
  const live = ACTIVE.has(full.status) || (manual && full.status === "draft");
  const runningStage = live ? stages.find((s) => s.status === "running") : null;
  const working = Boolean(full.working || runningStage || windows.some((w) => w.status === "running")) && live;
  const status = full.status === "draft" && working ? "running" : full.status;
  const active = ACTIVE.has(status);
  const preview = full.final?.url
    ? { url: full.final.url, final: true }
    : full.master?.url
      ? { url: full.master.url, final: false }
      : full.source?.url
        ? { url: full.source.url, final: false }
        : null;
  const source = preview
    ? el("video", { class: `project-source${preview.final ? " project-final-preview" : ""}`, src: preview.url,
        controls: preview.final ? "" : undefined, muted: preview.final ? undefined : true, playsinline: "", preload: "metadata" })
    : el("div", { class: "project-source empty-media" }, el("span", {}, icon("film")), el("small", {}, "no source"));
  const final = full.final?.url
    ? el("a", { class: "btn lime small", href: full.final.url, target: "_blank", rel: "noreferrer" }, icon("download"), "Final")
    : null;
  const cancel = active
    ? el("button", { class: "btn ghost small", type: "button", onclick: async () => {
        try { await api(`/api/projects/${full.id}/cancel`, { method: "POST" }); toast("Project canceled"); actions.refresh(); }
        catch (e) { toast(e.message, { error: true }); }
      } }, icon("stop"), "Cancel") : null;
  const pause = full.status === "running" || full.status === "planning"
    ? el("button", { class: "btn ghost small", type: "button", onclick: async () => {
        try { await api(`/api/projects/${full.id}/pause`, { method: "POST" }); toast("Project paused"); actions.refresh(); }
        catch (e) { toast(e.message, { error: true }); }
      } }, icon("pause"), "Pause") : null;
  const resume = full.status === "paused"
    ? el("button", { class: "btn ghost small", type: "button", onclick: async () => {
        try { await api(`/api/projects/${full.id}/resume`, { method: "POST" }); toast("Project resumed"); actions.refresh(); }
        catch (e) { toast(e.message, { error: true }); }
      } }, icon("play"), "Resume") : null;
  const retry = null;
  const refine = !manual && (full.master || full.config?.masterAsset || (full.kind === "refine" && full.source)) && full.status !== "running"
    ? el("button", { class: "btn ghost small", type: "button", onclick: async () => {
        try {
          await api(`/api/projects/${full.id}/refine`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ targetResolution: full.config?.targetResolution ?? "2k", sampler: full.config?.sampler ?? "up3" }),
          });
          toast("2K refinement restarted"); actions.refresh();
        } catch (e) { toast(e.message, { error: true }); }
      } }, icon("spark"), "Re-run 2K") : null;
  const details = el("button", { class: "btn ghost small", type: "button", onclick: () => actions.toggle(full.id) },
    icon("rows"), actions.expanded === full.id ? "Close" : manual ? "Manual edit" : "Inspect");

  const progressText = runningStage
    ? `Segment ${runningStage.idx}/${stages.length} running`
    : `${pct}%`;
  const card = el("article", { class: `project-card ${status}` },
    el("div", { class: "project-media" }, source, statusTag(status),
      el("span", { class: "project-duration" }, fmtDuration(full.target_seconds))),
    el("div", { class: "project-main" },
      el("div", { class: "project-top" },
        el("div", {}, el("span", { class: "proj-kicker" }, manual ? "MANUAL PROJECT" : full.kind === "extend" ? "EXTENSION" : full.kind === "refine" ? "2K REFINEMENT" : "EXTEND + 2K"),
          el("h3", { class: "project-name" }, full.prompt?.slice(0, 82) || full.config?.story?.slice(0, 82) || full.id)),
        el("span", { class: "project-id" }, full.id)),
      el("div", { class: "project-stages" },
        stageRow("Extend", isRefineOnly ? "skipped" : stages.length ? `${stages.filter((s) => s.status === "succeeded").length}/${stages.length} segments` : "queued", extensionDone || isRefineOnly, active && !extensionDone),
        stageRow("Refine", full.kind === "extend" ? "skipped" : windows.length ? `${windows.filter((w) => w.status === "succeeded").length}/${windows.length} windows` : "queued", icDone || full.kind === "extend", active && extensionDone && full.kind !== "extend"),
        stageRow("Finalize", final ? "ready" : "waiting", !!final, false)),
      el("div", { class: `bar project-bar${working ? " working" : ""}` }, el("i", { style: { width: `${pct}%` } })),
      el("div", { class: "project-meta" },
        el("span", {}, progressText),
        full.config?.story ? el("span", {}, "story context") : null,
        full.config?.segmentPrompts?.filter(Boolean).length ? el("span", {}, `${full.config.segmentPrompts.filter(Boolean).length} segment prompts`) : null,
        qc?.warnings?.length ? el("span", { class: "qc-warn" }, `${qc.warnings.length} QC signals`) : qc ? el("span", { class: "qc-ok" }, "QC clean") : null,
        full.error ? el("span", { class: "project-error" }, full.error) : null),
      el("div", { class: "project-actions" }, final, retry, resume, refine, details, pause, cancel)),
    actions.expanded === full.id ? projectDetail(full, actions) : null);
  return card;
}

function manualField(label, control) {
  return el("label", { class: "field" }, el("span", { class: "lbl" }, label), control);
}

function manualProjectPanel(p, actions) {
  const options = () => {
    const items = [];
    if (p.source) items.push({ id: p.source.id, label: "Original source", asset: p.source });
    for (const segment of p.segments || []) {
      if (segment.output?.id) items.push({ id: segment.output.id, label: `Segment ${segment.idx}`, asset: segment.output });
    }
    return items;
  };
  const selected = new Set(options().map((item) => item.id));
  const status = el("p", { class: "proj-form-status" });
  const extendSource = el("select", {}, ...options().map((item) => el("option", { value: item.id }, item.label)));
  extendSource.value = options().at(-1)?.id || "";
  const prompt = el("textarea", { rows: "4" }, p.prompt || "Continue the motion, camera and scene.");
  const seconds = el("input", { type: "number", min: "4", max: "12", step: "1", value: "5" });
  const context = el("select", {}, el("option", { value: "63" }, "63 frames (2.6 s)"), el("option", { value: "48" }, "48 frames (2 s)"));
  const steps = el("input", { type: "number", min: "1", max: "50", step: "1", value: String(p.config?.steps ?? 8) });
  const seed = el("input", { type: "number", min: "0", max: "2147483647", step: "1", value: String(p.config?.seedBase ?? 42) });
  const enhanceSource = el("select", {}, ...options().map((item) => el("option", { value: item.id }, item.label)));
  enhanceSource.value = options().at(-1)?.id || "";
  const start = el("input", { type: "number", min: "0", step: "0.1", value: "0" });
  const end = el("input", { type: "number", min: "2", step: "0.1", value: "10" });
  const resolution = el("select", {}, el("option", { value: "1080p" }, "1080p"), el("option", { value: "2k" }, "2K"));
  const sampler = el("select", {}, el("option", { value: "up3" }, "up3"), el("option", { value: "up4" }, "up4"), el("option", { value: "hf8" }, "hf8"));
  const overlap = el("input", { type: "number", min: "1", max: "60", step: "1", value: "17" });
  const refs = p.config?.references || [];

  const run = async (label, task) => {
    status.textContent = label;
    status.className = "proj-form-status";
    try {
      await task();
      status.textContent = "Done.";
      await actions.refresh();
    } catch (error) {
      status.textContent = error.message;
      status.className = "proj-form-status err";
      toast(error.message, { error: true });
    }
  };

  const extend = () => run("Generating extension…", async () => {
    const body = {
      sourceAsset: extendSource.value,
      seconds: Number(seconds.value),
      contextFrames: Number(context.value),
      steps: Number(steps.value),
      seed: Number(seed.value),
      prompt: prompt.value.trim(),
    };
    if (!body.prompt) throw new Error("extension prompt is required");
    await api(`/api/projects/${p.id}/manual/extend`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    toast("Extension complete");
  });

  const enhance = () => run("Enhancing selection…", async () => {
    const source = options().find((item) => item.id === enhanceSource.value);
    if (!source) throw new Error("choose a clip to enhance");
    const duration = Math.max(0, Number(source.asset.duration || 0));
    const from = Math.max(0, Number(start.value || 0));
    const to = Math.max(from + 2, Number(end.value || Math.min(duration, 15)));
    await api(`/api/projects/${p.id}/manual/enhance`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceAsset: source.id,
        startFrame: Math.round(from * 24),
        endFrame: Math.round(to * 24),
        resolution: resolution.value,
        sampler: sampler.value,
        overlapFrames: Number(overlap.value),
      }),
    });
    toast("Enhancement complete");
  });

  const assemble = () => run("Assembling final…", async () => {
    if (!selected.size) throw new Error("select at least one clip");
    await api(`/api/projects/${p.id}/manual/assemble`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ assets: [...selected] }),
    });
    toast("Final video assembled");
  });

  const timeline = options().map((item) => {
    const check = el("input", { type: "checkbox", checked: "checked", onchange: (event) => {
      if (event.target.checked) selected.add(item.id); else selected.delete(item.id);
    } });
    return el("article", { class: "manual-clip" },
      el("div", { class: "manual-clip-head" }, check, el("b", {}, item.label)),
      el("video", { class: "manual-video", src: item.asset.url, controls: "", preload: "metadata", playsinline: "" }),
      el("small", { class: "dim" }, item.asset.duration ? `${Number(item.asset.duration).toFixed(2)} s` : ""));
  });

  return el("div", { class: "manual-panel" },
    el("div", { class: "manual-panel-head" },
      el("div", {}, el("span", { class: "proj-kicker" }, "MANUAL CONTROL"),
        el("h3", { class: "display" }, "Build this project step by step"),
        el("p", {}, "Nothing runs automatically. Add one extension at a time, enhance a range, then assemble the cut.")),
      el("span", { class: "tag dark" }, `${refs.length} references`)),
    el("div", { class: "manual-controls" },
      el("section", { class: "manual-section" },
        el("div", { class: "manual-section-head" }, el("span", { class: "proj-kicker" }, "EXTEND"), el("b", {}, "H3 continuation")),
        manualField("Source clip", extendSource),
        el("div", { class: "manual-inline" }, manualField("Visible seconds", seconds), manualField("Context", context)),
        el("div", { class: "manual-inline" }, manualField("Steps", steps), manualField("Seed", seed)),
        manualField("Prompt", prompt),
        el("button", { class: "generate wide", type: "button", onclick: extend }, icon("film"), "Generate extension")),
      el("section", { class: "manual-section" },
        el("div", { class: "manual-section-head" }, el("span", { class: "proj-kicker" }, "ENHANCE"), el("b", {}, "IC selected range")),
        manualField("Clip", enhanceSource),
        el("div", { class: "manual-inline" }, manualField("Start (s)", start), manualField("End (s)", end)),
        el("div", { class: "manual-inline" }, manualField("Resolution", resolution), manualField("Sampler", sampler)),
        manualField("Overlap frames", overlap),
        el("button", { class: "generate wide", type: "button", onclick: enhance }, icon("spark"), "Enhance selected range")),
      el("section", { class: "manual-section" },
        el("div", { class: "manual-section-head" }, el("span", { class: "proj-kicker" }, "ASSEMBLE"), el("b", {}, "Final cut")),
        el("p", { class: "dim" }, "Use the checkboxes in the timeline to choose clips, then assemble."),
        el("button", { class: "generate wide", type: "button", onclick: assemble }, icon("download"), "Assemble selected clips"))),
    el("div", { class: "manual-timeline" }, ...timeline),
    p.final?.url ? el("div", { class: "manual-final" }, el("span", { class: "proj-kicker" }, "FINAL"),
      el("video", { src: p.final.url, controls: "", preload: "metadata" })) : null,
    status);
}

function projectDetail(p, actions) {
  const segments = p.segments || [];
  const windows = p.windows || [];
  const events = (p.events || []).slice(-8);
  const segmentList = segments.slice(0, 80).map((s) => el("div", { class: "segment-item" },
    el("div", { class: "segment-thumb" }, s.output?.url
      ? el("video", { src: s.output.url, muted: true, playsinline: "", preload: "metadata", controls: "" })
      : el("span", { class: "dim" }, s.status === "stale" ? "stale" : "pending")),
    el("div", { class: "segment-copy" },
      el("div", { class: "row" }, el("b", {}, `Segment ${s.idx}`), statusTag(s.status),
        s.output?.url ? el("a", { class: "mini-link", href: s.output.url, target: "_blank", rel: "noreferrer" }, "open") : null),
      el("p", {}, s.prompt || "No segment-specific prompt"),
      el("small", { class: "dim" }, `frames ${s.start_frame}–${s.end_frame} · seed ${s.seed ?? "—"} · ${s.context_frames}f context`),
      s.error ? el("small", { class: "project-error" }, s.error) : null),
    s.status === "failed" || s.status === "stale"
      ? el("button", { class: "btn ghost small", type: "button", onclick: async () => {
          try {
            await api(`/api/projects/${p.id}/retry`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ index: s.idx }) });
            await api(`/api/projects/${p.id}/start`, { method: "POST" });
            toast(`Retrying from segment ${s.idx}`); actions.refresh();
          } catch (e) { toast(e.message, { error: true }); }
        } }, icon("redo"), "Retry here") : null));

  const windowSummary = windows.length ? el("div", { class: "proj-subgrid" },
    el("div", { class: "mini-stat" }, el("b", {}, windows.filter((w) => w.status === "succeeded").length), el("small", {}, "IC windows done")),
    el("div", { class: "mini-stat" }, el("b", {}, windows.filter((w) => w.status === "failed").length), el("small", {}, "failed")),
    el("div", { class: "mini-stat" }, el("b", {}, windows.filter((w) => w.status === "running").length), el("small", {}, "running"))) : null;

  const qc = p.config?.qc;
  const storyNode = p.config?.story
    ? el("div", { class: "story-block" }, el("span", { class: "proj-kicker" }, "CONTINUITY"), el("p", {}, p.config.story))
    : null;
  const segmentsNode = segments.length
    ? el("div", { class: "detail-section" },
        el("div", { class: "detail-heading" }, el("b", {}, "Extension segments"), el("small", {}, `${segments.length} total`)),
        el("div", { class: "segment-grid" }, ...segmentList),
        segments.length > 80 ? el("p", { class: "help" }, `Showing the first 80 of ${segments.length} segments.`) : null)
    : null;
  const qcNode = qc
    ? el("div", { class: "qc-block" }, el("span", { class: "proj-kicker" }, "QUALITY"), el("div", { class: "qc-chips" },
        el("span", { class: `qc-chip ${qc.black ? "warn" : ""}` }, `${qc.black} black`),
        el("span", { class: `qc-chip ${qc.freeze ? "warn" : ""}` }, `${qc.freeze} freeze`),
        el("span", { class: `qc-chip ${qc.silence ? "warn" : ""}` }, `${qc.silence} silence`)))
    : null;
  const eventsNode = events.length
    ? el("div", { class: "detail-section" },
        el("div", { class: "detail-heading" }, el("b", {}, "Events"), el("small", {}, "latest")),
        el("div", { class: "event-list" }, ...events.map((event) => el("div", { class: "event-row" },
          el("span", { class: "tag ghost" }, event.kind), el("small", {}, event.created_at)))))
    : null;

  return el("div", { class: "project-detail" },
    el("div", { class: "detail-bar" },
      el("div", {}, el("span", { class: "proj-kicker" }, "DETAIL"), el("b", {}, p.id)),
      el("div", { class: "detail-actions" },
        p.source?.url ? el("a", { class: "mini-link", href: p.source.url, target: "_blank", rel: "noreferrer" }, "source") : null,
        p.master?.url ? el("a", { class: "mini-link", href: p.master.url, target: "_blank", rel: "noreferrer" }, "768p master") : null)),
    storyNode,
    windowSummary,
    segmentsNode,
    qcNode,
    eventsNode,
    p.config?.manual ? manualProjectPanel(p, actions) : null);
}

export function projectsView() {
  let projects = [];
  let full = new Map();
  let expanded = null;
  let timer = null;
  let disposed = false;
  let kind = "both";
  let projectMode = "auto";
  let signature = "";
  const list = el("div", { class: "project-list" });
  const status = el("p", { class: "proj-form-status" });
  const submit = el("button", { class: "generate wide", type: "submit" }, icon("send"), "Create project");
  const source = fileDrop({ label: "Drop a source clip", hint: "MP4/MOV/WebM · 15 s+ or a 768p master", accept: "video/mp4,video/quicktime,video/webm", iconName: "film" });
  const refs = {
    image: fileDrop({ label: "Images", hint: "up to 9 · JPG/PNG/WebP", accept: "image/png,image/jpeg,image/webp", multiple: true, iconName: "image" }),
    video: fileDrop({ label: "Videos", hint: "up to 2 extra · 2–15 s", accept: "video/mp4,video/quicktime,video/webm", multiple: true, iconName: "video" }),
    audio: fileDrop({ label: "Audio", hint: "up to 3 · 2–15 s", accept: "audio/wav,audio/mpeg,audio/mp4", multiple: true, iconName: "audio" }),
  };
  const prompt = el("textarea", { placeholder: "Base direction for every extension segment. Use <Picture 1>, <Video 1>, <Audio 1>.", rows: "4" });
  const story = el("textarea", { placeholder: "Persistent continuity bible: characters, wardrobe, locations, story state, camera rules, audio/dialogue rules.", rows: "5" });
  const segmentPrompts = el("textarea", { placeholder: "Optional per-segment prompts, one line per extension segment. Line 1 is Segment 1.", rows: "5" });
  const seed = el("input", { type: "number", value: "42", min: "0", max: "2147483647", step: "1" });
  const visible = el("input", { type: "number", value: "5", min: "2", max: "12", step: "1" });
  const steps = el("input", { type: "number", value: "8", min: "1", max: "50", step: "1" });
  const target = el("input", { type: "number", value: "120", min: "10", max: "7200", step: "1" });
  const modeButtons = new Map();
  const modeSeg = el("div", { class: "seg modes proj-mode-seg" }, ...[
    ["auto", "spark", "Auto"], ["manual", "sliders", "Manual"],
  ].map(([id, ic, label]) => {
    const button = el("button", { type: "button", "aria-pressed": String(projectMode === id), onclick: () => {
      projectMode = id;
      for (const [key, item] of modeButtons) item.setAttribute("aria-pressed", String(key === id));
      syncMode();
    } }, icon(ic), label);
    modeButtons.set(id, button);
    return button;
  }));
  const resolution = el("select", {}, el("option", { value: "2k" }, "2K · 2560×1440"), el("option", { value: "1080p" }, "1080p · 1920×1080"));
  const sampler = el("select", {}, el("option", { value: "up3" }, "up3 · 3 steps"), el("option", { value: "up4" }, "up4 · 4 steps"), el("option", { value: "hf8" }, "hf8 · 8 steps"));
  const kindButtons = new Map();
  const kindSeg = el("div", { class: "seg modes" }, ...[
    ["both", "spark", "Extend + 2K"], ["extend", "film", "Extend only"], ["refine", "image", "2K only"],
  ].map(([id, ic, label]) => {
    const b = el("button", { type: "button", "aria-pressed": String(kind === id), onclick: () => {
      kind = id;
      for (const [key, button] of kindButtons) button.setAttribute("aria-pressed", String(key === id));
    } }, icon(ic), label);
    kindButtons.set(id, b);
    return b;
  }));
  const targetPills = el("div", { class: "pills proj-target-pills" });
  const presetButtons = TARGETS.map(([label, seconds]) => el("button", { type: "button", "aria-pressed": String(Number(target.value) === seconds),
    onclick: () => { target.value = String(seconds); syncPresets(); updateEstimate(); } }, label));
  const syncPresets = () => {
    for (const [i, [, seconds]] of TARGETS.entries()) presetButtons[i].setAttribute("aria-pressed", String(Number(target.value) === seconds));
  };
  target.oninput = syncPresets;
  targetPills.append(...presetButtons);

  const form = el("form", { class: "proj-form", id: "long-project-form", onsubmit: async (event) => {
    event.preventDefault();
    const file = source.input.files?.[0];
    if (!file) { toast("Choose a source video first", { error: true }); source.drop.classList.add("missing"); setTimeout(() => source.drop.classList.remove("missing"), 600); return; }
    if (!prompt.value.trim() && !story.value.trim() && !segmentPrompts.value.trim()) { toast("Add a prompt, continuity story or segment prompt", { error: true }); return; }
    submit.disabled = true;
    const label = submit.textContent;
    submit.textContent = "Creating…";
    status.textContent = "Creating project and streaming the source…";
    status.className = "proj-form-status";
    try {
      const project = await api("/api/projects", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind, targetSeconds: Number(target.value), prompt: prompt.value, story: story.value,
          segmentPrompts: segmentPrompts.value.split(/\r?\n/), seedBase: Number(seed.value),
          visibleSeconds: Number(visible.value), steps: Number(steps.value),
          targetResolution: resolution.value, sampler: sampler.value, manual: projectMode === "manual",
        }),
      });
      await upload(`/api/projects/${project.id}/source?name=${encodeURIComponent(file.name)}`, file);
      for (const [refKind, field] of Object.entries(refs)) {
        for (const refFile of field.input.files || []) {
          await upload(`/api/projects/${project.id}/references?kind=${refKind}&name=${encodeURIComponent(refFile.name)}`, refFile);
        }
      }
      if (projectMode === "manual") {
        status.textContent = "Manual project created. Open its card to add the first step.";
        toast("Manual project created");
      } else {
        await api(`/api/projects/${project.id}/start`, { method: "POST" });
        status.textContent = "Project queued. It will keep running while you use another tab.";
        toast("Long-form project started");
      }
      source.reset();
      for (const field of Object.values(refs)) field.reset();
      updateEstimate();
      await refresh();
    } catch (error) {
      status.textContent = error.message;
      status.className = "proj-form-status err";
    } finally {
      submit.disabled = projects.some((p) => ACTIVE.has(p.status) || p.working);
      submit.textContent = label;
    }
  } },
    el("div", { class: "proj-form-head" }, el("span", { class: "proj-step" }, "01"), el("div", {}, el("h2", { class: "display" }, "Project blueprint"), el("p", {}, "Set the length, continuity context and the two engines that build the final film."))),
    el("div", { class: "proj-form-section proj-auto-only" }, el("span", { class: "lbl" }, "Pipeline"), kindSeg),
    el("div", { class: "proj-form-section" }, el("span", { class: "lbl" }, "Mode"), modeSeg, el("p", { class: "proj-mode-note" }, "Auto builds the whole project. Manual creates a draft; every extension, IC range and assembly is yours to run.")),
    el("div", { class: "proj-form-section proj-auto-only" }, el("span", { class: "lbl" }, "Target length"), targetPills,
      el("div", { class: "proj-inline" }, el("label", { class: "field" }, el("span", { class: "lbl" }, "Exact seconds"), target),
        el("div", { class: "proj-estimate" }, "Target ", el("b", {}, fmtDuration(Number(target.value))), " · source tail is 2.625 s context"))),
    el("div", { class: "proj-form-section" }, el("span", { class: "lbl" }, "Source"), source.drop),
    el("div", { class: "proj-prompt-grid" },
      el("label", { class: "field" }, el("span", { class: "lbl" }, "Base prompt", el("small", {}, "every segment")), prompt),
      el("label", { class: "field" }, el("span", { class: "lbl" }, "Continuity bible", el("small", {}, "persistent context")), story)),
    el("label", { class: "field proj-auto-only" }, el("span", { class: "lbl" }, "Per-segment prompts", el("small", {}, "one line per segment; overrides after story")), segmentPrompts),
    el("div", { class: "proj-field-row proj-auto-only" },
      el("label", { class: "field" }, el("span", { class: "lbl" }, "Seed base"), seed),
      el("label", { class: "field" }, el("span", { class: "lbl" }, "Visible s / segment"), visible),
      el("label", { class: "field" }, el("span", { class: "lbl" }, "Steps"), steps),
      el("label", { class: "field" }, el("span", { class: "lbl" }, "IC resolution"), resolution),
      el("label", { class: "field" }, el("span", { class: "lbl" }, "IC sampler"), sampler)),
    el("div", { class: "proj-reference-grid" }, ...Object.values(refs).map((f) => f.drop)));
  const syncMode = () => {
    form.classList.toggle("manual-mode", projectMode === "manual");
    submit.textContent = projectMode === "manual" ? "Create manual project" : "Create project";
  };
  syncMode();
  submit.setAttribute("form", "long-project-form");

  const detail = (id) => full.get(id) || null;
  const toggle = async (id) => {
    if (expanded === id) { expanded = null; render(); return; }
    expanded = id;
    try { full.set(id, await api(`/api/projects/${id}`)); } catch (error) { toast(error.message, { error: true }); }
    render();
  };
  const updateLiveCards = () => {
    for (const card of list.querySelectorAll("[data-project-id]")) {
      const id = card.getAttribute("data-project-id");
      const data = (id && full.get(id)) || projects.find((project) => project.id === id);
      if (!data) continue;
      const progress = Math.max(0, Math.min(1, Number(data.progress) || 0));
      const fill = card.querySelector("[data-progress-fill]");
      if (fill) fill.style.width = `${Math.round(progress * 100)}%`;
      const text = card.querySelector("[data-progress-text]");
      if (text) text.textContent = runtimeProgressText(data);
      const elapsed = card.querySelector("[data-elapsed]");
      if (elapsed) elapsed.textContent = runtimeElapsedText(data);
    }
  };
  const refresh = async () => {
    try {
      const data = await api("/api/projects");
      projects = data.projects || [];
      for (const p of projects) {
        const cached = full.get(p.id);
        const needsDetail = ACTIVE.has(p.status) || p.working || expanded === p.id || !cached
          || cached.status !== p.status || (p.status === "succeeded" && !cached.final);
        if (needsDetail) {
          try { full.set(p.id, await api(`/api/projects/${p.id}`)); } catch { /* keep summary */ }
        }
      }
      const nextSignature = JSON.stringify(projects.map((project) => {
        const data = full.get(project.id) || project;
        return [project.id, project.status, project.working, data.final?.id,
          data.segments?.map((s) => [s.idx, s.status, s.output_asset]),
          data.windows?.map((w) => [w.idx, w.status, w.output_asset])];
      }));
      if (nextSignature === signature) {
        updateLiveCards();
        return;
      }
      signature = nextSignature;
      render();
    } catch (error) {
      status.textContent = error.message;
      status.className = "proj-form-status err";
    }
  };
  const render = () => {
    const actions = { refresh, toggle, expanded, detail };
    const busyProject = projects.some((p) => ACTIVE.has(p.status) || p.working);
    if (["Create project", "Create manual project"].includes(submit.textContent)) submit.disabled = busyProject;
    list.replaceChildren(...(projects.length
      ? projects.map((p) => projectCard(p, actions))
      : [el("div", { class: "empty proj-empty" }, icon("film"), el("b", {}, "No long-form projects yet"), el("p", {}, "Create one on the left; the first project is usually a 2-minute proof."))]));
  };

  const estimateNode = el("b", { id: "proj-estimate" }, "~11 segments · 27 IC windows");
  const updateEstimate = () => {
    const e = estimate(Number(target.value), Number(visible.value), kind, 15);
    estimateNode.textContent = `${e.extension} segments · ${e.windows} IC windows`;
  };
  target.oninput = () => { syncPresets(); updateEstimate(); };
  visible.oninput = updateEstimate;
  kindSeg.addEventListener("click", () => setTimeout(updateEstimate, 0));

  const mainHead = el("header", { class: "proj-main-head" },
    el("div", { class: "proj-main-title" },
      el("span", { class: "proj-kicker" }, "FREEFIELD / LONG-FORM STUDIO"),
      el("h1", { class: "display" }, "Long-form ", el("em", {}, "projects")),
      el("p", {}, "Build one finished film from chained H3 segments and a 2K IC pass. The blueprint lives on the left; every project, preview and retry lives here.")),
    el("div", { class: "proj-main-actions" },
      el("div", { class: "proj-stat-strip" }, el("span", {}, "EXTEND"), el("b", {}, "Ref2VA"), el("span", {}, "REFINE"), el("b", {}, "124f IC"), el("span", {}, "FINAL"), el("b", {}, "MP4")),
      el("button", { class: "btn ghost small", type: "button", onclick: refresh }, icon("redo"), "Refresh")));

  const sideFoot = el("div", { class: "side-foot proj-side-foot" },
    el("div", { class: "proj-side-estimate" }, el("span", {}, "ESTIMATE"), estimateNode),
    el("div", { class: "row" }, submit),
    status);
  const sidebar = el("aside", { class: "side proj-side", "aria-label": "New long-form project" },
    el("div", { class: "side-scroll" }, form), sideFoot);
  sidebar.append(sideResizer(sidebar));

  const node = el("div", { class: "ws l-sidebar proj-ws" },
    sidebar,
    el("section", { class: "ws-main proj-main" },
      mainHead,
      list));
  const savedWidth = Number(store.get("side.w", 340));
  if (Number.isFinite(savedWidth)) node.style.setProperty("--side-w", `${Math.max(280, Math.min(680, savedWidth))}px`);
  refresh();
  updateEstimate();
  timer = setInterval(() => {
    if (disposed) return;
    if (projects.some((p) => ACTIVE.has(p.status) || p.working) || (expanded && full.get(expanded)?.status && ACTIVE.has(full.get(expanded).status))) refresh();
  }, 3000);
  return {
    node, active: "projects",
    dispose: () => { disposed = true; clearInterval(timer); source.input.onchange = null; for (const f of Object.values(refs)) f.input.onchange = null; },
  };
}








