// Long-video preparation app: reads every limit from capability documents.
import { api, el, icon, toast } from "./util.js";

function fmtDuration(seconds) {
  if (seconds === null || seconds === undefined) return "unknown";
  const value = Math.max(0, Number(seconds));
  return `${value.toFixed(3)} s`;
}

function capabilityLine(name, caps) {
  if (!caps) return el("p", { class: "prep-warning" }, `${name}: unavailable`);
  if (caps.available === false && caps.source !== "official") return el("p", { class: "prep-warning" }, `${name}: unavailable`);
  if (caps.available === false) return el("p", { class: "prep-warning" }, `${name}: official fallback`);
  return el("p", { class: "prep-capability" },
    `${name}: ${caps.authority || caps.source || "configured"}`,
    caps.profile ? ` · profile ${caps.profile}` : "");
}

function missingList(result) {
  return result?.missing?.length
    ? el("p", { class: "prep-warning" }, `Missing: ${result.missing.join(", ")}`)
    : null;
}

export function prepView() {
  const status = el("p", { class: "proj-form-status" });
  const sourceMeta = el("div", { class: "prep-meta" });
  const resultBox = el("div", { class: "prep-result" });
  const mode = { value: "enhance" };
  const source = { value: null };
  const prep = { value: null };
  const gpu = { value: null };
  let disposed = false;

  const sourceInput = el("input", { type: "file", accept: "video/*", hidden: "" });
  const sourceButton = el("button", { class: "btn small lime", type: "button", onclick: () => sourceInput.click() }, icon("upload"), "Load video");
  sourceInput.addEventListener("change", async () => {
    const file = sourceInput.files?.[0];
    if (!file) return;
    status.textContent = "Analyzing source…";
    status.className = "proj-form-status";
    try {
      const res = await fetch(`/api/prep/analyze?name=${encodeURIComponent(file.name)}`, { method: "POST", body: file });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error || `${res.status} ${res.statusText}`);
      source.value = body;
      sourceMeta.replaceChildren(
        el("b", {}, body.name),
        el("span", {}, `Duration ${fmtDuration(body.probe?.duration)}`),
        el("span", {}, `Frames ${body.probe?.frames ?? "unknown"}`),
        el("span", {}, `FPS ${body.probe?.fps ?? "unknown"}`),
        el("span", {}, `Size ${body.probe?.width ?? "?"}×${body.probe?.height ?? "?"}`),
        el("span", {}, `Audio ${body.probe?.hasAudio ? body.probe.audioCodec || "present" : "none"}`),
        el("span", {}, `VFR ${body.probe?.variableFrameRate === null ? "unknown" : body.probe.variableFrameRate ? "yes" : "no"}`)
      );
      status.textContent = "Source ready.";
      drawPlan();
    } catch (error) {
      status.textContent = error.message;
      status.className = "proj-form-status err";
    }
  });

  const context = el("input", { type: "number", placeholder: "context frames" });
  const visible = el("input", { type: "number", placeholder: "visible frames (optional)" });
  const target = el("input", { type: "number", placeholder: "target frames (optional)" });
  const planButton = el("button", { class: "btn small lime", type: "button", onclick: () => drawPlan(true) }, "Validate plan");

  const modeButtons = ["enhance", "extend"].map((id) => {
    const b = el("button", { class: "btn small ghost", type: "button", "aria-pressed": String(mode.value === id), onclick: () => {
      mode.value = id;
      modeButtons.forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      drawFields();
      drawPlan();
    } }, id === "enhance" ? "Enhance windows" : "Extend tail");
    return b;
  });

  const fields = el("div", { class: "prep-fields" });
  function drawFields() {
    fields.replaceChildren(...[
      mode.value === "extend" ? el("label", { class: "field" }, el("span", { class: "lbl" }, "Context frames"), context,
        el("small", {}, "Required; use the range shown in capabilities.")) : null,
      mode.value === "extend" ? el("label", { class: "field" }, el("span", { class: "lbl" }, "Visible frames"), visible) : null,
      mode.value === "extend" ? el("label", { class: "field" }, el("span", { class: "lbl" }, "Target frames"), target) : null,
      planButton,
    ].filter(Boolean));
  }
  drawFields();

  const drawCapabilities = () => {
    const items = [
      capabilityLine("GPU/output", gpu.value),
      capabilityLine("Prep", prep.value),
    ];
    if (prep.value && !prep.value.available) {
      items.push(el("p", { class: "prep-warning" }, `Prep unavailable: ${prep.value.reason}`));
      items.push(missingList(prep.value));
    }
    if (gpu.value) {
      items.push(el("p", { class: "prep-meta" },
        `Output ${gpu.value.max_seconds ?? "unknown"} s`,
        gpu.value.reference_clip_seconds ? ` · reference clips ${gpu.value.reference_clip_seconds[0]}–${gpu.value.reference_clip_seconds[1]} s` : "",
        gpu.value.reference_total_seconds ? ` · video ${gpu.value.reference_total_seconds.video} s · audio ${gpu.value.reference_total_seconds.audio} s` : ""));
    }
    if (prep.value?.available) {
      if (prep.value.enhance) items.push(el("p", { class: "prep-meta" }, `Enhance window ${prep.value.enhance.windowFrames} frames · overlap ${prep.value.enhance.overlapFrames} · minimum source ${prep.value.enhance.minSourceFrames}`));
      if (prep.value.extend) items.push(el("p", { class: "prep-meta" }, `Extend context ${prep.value.extend.contextFrames.min}–${prep.value.extend.contextFrames.max} · request ${prep.value.extend.requestFrames.min}–${prep.value.extend.requestFrames.max} frames`));
    }
    return el("div", { class: "prep-caps" }, ...items);
  };

  const drawPlan = async (validate = false) => {
    resultBox.replaceChildren();
    if (!source.value) return;
    if (!prep.value?.available) {
      resultBox.replaceChildren(el("p", { class: "prep-warning" }, "Prep capabilities are unavailable; export is disabled."));
      return;
    }
    if (mode.value === "enhance" && !prep.value.enhance) {
      resultBox.replaceChildren(el("p", { class: "prep-warning" }, "Enhance is unavailable in this capability document."));
      return;
    }
    if (mode.value === "extend" && !prep.value.extend) {
      resultBox.replaceChildren(el("p", { class: "prep-warning" }, "Extend is unavailable in this capability document."));
      return;
    }
    try {
      const body = { sourceId: source.value.id, mode: mode.value };
      if (mode.value === "extend") {
        if (!context.value) throw new Error("context frames are required");
        body.contextFrames = Number(context.value);
        if (target.value) body.targetFrames = Number(target.value);
        if (visible.value) body.visibleFrames = Number(visible.value);
      }
      const plan = await api("/api/prep/plan", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      const rows = mode.value === "enhance"
        ? plan.map((w) => el("div", { class: "prep-row" }, `Window ${w.index} · frames ${w.startFrame}–${w.endFrame} · ${w.frames} · overlap ${w.overlapBefore}/${w.overlapAfter}`))
        : [
          el("div", { class: "prep-row" }, `Tail · frames ${plan.tail.startFrame}–${plan.tail.endFrame} · ${plan.tail.frames}`),
          ...(plan.segments || []).map((s) => el("div", { class: "prep-row" }, `Segment ${s.index} · ${s.startFrame}–${s.endFrame} · visible ${s.visibleFrames} · request ${s.requestFrames}`)),
        ];
      const exportButton = el("button", { class: "btn small lime", type: "button", onclick: async () => {
        status.textContent = "Exporting…";
        try {
          const out = await api("/api/prep/export", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
          resultBox.append(el("div", { class: "prep-exports" },
            ...out.files.map((file) => el("a", { href: file.url, target: "_blank", rel: "noreferrer" }, icon("download"), file.name))));
          toast("Export ready");
          status.textContent = "Export ready.";
        } catch (error) {
          status.textContent = error.message;
          status.className = "proj-form-status err";
        }
      } }, icon("download"), "Export");
      resultBox.replaceChildren(...rows, exportButton);
      if (validate) status.textContent = "Plan valid.";
    } catch (error) {
      status.textContent = error.message;
      status.className = "proj-form-status err";
    }
  };

  prep.value = null;
  Promise.all([
    api("/api/prep/capabilities").then((value) => { prep.value = value; }),
    api("/api/h3/capabilities").then((value) => { gpu.value = value; }).catch(() => {}),
  ]).then(() => { if (!disposed) caps.replaceWith(drawCapabilities()); }).catch(() => {});
  const caps = drawCapabilities();

  const node = el("div", { class: "page" },
    el("div", { class: "sec-head", style: { marginTop: "6px" } },
      el("div", {}, el("h2", { class: "display", style: { fontSize: "34px" } }, "H3 Long Video Prep"),
        el("p", {}, "Prepare arbitrary-length video for H3 enhancement windows or extension tails."))),
    caps,
    el("div", { class: "prep-panel" },
      el("div", { class: "prep-source" }, sourceButton, sourceInput, sourceMeta),
      el("div", { class: "seg prep-modes", role: "group" }, ...modeButtons),
      fields,
      status,
      resultBox));

  return { node, active: "video", dispose: () => { disposed = true; } };
}




