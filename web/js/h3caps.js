import { api } from "./util.js";

export const H3_OFFICIAL = {
  profile: null,
  max_seconds: 15,
  max_refs: 12,
  max_images: 9,
  max_videos: 3,
  max_audios: 3,
  official_max_seconds: 15,
  reference_clip_seconds: [2, 15],
  reference_total_seconds: { video: 15, audio: 15 },
  source: "official",
  available: false,
};

let cached = null;
let pending = null;

export function h3CapsLoaded() { return Boolean(cached); }

export function h3CapsSync() {
  return cached || H3_OFFICIAL;
}

export function h3Caps() {
  if (cached) return Promise.resolve(cached);
  pending ??= api("/api/h3/capabilities")
    .then((data) => (cached = { ...H3_OFFICIAL, ...(data || {}) }))
    .catch(() => (cached = { ...H3_OFFICIAL, error: "GPU capacity unavailable" }))
    .finally(() => { pending = null; });
  return pending;
}

export function h3CapacityText(caps = h3CapsSync()) {
  const max = Number(caps.max_seconds) || 15;
  const official = Number(caps.official_max_seconds) || 15;
  const gpu = max < official ? `GPU limit ${max}s` : "official 15s";
  return caps.available
    ? `GPU profile ${caps.profile || "unknown"} · output 4–${max}s (${gpu})`
    : "GPU capacity unavailable · official 4–15s";
}

export function h3DurationMax(caps = h3CapsSync(), contextFrames = 0) {
  const max = Math.min(15, Number(caps.max_seconds) || 15);
  return Math.max(4, Math.floor(max - Number(contextFrames || 0) / 24));
}

