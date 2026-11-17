// HTTP surface for long-form projects. Raw video uploads are streamed straight
// to staging by ProjectService; JSON endpoints cover planning, start, cancel,
// retry and progress/event snapshots.
import { createReadStream, statSync } from "node:fs";
import { extname } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ProjectService } from "./service.ts";
import { MediaError } from "./assets.ts";

const MIME: Record<string, string> = {
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4",
};

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function sendFile(req: IncomingMessage, res: ServerResponse, path: string): void {
  const size = statSync(path).size;
  const type = MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) { res.writeHead(416, { "content-range": `bytes */${size}` }); res.end(); return; }
    res.writeHead(206, { "content-type": type, "content-length": end - start + 1, "content-range": `bytes ${start}-${end}/${size}`, "accept-ranges": "bytes", "cache-control": "no-cache" });
    createReadStream(path, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { "content-type": type, "content-length": size, "accept-ranges": "bytes", "cache-control": "no-cache" });
  if (req.method === "HEAD") { res.end(); return; }
  createReadStream(path).pipe(res);
}

async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).byteLength;
    if (size > 2 ** 20) throw new MediaError("project JSON is too large");
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MediaError("expected a JSON object");
  return value as Record<string, unknown>;
}

/**
 * Returns false when the path is not a project route. The caller owns the final
 * error response, but media/validation errors are answered here for a useful message.
 */
export async function handleProjects(
  service: ProjectService,
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  url: URL,
): Promise<boolean> {
  if (parts[0] !== "api" || parts[1] !== "projects") return false;
  const [, , id, sub, arg] = parts;

  try {
    if (!id) {
      if (req.method === "GET") { send(res, 200, { projects: service.list() }); return true; }
      if (req.method === "POST") {
        const body = await jsonBody(req);
        const project = service.create({
          kind: String(body.kind ?? "both") as "extend" | "refine" | "both",
          targetSeconds: Number(body.targetSeconds ?? 120),
          prompt: typeof body.prompt === "string" ? body.prompt : "",
          visibleSeconds: body.visibleSeconds === undefined ? undefined : Number(body.visibleSeconds),
          contextFrames: body.contextFrames === undefined ? undefined : Number(body.contextFrames),
          steps: body.steps === undefined ? undefined : Number(body.steps),
          targetResolution: body.targetResolution === "1080p" ? "1080p" : "2k",
          sampler: body.sampler === "up4" || body.sampler === "hf8" ? body.sampler : "up3",
        });
        send(res, 202, service.get(project.id));
        return true;
      }
      return false;
    }

    if (id === "assets" && req.method === "GET" && sub) {
      const path = service.assetPath(sub);
      sendFile(req, res, path);
      return true;
    }

    if (!/^\d{8}-\d{6}-[a-f0-9]{4}$/.test(id)) { send(res, 404, { error: "unknown project" }); return true; }

    if (req.method === "GET" && !sub) {
      const project = service.get(id);
      send(res, project ? 200 : 404, project ?? { error: "unknown project" });
      return true;
    }
    if (req.method === "POST" && sub === "source") {
      const name = url.searchParams.get("name") || "source.mp4";
      send(res, 200, await service.uploadSource(id, req, name));
      return true;
    }
    if (req.method === "POST" && sub === "references") {
      const kind = url.searchParams.get("kind");
      if (kind !== "image" && kind !== "video" && kind !== "audio") throw new MediaError("kind must be image, video or audio");
      const name = url.searchParams.get("name") || `${kind}.bin`;
      send(res, 200, await service.addReference(id, kind, req, name));
      return true;
    }
    if (req.method === "POST" && sub === "start") { send(res, 202, service.start(id)); return true; }
    if (req.method === "POST" && sub === "cancel") { send(res, 200, service.cancel(id)); return true; }
    if (req.method === "POST" && sub === "retry") {
      const body = await jsonBody(req);
      const index = Number(body.index);
      if (!Number.isInteger(index) || index < 1) throw new MediaError("index must be a positive integer");
      send(res, 200, service.resetFailedSegment(id, index));
      return true;
    }
    if (req.method === "GET" && sub === "events") {
      const after = Number(url.searchParams.get("after") || 0);
      const project = service.get(id);
      if (!project) { send(res, 404, { error: "unknown project" }); return true; }
      send(res, 200, project);
      return true;
    }
    if ((req.method === "GET" || req.method === "HEAD") && sub === "files" && arg === "final") {
      const path = service.finalPath(id);
      if (!path) { send(res, 404, { error: "final video is not ready" }); return true; }
      sendFile(req, res, path);
      return true;
    }
    send(res, 404, { error: "not found" });
    return true;
  } catch (error) {
    const status = error instanceof MediaError ? 400 : 500;
    send(res, status, { error: (error as Error).message || String(error) });
    return true;
  }
}
