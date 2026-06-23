/**
 * Zero-dependency static file server for the QA Dashboard public/ directory.
 * Usage: node test/static-server.js [port]
 * Port: first arg | PORT env | 8090.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = parseInt(process.argv[2] || process.env.PORT || "8090", 10);

// Resolve public/ relative to this file: test/static-server.js → ../public/
const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const server = createServer(async (req, res) => {
  // Strip query string and decode URI
  let pathname = decodeURIComponent(req.url.split("?")[0]);

  // Serve index.html for root
  if (pathname === "/") pathname = "/index.html";

  const filePath = join(PUBLIC_DIR, pathname);

  // Resolve content-type; default to octet-stream
  const ext = extname(filePath).toLowerCase();
  const contentType = MIME[ext] || "application/octet-stream";

  try {
    const data = await readFile(filePath);
    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("404 Not Found");
  }
});

// Only listen when run directly (e.g. by Playwright's webServer), NOT when imported.
// `node --test` scans every .js under test/ and would otherwise import this file and
// hang on a server that never exits.
if (import.meta.url === `file://${process.argv[1]}`) {
  server.listen(PORT, () => {
    console.log(`listening on ${PORT}`);
  });
}
