// Long-video preparation: limits come from the active prep capability profile.
import { api, el, icon, toast } from "./util.js";
import { frameStepper, sideResizer } from "./workspace.js";

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
  const exportBox = el("div", { class: "prep-export-results" });
  const exportCount = el("b", {}, "0 clips");
  const exportToggle = el("button", { class: "btn ghost small", type: "button", onclick: () => {
    const collapsed = exportTray.classList.toggle("collapsed");
    exportToggle.textContent = collapsed ? "Show" : "Hide";
  } }, "Hide");
  const exportTray = el("section", { class: "prep-export-tray", hidden: true },
    el("div", { class: "prep-export-tray-head" },
      el("div", { class: "prep-export-tray-title" }, el("span", { class: "proj-kicker" }, "EXPORTS"), exportCount),
      exportToggle),
    exportBox);
  const refreshExportTray = () => {
    const count = exportBox.querySelectorAll("a").length;
    exportCount.textContent = `${count} ${count === 1 ? "clip" : "clips"}`;
    exportTray.hidden = count === 0;
  };
  const selected = new Set();
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
  const contextSeconds = el("small", { class: "frame-seconds" });
  const syncFrameSeconds = () => {
    const fps = Number(source.value?.probe?.fps ?? prep.value?.source?.fps);
    const contextFrames = Number(context.value);
    contextSeconds.textContent = Number.isFinite(fps) && fps > 0 && Number.isFinite(contextFrames) && contextFrames > 0
      ? `${(contextFrames / fps).toFixed(3)} s`
      : "";
  };
  context.addEventListener("input", syncFrameSeconds);
  const planButton = el("button", { class: "btn lime prep-plan-btn", type: "button", onclick: () => drawPlan(true) },
    icon("check"), "Validate plan");
  const modeButtons = ["enhance", "extend"].map((id) => {
    const b = el("button", { type: "button", "aria-pressed": String(mode.value === id), onclick: () => {
      mode.value = id;
      selected.clear();
      modeButtons.forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      drawFields();
      drawPlan();
    } }, icon(id === "enhance" ? "spark" : "sliders"), id === "enhance" ? "Enhance" : "Extend");
    return b;
  });

  function drawFields() {
    const extendRange = prep.value?.extend
      ? `Allowed context: ${prep.value.extend.contextFrames.min}–${prep.value.extend.contextFrames.max} frames.`
      : "Load a capability document to see the allowed context range.";
    fields.replaceChildren(...[
      mode.value === "enhance"
        ? el("div", { class: "prep-mode-intro" },
          el("span", { class: "prep-mode-ic" }, icon("scissors")),
          el("div", {},
            el("b", {}, "Export enhancement windows"),
            el("p", {}, "Splits the source into enhancement windows for H3 Regenerate 2K IC. Window size, overlap, source coverage, fps, and audio rules come from the capability document. ", el("a", { class: "more", href: "#/app/h3-regenerate-2k-ic" }, "Open H3 Regenerate 2K IC", icon("chevR")))))
        : el("div", { class: "prep-mode-intro" },
          el("span", { class: "prep-mode-ic" }, icon("sliders")),
          el("div", {},
            el("b", {}, "Export a motion tail"),
            el("p", {}, "Exports only the final tail for H3 Extend. Prompt, references, and generation settings stay in the H3 Extend app. ", el("a", { class: "more", href: "#/app/h3-extend-sglang" }, "Open H3 Extend", icon("chevR"))))),
      mode.value === "extend"
        ? el("div", { class: "field" }, el("span", { class: "lbl" }, "Motion context", el("small", {}, "required")),
          frameStepper(context, { readout: contextSeconds }),
          el("p", { class: "help" }, extendRange))
        : null,
      mode.value === "extend"
        ? el("p", { class: "prep-help" }, "This exports one tail clip. H3 Extend generates the continuation and handles the chain.")
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
      rows.push(metaRow("Authority", prep.value.authority));
      rows.push(metaRow("Source fps", prep.value.source.fps === null ? "source probe" : `${prep.value.source.fps} fps`));
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
    syncFrameSeconds();
    drawFields();
    drawCapabilities();
    if (source.value) drawPlan();
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
      content.push(el("p", { class: "prep-help" }, "This server has no valid prep profile. An operator must fix its startup configuration; there is nothing for a viewer to upload."));
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
        el("p", {}, "The active server prep profile is unavailable, so cuts cannot be planned.")));
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
      }
      const plan = await api("/api/prep/plan", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      const isEnhance = mode.value === "enhance";
      const title = isEnhance ? `${plan.length} windows` : "Extension tail";
      const validIndexes = new Set(isEnhance ? plan.map((window) => window.index) : []);
      for (const index of [...selected]) if (!validIndexes.has(index)) selected.delete(index);
      const rowChecks = new Map();
      let exportButton = null;
      let selectAll = null;
      const syncSelection = () => {
        if (!isEnhance) {
          if (exportButton) {
            exportButton.disabled = false;
            exportButton.replaceChildren(icon("download"), "Export tail");
          }
          return;
        }
        if (selectAll) {
          selectAll.checked = plan.length > 0 && selected.size === plan.length;
          selectAll.indeterminate = selected.size > 0 && selected.size < plan.length;
        }
        if (!exportButton) return;
        const count = selected.size;
        exportButton.disabled = count === 0 || Boolean(exportButton.dataset.busy);
        exportButton.replaceChildren(icon("download"), count ? `Export selected (${count})` : "Select windows to export");
      };
      const appendExports = (out, label, detail) => {
        for (const file of out.files) {
          exportBox.append(el("a", { class: "prep-export-item", href: file.url, target: "_blank", rel: "noreferrer", title: file.name },
            el("span", { class: "prep-export-copy" },
              el("span", { class: "prep-export-top" }, el("b", {}, label), el("small", {}, detail)),
              el("span", { class: "prep-export-name" }, file.name)),
            icon("download")));
        }
        refreshExportTray();
      };
      const rows = isEnhance
        ? plan.map((w) => {
          const check = el("input", { type: "checkbox", class: "prep-check", checked: selected.has(w.index), "aria-label": `Select window ${w.index + 1}` });
          check.addEventListener("change", () => {
            if (check.checked) selected.add(w.index); else selected.delete(w.index);
            syncSelection();
          });
          rowChecks.set(w.index, check);
          return el("div", { class: "prep-plan-row" },
            check,
            el("span", { class: "prep-plan-index" }, String(w.index + 1).padStart(2, "0")),
            el("b", {}, `${w.startFrame} → ${w.endFrame}`),
            el("small", {}, `${w.frames} frames · overlap ${w.overlapBefore}/${w.overlapAfter}`));
        })
        : [
          el("div", { class: "prep-plan-row" },
            el("span", { class: "prep-plan-index" }, "TAIL"),
            el("b", {}, `${plan.tail.startFrame} → ${plan.tail.endFrame}`),
            el("small", {}, `${plan.tail.frames} frames`)),
        ];
      exportButton = el("button", { class: "btn lime", type: "button", onclick: async () => {
        if (isEnhance && !selected.size) return;
        exportBox.replaceChildren();
        exportButton.dataset.busy = "1";
        exportButton.disabled = true;
        const indexes = isEnhance ? [...selected].sort((a, b) => a - b) : [null];
        try {
          for (let position = 0; position < indexes.length; position++) {
            const index = indexes[position];
            exportButton.replaceChildren(icon("download"), `Exporting ${position + 1} / ${indexes.length}`);
            status.textContent = isEnhance
              ? `Exporting window ${index + 1} (${position + 1} / ${indexes.length})…`
              : "Exporting tail…";
            status.className = "prep-status";
            const payload = { ...body };
            if (index !== null) payload.windowIndices = [index];
            const out = await api("/api/prep/export", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
            const itemPlan = index === null ? plan.tail : plan.find((window) => window.index === index);
            appendExports(out, index === null ? "Tail" : `Window ${String(index + 1).padStart(2, "0")}`, `${itemPlan.startFrame} → ${itemPlan.endFrame} frames`);
            status.textContent = isEnhance
              ? `Exported ${position + 1} / ${indexes.length}.`
              : "Export ready.";
          }
          toast("Export ready");
        } catch (error) {
          status.textContent = error.message;
          status.className = "prep-status err";
        } finally {
          delete exportButton.dataset.busy;
          syncSelection();
        }
      } }, icon("download"), isEnhance ? "Select windows to export" : "Export tail");
      if (isEnhance) {
        selectAll = el("input", { type: "checkbox", class: "prep-check", "aria-label": "Select all windows" });
        selectAll.addEventListener("change", () => {
          selected.clear();
          if (selectAll.checked) for (const window of plan) selected.add(window.index);
          for (const [index, check] of rowChecks) check.checked = selected.has(index);
          syncSelection();
        });
      }
      syncSelection();
      resultBox.append(
        el("div", { class: "prep-plan-head" },
          el("div", {}, el("span", { class: "proj-kicker" }, "PLAN"), el("h3", { class: "display" }, title)),
          el("div", { class: "prep-plan-controls" },
            selectAll ? el("label", { class: "prep-select-all" }, selectAll, el("span", {}, "All")) : null,
            exportButton)),
        el("div", { class: "prep-plan" }, ...rows));
      if (validate) status.textContent = "Plan valid.";
      status.className = "prep-status";
    } catch (error) {
      status.textContent = error.message;
      status.className = "prep-status err";
    }
  }

  const acceptSourceFiles = (files) => {
    const file = files?.[0];
    if (!file) return;
    if (!file.type.startsWith("video/") && !/\.(mp4|mov|mkv|webm|m4v|avi)$/i.test(file.name)) {
      status.textContent = "Drop a video file to prepare.";
      status.className = "prep-status err";
      return;
    }
    const transfer = new DataTransfer();
    transfer.items.add(file);
    sourceInput.files = transfer.files;
    sourceInput.dispatchEvent(new Event("change", { bubbles: true }));
  };
  sourceButton.addEventListener("dragover", (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    sourceButton.classList.add("over");
  });
  sourceButton.addEventListener("dragleave", () => sourceButton.classList.remove("over"));
  sourceButton.addEventListener("drop", (event) => {
    event.preventDefault();
    event.stopPropagation();
    sourceButton.classList.remove("over");
    acceptSourceFiles(event.dataTransfer.files);
  });
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
      selected.clear();
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
      syncFrameSeconds();
      drawFields();
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
    drawFields();
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
        exportTray,
        resultBox)));

  return { node, active: "video", dispose: () => { disposed = true; } };
}

























