// Long-video preparation: every cut limit comes from capability documents.
import { api, el, icon, toast } from "./util.js";
import { sideResizer } from "./workspace.js";

function seconds(value) {
  return value === null || value === undefined ? "unknown" : `${Number(value).toFixed(3)} s`;
}

function metaRow(label, value) {
  return el("div", { class: "prep-meta-row" }, el("span", {}, label), el("b", {}, value));
}

export function prepView() {
  const status = el("p", { class: "prep-status" });
  const sourceMeta = el("div", { class: "prep-source-meta" });
  const resultBox = el("div", { class: "prep-result" });
  const capsHost = el("div", { class: "prep-caps" });
  const fields = el("div", { class: "prep-fields" });
  const mode = { value: "enhance" };
  const source = { value: null };
  const prep = { value: null };
  const gpu = { value: null };
  let disposed = false;

  const sourceInput = el("input", { type: "file", accept: "video/*", hidden: "" });
  const sourceButton = el("button", { class: "prep-source-card", type: "button", onclick: () => sourceInput.click() },
    el("span", { class: "prep-source-ic" }, icon("film")),
    el("span", { class: "prep-source-copy" },
      el("b", {}, "Load a video"),
      el("small", {}, "Drop or choose a source · metadata is read server-side")));

  const context = el("input", { type: "number", placeholder: "frames" });
  const visible = el("input", { type: "number", placeholder: "frames (optional)" });
  const target = el("input", { type: "number", placeholder: "frames (optional)" });
  const planButton = el("button", { class: "btn lime prep-plan-btn", type: "button", onclick: () => drawPlan(true) },
    icon("check"), "Validate plan");
  const modeButtons = ["enhance", "extend"].map((id) => {
    const b = el("button", { type: "button", "aria-pressed": String(mode.value === id), onclick: () => {
      mode.value = id;
      modeButtons.forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      drawFields();
      drawPlan();
    } }, icon(id === "enhance" ? "spark" : "sliders"), id === "enhance" ? "Enhance" : "Extend");
    return b;
  });

  function drawFields() {
    fields.replaceChildren(...[
      mode.value === "enhance"
        ? el("div", { class: "prep-mode-note" }, icon("scissors"),
          el("p", {}, "Exports every valid enhancement window. Window size, overlap, and source coverage come from the capability document."))
        : null,
      mode.value === "extend"
        ? el("label", { class: "field" }, el("span", { class: "lbl" }, "Motion context"),
          context,
          el("p", { class: "help" }, "Required. Use the context range from the capability panel."))
        : null,
      mode.value === "extend"
        ? el("div", { class: "prep-field-pair" },
          el("label", { class: "field" }, el("span", { class: "lbl" }, "Visible"), visible),
          el("label", { class: "field" }, el("span", { class: "lbl" }, "Target"), target))
        : null,
    ].filter(Boolean));
  }
  drawFields();

  function capabilityRows() {
    const rows = [];
    if (gpu.value) {
      rows.push(metaRow("GPU output", `${gpu.value.max_seconds ?? "unknown"} s`));
      if (gpu.value.reference_clip_seconds) rows.push(metaRow("Reference clip", `${gpu.value.reference_clip_seconds[0]}–${gpu.value.reference_clip_seconds[1]} s`));
      if (gpu.value.reference_total_seconds) {
        rows.push(metaRow("Reference total", `video ${gpu.value.reference_total_seconds.video} s · audio ${gpu.value.reference_total_seconds.audio} s`));
      }
    }
    if (prep.value?.available) {
      if (prep.value.enhance) {
        rows.push(metaRow("Enhance window", `${prep.value.enhance.windowFrames} frames`));
        rows.push(metaRow("Window overlap", `${prep.value.enhance.overlapFrames} frames`));
        rows.push(metaRow("Minimum source", `${prep.value.enhance.minSourceFrames} frames`));
      }
      if (prep.value.extend) {
        rows.push(metaRow("Extend context", `${prep.value.extend.contextFrames.min}–${prep.value.extend.contextFrames.max} frames`));
        rows.push(metaRow("Extend request", `${prep.value.extend.requestFrames.min}–${prep.value.extend.requestFrames.max} frames`));
      }
    }
    return rows;
  }

  function applyCapabilities() {
    if (!prep.value?.available) { planButton.disabled = true; drawCapabilities(); return; }
    if (prep.value.extend) {
      context.min = String(prep.value.extend.contextFrames.min);
      context.max = String(prep.value.extend.contextFrames.max);
    }
    planButton.disabled = false;
    drawCapabilities();
    if (source.value) drawPlan();
  }

  function loadCapabilityButton() {
    const input = el("input", { type: "file", accept: "application/json,.json", hidden: "" });
    const button = el("button", { class: "btn ghost small", type: "button", onclick: () => input.click() }, icon("upload"), "Load capability document");
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      status.textContent = "Loading capability document…";
      status.className = "prep-status";
      try {
        const text = await file.text();
        JSON.parse(text);
        const res = await fetch("/api/prep/capabilities", { method: "POST", headers: { "content-type": "application/json" }, body: text });
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(body?.error || `${res.status} ${res.statusText}`);
        prep.value = body;
        applyCapabilities();
        status.textContent = body.available ? "Capability document loaded." : `Capability rejected: ${body.reason}`;
        status.className = `prep-status${body.available ? "" : " err"}`;
      } catch (error) {
        status.textContent = error.message;
        status.className = "prep-status err";
      }
    });
    return el("div", { class: "prep-load" }, button, input);
  }

  function drawCapabilities() {
    const content = [];
    const gpuState = gpu.value ? (gpu.value.available ? "live profile" : gpu.value.source === "official" ? "official fallback" : "unavailable") : "loading";
    content.push(el("div", { class: "prep-cap-head" },
      el("span", { class: "proj-kicker" }, "CAPACITY"),
      el("span", { class: `tag ${gpu.value?.available ? "" : "dark"}` }, gpuState)));
    content.push(...capabilityRows());
    if (prep.value && !prep.value.available) {
      content.push(el("div", { class: "prep-alert" },
        el("b", {}, "Prep unavailable"),
        el("p", {}, prep.value.reason),
        prep.value.missing?.length ? el("code", {}, prep.value.missing.join(", ")) : null));
      content.push(loadCapabilityButton());
      content.push(el("p", { class: "prep-help" }, "Or configure FREEFIELD_PREP_CAPABILITIES_FILE / FREEFIELD_PREP_CAPABILITIES."));
    }
    if (!prep.value) content.push(el("p", { class: "prep-help" }, "Reading capability document…"));
    capsHost.replaceChildren(...content);
  }

  async function drawPlan(validate = false) {
    resultBox.replaceChildren();
    if (!source.value) {
      resultBox.append(el("div", { class: "prep-empty" }, icon("scissors"),
        el("b", {}, "No source loaded"),
        el("p", {}, "Load a video to see valid enhancement windows or an extension tail.")));
      return;
    }
    if (!prep.value?.available) {
      resultBox.append(el("div", { class: "prep-empty" },
        el("b", {}, "Preparation is gated"),
        el("p", {}, "A complete capability document is required before cuts can be planned.")));
      return;
    }
    if (mode.value === "enhance" && !prep.value.enhance) {
      resultBox.append(el("div", { class: "prep-empty" }, el("b", {}, "Enhance is unavailable"), el("p", {}, "The capability document does not declare an enhancement window.")));
      return;
    }
    if (mode.value === "extend" && !prep.value.extend) {
      resultBox.append(el("div", { class: "prep-empty" }, el("b", {}, "Extend is unavailable"), el("p", {}, "The capability document does not declare an extension contract.")));
      return;
    }
    try {
      const body = { sourceId: source.value.id, mode: mode.value };
      if (mode.value === "extend") {
        if (!context.value) throw new Error("Motion context is required");
        body.contextFrames = Number(context.value);
        if (target.value) body.targetFrames = Number(target.value);
        if (visible.value) body.visibleFrames = Number(visible.value);
      }
      const plan = await api("/api/prep/plan", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      const title = mode.value === "enhance" ? `${plan.length} windows` : "Extension tail";
      const rows = mode.value === "enhance"
        ? plan.map((w) => el("div", { class: "prep-plan-row" },
          el("span", { class: "prep-plan-index" }, String(w.index + 1).padStart(2, "0")),
          el("b", {}, `${w.startFrame} → ${w.endFrame}`),
          el("small", {}, `${w.frames} frames · overlap ${w.overlapBefore}/${w.overlapAfter}`)))
        : [
          el("div", { class: "prep-plan-row" },
            el("span", { class: "prep-plan-index" }, "TAIL"),
            el("b", {}, `${plan.tail.startFrame} → ${plan.tail.endFrame}`),
            el("small", {}, `${plan.tail.frames} frames`)),
          ...(plan.segments || []).map((s) => el("div", { class: "prep-plan-row" },
            el("span", { class: "prep-plan-index" }, String(s.index + 1).padStart(2, "0")),
            el("b", {}, `${s.startFrame} → ${s.endFrame}`),
            el("small", {}, `visible ${s.visibleFrames} · request ${s.requestFrames} frames`))),
        ];
      const exportButton = el("button", { class: "btn lime", type: "button", onclick: async () => {
        status.textContent = "Exporting…";
        status.className = "prep-status";
        try {
          const out = await api("/api/prep/export", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
          resultBox.append(el("div", { class: "prep-exports" }, ...out.files.map((file) =>
            el("a", { href: file.url, target: "_blank", rel: "noreferrer" }, icon("download"), file.name))));
          status.textContent = "Export ready.";
          toast("Export ready");
        } catch (error) {
          status.textContent = error.message;
          status.className = "prep-status err";
        }
      } }, icon("download"), "Export");
      resultBox.append(
        el("div", { class: "prep-plan-head" }, el("div", {}, el("span", { class: "proj-kicker" }, "PLAN"), el("h3", { class: "display" }, title)), exportButton),
        el("div", { class: "prep-plan" }, ...rows));
      if (validate) status.textContent = "Plan valid.";
      status.className = "prep-status";
    } catch (error) {
      status.textContent = error.message;
      status.className = "prep-status err";
    }
  }

  sourceInput.addEventListener("change", async () => {
    const file = sourceInput.files?.[0];
    if (!file) return;
    status.textContent = "Analyzing source…";
    status.className = "prep-status";
    try {
      const res = await fetch(`/api/prep/analyze?name=${encodeURIComponent(file.name)}`, { method: "POST", body: file });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error || `${res.status} ${res.statusText}`);
      source.value = body;
      const probe = body.probe || {};
      sourceMeta.replaceChildren(
        metaRow("Duration", seconds(probe.duration)),
        metaRow("Frames", probe.frames ?? "unknown"),
        metaRow("Frame rate", probe.fps ?? "unknown"),
        metaRow("Size", probe.width && probe.height ? `${probe.width}×${probe.height}` : "unknown"),
        metaRow("Audio", probe.hasAudio ? (probe.audioCodec || "present") : "none"),
        metaRow("VFR", probe.variableFrameRate === null ? "unknown" : probe.variableFrameRate ? "yes" : "no"));
      sourceButton.classList.add("loaded");
      sourceButton.querySelector("b").textContent = file.name;
      sourceButton.querySelector("small").textContent = "Replace source";
      status.textContent = "Source ready.";
      await drawPlan();
    } catch (error) {
      status.textContent = error.message;
      status.className = "prep-status err";
    }
  });

  Promise.all([
    api("/api/prep/capabilities").then((value) => { prep.value = value; }),
    api("/api/h3/capabilities").then((value) => { gpu.value = value; }).catch(() => {}),
  ]).then(() => {
    if (disposed) return;
    if (prep.value?.available) {
      if (prep.value.extend) {
        context.min = String(prep.value.extend.contextFrames.min);
        context.max = String(prep.value.extend.contextFrames.max);
      }
      planButton.disabled = false;
    } else {
      planButton.disabled = true;
    }
    drawCapabilities();
    drawPlan();
  }).catch((error) => {
    status.textContent = error.message;
    status.className = "prep-status err";
    planButton.disabled = true;
  });
  planButton.disabled = true;
  drawCapabilities();

  const side = el("aside", { class: "side prep-side" },
    el("div", { class: "side-scroll prep-side-scroll" },
      el("section", { class: "prep-card" },
        el("div", { class: "prep-cap-head" }, el("span", { class: "proj-kicker" }, "SOURCE"), el("span", { class: "tag ghost" }, "01")),
        sourceButton, sourceInput, sourceMeta),
      el("section", { class: "prep-card" },
        el("div", { class: "prep-cap-head" }, el("span", { class: "proj-kicker" }, "MODE"), el("span", { class: "tag ghost" }, "02")),
        el("div", { class: "seg modes prep-mode-seg" }, ...modeButtons),
        fields),
      el("section", { class: "prep-card prep-cap-card" }, capsHost)),
    el("div", { class: "side-foot prep-side-foot" }, planButton, status));
  side.append(sideResizer(side));
  const node = el("div", { class: "ws l-sidebar prep-ws" },
    side,
    el("div", { class: "ws-main prep-main-col" },
      el("header", { class: "prep-head" },
        el("span", { class: "proj-kicker" }, "H3 / PREP"),
        el("h1", { class: "display" }, "Long video ", el("em", {}, "prep")),
        el("p", {}, "Cut arbitrary-length video into valid H3 enhancement windows or a single extension tail. Limits come from the active capability document.")),
      el("main", { class: "prep-main" },
        el("div", { class: "prep-main-head" },
          el("div", {}, el("span", { class: "proj-kicker" }, "WORKBENCH"), el("h2", { class: "display" }, "Plan")),
          el("span", { class: "tag dark" }, "FRAME ACCURATE")),
        resultBox)));

  return { node, active: "video", dispose: () => { disposed = true; } };
}


