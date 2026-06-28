// Fetch all analytics and bake a self-contained snapshot.html (no API key inside).
// Usage: node build-snapshot.mjs [--fast]
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fetchAll } from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const full = !process.argv.includes("--fast");

console.log(`Fetching Remix analytics (${full ? "full counts" : "fast/capped"})…`);
const data = await fetchAll({
  full,
  onProgress: (done, total, g) =>
    console.log(`  [${done}/${total}] ${g.name}: ${g.plays}${g.capped ? "+" : ""} plays, ${g.unique} players`),
});

const tpl = readFileSync(join(HERE, "dashboard.html"), "utf8");
const html = tpl.replace(
  /\/\*DATA_START\*\/[\s\S]*?\/\*DATA_END\*\//,
  "/*DATA_START*/" + JSON.stringify(data) + "/*DATA_END*/"
);

// also drop the raw aggregate next to it for reuse
writeFileSync(join(HERE, "data.json"), JSON.stringify(data, null, 1));
writeFileSync(join(HERE, "snapshot.html"), html);

console.log(`\n✓ ${data.totalGames} games · ${data.totalPlays} plays · ${data.globalUnique} unique players`);
console.log("✓ wrote snapshot.html and data.json");
