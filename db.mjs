// Local score database (SQLite via Node's built-in node:sqlite — zero deps).
// We persist every recorded score so syncs are INCREMENTAL: after the first
// full backfill, each refresh only pulls scores newer than what we already have.
// The DB is git-ignored and stays on your machine — same privacy stance as the
// API key. Raw rows live here; the dashboard renders aggregates derived from them.
//
// Storage layout (schema v1): player identity (username + avatar URL) lives once
// per user in `users`, NOT repeated on every score row. `scores` holds only the
// keys + score + timestamp. This keeps the file small — an avatar URL stored 300k
// times across score rows is the single biggest source of bloat otherwise.

import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
// Overridable so tooling/tests can point at a copy without touching the real DB.
const DB_FILE = process.env.ANALYTICS_DB || join(HERE, "analytics.db");

const SCHEMA_VERSION = 1;
let db = null;

export function openDb() {
  if (db) return db;
  db = new DatabaseSync(DB_FILE);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS games (
      id              TEXT PRIMARY KEY,
      name            TEXT,
      icon            TEXT,
      created_at      TEXT,
      live_version_id TEXT,
      last_synced_at  TEXT,             -- max achieved_at we've stored for this game
      fully_synced    INTEGER DEFAULT 0 -- 1 once we've walked the whole feed to the end at least once
    );
    -- Player identity, one row per user (deduped out of the score rows).
    CREATE TABLE IF NOT EXISTS users (
      user_id  TEXT PRIMARY KEY,
      username TEXT,
      pfp      TEXT
    );
    -- Fresh installs get the lean shape directly; older DBs are migrated below.
    CREATE TABLE IF NOT EXISTS scores (
      game_id     TEXT NOT NULL,
      user_id     TEXT NOT NULL,
      score       INTEGER,
      achieved_at TEXT NOT NULL,
      PRIMARY KEY (game_id, user_id, achieved_at)
    );
    -- Only index we actually need: per-user lookups across games (drill-downs).
    -- WHERE/GROUP BY game_id is already served by the PRIMARY KEY's leading column,
    -- so a separate game index would just waste space.
    CREATE INDEX IF NOT EXISTS idx_scores_user ON scores(user_id);
  `);
  migrate(db);
  return db;
}

// Bring an older (v0) database up to the current schema. v0 stored username+pfp
// on every score row and carried two redundant indexes (idx_scores_game,
// idx_scores_at). We fold identity into `users`, drop the dead weight, and VACUUM
// to reclaim the freed pages. Runs once (guarded by PRAGMA user_version).
function migrate(d) {
  const ver = d.prepare("PRAGMA user_version").get().user_version;
  if (ver >= SCHEMA_VERSION) return;

  const cols = d.prepare("PRAGMA table_info(scores)").all().map((c) => c.name);
  const legacy = cols.includes("pfp") || cols.includes("username");

  if (legacy) {
    console.log("[db] migrating to v1 (deduping player identity, trimming indexes)… one-time, may take a moment for large DBs.");
    d.prepare("BEGIN").run();
    try {
      // Backfill users from the score rows — take each user's most recent
      // name/avatar (bare columns follow MAX(achieved_at) in SQLite).
      d.exec(`
        INSERT OR IGNORE INTO users (user_id, username, pfp)
        SELECT user_id, username, pfp FROM (
          SELECT user_id, username, pfp, MAX(achieved_at) FROM scores GROUP BY user_id
        );
      `);
      d.exec("ALTER TABLE scores DROP COLUMN pfp;");
      d.exec("ALTER TABLE scores DROP COLUMN username;");
      d.prepare("COMMIT").run();
    } catch (e) {
      d.prepare("ROLLBACK").run();
      throw e;
    }
  }

  // Drop the redundant indexes (no-op if they were never there).
  d.exec("DROP INDEX IF EXISTS idx_scores_game;");
  d.exec("DROP INDEX IF EXISTS idx_scores_at;");
  d.exec("CREATE INDEX IF NOT EXISTS idx_scores_user ON scores(user_id);");
  d.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);

  if (legacy) {
    d.exec("VACUUM;"); // reclaim the space freed by the dropped columns/indexes
    console.log("[db] migration complete — database compacted.");
  }
}

// Reclaim free pages and truncate the WAL. Safe to run anytime; handy after big
// syncs. Exposed for `npm run compact`.
export function compact() {
  const d = openDb();
  d.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  d.exec("VACUUM;");
}

// Upsert a game record (preserve last_synced_at — it's owned by the sync loop).
export function upsertGame(g) {
  openDb().prepare(`
    INSERT INTO games (id, name, icon, created_at, live_version_id)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      icon = excluded.icon,
      created_at = excluded.created_at,
      live_version_id = excluded.live_version_id
  `).run(g.id, g.name ?? null, g.icon ?? null, g.createdAt ?? null, g.liveVersionId ?? null);
}

export function getSyncState(gameId) {
  const row = openDb()
    .prepare("SELECT last_synced_at, fully_synced FROM games WHERE id = ?")
    .get(gameId);
  return {
    lastSyncedAt: row ? row.last_synced_at : null,
    fullySynced: row ? !!row.fully_synced : false,
  };
}

export function setSyncState(gameId, iso, fullySynced) {
  openDb()
    .prepare("UPDATE games SET last_synced_at = ?, fully_synced = ? WHERE id = ?")
    .run(iso, fullySynced ? 1 : 0, gameId);
}

// Bulk-insert score rows (OR IGNORE dedups on the composite key — safe to re-run
// across the sync boundary where two rows can share an exact achieved_at).
// Player identity is upserted into `users` in the same transaction, keeping the
// latest non-null name/avatar. Returns how many score rows were actually new.
export function insertScores(rows) {
  if (!rows.length) return 0;
  const d = openDb();
  const sStmt = d.prepare(`
    INSERT OR IGNORE INTO scores (game_id, user_id, score, achieved_at)
    VALUES (?, ?, ?, ?)
  `);
  const uStmt = d.prepare(`
    INSERT INTO users (user_id, username, pfp) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      username = COALESCE(excluded.username, users.username),
      pfp      = COALESCE(excluded.pfp, users.pfp)
  `);
  let added = 0;
  d.prepare("BEGIN").run();
  try {
    for (const r of rows) {
      added += sStmt.run(r.game_id, r.user_id, r.score ?? 0, r.achieved_at).changes;
      uStmt.run(r.user_id, r.username ?? null, r.pfp ?? null);
    }
    d.prepare("COMMIT").run();
  } catch (e) {
    d.prepare("ROLLBACK").run();
    throw e;
  }
  return added;
}

export function allGames() {
  return openDb().prepare("SELECT * FROM games").all();
}

export function totalScoreRows() {
  return openDb().prepare("SELECT COUNT(*) AS n FROM scores").get().n;
}

// log10 half-decade bucket (10^0..10^10) used by the score-distribution chart.
function scoreBucket(score) {
  const sb = Math.floor(Math.log10((score > 0 ? score : 0) + 1) * 2);
  return sb < 0 ? 0 : sb > 19 ? 19 : sb;
}

// Build the entire dashboard payload from stored rows — no network here.
// Shape matches what dashboard.html / snapshot expect, plus topPlayers + players.
export function aggregate({ generatedAt }) {
  const d = openDb();
  const games = d.prepare("SELECT * FROM games").all();

  // Per-game full ranking (user_id -> {rank, best}) so we can show a player's
  // standing in every game they've played. Built once, reused for the
  // top-20 leaderboard and for each top player's drill-down breakdown.
  const gameRank = Object.create(null);

  const detail = games.map((g) => {
    const gid = g.id;
    const base = d
      .prepare(`SELECT COUNT(*) plays, COUNT(DISTINCT user_id) uniq,
                       MIN(achieved_at) firstPlay, MAX(achieved_at) lastPlay
                FROM scores WHERE game_id = ?`)
      .get(gid);

    const topRow = d
      .prepare(`SELECT s.score, u.username
                FROM scores s LEFT JOIN users u ON u.user_id = s.user_id
                WHERE s.game_id = ? ORDER BY s.score DESC LIMIT 1`)
      .get(gid);

    const daily = Object.create(null);
    for (const r of d
      .prepare(`SELECT substr(achieved_at,1,10) day, COUNT(*) n
                FROM scores WHERE game_id = ? GROUP BY day`)
      .all(gid))
      daily[r.day] = r.n;

    const hourHist = new Array(24).fill(0);
    for (const r of d
      .prepare(`SELECT CAST(substr(achieved_at,12,2) AS INTEGER) hr, COUNT(*) n
                FROM scores WHERE game_id = ? GROUP BY hr`)
      .all(gid))
      hourHist[r.hr] = r.n;

    const scoreHist = new Array(20).fill(0);
    for (const r of d
      .prepare(`SELECT score, COUNT(*) n FROM scores WHERE game_id = ? GROUP BY score`)
      .all(gid))
      scoreHist[scoreBucket(r.score)] += r.n;

    // Full best-score ranking for this game (every player), ordered desc.
    const ranked = d
      .prepare(`SELECT s.user_id, u.username, u.pfp, MAX(s.score) score
                FROM scores s LEFT JOIN users u ON u.user_id = s.user_id
                WHERE s.game_id = ? GROUP BY s.user_id
                ORDER BY score DESC`)
      .all(gid);
    const ranks = new Map();
    ranked.forEach((r, i) => ranks.set(r.user_id, { rank: i + 1, best: r.score }));
    gameRank[gid] = { name: g.name, icon: g.icon || null, total: ranked.length, ranks };

    const leaderboard = ranked
      .slice(0, 20)
      .map((r, i) => ({ rank: i + 1, score: r.score, username: r.username, pfp: r.pfp, uid: r.user_id }));

    const recent = d
      .prepare(`SELECT s.user_id, u.username, u.pfp, s.score, s.achieved_at at
                FROM scores s LEFT JOIN users u ON u.user_id = s.user_id
                WHERE s.game_id = ? ORDER BY s.achieved_at DESC LIMIT 20`)
      .all(gid)
      .map((r) => ({ at: r.at, score: r.score, username: r.username, pfp: r.pfp, uid: r.user_id }));

    // Per-game most-active players (by recorded plays, not by score).
    const topPlayers = d
      .prepare(`SELECT s.user_id, u.username, u.pfp, COUNT(*) plays, MAX(s.achieved_at) last
                FROM scores s LEFT JOIN users u ON u.user_id = s.user_id
                WHERE s.game_id = ? GROUP BY s.user_id
                ORDER BY plays DESC, last DESC LIMIT 20`)
      .all(gid)
      .map((r, i) => ({
        rank: i + 1, plays: r.plays, last: r.last,
        username: r.username, pfp: r.pfp, uid: r.user_id,
      }));

    return {
      id: gid,
      name: g.name,
      icon: g.icon || null,
      liveVersionId: g.live_version_id || null,
      createdAt: g.created_at || null,
      plays: base.plays,
      capped: !g.fully_synced,
      unique: base.uniq,
      topScore: topRow ? topRow.score : 0,
      topUser: topRow ? topRow.username : null,
      firstPlay: base.firstPlay,
      lastPlay: base.lastPlay,
      daily,
      hourHist,
      scoreHist,
      leaderboard,
      recent,
      topPlayers,
    };
  });

  detail.sort((a, b) => b.plays - a.plays);

  // Cross-game overview aggregates.
  const dailyAll = Object.create(null);
  for (const r of d
    .prepare(`SELECT substr(achieved_at,1,10) day, COUNT(*) n FROM scores GROUP BY day`)
    .all())
    dailyAll[r.day] = r.n;

  const hourAll = new Array(24).fill(0);
  for (const r of d
    .prepare(`SELECT CAST(substr(achieved_at,12,2) AS INTEGER) hr, COUNT(*) n
              FROM scores GROUP BY hr`)
    .all())
    hourAll[r.hr] = r.n;

  const totalPlays = d.prepare("SELECT COUNT(*) n FROM scores").get().n;
  const globalUnique = d.prepare("SELECT COUNT(DISTINCT user_id) n FROM scores").get().n;

  // Reusable per-player builders, shared by the global most-active list and by
  // the per-player drill-down cards baked into `players`. Identity is now a
  // direct PRIMARY KEY lookup on `users` (was a scan of `scores`).
  const idNameStmt = d.prepare(`SELECT username, pfp FROM users WHERE user_id = ?`);
  const summaryStmt = d.prepare(`SELECT COUNT(*) plays, COUNT(DISTINCT game_id) games, MAX(achieved_at) last
                                 FROM scores WHERE user_id = ?`);
  // Per-player, per-game breakdown (plays + best score + standing) for the popup.
  const perGameStmt = d.prepare(`SELECT game_id, COUNT(*) plays, MAX(score) best, MAX(achieved_at) last
                                 FROM scores WHERE user_id = ? GROUP BY game_id
                                 ORDER BY plays DESC, best DESC`);
  const buildBreakdown = (userId) =>
    perGameStmt.all(userId).map((b) => {
      const gr = gameRank[b.game_id];
      const standing = gr && gr.ranks.get(userId);
      return {
        name: gr ? gr.name : b.game_id,
        icon: gr ? gr.icon : null,
        plays: b.plays,
        best: b.best,
        rank: standing ? standing.rank : null,
        outOf: gr ? gr.total : null,
        last: b.last,
      };
    });
  // Full drill-down card for one player. `rank` = global most-active rank if known.
  const buildPlayer = (userId, rank = null) => {
    const id = idNameStmt.get(userId) || {};
    const s = summaryStmt.get(userId) || { plays: 0, games: 0, last: null };
    return {
      uid: userId, username: id.username, pfp: id.pfp,
      plays: s.plays, games: s.games, last: s.last, rank,
      breakdown: buildBreakdown(userId),
    };
  };

  // Global most-active players: total plays + how many distinct games they touched.
  // Name/avatar from the users table. Lightweight rows — the full card (breakdown)
  // lives in `players` below, keyed by uid.
  const topAgg = d
    .prepare(`SELECT user_id, COUNT(*) plays, COUNT(DISTINCT game_id) games, MAX(achieved_at) last
              FROM scores GROUP BY user_id ORDER BY plays DESC, last DESC LIMIT 50`)
    .all();
  const globalTopPlayers = topAgg.map((r, i) => {
    const id = idNameStmt.get(r.user_id) || {};
    return {
      rank: i + 1, uid: r.user_id, plays: r.plays, games: r.games, last: r.last,
      username: id.username, pfp: id.pfp,
    };
  });

  // Bake a uid -> full-card map for EVERY player shown in any rendered list
  // (global most-active + each game's leaderboard / most-active / recent), so
  // clicking any name — in the game modal or the global list — opens their card
  // with zero extra requests, in both live-server and static-snapshot modes.
  const players = Object.create(null);
  for (const p of globalTopPlayers) players[p.uid] = buildPlayer(p.uid, p.rank);
  for (const g of detail) {
    for (const list of [g.leaderboard, g.topPlayers, g.recent]) {
      for (const r of list) {
        if (r.uid != null && !players[r.uid]) players[r.uid] = buildPlayer(r.uid);
      }
    }
  }

  return {
    generatedAt: generatedAt || null,
    full: true,
    totalGames: detail.length,
    totalPlays,
    globalUnique,
    anyCapped: detail.some((g) => g.capped),
    dailyAll,
    hourAll,
    games: detail,
    topPlayers: globalTopPlayers,
    players,
  };
}
