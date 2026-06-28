// Remix creator analytics — data layer.
// Pulls every live game's score feed + leaderboard from the Remix v1 API and
// aggregates it into a single compact object the dashboard/snapshot render from.
// The API key stays here (server-side only) and is NEVER written into output HTML.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = "https://remix.gg/api/v1";

// Key resolution order: env var -> local .remix-key file -> repo .mcp.json.
export function readKey() {
  if (process.env.REMIX_API_KEY) return process.env.REMIX_API_KEY.trim();
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
  throw new Error("No Remix API key found (env REMIX_API_KEY, .remix-key, or .mcp.json).");
}

const PAGE = 500;

async function api(path, key) {
  const res = await fetch(BASE + path, {
    headers: { Authorization: "Bearer " + key },
  });
  if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`);
  return res.json();
}

function dayKey(iso) {
  return iso.slice(0, 10); // YYYY-MM-DD
}

// Walk the full /scores feed for one game, accumulating metrics without
// retaining every raw row. `globalUsers` is a shared Set for cross-game unique.
async function fetchGameDetail(game, key, { maxPages = Infinity, globalUsers }) {
  const gid = game.id;
  const users = new Set();
  const daily = Object.create(null);
  const hourHist = new Array(24).fill(0); // scores by UTC hour-of-day
  const scoreHist = new Array(20).fill(0); // log10 half-decade buckets (10^0..10^10)
  const recent = []; // most-recent-by-date, capped at 20
  let plays = 0;
  let top = null; // { score, username, pfp }
  let firstPlay = null;
  let lastPlay = null;
  let cursor = null;
  let pages = 0;
  let capped = false;

  for (;;) {
    let p = `/games/${gid}/scores?limit=${PAGE}`;
    if (cursor) p += "&cursor=" + cursor;
    const d = await api(p, key);
    for (const s of d.scores) {
      plays++;
      const u = s.user || {};
      const uid = u.id || u.username || "?";
      users.add(uid);
      if (globalUsers) globalUsers.add(uid);
      const at = s.achieved_at;
      const day = dayKey(at);
      daily[day] = (daily[day] || 0) + 1;
      hourHist[new Date(at).getUTCHours()]++;
      const sb = Math.floor(Math.log10((s.score > 0 ? s.score : 0) + 1) * 2);
      scoreHist[sb < 0 ? 0 : sb > 19 ? 19 : sb]++;
      if (top === null || s.score > top.score)
        top = { score: s.score, username: u.username, pfp: u.pfp };
      if (firstPlay === null || at < firstPlay) firstPlay = at;
      if (lastPlay === null || at > lastPlay) lastPlay = at;
      // keep the 20 most recent plays by timestamp
      if (recent.length < 20 || at > recent[recent.length - 1].at) {
        recent.push({ at, score: s.score, username: u.username, pfp: u.pfp });
        recent.sort((a, b) => (a.at < b.at ? 1 : -1));
        if (recent.length > 20) recent.length = 20;
      }
    }
    cursor = d.next_cursor;
    pages++;
    if (!cursor) break;
    if (pages >= maxPages) {
      capped = true;
      break;
    }
  }

  let leaderboard = [];
  try {
    const lb = await api(`/games/${gid}/leaderboard`, key);
    leaderboard = (lb.leaderboard || []).map((r) => ({
      rank: r.rank,
      score: r.score,
      username: r.user?.username,
      pfp: r.user?.pfp,
    }));
  } catch {
    /* leaderboard is best-effort */
  }

  return {
    id: gid,
    name: game.name,
    icon: game.appImageUrl || null,
    liveVersionId: game.liveVersionId || null,
    createdAt: game.createdAt || null, // game record creation (≈ early/draft date)
    plays, // NOTE: this is score submissions (LB entries), not raw plays — true plays are higher
    capped,
    unique: users.size,
    topScore: top ? top.score : 0,
    topUser: top ? top.username : null,
    firstPlay,
    lastPlay,
    daily,
    hourHist,
    scoreHist,
    leaderboard,
    recent,
  };
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

// Pull and aggregate everything. opts.full=true removes the page cap (true totals).
export async function fetchAll(opts = {}) {
  const { full = true, concurrency = 5, onProgress } = opts;
  const key = opts.key || readKey();
  const { games } = await api("/games", key);
  const maxPages = full ? Infinity : 60;
  const globalUsers = new Set();
  let done = 0;

  const detail = await pool(games, concurrency, async (g) => {
    const d = await fetchGameDetail(g, key, { maxPages, globalUsers });
    done++;
    if (onProgress) onProgress(done, games.length, d);
    return d;
  });

  detail.sort((a, b) => b.plays - a.plays);

  // Cross-game daily totals + hour-of-day histogram for the overview charts.
  const dailyAll = Object.create(null);
  const hourAll = new Array(24).fill(0);
  for (const g of detail) {
    for (const [day, n] of Object.entries(g.daily)) dailyAll[day] = (dailyAll[day] || 0) + n;
    for (let h = 0; h < 24; h++) hourAll[h] += g.hourHist[h] || 0;
  }

  const totalPlays = detail.reduce((a, g) => a + g.plays, 0);
  const anyCapped = detail.some((g) => g.capped);

  return {
    generatedAt: new Date().toISOString(),
    full,
    totalGames: detail.length,
    totalPlays,
    globalUnique: globalUsers.size,
    anyCapped,
    dailyAll,
    hourAll,
    games: detail,
  };
}
