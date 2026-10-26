# SOLANA RADAR — Smart Wallet Monitor

Two features, one screen:

1. **Monthly wallet ranking**: the best-performing wallets over the last 30 days (realized profit, ROI, win rate, trade count).
2. **Synchronized buy radar**: raises an alert when **3 or more distinct wallets** from the ranking buy the **same token** within **5 minutes**. The latest alert stays on screen until a newer one arrives.

No database: everything lives in memory (after a restart the radar starts empty and the ranking is fetched again).
No npm dependencies. Runs on Node 12+.

> Possible opportunity for analysis only. Not financial advice and no guarantee of gains.

## How it works

```
MadeOnSol  --(1 call every 6 h)-->  top-50 ranking  --> wallet list
                                                          |
                                         Helius webhook (enhanced, ~3 s delay)
                                                          |
                    buy = token balance went up AND the wallet spent SOL
                                                          |
                         5-minute sliding window per token, unique wallets
                                                          |
                                           alert  -->  dashboard (SSE)
```

- **Ranking**: `GET madeonsol.com/api/v1/kol/leaderboard?period=30d&sort=pnl&limit=50` (free plan: 200 calls/day; this uses ~4/day).
- **Radar**: one Helius webhook watching the 50 wallets. The server creates/updates **only its own webhook** (identified by its URL) and only edits it when the list changed (each create/edit costs 100 credits).
- **Buy classification**: Helius' `type` field is often wrong for Pump.fun transactions (they show up as `TRANSFER`/`UNKNOWN`), so it is ignored. Buys are detected from balance changes in `accountData`, validated against MadeOnSol's feed.
- **Token symbol/name**: DexScreener (public API, no key). If it fails the UI shows only the mint.

## Configuration

1. Copy `.env.example` to `.env` and fill in:

| Variable | What it is |
|---|---|
| `MADEONSOL_API_KEY` | free key from https://madeonsol.com/developer |
| `HELIUS_API_KEY` | free key from https://dashboard.helius.dev (only needed with `PUBLIC_URL`) |
| `WEBHOOK_SECRET` | long random text (min. 16 chars). Helius sends it in the `Authorization` header; without it the server answers 401 |
| `PUBLIC_URL` | public URL of the server, e.g. `https://your-app.up.railway.app`. **Empty = local mode** (ranking works, radar off) |

   Generate a secret: `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`

2. Run: `npm start` and open http://localhost:3000
3. Tests: `npm test`

Keys stay on the backend only (`.env` is in `.gitignore`); nothing is sent to the browser, and errors/logs have keys masked.

### Live radar (needs a public URL)

Helius delivers events over HTTP, so the server must be reachable from the internet: deploy it (e.g. on Railway) and set `PUBLIC_URL` to the deployed domain (no trailing slash). On startup the server registers the webhook by itself. On Railway set the variables in the service's **Variables** tab and expose port 8080 (set `PORT=8080`).
To stop spending credits: delete the webhook at https://dashboard.helius.dev/webhooks.

## Optional settings (`.env`)

`PORT` (3000) · `RANKING_SIZE` (50) · `RANKING_REFRESH_HOURS` (6) · `WINDOW_MINUTES` (5) · `MIN_WALLETS` (3) · `MIN_BUY_SOL` (0.01) · `DAILY_EVENT_WARN` (30000)

## Confirmed / known limitations

- **MadeOnSol free plan**: 200 calls/day; live feeds are delayed 5 min (that is why the radar uses Helius). The leaderboard is not delayed.
- **Helius free plan**: 1M credits/month, 1 credit per webhook event. The top 50 generate ~9,600 events/day (~290k credits/month). The dashboard warns when a day's volume exceeds `DAILY_EVENT_WARN`.
- **Measured webhook latency**: median 3 s (2–6 s) between the transaction and the notification.
- **ROI**: MadeOnSol's docs do not define the unit of `avg_roi`; it is displayed as a percentage. Profit (`pnl`) is in SOL, per the docs.
- **No history**: restarting the server loses the latest alert and the current window (buys from the last 5 minutes are not recovered).
- **MadeOnSol terms**: the free plan is for personal use. Read the terms before opening the dashboard to the public (a Business plan with an embed license and attribution exists).
- If a ranked wallet is a bot with thousands of swaps/day it consumes credits; lower `RANKING_SIZE` if needed.

## Layout

```
src/buyParser.js   Helius event -> buys (from balance changes)
src/detector.js    sliding window, unique wallets, deduplication, no spam
src/madeonsol.js   normalized ranking (missing = null, never 0)
src/helius.js      creates/updates the webhook (only ours)
src/app.js         wires everything together, in-memory state
src/server.js      HTTP: dashboard, /api/state, /events (SSE), /webhook/helius
public/            dashboard (plain HTML/CSS/JS, third-party text always via textContent)
test/              automated tests (npm test), with real captured transactions as fixtures
```
