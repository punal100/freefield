export type MergeQuality = "copy" | "high" | "balanced" | "small";

export type MergeProbe = {
  duration: number | null;
  fps: number | null;
  frames: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  hasAudio: boolean;
};

export type MergePreset = {
  label: string;
  crf: number | null;
  preset: string | null;
  audioBitrate: string | null;
};

export const MERGE_PRESETS: Record<MergeQuality, MergePreset> = {
  copy: { label: "Match source", crf: null, preset: null, audioBitrate: null },
  high: { label: "High quality", crf: 16, preset: "slow", audioBitrate: "192k" },
  balanced: { label: "Balanced", crf: 20, preset: "medium", audioBitrate: "160k" },
  small: { label: "Small file", crf: 24, preset: "medium", audioBitrate: "128k" },
};

export function mergePreset(value: unknown): { quality: MergeQuality; preset: MergePreset } {
  const quality = String(value || "balanced") as MergeQuality;
  if (!(quality in MERGE_PRESETS)) throw new Error("merge quality must be copy, high, balanced or small");
  return { quality, preset: MERGE_PRESETS[quality] };
}

/** Stream copy only works when every clip has the same encodable track layout. */
export function streamCopyProblem(probes: MergeProbe[]): string | null {
  const first = probes[0];
  if (!first) return "no source clips";
  if (!["h264", "hevc"].includes(String(first.videoCodec))) return "source video codec is not H.264 or HEVC";
  if (!first.width || !first.height) return "source dimensions are unavailable";
  for (const [index, probe] of probes.entries()) {
    const n = index + 1;
    if (!["h264", "hevc"].includes(String(probe.videoCodec))) return `clip ${n} is not H.264 or HEVC`;
    if (probe.width !== first.width || probe.height !== first.height) return `clip ${n} has different dimensions`;
    if (!probe.fps || !first.fps || Math.abs(probe.fps - first.fps) > 0.01) return `clip ${n} has a different frame rate`;
    if (probe.hasAudio !== first.hasAudio) return `clip ${n} differs in audio presence`;
    if (probe.hasAudio) {
      if (!["aac", "mp3"].includes(String(probe.audioCodec))) return `clip ${n} audio is not AAC or MP3`;
      if (probe.audioCodec !== first.audioCodec) return `clip ${n} audio codec differs`;
    }
    if (probe.duration === null || probe.duration <= 0) return `clip ${n} duration is unavailable`;
  }
  return null;
}

export function mergeTarget(probes: MergeProbe[], fallbackFps: number | null): { width: number; height: number; fps: number; hasAudio: boolean } {
  const first = probes[0];
  if (!first?.width || !first.height) throw new Error("first clip dimensions are unavailable");
  const fps = first.fps ?? fallbackFps;
  if (!fps || fps <= 0) throw new Error("first clip frame rate is unavailable");
  return {
    width: Math.max(2, Math.round(first.width / 2) * 2),
    height: Math.max(2, Math.round(first.height / 2) * 2),
    fps: Math.round(fps * 1000) / 1000,
    hasAudio: probes.some((probe) => probe.hasAudio),
  };
}

export function mergeFilter(probes: MergeProbe[], target: { width: number; height: number; fps: number; hasAudio: boolean }): string {
  const filters: string[] = [];
  for (const [index, probe] of probes.entries()) {
    filters.push(`[${index}:v]scale=${target.width}:${target.height}:force_original_aspect_ratio=decrease,pad=${target.width}:${target.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${target.fps},format=yuv420p[v${index}]`);
    if (target.hasAudio) {
      if (probe.hasAudio) {
        filters.push(`[${index}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a${index}]`);
      } else {
        const duration = Math.max(0.001, Number(probe.duration) || 0.001);
        filters.push(`anullsrc=r=48000:cl=stereo,atrim=0:${duration},asetpts=PTS-STARTPTS[a${index}]`);
      }
    }
  }
  const inputs = probes.map((_, index) => target.hasAudio ? `[v${index}][a${index}]` : `[v${index}]`).join("");
  filters.push(`${inputs}concat=n=${probes.length}:v=1:a=${target.hasAudio ? 1 : 0}[v${target.hasAudio ? "out" : ""}]${target.hasAudio ? "[aout]" : ""}`);
  return filters.join(";");
}
