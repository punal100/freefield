// Long-form projects: create a 120 s (or longer) extension / 2K refinement
// project, upload the source, start it, and watch segment/window progress.
// Every GPU request is made by the server; this page never talks to SGLang.
import { api, el, icon, toast } from "./util.js";

const ACTIVE = new Set(["planning", "running", "paused"]);

async function upload(path, file) {
  const res = await fetch(path, { method: "POST", body: file, headers: { "content-type": file.type || "application/octet-stream" } });
  let body = null;
  try { body = await res.json(); } catch { /* no body */ }
  if (!res.ok) throw new Error(body?.error || `${res.status} ${res.statusText}`);
  return body;
}

function projectCard(p, actions) {
  const pct = Math.round((p.progress || 0) * 100);
  const src = p.source?.url ? el("video", { src: p.source.url, muted: "", playsinline: "", preload: "metadata", controls: "" }) : null;
  const final = p.final?.url ? el("a", { class: "btn lime small", href: p.final.url, target: "_blank", rel: "noreferrer" }, icon("download"), "Final video") : null;
  const cancel = ACTIVE.has(p.status) ? el("button", { class: "btn ghost small", type: "button", onclick: async () => {
    try { await api(`/api/projects/${p.id}/cancel`, { method: "POST" }); toast("Project canceled"); actions.refresh(); }
    catch (e) { toast(e.message, { error: true }); }
  } }, "Cancel") : null;
  const retry = (p.status === "failed" || p.status === "canceled") ? el("button", { class: "btn lime small", type: "button", onclick: async () => {
    try { await api(`/api/projects/${p.id}/start`, { method: "POST" }); toast("Project restarted"); actions.refresh(); }
    catch (e) { toast(e.message, { error: true }); }
  } }, icon("redo"), "Retry") : null;
  const segments = p.segments?.length ? el("div", { style: { display: "grid", gap: "6px" } },
    ...p.segments.map((s) => el("div", { style: { display: "flex", gap: "8px", alignItems: "center", fontSize: "12px", color: "var(--dim)" } },
      el("span", {}, `Segment ${s.idx}`),
      el("span", { class: `tag ${s.status === "succeeded" ? "" : "dark"}` }, s.status),
      s.output?.url ? el("a", { href: s.output.url, target: "_blank", rel: "noreferrer" }, "preview") : null,
      s.error ? el("span", { style: { color: "var(--bad)" } }, s.error) : null))) : null;
  const windowText = p.windows?.length ? el("small", { style: { color: "var(--dim)" } },
    `${p.windows.filter((w) => w.status === "succeeded").length}/${p.windows.length} IC windows`) : null;
  return el("div", { class: "card", style: { display: "grid", gap: "12px" } },
    el("div", { style: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" } },
      el("b", {}, p.kind), el("span", { class: `tag ${p.status === "succeeded" ? "" : "dark"}` }, p.status),
      el("span", { style: { color: "var(--dim)", fontSize: "12px" } }, `${p.target_seconds}s target`),
      el("span", { style: { marginLeft: "auto", color: "var(--dim)", fontSize: "12px" } }, `${pct}%`)),
    el("div", { class: "bar" }, el("i", { style: { width: `${pct}%` } })),
    p.prompt ? el("p", {}, p.prompt) : null,
    src ? el("div", { style: { maxHeight: "120px", overflow: "hidden", borderRadius: "10px" } }, src) : null,
    segments, windowText,
    el("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap" } }, final, retry, cancel,
      p.error ? el("span", { style: { color: "var(--bad)", fontSize: "12px" } }, p.error) : null));
}

export function projectsView() {
  let projects = [];
  let timer = null;
  let disposed = false;
  const list = el("div", { style: { display: "grid", gap: "12px" } });
  const status = el("p", { class: "dim", style: { minHeight: "20px" } });

  const refresh = async () => {
    try {
      const data = await api("/api/projects");
      projects = data.projects || [];
      list.replaceChildren(...(projects.length ? projects.map((p) => projectCard(p, { refresh })) : [el("div", { class: "empty" }, "No long-form projects yet.")]));
    } catch (e) {
      status.textContent = e.message;
      status.style.color = "var(--bad)";
    }
  };

  const kind = el("select", { class: "selrow" },
    el("option", { value: "both" }, "Extend + 2K refine"),
    el("option", { value: "extend" }, "Extend only"),
    el("option", { value: "refine" }, "2K refine only"));
  const target = el("input", { type: "number", value: "120", min: "10", max: "7200", step: "1" });
  const visible = el("input", { type: "number", value: "10", min: "2", max: "12", step: "1" });
  const steps = el("input", { type: "number", value: "8", min: "1", max: "50", step: "1" });
  const prompt = el("textarea", { placeholder: "Story / continuation prompt. Use <Picture 1>, <Video 1>, <Audio 1> tags for references.", rows: "4" });
  const source = el("input", { type: "file", accept: "video/mp4,video/quicktime,video/webm" });
  const images = el("input", { type: "file", accept: "image/png,image/jpeg,image/webp", multiple: "" });
  const videos = el("input", { type: "file", accept: "video/mp4,video/quicktime,video/webm", multiple: "" });
  const audios = el("input", { type: "file", accept: "audio/wav,audio/mpeg,audio/mp4", multiple: "" });
  const submit = el("button", { class: "generate", type: "submit" }, icon("send"), "Create project");

  const form = el("form", { class: "card", style: { display: "grid", gap: "12px" }, onsubmit: async (event) => {
    event.preventDefault();
    const file = source.files?.[0];
    if (!file) { toast("Choose a source video first", { error: true }); return; }
    submit.disabled = true;
    const original = submit.textContent;
    submit.textContent = "Creating…";
    status.textContent = "Creating project and streaming the source…";
    status.style.color = "var(--dim)";
    try {
      const project = await api("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: kind.value, targetSeconds: Number(target.value), prompt: prompt.value,
          visibleSeconds: Number(visible.value), steps: Number(steps.value), targetResolution: "2k",
        }),
      });
      await upload(`/api/projects/${project.id}/source?name=${encodeURIComponent(file.name)}`, file);
      for (const [kindName, input] of [["image", images], ["video", videos], ["audio", audios]]) {
        for (const f of input.files || []) {
          await upload(`/api/projects/${project.id}/references?kind=${kindName}&name=${encodeURIComponent(f.name)}`, f);
        }
      }
      await api(`/api/projects/${project.id}/start`, { method: "POST" });
      status.textContent = "Project started. It will continue in the background.";
      await refresh();
    } catch (e) {
      status.textContent = e.message;
      status.style.color = "var(--bad)";
    } finally {
      submit.disabled = false;
      submit.textContent = original;
    }
  } },
    el("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: "10px" } },
      el("label", { class: "field" }, el("span", { class: "lbl" }, "Pipeline"), kind),
      el("label", { class: "field" }, el("span", { class: "lbl" }, "Target seconds"), target),
      el("label", { class: "field" }, el("span", { class: "lbl" }, "Visible seconds/segment"), visible),
      el("label", { class: "field" }, el("span", { class: "lbl" }, "Steps"), steps)),
    el("label", { class: "field" }, el("span", { class: "lbl" }, "Source video"), source,
      el("small", { class: "help" }, "Existing 15 s+ clip, or the 768p master for refine-only.")),
    el("label", { class: "field" }, el("span", { class: "lbl" }, "Prompt"), prompt),
    el("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: "10px" } },
      el("label", { class: "field" }, el("span", { class: "lbl" }, "Images"), images),
      el("label", { class: "field" }, el("span", { class: "lbl" }, "Videos"), videos),
      el("label", { class: "field" }, el("span", { class: "lbl" }, "Audio"), audios)),
    submit,
    status);

  const node = el("div", { class: "page" },
    el("header", { class: "apps-head" },
      el("span", { class: "ic" }, icon("film")),
      el("h1", { class: "display" }, "Long-form ", el("em", {}, "projects")),
      el("p", {}, "Automatic H3 extension and 2K refinement. The orchestrator keeps every segment, retries failed ones and assembles the final MP4; no manual stitching.")),
    form,
    el("div", { class: "sec-head" }, el("h2", { class: "display" }, "Projects"),
      el("button", { class: "btn ghost small", type: "button", onclick: refresh }, icon("redo"), "Refresh")),
    list,
    el("p", { class: "help" }, "This page is the Freefield project surface: project history, progress, segment previews and final output. GPU requests are queued by the server, not the browser."));

  refresh();
  timer = setInterval(() => {
    if (disposed) return;
    if (projects.some((p) => ACTIVE.has(p.status))) refresh();
  }, 3000);
  return { node, active: "projects", dispose: () => { disposed = true; clearInterval(timer); } };
}
