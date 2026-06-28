# Remix Creator Analytics

A self-hosted, Remix-branded analytics dashboard for [Remix](https://remix.gg)
game creators. **Bring your own API key**, run one command, and see every live
game's scores, players, leaderboards, activity and trends in one panel.

Zero dependencies — just Node 18+. Your API key never leaves your machine.

```bash
git clone <this-repo> && cd remix-creator-analytics
node server.mjs
# open http://localhost:8787 → paste your API key → done
```

## Features

- **Overview** — total plays, unique players (de-duped across all your games),
  24h / 7d activity, most-played game.
- **Charts** — plays-per-day trend, activity by hour-of-day, top games bar,
  players-vs-plays comparison.
- **Per-game drill-down** — daily scores, score distribution histogram, hourly
  activity, top-20 leaderboard with avatars, and the most recent plays.
- **First play** — the earliest recorded-score date (the API exposes no
  `publishedAt` / launch date), with the game record's `createdAt` in the tooltip.
- **Two modes** — a live auto-refreshing server, or a static self-contained
  `snapshot.html` you can share (no key inside).

## Your key stays private

This is the whole point. The dashboard is split so the key is **never** exposed:

- You paste the key into the **onboarding screen**, which `POST`s it to your
  **local** server (`localhost`) — never to us, never to any third party.
- The server keeps the key in memory and, **only if you leave the checkbox
  ticked**, writes it to a local, **git-ignored `.env`** file (as
  `REMIX_API_KEY=…`). It is never written to `localStorage` or the browser.
- The browser only ever receives **aggregated stats** from `/api/data` — the
  key is never sent back to the page and never appears in `snapshot.html`.
- Don't want to type it into a UI at all? Put `REMIX_API_KEY=sk_live_…` in a
  `.env` file next to the server and just start it — onboarding is skipped.

> Treat your `sk_live_...` key like a password — it can create and modify your
> games. Never paste it into a website you don't control, and never commit it.

## Usage

### Live server (recommended)
```bash
node server.mjs                 # full counts, refresh every 5 min, port 8787
node server.mjs --fast          # cap at 60 pages/game (much faster for big accounts)
node server.mjs --port 9000 --interval 120
```
Open the URL, paste your key once, and the panel auto-builds. Tick
**auto-refresh** for 30s polling or hit **↻** to refresh on demand.

### Static snapshot (shareable, no key inside)
```bash
# put your key in .remix-key (or export REMIX_API_KEY=...), then:
node build-snapshot.mjs          # full counts
node build-snapshot.mjs --fast   # capped/fast
```
Produces `snapshot.html` (data baked in, **no key**) — double-click to open or
send to a teammate. Also writes `data.json` (raw aggregate).

### Where the key is read from
In priority order: `REMIX_API_KEY` env var → local `.env` file → legacy
`.remix-key` file → the onboarding screen (server mode). Get a key at
**<https://remix.gg/api>**.

## How it works

Built on the Remix creator API (`https://remix.gg/api/v1`, bearer auth):

| Endpoint | Used for |
|----------|----------|
| `GET /games` | your games + `createdAt` |
| `GET /games/:id/leaderboard` | top players (best score per user) |
| `GET /games/:id/scores` | full score feed — paginated via `next_cursor`, `limit` up to 500 |

> **"Plays" here = recorded scores, not every play.** The API only exposes
> score submissions (leaderboard entries). Games played without reaching
> game-over, or played through remix.gg, don't create a leaderboard / score
> record — so real play counts are higher than shown. There is no
> plays/sessions/views endpoint at the time of writing.

## Files
| File | Role |
|------|------|
| `lib.mjs` | API client + aggregation (shared) |
| `server.mjs` | live server + onboarding (`/`, `/api/status`, `/api/key`, `/api/data`, `/api/refresh`) |
| `build-snapshot.mjs` | fetch → bake `snapshot.html` |
| `dashboard.html` | UI (Remix-branded; data source: `/api/data` live, or inlined for snapshot) |

## License

MIT — see [LICENSE](./LICENSE). Not affiliated with or endorsed by Remix;
"Remix" branding/colors belong to Remix and are used here for a creator tool.
