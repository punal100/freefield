// Manual long-form studio: user-driven extension and IC steps over a project
// source. Unlike the project worker, nothing is queued automatically.
import { api, el, icon, toast } from "./util.js";

function fmtSeconds(value) {
  const n = Math.max(0, Math.round(Number(value) || 0));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
}

function field(label, input) {
  return el("label", { class: "field" }, el("span", { class: "lbl" }, label), input);
}

function fileField(label, accept, multiple = false) {
  const input = el("input", { type: "file", accept, multiple: multiple ? "" : undefined });
  return { input, node: field(label, input) };
}

async function upload(url, file) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": file.type || "application/octet-stream" },
    body: file,
  });
  let body = null;
  try { body = await res.json(); } catch { /* no body */ }
  if (!res.ok) throw new Error(body?.error || `${res.status} ${res.statusText}`);
  return body;
}

function sourceOptions(project) {
  const items = [];
  if (project.source) items.push({ id: project.source.id, label: "Original source", asset: project.source });
  for (const segment of project.segments || []) {
    if (segment.output?.id) items.push({ id: segment.output.id, label: `Segment ${segment.idx}`, asset: segment.output });
  }
  return items;
}

function videoCard(asset, label, selected, onSelect) {
  const check = el("input", { type: "checkbox", checked: selected ? true : undefined, onchange: (event) => onSelect(event.target.checked) });
  return el("article", { class: "manual-clip" },
    el("div", { class: "manual-clip-head" }, check, el("b", {}, label)),
    asset?.url
      ? el("video", { class: "manual-video", src: asset.url, controls: "", preload: "metadata", playsinline: "" })
      : el("div", { class: "manual-video empty" }, icon("film"), "No output"),
    el("small", { class: "dim" }, asset?.duration ? `${asset.duration.toFixed(2)} s` : ""));
}

export function manualView() {
  let projects = [];
  let project = null;
  let selected = new Set();
  let busy = "";
  let error = "";
  const root = el("div", { class: "page manual-page" });

  const loadList = async () => {
    const data = await api("/api/projects");
    projects = (data.projects || []).filter((p) => p.config?.manual);
    if (!project && projects.length) project = await api(`/api/projects/${projects[0].id}`);
  };

  const refresh = async () => {
    if (project) project = await api(`/api/projects/${project.id}`);
    render();
  };

  const run = async (label, fn) => {
    busy = label;
    error = "";
    render();
    try { await fn(); }
    catch (err) { error = err.message; toast(err.message, { error: true }); }
    finally { busy = ""; render(); }
  };

  const create = async (form) => {
    const file = form.source.files?.[0];
    if (!file) throw new Error("choose a source video");
    const created = await api("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "extend",
        targetSeconds: 120,
        manual: true,
        prompt: form.prompt.value || "Manual extension studio",
        steps: 8,
        visibleSeconds: 5,
        contextFrames: 63,
        targetResolution: "1080p",
      }),
    });
    await upload(`/api/projects/${created.id}/source?name=${encodeURIComponent(file.name)}`, file);
    project = await api(`/api/projects/${created.id}`);
    await loadList();
    toast("Manual session created");
  };

  const addRefs = async (form) => {
    for (const [kind, field] of Object.entries(form.refs)) {
      for (const file of field.input.files || []) {
        await upload(`/api/projects/${project.id}/references?kind=${kind}&name=${encodeURIComponent(file.name)}`, file);
      }
    }
    project = await api(`/api/projects/${project.id}`);
    toast("References added");
  };

  const extend = async (form) => {
    const prompt = form.prompt.value.trim();
    if (!prompt) throw new Error("extension prompt is required");
    const body = {
      sourceAsset: form.source.value,
      seconds: Number(form.seconds.value),
      contextFrames: Number(form.context.value),
      steps: Number(form.steps.value),
      seed: Number(form.seed.value),
      prompt,
    };
    project = await api(`/api/projects/${project.id}/manual/extend`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    toast("Extension complete");
  };

  const enhance = async (form) => {
    const source = sourceOptions(project).find((item) => item.id === form.source.value);
    if (!source) throw new Error("choose a clip to enhance");
    const duration = Math.max(0, Number(source.asset.duration || 0));
    const start = Math.max(0, Number(form.start.value || 0));
    const end = Math.max(start + 2, Number(form.end.value || Math.min(duration, 15)));
    if (end <= start) throw new Error("enhancement range is empty");
    project = await api(`/api/projects/${project.id}/manual/enhance`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceAsset: form.source.value,
        startFrame: Math.round(start * 24),
        endFrame: Math.round(end * 24),
        resolution: form.resolution.value,
        sampler: form.sampler.value,
        overlapFrames: Number(form.overlap.value),
      }),
    });
    toast("Enhancement complete");
  };

  const assemble = async () => {
    if (!selected.size) throw new Error("select at least one clip");
    project = await api(`/api/projects/${project.id}/manual/assemble`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assets: [...selected] }),
    });
    toast("Final video assembled");
  };

  const createPanel = () => {
    const source = fileField("Source video", "video/mp4,video/quicktime,video/webm");
    const prompt = el("textarea", { rows: "4", placeholder: "What should continue from the source?" });
    const form = { source: source.input, prompt };
    return el("form", { class: "manual-create", onsubmit: (event) => {
      event.preventDefault();
      run("Creating manual session…", () => create(form));
    } },
      el("h2", { class: "display" }, "Manual studio"),
      el("p", { class: "dim" }, "Upload a source, then add and enhance one clip at a time. Nothing runs automatically."),
      source.node,
      field("Session prompt", prompt),
      el("button", { class: "generate wide", type: "submit", disabled: busy ? "" : undefined }, icon("plus"), "Create manual session"),
      error ? el("p", { class: "project-error" }, error) : null,
      busy ? el("p", { class: "dim" }, busy) : null);
  };

  const projectPanel = () => {
    const options = sourceOptions(project);
    const sourceSelect = el("select", {}, ...options.map((item) => el("option", { value: item.id }, item.label)));
    sourceSelect.value = options.at(-1)?.id || "";
    const seconds = el("input", { type: "number", min: "4", max: "10", step: "1", value: "5" });
    const context = el("select", {}, el("option", { value: "5" }, "5 frames"), el("option", { value: "22" }, "22 frames"), el("option", { value: "63" }, "63 frames"));
    context.value = "63";
    const steps = el("input", { type: "number", min: "1", max: "50", step: "1", value: String(project.config?.steps ?? 8) });
    const seed = el("input", { type: "number", min: "0", max: "2147483647", step: "1", value: String(project.config?.seedBase ?? 42) });
    const prompt = el("textarea", { rows: "5", placeholder: "Continuation prompt" }, project.prompt || "");
    const refs = {
      image: fileField("Images", "image/png,image/jpeg,image/webp", true),
      video: fileField("Videos", "video/mp4,video/quicktime,video/webm", true),
      audio: fileField("Audio", "audio/wav,audio/mpeg,audio/mp4", true),
    };
    const extForm = { source: sourceSelect, seconds, context, steps, seed, prompt, refs };
    const enhanceSource = el("select", {}, ...options.map((item) => el("option", { value: item.id }, item.label)));
    enhanceSource.value = options.at(-1)?.id || "";
    const enhanceStart = el("input", { type: "number", min: "0", step: "0.1", value: "0" });
    const enhanceEnd = el("input", { type: "number", min: "2", step: "0.1", value: "10" });
    const resolution = el("select", {}, el("option", { value: "1080p" }, "1080p"), el("option", { value: "2k" }, "2K"));
    const sampler = el("select", {}, el("option", { value: "up3" }, "up3"), el("option", { value: "up4" }, "up4"), el("option", { value: "hf8" }, "hf8"));
    const overlap = el("input", { type: "number", min: "1", max: "60", step: "1", value: "17" });
    const enhForm = { source: enhanceSource, start: enhanceStart, end: enhanceEnd, resolution, sampler, overlap };
    const timeline = [project.source ? videoCard(project.source, "Source", selected.has(project.source.id), (on) => {
      if (on) selected.add(project.source.id); else selected.delete(project.source.id); render();
    }) : null, ...(project.segments || []).filter((s) => s.output?.id).map((segment) => videoCard(segment.output, `Segment ${segment.idx}`, selected.has(segment.output.id), (on) => {
      if (on) selected.add(segment.output.id); else selected.delete(segment.output.id); render();
    }))].filter(Boolean);

    return el("div", { class: "manual-layout" },
      el("aside", { class: "manual-controls" },
        el("div", { class: "manual-section" },
          el("div", { class: "manual-section-head" }, el("span", { class: "proj-kicker" }, "ADD EXTENSION"), el("b", {}, "H3 continuation")),
          field("Source clip", sourceSelect),
          el("div", { class: "manual-inline" }, field("Visible seconds", seconds), field("Context", context)),
          el("div", { class: "manual-inline" }, field("Steps", steps), field("Seed", seed)),
          field("Prompt", prompt),
          el("details", { class: "manual-refs" }, el("summary", {}, `References (${project.config?.references?.length ?? 0} attached)`),
            ...Object.values(refs).map((ref) => ref.node),
            el("button", { class: "btn ghost small", type: "button", onclick: () => run("Adding references…", () => addRefs({ refs })) }, icon("upload"), "Add references")),
          el("button", { class: "generate wide", type: "button", onclick: () => run("Generating extension…", () => extend(extForm)) }, icon("film"), "Generate extension")),
        el("div", { class: "manual-section" },
          el("div", { class: "manual-section-head" }, el("span", { class: "proj-kicker" }, "ENHANCE"), el("b", {}, "IC on a selected range")),
          field("Clip", enhanceSource),
          el("div", { class: "manual-inline" }, field("Start (s)", enhanceStart), field("End (s)", enhanceEnd)),
          field("Overlap frames", overlap),
          el("div", { class: "manual-inline" }, field("Resolution", resolution), field("Sampler", sampler)),
          el("button", { class: "generate wide", type: "button", onclick: () => run("Enhancing selection…", () => enhance(enhForm)) }, icon("spark"), "Enhance selected range")),
        el("div", { class: "manual-section" },
          el("div", { class: "manual-section-head" }, el("span", { class: "proj-kicker" }, "ASSEMBLE"), el("b", {}, "Final cut")),
          el("p", { class: "dim" }, `${selected.size} clip(s) selected in the timeline.`),
          el("button", { class: "generate wide", type: "button", onclick: () => run("Assembling final…", assemble) }, icon("download"), "Assemble selected clips"))),
      el("section", { class: "manual-right" },
        el("header", { class: "proj-main-head" },
          el("div", {}, el("span", { class: "proj-kicker" }, "FREEFIELD / MANUAL STUDIO"), el("h1", { class: "display" }, "Cut by ", el("em", {}, "hand")),
            el("p", {}, "Source, newly generated extensions, IC ranges and the final assembly are explicit steps.")),
          el("div", { class: "row" },
            el("a", { class: "btn ghost small", href: project.final?.url || "#", target: "_blank", rel: "noreferrer", hidden: project.final ? undefined : "" }, icon("download"), "Final"),
            el("button", { class: "btn ghost small", type: "button", onclick: () => { project = null; selected.clear(); render(); } }, icon("plus"), "New session"))),
        el("div", { class: "manual-timeline" }, ...timeline),
        project.final?.url ? el("div", { class: "manual-final" }, el("span", { class: "proj-kicker" }, "FINAL"), el("video", { src: project.final.url, controls: "", preload: "metadata" })) : null,
        error ? el("p", { class: "project-error" }, error) : null,
        busy ? el("p", { class: "dim" }, busy) : null));
  };

  const render = () => {
    if (!project) root.replaceChildren(createPanel());
    else root.replaceChildren(projectPanel());
  };

  const boot = async () => {
    try { await loadList(); render(); }
    catch (err) { root.replaceChildren(el("div", { class: "empty" }, err.message)); }
  };
  boot();
  return { node: root, active: "manual", dispose: () => {} };
}
