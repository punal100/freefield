import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname } from "node:path";
import { PrepInputError, type PrepService } from "./service.ts";

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function json(req: IncomingMessage, maxBytes = 2 ** 20): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new PrepInputError("request body is too large");
    chunks.push(buffer);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value as Record<string, unknown>;
  } catch {
    throw new PrepInputError("request body must be a JSON object");
  }
}

const MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".m4v": "video/x-m4v",
};

export async function handlePrep(
  service: PrepService,
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  url: URL,
): Promise<boolean> {
  if (parts[0] !== "api" || parts[1] !== "prep") return false;
  try {
    if (req.method === "GET" && parts.length === 3 && parts[2] === "capabilities") {
      send(res, 200, service.capabilityResult());
      return true;
    }
    if (req.method === "POST" && parts.length === 3 && parts[2] === "analyze") {
      const name = url.searchParams.get("name") || "source";
      const source = await service.analyze(req, name);
      send(res, 200, { id: source.id, name: source.name, probe: source.probe });
      return true;
    }
    if (req.method === "POST" && parts.length === 3 && parts[2] === "plan") {
      send(res, 200, service.plan(await json(req)));
      return true;
    }
    if (req.method === "POST" && parts.length === 3 && parts[2] === "export") {
      send(res, 200, await service.export(await json(req)));
      return true;
    }
    if (req.method === "GET" && parts.length === 5 && parts[2] === "files") {
      const path = service.file(parts[3], parts[4]);
      if (!path) { send(res, 404, { error: "file not found" }); return true; }
      const info = await stat(path);
      const ext = extname(path).toLowerCase();
      res.writeHead(200, {
        "content-type": MIME[ext] || "application/octet-stream",
        "content-length": info.size,
        "cache-control": "no-store",
      });
      createReadStream(path).pipe(res);
      return true;
    }
    send(res, 404, { error: "not found" });
    return true;
  } catch (error) {
    const message = error instanceof PrepInputError || error instanceof Error ? error.message : String(error);
    send(res, error instanceof PrepInputError ? 400 : 500, { error: message });
    return true;
  }
}
