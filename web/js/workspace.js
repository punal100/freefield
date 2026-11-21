// An app's workspace. Two layouts, both built from app.json alone:
//   composer: prompt-first apps (image, audio): results fill the page, a floating prompt bar sits at the bottom
//   sidebar:  upload-first apps (video, tools): controls in a left column, results and examples on the right
import { el, icon, store, toast, popover, closePopover, fmtSeconds, fmtShort, isMedia, extOf, masonry } from "./util.js";
import { t } from "./i18n.js";
import {
  byId, layoutOf, familyOf, VIDEO_TABS, videoTabOf, tagline, iconOf, promptInput, estimate, fitOf, rememberApp, categoryOf, CATEGORIES, apps,
} from "./catalog.js";
import { exampleItem, thumb, hoverPlay, fullMedia, playWhenVisible, optionTile, optionThumb } from "./media.js";
import { flags, flagButton } from "./flags.js";
import { feed, feedView, hooks } from "./feed.js";
import { openPainter, maskPreview } from "./paint.js";
import { h3Caps, h3CapsLoaded, h3CapsSync, h3CapacityText, h3DurationMax } from "./h3caps.js";

// ------------------------------------------------------------------ form state (per app, kept while the page is open)
const forms = new Map();

/** A multiple select's value from older saves or examples, where it was one string. */
function asPicks(inp, v) {
  return inp.multiple && !Array.isArray(v) && v !== undefined && v !== null ? (v === "" ? [] : [v]) : v;
}

function validValue(inp, v) {
  if (v === undefined || v === null) return false;
  if (inp.multiple) return Array.isArray(v) && v.length <= (inp.multiple.max ?? Infinity) && v.every((x) => (inp.options || []).some((o) => String(o.value) === String(x)));
  if (inp.type === "select") return (inp.options || []).some((o) => String(o.value) === String(v));
  if (inp.type === "slider" || inp.type === "number") return Number.isFinite(Number(v)) && (inp.min === undefined || v >= inp.min) && (inp.max === undefined || v <= inp.max);
  return true;
}

export function formFor(app) {
  let f = forms.get(app.id);
  if (f) return f;
  const saved = store.get(`values.${app.id}`) || {};
  const values = {};
  for (const inp of app.inputs) {
    if (isMedia(inp.type)) continue;
    const fallback = inp.type === "textarea" || inp.type === "text" ? "" : inp.type === "seed" ? -1 : inp.multiple ? [...(inp.default ?? [])] : inp.default ?? "";
    values[inp.id] = validValue(inp, asPicks(inp, saved[inp.id])) ? asPicks(inp, saved[inp.id]) : fallback;
  }
  f = { values, files: {}, preset: (app.presets || []).some((p) => p.id === saved.__preset) ? saved.__preset : "", count: 1 };
  forms.set(app.id, f);
  return f;
}
function persist(app) {
  const f = formFor(app);
  store.set(`values.${app.id}`, { ...f.values, __preset: f.preset });
}

const ACCEPT = {
  image: "image/png,image/jpeg,image/webp,image/bmp,image/gif",
  video: "video/mp4,video/quicktime,video/webm,video/x-matroska,video/x-msvideo",
  audio: "audio/mpeg,audio/wav,audio/x-wav,audio/flac,audio/mp4,audio/aac,audio/ogg",
};
const EXTENSIONS = {
  image: ["png", "jpg", "jpeg", "webp", "bmp", "gif"],
  video: ["mp4", "mov", "mkv", "webm", "avi", "m4v"],
  audio: ["mp3", "wav", "flac", "ogg", "m4a", "aac"],
};
function fileMatches(type, file) {
  return Boolean(EXTENSIONS[type]?.includes(extOf(file.name)));
}

function mediaSeconds(file, type) {
  return new Promise((resolve, reject) => {
    const media = document.createElement(type === "audio" ? "audio" : "video");
    const url = URL.createObjectURL(file);
    const done = (value, error) => {
      URL.revokeObjectURL(url);
      media.removeAttribute("src");
      if (error) reject(error); else resolve(value);
    };
    media.preload = "metadata";
    media.onloadedmetadata = () => Number.isFinite(media.duration) ? done(media.duration) : done(0);
    media.onerror = () => done(0, new Error(`${file.name}: could not read the ${type} duration`));
    media.src = url;
  });
}

async function validateMediaFiles(app) {
  const form = formFor(app);
  const totals = { video: 0, audio: 0 };
  let files = 0;
  for (const inp of app.inputs.filter((i) => isMedia(i.type))) {
    const value = form.files[inp.id];
    const items = Array.isArray(value) ? value : value ? [value] : [];
    files += items.length;
    for (const { file } of items) {
      if (!fileMatches(inp.type, file)) {
        throw new Error(`${inp.label}: ${file.name} — unsupported ${inp.type} format`);
      }
      if (app.backend === "sglang" && inp.type === "image" && !["png", "jpg", "jpeg", "webp", "bmp"].includes(extOf(file.name))) {
        throw new Error(`${inp.label}: ${file.name} — SGLang accepts PNG, JPG, JPEG, WebP, or BMP images`);
      }
      const [min, max] = inp.limits?.seconds ?? [];
      if (min === undefined || max === undefined || (inp.type !== "video" && inp.type !== "audio")) continue;
      const seconds = await mediaSeconds(file, inp.type);
      if (seconds < min - 0.1 || seconds > max + 0.1) {
        throw new Error(`${inp.label}: ${file.name} is ${seconds.toFixed(1)} s; needs ${min}–${max} s`);
      }
      totals[inp.type] += seconds;
    }
  }
  const tail = app.id === "h3-extend-sglang" ? Number(form.values.context || 0) / 24 : 0;
  totals.video += tail;
  const mixed = files + (tail ? 1 : 0);
  const maxFiles = app.backend === "sglang" ? Math.min(12, Number(h3CapsSync().max_refs) || 12) : 12;
  if (mixed > maxFiles) throw new Error(`This H3 profile admits at most ${maxFiles} reference files including the motion tail; remove ${mixed - maxFiles}`);
  for (const [kind, total] of Object.entries(totals)) {
    if (total > 15.1) throw new Error(`Reference ${kind}: ${total.toFixed(1)} s total; the maximum is 15 s${kind === "video" && tail ? " including the motion tail" : ""}`);
  }
}

function refBudget(app) {
  const box = el("div", { class: "ref-budget", style: { margin: "8px 0", padding: "8px 10px", border: "1px solid var(--line)", borderRadius: "8px", fontSize: "12px" } });
  const update = async () => {
    const form = formFor(app);
    const totals = { video: 0, audio: 0 };
    const counts = { image: 0, video: 0, audio: 0 };
    let files = 0;
    for (const inp of app.inputs.filter((i) => isMedia(i.type))) {
      const value = form.files[inp.id];
      const items = Array.isArray(value) ? value : value ? [value] : [];
      counts[inp.type] += items.length;
      files += items.length;
      if (inp.type !== "video" && inp.type !== "audio") continue;
      for (const { file } of items) {
        try { totals[inp.type] += await mediaSeconds(file, inp.type); } catch { /* unreadable files are reported on submit */ }
      }
    }
    const tail = app.id === "h3-extend-sglang" ? Number(form.values.context || 0) / 24 : 0;
    const video = totals.video + tail;
    const mixed = files + (tail ? 1 : 0);
    const problems = [];
    if (video > 15.1) problems.push(`video ${video.toFixed(1)}/15 s`);
    if (totals.audio > 15.1) problems.push(`audio ${totals.audio.toFixed(1)}/15 s`);
    const maxFiles = Math.min(12, Number(h3CapsSync().max_refs) || 12);
    if (mixed > maxFiles) problems.push(`${mixed}/${maxFiles} files`);
    if (counts.audio > 0 && counts.image === 0 && counts.video === 0 && !tail) problems.push("audio needs an image or video reference");
    box.textContent = `Reference budgets — Video ${video.toFixed(1)}/15 s${tail ? ` (incl. ${tail.toFixed(1)} s tail)` : ""} · Audio ${totals.audio.toFixed(1)}/15 s · Files ${mixed}/${maxFiles}`;
    if (problems.length) box.textContent += ` — WARNING: ${problems.join(" · ")}`;
    box.style.color = problems.length ? "var(--warn, #e5a50a)" : "";
  };
  update();
  return box;
}

function setFile(app, inp, file) {
  if (!fileMatches(inp.type, file)) {
    toast(`${inp.label}: ${file.name} — unsupported ${inp.type} format`, { error: true });
    return false;
  }
  const maxMb = inp.limits?.max_mb;
  if (maxMb && file.size > maxMb * 1e6) {
    toast(`${inp.label}: ${t("ws.drop.mb", { mb: maxMb })}`, { error: true });
    return false;
  }
  const f = formFor(app);
  if (inp.multiple) {
    const list = f.files[inp.id] ?? (f.files[inp.id] = []);
    const max = inp.multiple.max ?? 1;
    if (list.length >= max) {
      toast(`${inp.label}: at most ${max}`, { error: true });
      return false;
    }
    list.push({ file, url: URL.createObjectURL(file), keepAudio: true });
  } else {
    if (f.files[inp.id]) URL.revokeObjectURL(f.files[inp.id].url);
    f.files[inp.id] = { file, url: URL.createObjectURL(file) };
  }
  dropMasksOf(app, inp.id);
  return true;
}

/** Replace one item in a multiple reference slot without touching the others. */
function replaceFile(app, inp, file, index) {
  if (!fileMatches(inp.type, file)) {
    toast(`${inp.label}: ${file.name} — unsupported ${inp.type} format`, { error: true });
    return false;
  }
  const maxMb = inp.limits?.max_mb;
  if (maxMb && file.size > maxMb * 1e6) {
    toast(`${inp.label}: ${t("ws.drop.mb", { mb: maxMb })}`, { error: true });
    return false;
  }
  const list = formFor(app).files[inp.id];
  if (!Array.isArray(list) || index < 0 || index >= list.length) return false;
  URL.revokeObjectURL(list[index].url);
  list[index] = { file, url: URL.createObjectURL(file), keepAudio: list[index].keepAudio !== false };
  dropMasksOf(app, inp.id);
  return true;
}
function clearFile(app, id, index) {
  const f = formFor(app);
  const x = f.files[id];
  if (Array.isArray(x)) {
    if (index === undefined) {
      for (const item of x) URL.revokeObjectURL(item.url);
      delete f.files[id];
    } else {
      const [gone] = x.splice(index, 1);
      if (gone) URL.revokeObjectURL(gone.url);
      if (!x.length) delete f.files[id];
    }
  } else {
    if (x) URL.revokeObjectURL(x.url);
    delete f.files[id];
  }
  dropMasksOf(app, id);
}
/** A mask painted over a photo means nothing once the photo changes. */
function dropMasksOf(app, id) {
  for (const m of app.inputs.filter((i) => i.paint === id)) clearFile(app, m.id);
}

/** Put dropped or pasted files into the first matching slots. */
function assignFiles(app, files) {
  const slots = app.inputs.filter((i) => isMedia(i.type) && !i.paint);   // a painted mask is made with the brush, not dropped
  const f = formFor(app);
  const room = (s) => s.multiple ? (f.files[s.id]?.length ?? 0) < (s.multiple.max ?? 1) : !f.files[s.id];
  let used = 0;
  for (const file of files) {
    const free = slots.find((s) => fileMatches(s.type, file) && room(s));
    if (free && setFile(app, free, file)) used++;
  }
  return used;
}

async function fileFromUrl(url, name) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const blob = await res.blob();
  return new File([blob], name, { type: blob.type || res.headers.get("content-type") || "" });
}

// ------------------------------------------------------------------ submitting
function missingInputs(app) {
  const f = formFor(app);
  const out = [];
  for (const inp of app.inputs) {
    if (isMedia(inp.type)) {
      const has = inp.multiple ? Boolean(f.files[inp.id]?.length) : Boolean(f.files[inp.id]);
      if (inp.required && !has) out.push(inp);
      continue;
    }
    if (inp.required && inp.type === "textarea" && !String(f.values[inp.id] ?? "").trim() && !inp.default) out.push(inp);
  }
  return out;
}

function buildForm(app, { randomSeed = false } = {}) {
  const f = formFor(app);
  const fd = new FormData();
  for (const inp of app.inputs) {
    if (isMedia(inp.type)) {
      const x = f.files[inp.id];
      if (inp.multiple) { for (const item of x ?? []) fd.append(inp.id, item.file, item.file.name); }
      else if (x) fd.append(inp.id, x.file, x.file.name);
      continue;
    }
    const v = f.values[inp.id];
    if (inp.type === "toggle") { fd.append(inp.id, v ? "true" : "false"); continue; }
    if (inp.multiple) { fd.append(inp.id, JSON.stringify(Array.isArray(v) ? v : [])); continue; }   // none picked is a choice too
    if (inp.type === "seed" && (randomSeed || v === -1 || v === "-1" || v === "" || v === null)) continue;
    // "Any" in a builder select is the empty value: send it, or the server would fill in the default
    if (v === "" && inp.type === "select" && (inp.options || []).some((o) => o.value === "")) { fd.append(inp.id, ""); continue; }
    if (v === "" || v === null || v === undefined) continue;
    fd.append(inp.id, String(v));
  }
  if (app.inputs.some((i) => i.id === "ref_video_audio")) {
    const videos = f.files.ref_videos ?? [];
    if (videos.length) fd.append("ref_video_audio_flags", JSON.stringify(videos.map((x) => x.keepAudio !== false)));
  }
  if (f.preset) fd.append("preset", f.preset);
  return fd;
}

/** Validate, then submit `count` runs. Returns false when something is missing (and shows what). */
async function submit(app, ui) {
  const missing = missingInputs(app);
  ui.clearMissing?.();
  if (missing.length) {
    for (const inp of missing) ui.markMissing?.(inp.id);
    const first = missing[0];
    toast(isMedia(first.type) ? t("ws.need", { label: first.label }) : t("ws.needtext", { label: first.label }), { error: true });
    return false;
  }
  const f = formFor(app);
  const n = Math.max(1, Math.min(4, f.count || 1));
  persist(app);
  try {
    await validateMediaFiles(app);
    for (let k = 0; k < n; k++) await feed.run(app.id, buildForm(app, { randomSeed: n > 1 }));
    toast(t("toast.started", { app: app.name }));
    return true;
  } catch (err) {
    toast(err.message, { error: true });
    return false;
  }
}

/** Open an app with one option already chosen (a card on the Explore page's effects wall). */
export function pickOption(app, inputId, value) {
  formFor(app).values[inputId] = value;
  persist(app);
  if (location.hash !== `#/app/${app.id}`) location.hash = `#/app/${app.id}`;
  else hooks.rerender?.();
}

/** Load a result's settings and input files into its app's form (and optionally run it again). */
export async function recreate(item, { run = false } = {}) {
  const app = byId.get(item.app);
  if (!app) return;
  const f = formFor(app);
  for (const inp of app.inputs) {
    if (isMedia(inp.type)) continue;
    if (item.values?.[inp.id] !== undefined && validValue(inp, asPicks(inp, item.values[inp.id]))) f.values[inp.id] = asPicks(inp, item.values[inp.id]);
    if (inp.type === "seed" && item.seed !== null && item.seed !== undefined) f.values[inp.id] = item.seed;
  }
  f.preset = item.preset || "";
  try {
    for (const inp of app.inputs.filter((i) => isMedia(i.type))) {
      const entries = item.inputs.filter((i) => i.id === inp.id && i.file);
      if (!entries.length) continue;
      clearFile(app, inp.id);
      for (const i of entries) {
        const name = i.name || `${i.id}.${extOf(i.file) || "bin"}`;
        setFile(app, inp, await fileFromUrl(i.file, name));
      }
    }
  } catch (err) {
    toast(err.message, { error: true });
  }
  persist(app);
  if (run) wsTab = "history";
  if (location.hash !== `#/app/${app.id}`) location.hash = `#/app/${app.id}`;
  else hooks.rerender?.();
  if (run) await submit(app, {});
  else toast(t("toast.loaded", { app: app.name }));
}

/** Where a result usually goes next, by the kind of file it is (the rest of the apps that take it follow). */
let pendingICPrompt = "";

const NEXT = {
  image: ["video", "motion-transfer", "h3-photo", "relight", "upscale", "inpaint", "edit", "expand-image", "character", "remove-bg"],
  video: ["upscale-video", "extend-video", "reframe", "mixed-media", "video-remove-bg", "smooth", "sdr-hdr"],
};

/** "Use in…": put a result (an image or a video) into the first slot of that kind in another app, and open that app. */
export function useIn(anchor, item, done) {
  const type = item.type;
  const slotOf = (a) => a.inputs.find((i) => i.type === type && !i.paint);
  const first = (NEXT[type] || []).map((id) => byId.get(id)).filter((a) => a && slotOf(a));
  const rest = apps.filter((a) => slotOf(a) && !first.includes(a)).sort((x, y) => x.name.localeCompare(y.name));
  const go = async (a) => {
    closePopover();
    done?.();
    try {
      const ext = extOf(item.full) || (type === "video" ? "mp4" : "png");
      if (!setFile(a, slotOf(a), await fileFromUrl(item.full, `${item.app || "result"}.${ext}`))) return;
      if (a.id === "h3-regenerate-2k-ic") pendingICPrompt = item.values?.prompt ? String(item.values.prompt) : "";
      if (location.hash !== `#/app/${a.id}`) location.hash = `#/app/${a.id}`;
      else hooks.rerender?.();
      toast(t("toast.sent", { app: a.name }));
    } catch (err) {
      toast(err.message, { error: true });
    }
  };
  const row = (a) => el("button", { class: "opt", type: "button", onclick: () => go(a) },
    el("span", { class: "thumb" }, appThumb(a)), el("span", { class: "two" }, el("b", {}, a.name), el("small", {}, tagline(a))));
  popover(anchor, el("div", { class: "usein" }, el("h4", {}, t("act.usein")), ...first.map(row),
    rest.length ? el("details", {}, el("summary", {}, t("usein.more", { n: rest.length })), ...rest.map(row)) : null), { width: 340 });
}

// ------------------------------------------------------------------ small parts
function appThumb(a) {
  const ex = a.example?.full ? a.example : null;
  if (!ex) return el("span", { style: { display: "grid", placeItems: "center", width: "100%", height: "100%", color: "#55555c" } }, icon(iconOf(a)));
  const src = ex.type === "video" ? ex.poster : ex.card || ex.full;
  return el("img", { src, alt: "", loading: "lazy", class: ex.type === "audio" ? "contain" : null, style: ex.type === "audio" ? { objectFit: "contain" } : null });
}

function switcher(app) {
  const family = familyOf(app);
  return el("div", {},
    el("h4", {}, t("ws.change")),
    ...family.map((a) => el("button", { class: "opt", type: "button", "aria-selected": String(a.id === app.id),
      onclick: () => { closePopover(); location.hash = `#/app/${a.id}`; } },
      el("span", { class: "thumb" }, appThumb(a)),
      el("span", { class: "two" }, el("b", {}, a.name), el("small", {}, a.summary)),
      el("span", { class: "chk" }, icon("check")))),
    el("a", { class: "opt", href: "#/apps", onclick: closePopover }, icon("layers"), t("explore.seeall")));
}

function optionLabel(inp, v) {
  if (Array.isArray(v)) return v.length ? v.map((x) => optionLabel(inp, x)).join(inp.multiple?.ordered ? " → " : ", ") : t("ws.none");
  const o = (inp.options || []).find((x) => String(x.value) === String(v));
  return o ? o.label : String(v ?? "");
}

/** A multiple select's list: tap to add or remove; ordered ones number the picks, which is the order they run in. */
function multiPicker(inp, f, onChange) {
  const max = inp.multiple.max ?? Infinity;
  const list = el("div", { class: "multi-list" });
  const draw = () => {
    const picked = f.values[inp.id] || [];
    list.replaceChildren(...(inp.options || []).map((o) => {
      const at = picked.findIndex((x) => String(x) === String(o.value));
      return el("button", { class: "opt", type: "button", "aria-pressed": String(at >= 0), onclick: () => {
        const cur = [...(f.values[inp.id] || [])];
        if (at >= 0) cur.splice(at, 1);
        else if (cur.length >= max) { toast(t("ws.multi.max", { n: max }), { error: true }); return; }
        else cur.push(o.value);
        f.values[inp.id] = cur;
        onChange();
        draw();
      } }, o.label, at >= 0 ? el("span", { class: "pick" }, inp.multiple.ordered ? String(at + 1) : icon("check")) : null);
    }));
  };
  draw();
  const clear = el("button", { class: "mini-link", type: "button", onclick: () => { f.values[inp.id] = []; onChange(); draw(); } }, t("ws.multi.clear"));
  return el("div", {}, el("h4", {}, inp.label, el("span", { class: "n" }, Number.isFinite(max) ? t(inp.multiple.ordered ? "ws.multi.upto.ordered" : "ws.multi.upto", { n: max }) : ""), clear), list);
}

/** The switch between sibling apps (Cinema Studio's image and video modes). */
function modeSwitch(app) {
  if (!app.modes) return null;
  return el("div", { class: "seg modes", role: "group", "aria-label": app.name }, ...app.modes.map((id) => byId.get(id)).filter(Boolean).map((a) =>
    el("button", { type: "button", "aria-pressed": String(a.id === app.id), onclick: () => { if (a.id !== app.id) location.hash = `#/app/${a.id}`; } },
      icon(a.mode_label ? (a.inputs.some((i) => i.type === "image") ? "user" : "spark") : a.section === "video" ? "video" : "image"),
      a.mode_label || t(`nav.${a.section}`))));
}

/** A select marked "gallery" (the effects picker): cards with each option's lab example, and the chosen one playing. */
function galleryField(app, inp, f, set, help) {
  const shots = app.example?.options?.[inp.id] || {};
  const val = el("span", { class: "v" }, optionLabel(inp, f.values[inp.id]));
  const now = el("div", { class: "fx-now" });
  const drawNow = () => {
    const shot = shots[String(f.values[inp.id])];
    now.hidden = !shot;
    now.replaceChildren(...(shot ? [optionThumb(shot, { play: "visible" })] : []));
  };
  drawNow();
  const row = el("button", { class: "selrow", type: "button", "aria-haspopup": "dialog", "aria-label": inp.label }, val, icon("chevD"));
  row.onclick = () => popover(row, el("div", {}, el("h4", {}, inp.label), el("div", { class: "fx-grid" }, ...(inp.options || []).map((o) =>
    optionTile(o, shots[String(o.value)], { selected: String(o.value) === String(f.values[inp.id]), flagKey: flags.key(app.id, inp.id, o.value),
      onPick: () => { set(o.value); val.textContent = o.label; drawNow(); closePopover(); } })))), { width: 640, cls: "wide" });
  return el("div", { class: "field" }, el("span", { class: "lbl" }, inp.label), row, now, help);
}

export function frameStepper(box, { readout = null } = {}) {
  const min = box.min === "" ? 0 : Number(box.min);
  const max = box.max === "" ? null : Number(box.max);
  const step = Number(box.step) || 1;
  const hasRail = max !== null && Number.isFinite(min) && Number.isFinite(max) && max > min;
  const clampValue = (value) => {
    let next = Math.round(Number(value));
    if (!Number.isFinite(next)) next = Number(box.value) || min;
    next = Math.max(Number.isFinite(min) ? min : next, next);
    if (hasRail) next = Math.min(max, next);
    return next;
  };
  const rail = hasRail ? el("input", { type: "range", class: "frame-rail", min, max, step, "aria-label": `${box.getAttribute("aria-label") || "Frames"} slider` }) : null;
  const paintRail = () => {
    if (!rail) return;
    rail.style.setProperty("--p", `${((Number(rail.value) - min) / (max - min || 1)) * 100}%`);
  };
  const syncRail = () => {
    if (!rail) return;
    const value = Number(box.value);
    if (Number.isFinite(value)) rail.value = String(Math.min(max, Math.max(min, value)));
    paintRail();
  };
  const commit = (value) => {
    const next = clampValue(value);
    box.value = String(next);
    syncRail();
    box.dispatchEvent(new Event("input", { bubbles: true }));
    box.dispatchEvent(new CustomEvent("framecommit", { bubbles: true }));
  };
  const minus = el("button", { class: "frame-step", type: "button", "aria-label": "Decrease frames", onclick: () => commit(Number(box.value) - step) }, "−");
  const plus = el("button", { class: "frame-step", type: "button", "aria-label": "Increase frames", onclick: () => commit(Number(box.value) + step) }, "+");
  box.classList.add("frame-input");
  box.setAttribute("inputmode", "numeric");
  box.addEventListener("input", syncRail);
  box.addEventListener("change", () => { if (box.value !== "") commit(box.value); });
  if (rail) {
    rail.addEventListener("input", () => {
      box.value = rail.value;
      paintRail();
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    rail.addEventListener("change", () => box.dispatchEvent(new CustomEvent("framecommit", { bubbles: true })));
    syncRail();
  }
  return el("div", { class: "frame-stepper" },
    el("div", { class: "frame-head" },
      el("div", { class: "frame-control" }, minus, box, plus),
      readout),
    rail ? el("div", { class: "frame-rail-wrap" }, rail, el("div", { class: "frame-bounds" }, el("small", {}, String(min)), el("small", {}, String(max)))) : null);
}

function rangeInput(inp, value, onChange) {
  const out = el("b", {}, String(value));
  const r = el("input", { type: "range", min: inp.min ?? 0, max: inp.max ?? 100, step: inp.step ?? 1, value: value, "aria-label": inp.label });
  const paint = () => r.style.setProperty("--p", `${((r.value - r.min) / (r.max - r.min || 1)) * 100}%`);
  paint();
  r.addEventListener("input", () => { out.textContent = r.value; paint(); onChange(Number(r.value)); });
  return el("div", { class: "range" }, el("div", { class: "top" }, el("span", {}, inp.label), out), r);
}

function seedEditor(app, inp, f, onChange) {
  const box = el("input", { type: "number", min: inp.min ?? 0, placeholder: t("ws.seed.random"), value: f.values[inp.id] === -1 ? "" : f.values[inp.id] ?? "" });
  box.addEventListener("input", () => { f.values[inp.id] = box.value === "" ? -1 : Math.trunc(Number(box.value)); onChange(); });
  const last = feed.list(app.id).find((e) => e.values?.[inp.id] !== undefined);
  return el("div", { class: "pad" },
    el("div", { class: "row" }, box,
      el("button", { class: "btn small ghost", type: "button", title: t("ws.seed.random"), onclick: () => { box.value = ""; f.values[inp.id] = -1; onChange(); } }, icon("dice"))),
    last ? el("button", { class: "btn small ghost", type: "button", onclick: () => { box.value = last.values[inp.id]; f.values[inp.id] = last.values[inp.id]; onChange(); } },
      `${t("ws.seed.reuse")} · ${last.values[inp.id]}`) : null,
    el("p", { class: "help" }, t("ws.seed.help")));
}

function genButton(app, onClick, { wide = false } = {}) {
  const est = estimate(app);
  const b = el("button", { class: `generate${wide ? " wide" : ""}`, type: "button", disabled: !app.runnable,
    title: !app.runnable ? (app.status === "draft" ? t("ws.draft") : t("ws.noworkflow")) : est ? t("ws.est", { gpu: est.gpu }) : null },
    t("ws.generate"), est ? el("span", { class: "cost" }, icon("spark"), fmtShort(est.seconds)) : el("span", { class: "cost" }, icon("spark")));
  b.addEventListener("click", async () => {
    if (b.dataset.busy) return;
    b.dataset.busy = "1";
    try { await onClick(); } finally { delete b.dataset.busy; }
  });
  return b;
}

function countControl(f) {
  const label = el("span", {});
  const minus = el("button", { type: "button", "aria-label": "−" }, "−");
  const plus = el("button", { type: "button", "aria-label": "+" }, "+");
  const draw = () => {
    label.replaceChildren(String(f.count), el("small", {}, "/4"));
    minus.disabled = f.count <= 1;
    plus.disabled = f.count >= 4;
  };
  minus.onclick = () => { f.count = Math.max(1, f.count - 1); draw(); };
  plus.onclick = () => { f.count = Math.min(4, f.count + 1); draw(); };
  draw();
  return el("div", { class: "count", title: t("ws.count") }, minus, label, plus);
}

// ------------------------------------------------------------------ composer layout
function composerBar(app, rerenderBar) {
  const f = formFor(app);
  const pi = promptInput(app);
  const mediaInputs = app.inputs.filter((i) => isMedia(i.type));
  const pickers = Object.fromEntries(mediaInputs.map((inp) => {
    const input = el("input", { type: "file", accept: ACCEPT[inp.type], hidden: true });
    input.addEventListener("change", () => { if (input.files[0] && setFile(app, inp, input.files[0])) rerenderBar(); input.value = ""; });
    return [inp.id, input];
  }));
  const pick = (inp) => pickers[inp.id].click();
  const hint = el("div", { class: "cmp-hint", hidden: true });

  const prompt = pi ? el("textarea", { class: "cmp-prompt", rows: "2", "aria-label": pi.label,
    // an optional prompt (a template app's "Extra direction") says so instead of asking for a scene
    placeholder: pi.default ? t("ws.eg", { x: pi.default }) : pi.required ? t("ws.prompt.ph") : t("ws.prompt.opt", { label: pi.label }), value: f.values[pi.id] ?? "" }) : null;
  const grow = () => { if (!prompt) return; prompt.style.height = "auto"; prompt.style.height = `${Math.min(220, prompt.scrollHeight)}px`; };
  if (prompt) {
    prompt.addEventListener("input", () => { f.values[pi.id] = prompt.value; grow(); prompt.classList.remove("missing"); persistSoon(); });
    prompt.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); go(); } });
    requestAnimationFrame(grow);
  }

  const attach = el("div", { class: "cmp-attach" }, ...mediaInputs.map((inp) => {
    const x = f.files[inp.id];
    if (!x) {
      return el("button", { class: "att need", type: "button", title: `${t("ws.add", { what: inp.label })}${inp.required ? "" : ` (${t("ws.optional")})`}`,
        "aria-label": t("ws.add", { what: inp.label }), dataset: { slot: inp.id }, onclick: () => pick(inp) }, icon(inp.type === "image" ? "image" : inp.type));
    }
    const m = inp.type === "image" ? el("img", { src: x.url, alt: "" }) : inp.type === "video" ? el("video", { src: `${x.url}#t=0.1`, muted: true, preload: "metadata" }) : el("span", { style: { display: "grid", placeItems: "center", height: "100%" } }, icon("audio"));
    return el("div", { class: "att", title: x.file.name },
      m, el("span", { class: "lbl" }, inp.label),
      el("button", { class: "x", type: "button", "aria-label": t("ws.remove"), onclick: () => { clearFile(app, inp.id); rerenderBar(); } }, icon("x")));
  }));

  const chips = [];
  if (mediaInputs.length) {
    chips.push(el("button", { class: "chip square", type: "button", title: t("ws.add", { what: mediaInputs[0].label }), "aria-label": t("ws.add", { what: mediaInputs[0].label }),
      onclick: (ev) => {
        const empty = mediaInputs.filter((i) => !f.files[i.id]);
        if (mediaInputs.length === 1 || empty.length === 1) return pick(empty[0] || mediaInputs[0]);
        popover(ev.currentTarget, el("div", {}, ...mediaInputs.map((inp) => el("button", { class: "opt", type: "button", onclick: () => { closePopover(); pick(inp); } },
          icon(inp.type === "image" ? "image" : inp.type), inp.label))));
      } }, icon("plus")));
  }
  const modes = modeSwitch(app);
  if (modes) chips.push(modes);
  const model = el("button", { class: "chip model", type: "button", "aria-haspopup": "dialog",
    onclick: (ev) => popover(ev.currentTarget, switcher(app), { width: 360 }) },
    el("span", { class: "thumb" }, appThumb(app)), el("span", { class: "v" }, app.name), icon("chevD"));
  chips.push(model);

  for (const inp of app.inputs) {
    if (isMedia(inp.type) || inp === pi) continue;
    chips.push(chipFor(app, inp, f));
  }
  if (app.presets?.length) {
    const presetChip = el("button", { class: `chip${f.preset ? " filled" : ""}`, type: "button" }, el("span", { class: "k" }, t("ws.preset")),
      el("span", { class: "v" }, f.preset ? app.presets.find((p) => p.id === f.preset)?.label : t("ws.preset.none")));
    presetChip.onclick = (ev) => popover(ev.currentTarget, el("div", {}, el("h4", {}, t("ws.preset")),
      ...[{ id: "", label: t("ws.preset.none") }, ...app.presets].map((p) => el("button", { class: "opt", type: "button", "aria-selected": String(f.preset === p.id),
        onclick: () => { f.preset = p.id; persist(app); closePopover(); rerenderBar(); } }, p.label, el("span", { class: "chk" }, icon("check"))))));
    chips.push(presetChip);
  }

  const ui = {
    clearMissing: () => { prompt?.classList.remove("missing"); attach.querySelectorAll(".missing").forEach((n) => n.classList.remove("missing")); },
    markMissing: (id) => {
      if (pi && id === pi.id) { prompt.classList.add("missing"); prompt.focus(); }
      attach.querySelector(`[data-slot="${id}"]`)?.classList.add("missing");
    },
  };
  const go = async () => { if (await submit(app, ui) && wsTab !== "history") { wsTab = "history"; hooks.rerender?.(); } };
  const gen = genButton(app, go);
  if (!app.runnable) { hint.hidden = false; hint.textContent = app.status === "draft" ? t("ws.draft") : t("ws.noworkflow"); }

  const bar = el("div", { class: "composer" },
    hint,
    el("div", { class: "cmp-top" }, attach, prompt || el("div", { class: "cmp-prompt dim", style: { paddingTop: "16px" } }, app.summary)),
    el("div", { class: "cmp-row" }, ...chips, el("span", { class: "grow" }), countControl(f), gen),
    ...Object.values(pickers));
  return bar;
}

let persistTimer = null;
function persistSoon() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => { for (const id of forms.keys()) { const a = byId.get(id); if (a) persist(a); } }, 400);
}

function chipFor(app, inp, f) {
  const set = (v) => { f.values[inp.id] = v; persistSoon(); };
  if (inp.type === "toggle") {
    const b = el("button", { class: `chip${f.values[inp.id] ? " on" : ""}`, type: "button", "aria-pressed": String(Boolean(f.values[inp.id])), title: inp.help || inp.label },
      icon(/enhance|reprompt/.test(inp.id) ? "wand" : "check"), inp.label);
    b.onclick = () => { set(!f.values[inp.id]); b.classList.toggle("on", Boolean(f.values[inp.id])); b.setAttribute("aria-pressed", String(Boolean(f.values[inp.id]))); };
    return b;
  }
  const v = el("span", { class: "v" });
  const b = el("button", { class: "chip", type: "button", "aria-haspopup": "dialog", title: inp.help || inp.label },
    inp.type === "seed" ? icon("dice") : el("span", { class: "k" }, inp.label), v);
  const draw = () => {
    const val = f.values[inp.id];
    if (inp.type === "select") v.textContent = optionLabel(inp, val);
    else if (inp.type === "seed") v.textContent = val === -1 || val === "" ? t("ws.seed.random") : String(val);
    else if (inp.type === "textarea" || inp.type === "text") { v.textContent = String(val || "").trim() ? "✓" : "—"; b.classList.toggle("filled", Boolean(String(val || "").trim())); }
    else v.textContent = String(val);
  };
  draw();
  b.onclick = (ev) => {
    let content;
    if (inp.multiple) {
      content = multiPicker(inp, f, () => { persistSoon(); draw(); });
    } else if (inp.type === "select") {
      content = el("div", {}, el("h4", {}, inp.label), ...(inp.options || []).map((o) => el("button", { class: "opt", type: "button",
        "aria-selected": String(String(o.value) === String(f.values[inp.id])), onclick: () => { set(o.value); draw(); closePopover(); } },
        o.label, el("span", { class: "chk" }, icon("check")))));
    } else if (inp.type === "slider") {
      content = el("div", { class: "pad" }, rangeInput(inp, f.values[inp.id], (n) => { set(n); draw(); }), inp.help ? el("p", { class: "help" }, inp.help) : null);
    } else if (inp.type === "seed") {
      content = seedEditor(app, inp, f, () => { persistSoon(); draw(); });
    } else if (inp.type === "textarea") {
      const ta = el("textarea", { placeholder: inp.default ? t("ws.eg", { x: inp.default }) : inp.label, value: f.values[inp.id] ?? "" });
      ta.addEventListener("input", () => { set(ta.value); draw(); });
      content = el("div", { class: "pad" }, el("b", {}, inp.label), ta, inp.help ? el("p", { class: "help" }, inp.help) : null);
    } else {
      const box = el("input", { type: inp.type === "number" ? "number" : "text", min: inp.min, max: inp.max, step: inp.step, value: f.values[inp.id] ?? "",
        placeholder: inp.default !== undefined ? String(inp.default) : "" });
      box.addEventListener("input", () => { set(inp.type === "number" ? (box.value === "" ? "" : Number(box.value)) : box.value); draw(); });
      content = el("div", { class: "pad" }, el("b", {}, inp.label), box, inp.help ? el("p", { class: "help" }, inp.help) : null);
    }
    popover(ev.currentTarget, content, { width: inp.type === "textarea" ? 360 : undefined });
  };
  return b;
}

// ------------------------------------------------------------------ sidebar layout
/** An input painted over another image (inpaint's mask): opens the brush over that image. */
function paintZone(app, inp, rerender) {
  const f = formFor(app);
  const src = f.files[inp.paint];
  const srcInp = app.inputs.find((i) => i.id === inp.paint);
  const x = f.files[inp.id];
  const paint = async () => {
    if (!src) { toast(t("paint.first", { label: srcInp?.label || inp.paint }), { error: true }); return; }
    const file = await openPainter(src.file, { mask: x?.file || null, title: inp.label });
    if (file && setFile(app, inp, file)) rerender();
  };
  if (!x) {
    return el("div", { class: `drop paint${src ? "" : " off"}`, role: "button", tabindex: "0", dataset: { slot: inp.id }, "aria-label": t("paint.cta"),
      onclick: paint, onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); paint(); } } },
      src ? el("img", { src: src.url, alt: "" }) : null,
      el("span", { class: "ic" }, icon("wand")),
      el("b", {}, inp.label),
      el("small", {}, src ? t("paint.cta") : t("paint.first", { label: srcInp?.label || inp.paint })),
      inp.help ? el("small", { class: "faint" }, inp.help) : null);
  }
  const zone = el("div", { class: "drop has", dataset: { slot: inp.id } },
    el("span", { class: "fname" }, inp.label),
    el("div", { class: "bar2" },
      el("button", { class: "mini", type: "button", title: t("paint.edit"), "aria-label": t("paint.edit"), onclick: paint }, icon("wand")),
      el("button", { class: "mini", type: "button", title: t("ws.remove"), "aria-label": t("ws.remove"), onclick: () => { clearFile(app, inp.id); rerender(); } }, icon("x"))));
  if (src) maskPreview(src.url, x.file).then((c) => zone.prepend(c)).catch(() => zone.prepend(el("img", { src: x.url, alt: "" })));
  else zone.prepend(el("img", { src: x.url, alt: "" }));
  return zone;
}

const REF_TAG = { image: "Picture", video: "Video", audio: "Audio" };

function multiDropzone(app, inp, rerender) {
  const f = formFor(app);
  const list = f.files[inp.id] ?? [];
  const max = inp.multiple?.max ?? 1;
  const input = el("input", { type: "file", accept: ACCEPT[inp.type], multiple: true, hidden: true });
  const replaceInput = el("input", { type: "file", accept: ACCEPT[inp.type], hidden: true });
  let replaceIndex = -1;
  const add = (files) => {
    let changed = false;
    for (const file of files) if (setFile(app, inp, file)) changed = true;
    if (changed) rerender();
  };
  input.addEventListener("change", () => { add([...input.files]); input.value = ""; });
  replaceInput.addEventListener("change", () => {
    if (replaceInput.files[0] && replaceFile(app, inp, replaceInput.files[0], replaceIndex)) rerender();
    replaceInput.value = "";
  });
  const bits = [];
  bits.push(`up to ${max}`);
  if (inp.limits?.max_mb) bits.push(t("ws.drop.mb", { mb: inp.limits.max_mb }));
  if (inp.limits?.seconds) bits.push(t("ws.drop.seconds", { a: inp.limits.seconds[0], b: inp.limits.seconds[1] }));
  if (inp.limits?.total_seconds) bits.push(`${inp.limits.total_seconds} s total`);
  if (inp.limits?.total_mb) bits.push(`${inp.limits.total_mb} MB total`);
  const note = el("small", { class: "faint" }, bits.join(" · "));

  const hasAudioSwitch = inp.type === "video" && app.inputs.some((item) => item.id === "ref_video_audio");
  const tile = (x, i) => {
    const media = inp.type === "image" ? el("img", { src: x.url, alt: "" })
      : inp.type === "video" ? el("video", { src: x.url, muted: true, loop: true, playsinline: true, autoplay: true, preload: "auto" })
        : el("audio", { src: x.url, controls: true, preload: "metadata" });
    if (inp.type === "video") media.muted = true;
    const warn = el("small", { class: "ref-note" });
    if ((inp.type === "video" || inp.type === "audio") && inp.limits?.seconds) {
      media.addEventListener("loadedmetadata", () => {
        const [a, b] = inp.limits.seconds;
        if (media.duration < a - 0.1 || media.duration > b + 0.1) {
          warn.textContent = `${media.duration.toFixed(1)} s — needs ${a}–${b} s`;
          warn.classList.add("warn");
        }
      });
    }
    const masterAudio = f.values.ref_video_audio !== false;
    const audioSwitch = hasAudioSwitch ? (() => {
      const box = el("input", { type: "checkbox", checked: masterAudio && x.keepAudio !== false, disabled: !masterAudio, role: "switch",
        "aria-label": `${t("ws.audio")} <Video ${i + 1}>`, title: masterAudio ? t("ws.audio.keep") : t("ws.audio.master") });
      box.addEventListener("change", () => { x.keepAudio = box.checked; });
      return el("label", { class: `ref-audio${masterAudio ? "" : " off"}`, title: masterAudio ? t("ws.audio.keep") : t("ws.audio.master") },
        el("span", {}, t("ws.audio")), el("span", { class: "switch" }, box, el("i")));
    })() : null;
    const move = (to) => {
      if (to < 0 || to >= list.length) return;
      const [item] = list.splice(i, 1);
      list.splice(to, 0, item);
      rerender();
    };
    return el("div", { class: "ref-item", dataset: { slot: inp.id } },
      el("div", { class: "ref-media" }, media),
      el("div", { class: "ref-txt" }, el("b", {}, `<${REF_TAG[inp.type]} ${i + 1}>`), el("span", { class: "ref-name" }, x.file.name), warn, audioSwitch),
      el("div", { class: "ref-ctl" },
        el("button", { class: "mini", type: "button", title: t("ws.replace"), "aria-label": t("ws.replace"), onclick: () => { replaceIndex = i; replaceInput.click(); } }, icon("swap")),
        el("button", { class: "mini", type: "button", title: "Move up", "aria-label": "Move up", onclick: () => move(i - 1), disabled: i === 0 }, "↑"),
        el("button", { class: "mini", type: "button", title: "Move down", "aria-label": "Move down", onclick: () => move(i + 1), disabled: i === list.length - 1 }, "↓"),
        el("button", { class: "mini", type: "button", title: t("ws.remove"), "aria-label": t("ws.remove"), onclick: () => { clearFile(app, inp.id, i); rerender(); } }, icon("x"))));
  };

  const zone = el("div", { class: "refset", dataset: { slot: inp.id } },
    el("span", { class: "lbl" }, inp.label, inp.required ? null : el("small", {}, t("ws.optional"))),
    ...list.map(tile),
    list.length < max ? el("button", { class: "ref-add", type: "button", onclick: () => input.click(), "aria-label": t("ws.add", { what: inp.label }) },
      icon("plus"), el("span", {}, t("ws.add", { what: inp.label }))) : null,
    el("small", { class: "faint" }, inp.help || "", inp.help ? el("br") : null, note),
    input, replaceInput);
  zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    zone.classList.remove("over");
    add([...e.dataTransfer.files]);
  });
  return zone;
}

function dropzone(app, inp, rerender) {
  if (inp.paint) return paintZone(app, inp, rerender);
  if (inp.multiple) return multiDropzone(app, inp, rerender);
  const f = formFor(app);
  const x = f.files[inp.id];
  const input = el("input", { type: "file", accept: ACCEPT[inp.type], hidden: true });
  input.addEventListener("change", () => { if (input.files[0] && setFile(app, inp, input.files[0])) rerender(); input.value = ""; });
  const limits = [inp.limits?.max_mb ? t("ws.drop.mb", { mb: inp.limits.max_mb }) : "", inp.limits?.seconds ? t("ws.drop.seconds", { a: inp.limits.seconds[0], b: inp.limits.seconds[1] }) : ""].filter(Boolean).join(" · ");
  let zone;
  if (!x) {
    zone = el("div", { class: "drop", role: "button", tabindex: "0", dataset: { slot: inp.id }, "aria-label": t("ws.add", { what: inp.label }),
      onclick: () => input.click(), onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } } },
      el("span", { class: "ic" }, icon(inp.type === "image" ? "image" : inp.type === "video" ? "video" : "audio")),
      el("b", {}, inp.label, inp.required ? "" : el("span", { class: "faint", style: { fontWeight: 500 } }, ` · ${t("ws.optional")}`)),
      el("small", {}, inp.help || t(`ws.drop.${inp.type}`)),
      el("small", { class: "faint" }, [t("ws.drop.hint"), limits].filter(Boolean).join(" · ")),
      input);
  } else {
    const media = inp.type === "image" ? el("img", { src: x.url, alt: "" })
      : inp.type === "video" ? el("video", { src: x.url, muted: true, loop: true, playsinline: true, autoplay: true, preload: "auto" })
        : el("audio", { src: x.url, controls: true, preload: "metadata" });
    if (inp.type === "video") media.muted = true;
    const warn = el("span", { class: "fname" }, x.file.name);
    if ((inp.type === "video" || inp.type === "audio") && inp.limits?.seconds) {
      media.addEventListener("loadedmetadata", () => {
        const [a, b] = inp.limits.seconds;
        if (media.duration < a - 0.1 || media.duration > b + 0.1) { warn.textContent = `${x.file.name} · ${media.duration.toFixed(1)} s (${a}–${b} s)`; warn.style.color = "var(--warn)"; }
      });
    }
    zone = el("div", { class: "drop has", dataset: { slot: inp.id } }, media, warn,
      el("div", { class: "bar2" },
        el("button", { class: "mini", type: "button", title: t("ws.replace"), "aria-label": t("ws.replace"), onclick: () => input.click() }, icon("swap")),
        el("button", { class: "mini", type: "button", title: t("ws.remove"), "aria-label": t("ws.remove"), onclick: () => { clearFile(app, inp.id); rerender(); } }, icon("x"))),
      input);
  }
  zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    zone.classList.remove("over");
    const file = e.dataTransfer.files[0];
    if (file && setFile(app, inp, file)) rerender();
  });
  return zone;
}

function sideField(app, inp, f, ui, onChange = null) {
  const set = (v) => { f.values[inp.id] = v; persistSoon(); onChange?.(inp, v); };
  const help = inp.help ? el("p", { class: "help" }, inp.help) : null;
  if (inp.type === "textarea") {
    const ta = el("textarea", { class: inp.required ? "" : "short", placeholder: inp.default ? t("ws.eg", { x: inp.default }) : inp.label, value: f.values[inp.id] ?? "", "aria-label": inp.label });
    ta.addEventListener("input", () => { set(ta.value); ta.classList.remove("missing"); });
    ui.refs[inp.id] = ta;
    return el("label", { class: "field" }, el("span", { class: "lbl" }, inp.label, inp.required ? null : el("small", {}, t("ws.optional"))), ta, help);
  }
  if (inp.multiple) {
    const val = el("span", { class: "v" }, optionLabel(inp, f.values[inp.id]));
    const row = el("button", { class: "selrow", type: "button", "aria-haspopup": "dialog", "aria-label": inp.label }, val, icon("chevD"));
    row.onclick = () => popover(row, multiPicker(inp, f, () => { persistSoon(); val.textContent = optionLabel(inp, f.values[inp.id]); }), { width: Math.max(280, row.offsetWidth) });
    return el("div", { class: "field" }, el("span", { class: "lbl" }, inp.label), row, help);
  }
  if (inp.type === "select" && inp.gallery) return galleryField(app, inp, f, set, help);
  if (inp.type === "select") {
    const opts = inp.options || [];
    const short = opts.length <= 4 && opts.every((o) => String(o.label).length <= 12);
    if (short) {
      const seg = el("div", { class: "seg", role: "group", "aria-label": inp.label });
      const draw = () => seg.replaceChildren(...opts.map((o) => el("button", { type: "button", "aria-pressed": String(String(o.value) === String(f.values[inp.id])),
        onclick: () => { set(o.value); draw(); } }, o.label)));
      draw();
      return el("div", { class: "field" }, el("span", { class: "lbl" }, inp.label), seg, help);
    }
    const val = el("span", { class: "v" }, optionLabel(inp, f.values[inp.id]));
    const row = el("button", { class: "selrow", type: "button", "aria-haspopup": "dialog", "aria-label": inp.label }, val, icon("chevD"));
    row.onclick = () => popover(row, el("div", {}, el("h4", {}, inp.label), ...opts.map((o) => el("button", { class: "opt", type: "button",
      "aria-selected": String(String(o.value) === String(f.values[inp.id])), onclick: () => { set(o.value); val.textContent = o.label; closePopover(); } },
      o.label, el("span", { class: "chk" }, icon("check"))))), { width: Math.max(260, row.offsetWidth) });
    return el("div", { class: "field" }, el("span", { class: "lbl" }, inp.label), row, help);
  }
  if (inp.type === "slider") return el("div", { class: "field" }, rangeInput(inp, f.values[inp.id], set), help);
  if (inp.type === "toggle") {
    const box = el("input", { type: "checkbox", checked: Boolean(f.values[inp.id]), "aria-label": inp.label });
    box.addEventListener("change", () => set(box.checked));
    return el("label", { class: "field" }, el("span", { class: "togrow" }, el("span", { class: "t" }, el("b", { style: { fontSize: "13px" } }, inp.label),
      inp.help ? el("small", {}, inp.help) : null), el("span", { class: "switch" }, box, el("i"))));
  }
  if (inp.type === "seed") {
    const box = el("input", { type: "number", min: inp.min ?? 0, placeholder: t("ws.seed.random"), value: f.values[inp.id] === -1 ? "" : f.values[inp.id] ?? "", "aria-label": inp.label });
    box.addEventListener("input", () => set(box.value === "" ? -1 : Math.trunc(Number(box.value))));
    return el("label", { class: "field" }, el("span", { class: "lbl" }, inp.label || t("ws.seed"),
      el("button", { class: "mini", type: "button", title: t("ws.seed.random"), style: { width: "26px", height: "26px" }, onclick: (e) => { e.preventDefault(); box.value = ""; set(-1); } }, icon("dice"))),
      box, el("p", { class: "help" }, t("ws.seed.help")));
  }
  const box = el("input", { type: inp.type === "number" ? "number" : "text", min: inp.min, max: inp.max, step: inp.step, value: f.values[inp.id] ?? "",
    placeholder: inp.default !== undefined ? String(inp.default) : "", "aria-label": inp.label });
  const frameRate = Number(inp.frameRate);
  const frameSeconds = Number.isFinite(frameRate) && frameRate > 0
    ? el("small", { class: "frame-seconds" })
    : null;
  const paintSeconds = () => {
    if (!frameSeconds) return;
    const frames = Number(box.value);
    frameSeconds.textContent = Number.isFinite(frames) && frames > 0 ? `${(frames / frameRate).toFixed(3)} s` : "";
  };
  box.addEventListener("input", () => {
    if (frameSeconds) {
      f.values[inp.id] = box.value === "" ? "" : Number(box.value);
      persistSoon();
      paintSeconds();
      return;
    }
    set(inp.type === "number" ? (box.value === "" ? "" : Number(box.value)) : box.value);
  });
  if (frameSeconds) box.addEventListener("framecommit", () => onChange?.(inp, f.values[inp.id]));
  paintSeconds();
  const label = el("span", { class: "lbl" }, inp.label, inp.required ? null : el("small", {}, t("ws.optional")));
  if (frameSeconds) return el("div", { class: "field" }, label, frameStepper(box, { readout: frameSeconds }), help);
  return el("label", { class: "field" }, label, box, help);
}

const isAdvanced = (inp) => inp.type === "seed" || /negative/.test(inp.id);

function presetField(app, f) {
  const opts = [{ id: "", label: t("ws.preset.none") }, ...app.presets];
  const seg = el("div", { class: "seg", role: "group", "aria-label": t("ws.preset") });
  const draw = () => seg.replaceChildren(...opts.map((p) => el("button", { type: "button", "aria-pressed": String(p.id === f.preset),
    onclick: () => { f.preset = p.id; persist(app); draw(); } }, p.label)));
  draw();
  return el("div", { class: "field" }, el("span", { class: "lbl" }, t("ws.preset")), seg);
}

const SIDE_MIN = 280;
const SIDE_MAX = 680;
const SIDE_DEFAULT = 340;

function sideMax() {
  return Math.min(SIDE_MAX, Math.max(SIDE_MIN + 120, window.innerWidth - 320));
}

function clampSideWidth(width) {
  const value = Number(width);
  return Math.max(SIDE_MIN, Math.min(sideMax(), Number.isFinite(value) ? value : SIDE_DEFAULT));
}

function sideResizer(side) {
  const handle = el("div", {
    class: "side-resizer",
    role: "separator",
    tabindex: "0",
    "aria-orientation": "vertical",
    "aria-label": t("ws.resize"),
    title: t("ws.resize"),
    "aria-valuemin": String(SIDE_MIN),
    "aria-valuemax": String(sideMax()),
    "aria-valuenow": String(clampSideWidth(store.get("side.w", SIDE_DEFAULT))),
  });
  const apply = (width) => {
    const root = side.closest(".ws");
    const next = clampSideWidth(width);
    root?.style.setProperty("--side-w", `${next}px`);
    handle.setAttribute("aria-valuenow", String(Math.round(next)));
    handle.setAttribute("aria-valuemax", String(Math.round(sideMax())));
    return next;
  };
  const current = () => measureSideWidth(side);
  let dragging = false;
  let startX = 0;
  let startWidth = SIDE_DEFAULT;

  const finish = () => {
    if (!dragging) return;
    dragging = false;
    side.closest(".ws")?.classList.remove("resizing");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    store.set("side.w", Math.round(current()));
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", finish);
    window.removeEventListener("pointercancel", finish);
  };
  const move = (e) => {
    if (!dragging) return;
    apply(startWidth + e.clientX - startX);
  };

  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragging = true;
    startX = e.clientX;
    startWidth = current();
    side.closest(".ws")?.classList.add("resizing");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    handle.focus();
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  });

  handle.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 48 : 16;
    let delta = 0;
    if (e.key === "ArrowLeft") delta = -step;
    else if (e.key === "ArrowRight") delta = step;
    else if (e.key === "Home") return (e.preventDefault(), storeSideWidth(apply(SIDE_MIN)));
    else if (e.key === "End") return (e.preventDefault(), storeSideWidth(apply(sideMax())));
    if (!delta) return;
    e.preventDefault();
    storeSideWidth(apply(current() + delta));
  });

  handle.addEventListener("dblclick", () => storeSideWidth(apply(SIDE_DEFAULT)));
  return handle;
}

function measureSideWidth(side) {
  const width = side.getBoundingClientRect().width;
  return width ? width : clampSideWidth(store.get("side.w", SIDE_DEFAULT));
}

function storeSideWidth(width) {
  store.set("side.w", Math.round(width));
}

function sidebarPanel(app, rerenderSide) {
  const f = formFor(app);
  const caps = h3CapsSync();
  const ui = { refs: {} };
  const tab = videoTabOf(app.id);
  const tabs = tab ? el("div", { class: "side-tabs", role: "tablist" }, ...VIDEO_TABS.map((vt) => el("button", { type: "button", role: "tab",
    "aria-selected": String(vt.id === tab),
    onclick: () => {
      if (vt.id === tab) return;
      const last = store.get(`last.vtab.${vt.id}`);
      const target = vt.apps.includes(last) && byId.has(last) ? last : vt.apps.find((id) => byId.has(id));
      if (target) location.hash = `#/app/${target}`;
    } }, t(`vtab.${vt.id}`)))) : null;

  const ex = exampleItem(app);
  const card = el("div", { class: `model-card${ex ? "" : " empty"}`, role: "button", tabindex: "0", "aria-label": `${t("ws.change")}: ${app.name}` });
  const cardMedia = ex ? thumb(ex, { play: "visible" }) : el("div", { class: "media" }, el("span", { class: "placeholder" }, icon(iconOf(app))));
  card.append(cardMedia, el("div", { class: "txt" }, el("h3", { class: "display" }, app.name), el("p", {}, tagline(app))));
  const change = el("button", { class: "change", type: "button" }, icon("swap"), t("ws.change"));
  const openSwitch = (ev) => { ev.stopPropagation(); popover(change, switcher(app), { width: 340 }); };
  change.onclick = openSwitch;
  card.onclick = openSwitch;
  card.onkeydown = (e) => { if (e.key === "Enter") openSwitch(e); };
  card.append(change);

  if (app.id === "h3-regenerate-2k-ic" && f.values.resolution === "4k") f.values.vae = "standard";
  const durationInput = app.backend === "sglang" ? app.inputs.find((inp) => inp.id === "duration") : null;
  if (durationInput) {
    durationInput.max = Math.min(15, Number(durationInput.max) || 15, Number(caps.max_seconds) || 15);
    f.values.duration = Math.min(Number(f.values.duration) || 5, durationInput.max);
  }
  const extendDuration = app.id === "h3-extend-sglang" ? durationInput : null;
  const setExtendDurationMax = (contextFrames) => {
    if (!extendDuration) return;
    const max = Math.max(2, h3DurationMax(caps, contextFrames));
    extendDuration.max = max;
    f.values.duration = Math.min(max, Math.max(Number(extendDuration.min || 2), Number(f.values.duration) || 5));
  };
  if (extendDuration) setExtendDurationMax(f.values.context ?? 63);
  const onValue = (inp, value) => {
    if (app.id === "h3-extend-sglang") {
      if (inp.id === "context") { setExtendDurationMax(value); rerenderSide(); }
      else if (inp.id === "ref_video_audio") rerenderSide();
      return;
    }
    if (app.id !== "h3-regenerate-2k-ic") {
      if (inp.id === "ref_video_audio") rerenderSide();
      return;
    }
    if (inp.id === "resolution" && value === "4k" && f.values.vae !== "standard") {
      f.values.vae = "standard";
      rerenderSide();
    } else if (inp.id === "vae" && value !== "standard" && f.values.resolution === "4k") {
      f.values.vae = "standard";
      rerenderSide();
    } else if (inp.id === "ref_video_audio") {
      rerenderSide();
    }
  };
  const main = [], adv = [];
  for (const inp of app.inputs) {
    if (isMedia(inp.type)) main.push(dropzone(app, inp, rerenderSide));
    else (isAdvanced(inp) ? adv : main).push(sideField(app, inp, f, ui, onValue));
  }
  if (app.presets?.length) adv.unshift(presetField(app, f));
  if (app.inputs.some((i) => i.type === "video" || i.type === "audio")) main.push(refBudget(app));
  if (app.backend === "sglang") main.push(el("p", { class: "help h3-capacity" }, h3CapacityText(caps)));
  if (app.backend === "sglang" && !h3CapsLoaded()) h3Caps().then(() => rerenderSide());
  const advanced = adv.length ? el("details", { class: "adv" }, el("summary", {}, t("ws.advanced"), icon("chevD", "i-chev")), el("div", { class: "in" }, ...adv)) : null;

  const promptOffer = app.id === "h3-regenerate-2k-ic" && pendingICPrompt && !String(f.values.prompt ?? "").trim()
    ? el("div", { class: "prompt-offer" },
      el("b", {}, t("ws.prompt.offer.title")),
      el("p", {}, t("ws.prompt.offer.warn")),
      el("div", { class: "row" },
        el("button", { class: "btn small lime", type: "button", onclick: () => { f.values.prompt = pendingICPrompt; persist(app); pendingICPrompt = ""; rerenderSide(); } }, t("ws.prompt.offer.use")),
        el("button", { class: "btn small ghost", type: "button", onclick: () => { pendingICPrompt = ""; rerenderSide(); } }, t("ws.prompt.offer.skip"))))
    : null;
  const scroll = el("div", { class: "side-scroll" }, card, modeSwitch(app), promptOffer, ...main, advanced);
  const note = el("p", { class: "side-note" }, !app.runnable ? (app.status === "draft" ? t("ws.draft") : t("ws.noworkflow")) : "");
  ui.clearMissing = () => { scroll.querySelectorAll(".missing").forEach((n) => n.classList.remove("missing")); };
  ui.markMissing = (id) => {
    const n = ui.refs[id] || scroll.querySelector(`[data-slot="${id}"]`);
    if (!n) return;
    n.classList.add("missing");
    n.scrollIntoView({ block: "center", behavior: "smooth" });
  };
  const go = async () => { if (await submit(app, ui) && wsTab !== "history") { wsTab = "history"; hooks.rerender?.(); } };
  const foot = el("div", { class: "side-foot" }, el("div", { class: "row" }, countControl(f), genButton(app, go)), note);
  const side = el("aside", { class: "side", "aria-label": app.name }, tabs, scroll, foot);
  side.append(sideResizer(side));
  side.addEventListener("dragover", (e) => e.preventDefault());
  side.addEventListener("drop", (e) => { e.preventDefault(); e.stopPropagation(); if (assignFiles(app, e.dataTransfer.files)) rerenderSide(); });
  return side;
}

// ------------------------------------------------------------------ main area: history, library, how it works
let wsTab = "history";
let dense = store.get("dense", false);

function relatedExamples(app) {
  const cat = categoryOf(app.id);
  const same = (CATEGORIES.find((c) => c.id === cat)?.apps || []).filter((id) => id !== app.id).map((id) => byId.get(id)).filter((a) => a?.example);
  const rest = apps.filter((a) => a.example?.full && a.id !== app.id && !same.includes(a) && a.section === app.section);
  return [...same, ...rest].slice(0, 12);
}

function exampleTiles(list, { onPick } = {}) {
  return list.map((a) => {
    const item = exampleItem(a);
    const m = thumb(item, { play: "visible" });
    const node = el("div", { class: "m-item", role: "button", tabindex: "0", onclick: () => onPick?.(a), onkeydown: (e) => { if (e.key === "Enter") onPick?.(a); } },
      m, el("div", { class: "cap" }, el("span", {}, a.name), icon("chevR")));
    return node;
  });
}

function heroFlow(app) {
  const item = exampleItem(app);
  if (!item) return null;
  const ins = item.inputs.slice(0, 2).map((i) => el("div", { class: "media" }, i.thumb ? el("img", { src: i.thumb, alt: i.label, title: i.label }) : el("span", { class: "typeicon" }, icon(i.type || "image"))));
  return el("div", { class: "flow" },
    ins.length ? el("div", { class: "ins" }, ...ins) : null,
    ins.length ? el("span", { class: "arrow" }, icon("chevR")) : null,
    el("div", { class: "out" }, thumb(item, { play: "visible", useFull: item.type === "video" })));
}

function emptyFor(app, layout) {
  const item = exampleItem(app);
  const load = () => item && recreate(item);
  if (layout === "composer") {
    return el("div", { class: "feed-empty" }, el("div", {},
      el("div", { class: "glass" }, icon(iconOf(app))),
      el("h2", { class: "display" }, t("ws.create.title"), el("span", {}, app.name)),
      el("p", {}, app.summary),
      item ? el("button", { class: "ex", type: "button", onclick: load }, thumb(item, { play: "visible" }),
        el("span", {}, el("b", {}, t("ws.example")), el("small", {}, t("ws.useex")))) : null));
  }
  const related = relatedExamples(app);
  const grid = el("div");
  if (related.length) masonry(grid, exampleTiles(related, { onPick: (a) => { location.hash = `#/app/${a.id}`; } }), { min: 230 });
  return el("div", { style: { display: "grid", gap: "8px" } },
    el("section", { class: "ws-hero" },
      el("div", {}, el("h1", { class: "display" }, tagline(app)), el("p", {}, app.summary),
        el("div", { class: "row" },
          item ? el("button", { class: "btn lime", type: "button", onclick: load }, icon("redo"), t("ws.useex")) : null,
          el("button", { class: "btn ghost", type: "button", onclick: () => { wsTab = "how"; hooks.rerender?.(); } }, icon("info"), t("ws.how")))),
      heroFlow(app)),
    related.length ? el("div", { class: "sec-head" }, el("div", {}, el("h2", { class: "display" }, t("ws.related")))) : null,
    grid);
}

function valueRows(app, values) {
  const labels = Object.fromEntries(app.inputs.map((i) => [i.id, i]));
  const pi = promptInput(app);
  return Object.entries(values || {}).filter(([k, v]) => labels[k] && labels[k] !== pi && labels[k].type !== "seed" && v !== "" && v !== null && v !== undefined)
    .flatMap(([k, v]) => [el("dt", {}, labels[k].label), el("dd", {}, labels[k].type === "select" ? optionLabel(labels[k], v) : labels[k].type === "toggle" ? (v === true || v === "true" ? "✓" : "—") : String(v))]);
}

function libraryTab(app) {
  const item = exampleItem(app);
  const wrap = el("div", { style: { display: "grid", gap: "8px" } });
  if (item) {
    const pi = promptInput(app);
    const prompt = pi ? item.values?.[pi.id] : null;
    wrap.append(el("section", { class: "ex-big" },
      el("div", { class: "stage" }, fullMedia(item.type, item.full, { poster: item.poster, autoplay: false })),
      el("div", { class: "side2" },
        el("div", {}, el("span", { class: "tag ghost" }, t("ws.example")), el("h2", { class: "display", style: { margin: "10px 0 0", fontSize: "26px" } }, app.name)),
        prompt ? el("div", { class: "prompt", style: { padding: "12px", borderRadius: "12px", background: "#1b1b1e", fontSize: "13.5px" } }, prompt) : null,
        item.inputs.length ? el("div", { class: "ins-row" }, ...item.inputs.map((i) => el("figure", {},
          el("div", { class: "media" }, i.thumb ? el("img", { src: i.thumb, alt: "" }) : el("span", { class: "typeicon" }, icon(i.type || "image"))), el("figcaption", {}, i.label)))) : null,
        el("dl", { class: "vals" }, ...valueRows(app, item.values)),
        el("div", { class: "statline" },
          item.seconds ? el("span", {}, icon("clock"), fmtSeconds(item.seconds)) : null,
          item.gpu ? el("span", {}, icon("chip"), item.gpu.split(",")[0]) : null,
          item.peak ? el("span", {}, t("view.peak", { gb: item.peak })) : null,
          item.seed !== null && item.seed !== undefined ? el("span", {}, icon("dice"), item.seed) : null),
        el("div", { class: "row", style: { display: "flex", gap: "8px", flexWrap: "wrap" } },
          el("button", { class: "btn lime", type: "button", onclick: () => recreate(item) }, icon("redo"), t("ws.useex")),
          el("button", { class: "btn ghost", type: "button", onclick: () => hooks.compare?.(item) }, icon("compare"), t("act.compare")),
          flagButton(flags.key(app.id))))));
  }
  const related = relatedExamples(app);
  if (related.length) {
    const grid = el("div");
    masonry(grid, exampleTiles(related, { onPick: (a) => { location.hash = `#/app/${a.id}`; } }), { min: 230 });
    wrap.append(el("div", { class: "sec-head" }, el("h2", { class: "display" }, t("ws.related"))), grid);
  }
  if (!item && !related.length) wrap.append(el("div", { class: "empty" }, t("explore.noex")));
  return wrap;
}

function vramBars(app) {
  const v = app.vram;
  if (!v) return null;
  const peak = app.example?.peak_vram_gb ?? null;
  const max = Math.max(48, v.whole_gb, peak || 0) * 1.05;
  const pct = (gb) => `${Math.min(100, (gb / max) * 100)}%`;
  const ticks = [24, 48].map((g) => el("u", { style: { left: pct(g) }, title: `${g} GB` }));
  const row = (label, gb, cls) => el("div", { style: { display: "grid", gap: "6px" } },
    el("div", { style: { display: "flex", justifyContent: "space-between", fontSize: "12.5px" } }, el("span", { class: "dim" }, label), el("b", {}, `${gb} GB`)),
    el("div", { class: "vbar" }, el("i", { class: cls, style: { width: pct(gb) } }), ...ticks));
  const fit = fitOf(app);
  return el("div", { class: "card" }, el("h3", {}, icon("chip"), t("how.vram"), fit ? el("span", { class: `fit ${fit[1]}`, style: { marginLeft: "auto" } }, t(fit[0])) : null),
    row(t("how.whole"), v.whole_gb, "whole"), row(t("how.phase"), v.largest_phase_gb, ""),
    peak ? row(`${t("how.measured")} (${(app.example.gpu || "").split(",")[0]})`, peak, "whole") : null,
    el("div", { class: "vscale" }, el("span", { style: { left: pct(24) } }, "24 GB"), el("span", { style: { left: pct(48) } }, "48 GB")));
}

function cliLine(app) {
  const parts = ["npm run app --", app.id];
  for (const inp of app.inputs) {
    if (isMedia(inp.type)) {
      if (inp.required) {
        const ext = inp.type === "image" ? "jpg" : inp.type === "video" ? "mp4" : "mp3";
        const n = inp.multiple ? Math.min(2, inp.multiple.max ?? 2) : 1;
        for (let i = 0; i < n; i++) parts.push(`--file ${inp.id}=my-${inp.type}${n > 1 ? `-${i + 1}` : ""}.${ext}`);
      }
      continue;
    }
    if (inp.required && inp.type === "textarea") parts.push(`--set ${inp.id}="${String(inp.default || "…").slice(0, 40)}"`);
  }
  return parts.join(" ");
}

function howTab(app) {
  const total = app.models.filter((m) => !m.optional).reduce((s, m) => s + m.gb, 0);
  return el("div", { class: "how-grid" },
    el("div", { class: "card" }, el("h3", {}, icon("layers"), t("how.pipeline")), el("p", {}, t("how.pipeline.d", { id: app.id })),
      el("div", { class: "statline" }, el("span", {}, `${t("how.pack")}: ${app.pack}`), el("span", {}, app.status === "ready" ? "ready" : t("tag.draft")),
        app.higgsfield_feature ? el("span", {}, `${t("how.equiv")}: ${app.higgsfield_feature}`) : null),
      app.runnable || app.status === "draft" ? el("p", { class: "row" }, el("a", { class: "btn small", href: `/api/apps/${app.id}/workflow`, download: `freefield-${app.id}.json` },
        icon("download"), t("how.workflow")), el("span", { class: "dim", style: { fontSize: "12.5px" } }, t("how.workflow.d"))) : null,
      el("p", {}, t("how.download")), el("pre", { class: "code" }, `modal run infra/modal_app.py::download --pack ${app.pack}`),
      el("p", {}, t("how.cli")), el("pre", { class: "code" }, cliLine(app))),
    app.models.length ? el("div", { class: "card" }, el("h3", {}, icon("box"), t("how.models"), el("span", { class: "dim", style: { marginLeft: "auto", fontWeight: 500 } }, t("how.total", { gb: total.toFixed(1) }))),
      el("table", { class: "models" }, el("tbody", {}, ...app.models.map((m) => el("tr", {},
        el("td", {}, el("div", {}, m.name), el("small", { class: "dim" }, [m.repo, m.license, m.gated ? t("how.gated") : "", m.optional ? t("how.optional") : ""].filter(Boolean).join(" · "))),
        el("td", { class: "r" }, `${m.gb} GB`)))))) : null,
    vramBars(app),
    app.notes || app.credits?.length ? el("div", { class: "card" },
      app.notes ? el("h3", {}, icon("info"), t("how.notes")) : null, app.notes ? el("p", {}, app.notes) : null,
      app.credits?.length ? el("h3", {}, t("how.credits")) : null, app.credits?.length ? el("p", {}, app.credits.join(" · ")) : null) : null);
}

function mainArea(app, layout, disposers) {
  const body = el("div", { class: "ws-body", style: { display: "flex", flexDirection: "column", flex: "1", minHeight: "0" } });
  const tabs = el("div", { class: "tabs", role: "tablist" });
  const denseBtn = el("button", { class: "icon-btn", type: "button", title: t("ws.dense"), "aria-label": t("ws.dense"), "aria-pressed": String(dense) });
  let disposeBody = null;
  const draw = () => {
    tabs.replaceChildren(...[["history", "clock"], ["library", "film"], ["how", "info"]].map(([id, ic]) => el("button", { type: "button", role: "tab",
      "aria-selected": String(wsTab === id), onclick: () => { wsTab = id; draw(); } }, icon(ic), t(`ws.${id}`))));
    denseBtn.replaceChildren(icon(dense ? "rows" : "grid"));
    denseBtn.hidden = wsTab !== "history";
    disposeBody?.();
    disposeBody = null;
    if (wsTab === "history") disposeBody = feedView(body, { app: app.id, empty: () => emptyFor(app, layout), dense });
    else body.replaceChildren(wsTab === "library" ? libraryTab(app) : howTab(app));
  };
  denseBtn.onclick = () => { dense = !dense; store.set("dense", dense); denseBtn.setAttribute("aria-pressed", String(dense)); draw(); };
  draw();
  disposers.push(() => disposeBody?.());
  return el("section", { class: "ws-main" }, el("div", { class: "ws-top" }, tabs, el("div", { class: "right" }, denseBtn)), body);
}

// ------------------------------------------------------------------ the view
export function workspaceView(appId) {
  const app = byId.get(appId);
  if (!app) return { node: el("div", { class: "page" }, el("div", { class: "empty" }, `${appId}?`)), active: "apps" };
  rememberApp(app);
  const vt = videoTabOf(app.id);
  if (vt) store.set(`last.vtab.${vt}`, app.id);
  const layout = layoutOf(app);
  const disposers = [];
  const root = el("div", { class: `ws l-${layout}` });
  if (layout === "sidebar") root.style.setProperty("--side-w", `${clampSideWidth(store.get("side.w", SIDE_DEFAULT))}px`);
  const clampRootSide = () => {
    if (layout !== "sidebar") return;
    const width = parseFloat(getComputedStyle(root).getPropertyValue("--side-w"));
    const next = clampSideWidth(width);
    if (Number.isFinite(width) && next !== width) root.style.setProperty("--side-w", `${next}px`);
  };
  window.addEventListener("resize", clampRootSide);
  disposers.push(() => window.removeEventListener("resize", clampRootSide));

  if (layout === "composer") {
    let bar = null;
    const drawBar = () => { const next = composerBar(app, drawBar); bar ? bar.replaceWith(next) : null; bar = next; if (!bar.isConnected) root.append(bar); };
    root.append(mainArea(app, layout, disposers));
    drawBar();
    // drop files anywhere on the page
    const over = (e) => { if ([...(e.dataTransfer?.types || [])].includes("Files")) { e.preventDefault(); bar.classList.add("drag"); } };
    const leave = (e) => { if (!e.relatedTarget) bar.classList.remove("drag"); };
    const drop = (e) => { if (!e.dataTransfer?.files?.length) return; e.preventDefault(); bar.classList.remove("drag"); if (assignFiles(app, e.dataTransfer.files)) drawBar(); };
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    disposers.push(() => { window.removeEventListener("dragover", over); window.removeEventListener("dragleave", leave); window.removeEventListener("drop", drop); });
    disposers.push(() => bar?.remove());
    const paste = (e) => { const files = [...(e.clipboardData?.files || [])]; if (files.length && assignFiles(app, files)) { e.preventDefault(); drawBar(); } };
    document.addEventListener("paste", paste);
    disposers.push(() => document.removeEventListener("paste", paste));
  } else {
    let side = null;
    const drawSide = () => {
      const scrollTop = side?.querySelector(".side-scroll")?.scrollTop || 0;
      const next = sidebarPanel(app, drawSide);
      if (side) side.replaceWith(next); else root.prepend(next);
      side = next;
      side.querySelector(".side-scroll").scrollTop = scrollTop;
    };
    root.append(mainArea(app, layout, disposers));
    drawSide();
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
    const over = (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } };
    const drop = (e) => {
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault();
      if (assignFiles(app, e.dataTransfer.files)) drawSide();
    };
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    disposers.push(() => { window.removeEventListener("dragover", over); window.removeEventListener("drop", drop); });
    const paste = (e) => { const files = [...(e.clipboardData?.files || [])]; if (files.length && assignFiles(app, files)) { e.preventDefault(); drawSide(); } };
    document.addEventListener("paste", paste);
    disposers.push(() => document.removeEventListener("paste", paste));
  }
  return { node: root, dispose: () => disposers.forEach((d) => d()), app };
}

/** For the viewer's "Recreate" and the feed's "Try again". */
export function setTab(tab) { wsTab = tab; }
export { submit as submitApp, hoverPlay, playWhenVisible, sideResizer };













