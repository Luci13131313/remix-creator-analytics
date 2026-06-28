// Live analytics server with in-app onboarding.
// The API key is held in server memory (and optionally saved to a gitignored
// .remix-key file). The browser sends the key once via POST /api/key over
// localhost and never receives it back — only aggregated stats are served.
// Usage: node server.mjs [--port 8787] [--fast] [--interval 300]
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fetchAll, validateKey, readKey } from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (flag, def) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const PORT = Number(arg("--port", 8787));
const FULL = !process.argv.includes("--fast");
const INTERVAL = Number(arg("--interval", 300)) * 1000;

let apiKey = null;
let cache = null;
let refreshing = false;
let lastError = null;

// Seed from env/.remix-key/.mcp.json if present (so power users skip onboarding).
try {
  apiKey = readKey();
  console.log("Key found via env/.remix-key/.mcp.json — onboarding skipped.");
} catch {
  console.log("No key configured — open the dashboard to paste your Remix API key.");
}

async function refresh() {
  if (refreshing || !apiKey) return;
  refreshing = true;
  const t = Date.now();
  try {
    cache = await fetchAll({ full: FULL, key: apiKey });
    lastError = null;
    console.log(`[refresh] ${cache.totalGames} games · ${cache.totalPlays} scores · ${cache.globalUnique} players (${((Date.now() - t) / 1000).toFixed(1)}s)`);
  } catch (e) {
    lastError = String(e.message || e);
    console.error("[refresh] failed:", lastError);
  } finally {
    refreshing = false;
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      try { resolve(JSON.parse(b || "{}")); } catch { resolve({}); }
    });
  });
}

function send(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(obj));
}

const html = readFileSync(join(HERE, "dashboard.html"), "utf8");

createServer(async (req, res) => {
  const url = req.url.split("?")[0];

  if (url === "/api/status") {
    return send(res, 200, {
      hasKey: !!apiKey,
      hasData: !!cache,
      refreshing,
      generatedAt: cache?.generatedAt || null,
      error: lastError,
    });
  }

  if (url === "/api/key" && req.method === "POST") {
    const { key } = await readBody(req);
    if (!key || typeof key !== "string") return send(res, 400, { ok: false, error: "missing key" });
    const v = await validateKey(key.trim());
    if (!v.ok) return send(res, 401, { ok: false, error: v.error });
    apiKey = key.trim();
    try { writeFileSync(join(HERE, ".remix-key"), apiKey + "\n"); } catch {}
    refresh(); // kick off in background
    return send(res, 200, { ok: true, games: v.count });
  }

  if (url === "/api/data") {
    if (!apiKey) return send(res, 401, { needKey: true });
    if (!cache) await refresh();
    return send(res, 200, cache || {});
  }

  if (url === "/api/refresh" && req.method === "POST") {
    await refresh();
    return send(res, 200, { ok: true, generatedAt: cache?.generatedAt, error: lastError });
  }

  if (url === "/" || url === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(html);
  }

  res.writeHead(404);
  res.end("not found");
}).listen(PORT, () => {
  console.log(`Remix Analytics → http://localhost:${PORT}`);
  console.log(`  mode: ${FULL ? "full counts" : "fast/capped"} · refresh every ${INTERVAL / 1000}s`);
  refresh(); // no-op until a key exists
  setInterval(refresh, INTERVAL); // picks up automatically after onboarding
});
