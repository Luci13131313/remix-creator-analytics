// Remix creator analytics — data layer.
// Syncs every live game's score feed from the Remix v1 API into a local SQLite
// DB (incrementally — only scores newer than the last sync), then aggregates
// from the DB into the object the dashboard/snapshot render from.
// The API key stays here (server-side only) and is NEVER written into output HTML.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  upsertGame, getSyncState, setSyncState, insertScores, aggregate,
} from "./db.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = "https://remix.gg/api/v1";
const ENV_FILE = join(HERE, ".env");

function readEnvFile() {
  if (!existsSync(ENV_FILE)) return null;
  const m = readFileSync(ENV_FILE, "utf8").match(/^\s*REMIX_API_KEY\s*=\s*(.+?)\s*$/m);
  return m ? m[1].replace(/^["']|["']$/g, "").trim() : null;
}

// Key resolution order: process env -> .env file -> legacy .remix-key -> repo .mcp.json.
export function readKey() {
  if (process.env.REMIX_API_KEY) return process.env.REMIX_API_KEY.trim();
  const fromEnv = readEnvFile();
  if (fromEnv) return fromEnv;
  const local = join(HERE, ".remix-key");
  if (existsSync(local)) {
    const k = readFileSync(local, "utf8").trim();
    if (k) return k;
  }
  const mcp = join(HERE, "..", "..", ".mcp.json");
  if (existsSync(mcp)) {
    const j = JSON.parse(readFileSync(mcp, "utf8"));
    const k = j?.mcpServers?.["remix-mcp"]?.env?.REMIX_API_KEY;
    if (k) return k.trim();
  }
  throw new Error("No Remix API key found (env REMIX_API_KEY, .env, .remix-key, or .mcp.json).");
}

// Persist the key to a local, git-ignored .env (preserving any other vars).
// This is the ONLY place the key is written — never to the browser/localStorage.
export function saveKeyToEnv(key) {
  let lines = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8").split(/\r?\n/) : [];
  let found = false;
  lines = lines.map((l) =>
    /^\s*REMIX_API_KEY\s*=/.test(l) ? ((found = true), `REMIX_API_KEY=${key}`) : l
  );
  if (!found) lines.push(`REMIX_API_KEY=${key}`);
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  writeFileSync(ENV_FILE, lines.join("\n") + "\n");
  return ENV_FILE;
}

const PAGE = 500;

async function api(path, key) {
  const res = await fetch(BASE + path, {
    headers: { Authorization: "Bearer " + key },
  });
  if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`);
  return res.json();
}

// Incrementally sync one game's score feed into the DB.
// The feed is ordered newest-first, so we walk pages from the top and stop as
// soon as we cross into rows we already have (achieved_at < last synced). The
// first run for a game (no prior state) walks to the very end = full backfill.
// `maxPages` caps the *first backfill* in --fast mode; capped runs leave
// fully_synced=0 so the UI shows a "+" until a full sync completes.
async function syncGame(game, key, { maxPages = Infinity }) {
  const gid = game.id;
  // Store/refresh the game record (map API's appImageUrl -> icon).
  upsertGame({
    id: gid,
    name: game.name,
    icon: game.appImageUrl || null,
    createdAt: game.createdAt || null,
    liveVersionId: game.liveVersionId || null,
  });

  const { lastSyncedAt, fullySynced } = getSyncState(gid);
  let cursor = null;
  let pages = 0;
  let reachedKnown = false;
  let drainedFeed = false;
  let newMax = lastSyncedAt; // highest achieved_at we end up with
  let added = 0;

  for (;;) {
    let p = `/games/${gid}/scores?limit=${PAGE}`;
    if (cursor) p += "&cursor=" + cursor;
    const d = await api(p, key);

    const batch = [];
    for (const s of d.scores) {
      const at = s.achieved_at;
      // Descending order: once we drop below the last synced timestamp,
      // everything beyond is already stored — flag and stop after this page.
      if (lastSyncedAt && at < lastSyncedAt) { reachedKnown = true; continue; }
      const u = s.user || {};
      batch.push({
        game_id: gid,
        user_id: u.id || u.username || "?",
        username: u.username ?? null,
        pfp: u.pfp ?? null,
        score: s.score ?? 0,
        achieved_at: at,
      });
      if (!newMax || at > newMax) newMax = at;
    }
    added += insertScores(batch);

    cursor = d.next_cursor;
    pages++;
    if (reachedKnown) break;        // caught up to known territory
    if (!cursor) { drainedFeed = true; break; } // hit the end of the feed
    if (pages >= maxPages) break;   // fast-mode cap on first backfill
  }

  // fully_synced becomes true once we've ever walked the whole feed, OR if this
  // was an incremental run that caught up to already-complete data.
  const nowFull = fullySynced || drainedFeed || (reachedKnown && !!lastSyncedAt);
  setSyncState(gid, newMax || lastSyncedAt, nowFull);
  return { gid, added, fullySynced: nowFull };
}

// Validate a key by hitting /games. Returns { ok, count } or { ok:false, error }.
export async function validateKey(key) {
  try {
    const d = await api("/games", key);
    return { ok: true, count: (d.games || []).length };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// Simple promise pool so we don't hammer the API with all games at once.
async function pool(items, size, worker) {
  const out = new Array(items.length);
  let i = 0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return out;
}

// Incrementally sync all live games into the DB. opts.full=true (default)
// removes the page cap so the first backfill captures full history.
export async function sync(opts = {}) {
  const { full = true, concurrency = 5, onProgress } = opts;
  const key = opts.key || readKey();
  const { games } = await api("/games", key);
  const maxPages = full ? Infinity : 60;
  let done = 0;
  let addedTotal = 0;

  await pool(games, concurrency, async (g) => {
    const r = await syncGame(g, key, { maxPages });
    addedTotal += r.added;
    done++;
    if (onProgress) onProgress(done, games.length, r);
  });

  return { games: games.length, added: addedTotal };
}

// Sync (network) then aggregate (from the DB) into the dashboard payload.
// Kept named fetchAll so server.mjs / build-snapshot.mjs need no changes.
export async function fetchAll(opts = {}) {
  await sync(opts);
  const data = aggregate({ generatedAt: new Date().toISOString() });
  data.full = opts.full !== false;
  return data;
}
