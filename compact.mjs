// Compact the local database: checkpoint the WAL and VACUUM to reclaim free
// pages. Opening the DB also runs any pending schema migration. Usage:
//   npm run compact
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { compact } from "./db.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DB = process.env.ANALYTICS_DB || join(HERE, "analytics.db");
const mb = (b) => (b / 1048576).toFixed(1) + " MB";

const before = statSync(DB).size;
compact();
const after = statSync(DB).size;
console.log(`Compacted: ${mb(before)} -> ${mb(after)} (saved ${mb(before - after)})`);
