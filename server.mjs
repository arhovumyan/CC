// Minimal zero-dependency static file server for container hosts
// (Railway, Render, Cloud Run, Fly, etc.). Serves the assembled web
// game from ./www on the port the host provides via $PORT.
//
// Run `npm run build:web` first to populate www/ (the start script does this).
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, normalize, extname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "www");
const port = process.env.PORT || 8080;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

async function send(res, filePath, status = 200) {
  const body = await readFile(filePath);
  res.writeHead(status, {
    "Content-Type": MIME[extname(filePath).toLowerCase()] || "application/octet-stream",
  });
  res.end(body);
}

const server = createServer(async (req, res) => {
  try {
    // Strip query string, prevent path traversal outside www/.
    const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    let rel = normalize(urlPath).replace(/^(\.\.[/\\])+/, "");
    if (rel === "/" || rel === "\\") rel = "/index.html";

    const target = join(root, rel);
    if (!target.startsWith(root)) {
      res.writeHead(403);
      return res.end("Forbidden");
    }

    const info = await stat(target).catch(() => null);
    if (info?.isFile()) return await send(res, target);
    if (info?.isDirectory()) return await send(res, join(target, "index.html"));

    // Unknown path → serve the app entry (single-page fallback).
    return await send(res, join(root, "index.html"));
  } catch (err) {
    res.writeHead(500);
    res.end("Internal Server Error");
    console.error(err);
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Match Duel served from ${root} on http://0.0.0.0:${port}`);
});
